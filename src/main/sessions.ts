import { randomUUID, randomBytes } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { BrowserWindow, Notification, clipboard } from 'electron'
import { HIVE_DIR, MAIN_AGENT, agentPtyKey, assertSessionId, canSwitchLive, footerMode, hookMode, permissionLabel, projectAgents, resumeRecord } from '../shared/defaults'
import type {
  AgentDef,
  AgentInfo,
  EffortLevel,
  FileLockMode,
  LiveSessionState,
  McpServerDef,
  PermissionMode,
  ProjectConfig,
  SessionListItem,
  SessionStatus,
  SessionUsage
} from '../shared/types'
import { claudeCode } from './agents/claude-code'
import { parseTranscript, recacheEstimate } from './agents/transcript'
import type { LaunchSkill } from './agents/types'
import { agentService } from './agentService'
import { config } from './config'
import { emit, toast } from './events'
import { hashDir, hashText, splitArgs } from './fsutil'
import { createLogger } from './logger'
import { listMcp, toLaunchDef } from './mcp'
import { childEnv, killPty, spawnPty, writePty } from './ptyHost'
import { hiveSkills } from './skills'
import { notificationIcon } from './paths'
import { parsePlanUsage, reportPlanUsage } from './planUsage'
import { workspace } from './workspace'

const log = createLogger('sessions')

export interface HiveMcpProvider {
  (projectPath: string): McpServerDef | null
}

/** Minimum time between transcript backups while a turn is running. */
const BACKUP_INTERVAL_MS = 60_000

interface LiveSession {
  state: LiveSessionState
  transcriptMtime: number
  backupTimer?: NodeJS.Timeout
  /** When the transcript was last copied to .hive/sessions (see BACKUP_INTERVAL_MS). */
  lastBackupAt?: number
  /** Launched without --model, so its transcript shows Claude Code's default model. */
  defaultModel: boolean
  /** Set while a Hive-requested /compact runs: compactions in the transcript before it, and a safety timer. */
  compacting?: { before: number; timer: NodeJS.Timeout; started: boolean; output: string }
  /** The user stopped it (e.g. during its worktree setup), so an early exit isn't reported as a failure. */
  stopRequested?: boolean
  /** Terminal output tail, to read the permission mode from Claude Code's footer. */
  modeTail: string
  /** The mode it was launched in (--permission-mode). */
  launchMode: PermissionMode | null
  /** The mode the settings asked for when it launched, or when the user last applied a settings change to it. */
  configuredMode: PermissionMode | null
  /** A settings change already offered to it, so the offer isn't repeated on every refresh. */
  offeredMode?: PermissionMode | null
  /** Launch in this mode instead of the configured one (Restart in mode). */
  modeOverride?: PermissionMode
}

export interface EffectiveSettings {
  skills: LaunchSkill[]
  skillHashes: Record<string, string>
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  chime: boolean
}

/** A claim an agent holds on a file it edited, so another agent in the same folder doesn't edit it at the same time. */
interface FileLock {
  liveId: string
  at: number
  path: string
}

/** A lock is released when its agent's turn ends; this covers an agent that stalls without ending it. */
const LOCK_TTL_MS = 15 * 60_000

const usageCache = new Map<string, { mtime: number; size: number; usage: SessionUsage }>()

/** Writes text to a session in small pieces, the way keystrokes arrive, rather than as one burst. */
async function typeInto(key: string, text: string): Promise<void> {
  const CHUNK = 8
  for (let i = 0; i < text.length; i += CHUNK) {
    writePty(key, text.slice(i, i + CHUNK))
    if (i + CHUNK < text.length) await new Promise((r) => setTimeout(r, 10))
  }
}

/** Runs a worktree's setup command in the agent's terminal (Windows: cmd.exe, elsewhere: sh). */
function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] }
}

const shownNotifications = new Set<Notification>()

const liveId = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

class SessionManager {
  private live = new Map<string, LiveSession>()
  private locks = new Map<string, FileLock>()
  readonly hookToken = randomBytes(24).toString('hex')
  hookUrl = ''
  apiEnv: () => Record<string, string> = () => ({})
  hiveMcp: HiveMcpProvider = () => null
  private exitWaiters = new Map<string, () => void>()
  /** Agents being started (liveId → the session being resumed), so two starts at once can't both get through. */
  private starting = new Map<string, string | undefined>()
  private getWindow: () => BrowserWindow | null = () => null

  setWindowProvider(fn: () => BrowserWindow | null): void {
    this.getWindow = fn
  }

  key(projectPath: string, agentId: string = MAIN_AGENT): string {
    return agentPtyKey(projectPath, agentId)
  }

  liveCount(): number {
    return this.live.size
  }

  liveStates(): LiveSessionState[] {
    return [...this.live.values()].map((l) => l.state)
  }

  /** One agent's session; without agentId, Agent 1's if it runs, else the project's first running agent's. */
  liveFor(projectPath: string, agentId?: string): LiveSessionState | null {
    if (agentId) return this.live.get(liveId(projectPath, agentId))?.state ?? null
    const all = this.projectStates(projectPath)
    return all.find((s) => s.agentId === MAIN_AGENT) ?? all[0] ?? null
  }

  projectStates(projectPath: string): LiveSessionState[] {
    const prefix = `${projectPath.toLowerCase()}#`
    return [...this.live.entries()].filter(([k]) => k.startsWith(prefix)).map(([, l]) => l.state)
  }

  private async agentDef(projectPath: string, agentId: string): Promise<{ agent: AgentDef; cfg: ProjectConfig; count: number }> {
    const cfg = await workspace.projectConfig(projectPath)
    const agents = projectAgents(cfg)
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) throw new Error('That agent no longer exists.')
    return { agent, cfg, count: agents.length }
  }

  /** Resolves global + project settings (and the agent's own overrides) into what a session launches with. */
  async effective(projectPath: string, agent?: AgentDef): Promise<EffectiveSettings> {
    const s = config.settings
    const pc = await workspace.projectConfig(projectPath)
    const skillsDisabled = new Set(pc.skills.disabled)
    const skills: LaunchSkill[] = []
    const skillHashes: Record<string, string> = {}
    for (const sk of await hiveSkills()) {
      if (!sk.globallyEnabled || skillsDisabled.has(sk.name)) continue
      skills.push({ name: sk.name, sourcePath: sk.path })
      skillHashes[sk.name] = await hashDir(sk.path).catch(() => '')
    }
    const mcpDisabled = new Set(pc.mcp.disabled)
    const mcpServers: Record<string, McpServerDef> = {}
    for (const m of await listMcp()) {
      if (m.globallyEnabled && !mcpDisabled.has(m.name) && m.def) mcpServers[m.name] = toLaunchDef(m.def, workspace.mcpDir)
    }
    const hive = this.hiveMcp(projectPath)
    if (hive) mcpServers.hive = hive

    const projectPermission: PermissionMode = pc.permissionMode === 'inherit' ? s.claude.defaultPermissionMode : pc.permissionMode
    let permissionMode: PermissionMode | null = agent?.permissionMode ?? projectPermission
    if (permissionMode === 'bypassPermissions' && !s.claude.enableBypassOption) permissionMode = s.claude.defaultPermissionMode
    const model = agent?.model || (pc.model && pc.model !== 'inherit' ? pc.model : s.claude.defaultModel || null)
    const effort = agent?.effort ?? (pc.effort !== 'inherit' ? pc.effort : s.claude.defaultEffort || null)
    const extraArgs = [...splitArgs(s.claude.extraArgs), ...splitArgs(pc.extraArgs)]
    const chime = pc.chime === 'inherit' ? s.notifications.chimeEnabled : pc.chime === 'on'
    return { skills, skillHashes, mcpServers, model, effort, permissionMode, extraArgs, chime }
  }

  signature(e: EffectiveSettings): string {
    // The permission mode can be switched live (setPermissionMode), so it doesn't ask for a restart.
    const { chime: _c, skills: _s, permissionMode: _p, ...rest } = e
    return hashText(JSON.stringify(rest))
  }

  /** Every agent of a project with its running session, for ProjectInfo. */
  async liveInfo(projectPath: string, cfg: ProjectConfig): Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[] }> {
    const agents: AgentInfo[] = []
    const records = (await workspace.sessionsFile(projectPath)).sessions
    const open = new Set(this.projectStates(projectPath).map((s) => s.sessionId))
    for (const a of projectAgents(cfg)) {
      const l = this.live.get(liveId(projectPath, a.id))
      let restartNeeded = false
      if (l && !l.state.settingUp) {
        try {
          const eff = await this.effective(projectPath, a)
          restartNeeded = this.signature(eff) !== l.state.launchSignature
          this.noticeModeSetting(l, eff.permissionMode)
        } catch {
          // Settings can't be read right now; don't nag.
        }
      }
      const r = l ? null : resumeRecord(projectPath, a, records, open)
      agents.push({ ...a, live: l?.state ?? null, restartNeeded, resume: r && { id: r.id, name: r.name, lastActiveAt: r.lastActiveAt } })
    }
    const primary = agents.find((a) => a.id === MAIN_AGENT && a.live) ?? agents.find((a) => a.live)
    return { live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, agents }
  }

  private backupPath(projectPath: string, sessionId: string, archived = false): string {
    return join(projectPath, HIVE_DIR, archived ? 'archive' : 'sessions', `${assertSessionId(sessionId)}.jsonl`)
  }

  /**
   * Folders a session may have run in: Claude Code files transcripts by folder, and a worktree agent's
   * sessions run in its worktree. The session's own record comes first.
   */
  private async sessionFolders(projectPath: string, sessionId: string): Promise<string[]> {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    const cfg = await workspace.projectConfig(projectPath)
    const folders = [rec?.cwd, projectPath, ...projectAgents(cfg).map((a) => a.worktree?.path)].filter((f): f is string => !!f)
    return [...new Map(folders.map((f) => [f.toLowerCase(), f])).values()]
  }

  /** Claude Code's transcript of a session, wherever the session ran. */
  async claudeTranscript(projectPath: string, sessionId: string): Promise<string | null> {
    for (const f of await this.sessionFolders(projectPath, sessionId)) {
      const t = await claudeCode.transcriptPath(f, sessionId)
      if (t) return t
    }
    return null
  }

  async start(projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean; permissionMode?: PermissionMode }): Promise<LiveSessionState> {
    projectPath = workspace.assertProject(projectPath)
    if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
    const agentId = opts.agentId || MAIN_AGENT
    const id = liveId(projectPath, agentId)
    // Checked and reserved before anything is awaited: a double click, or the UI and the Agent API at
    // once, must not start the agent twice (the second start would orphan the first process).
    if (this.live.has(id) || this.starting.has(id)) throw new Error('This agent is already running or starting. Stop it first.')
    // Two terminals on one conversation would both append to its transcript.
    if (opts.resumeId && [...this.starting.values()].includes(opts.resumeId)) throw new Error('This conversation is already being opened in another agent.')
    this.starting.set(id, opts.resumeId)
    try {
      return await this.startReserved(projectPath, agentId, id, opts)
    } finally {
      this.starting.delete(id)
    }
  }

  private async startReserved(projectPath: string, agentId: string, id: string, opts: { resumeId?: string; name?: string; skipSetup?: boolean; permissionMode?: PermissionMode }): Promise<LiveSessionState> {
    const { agent, cfg, count } = await this.agentDef(projectPath, agentId)
    if (this.live.has(id)) throw new Error(count > 1 ? `${agent.name} is already running. Stop it first.` : 'A session is already running for this project. Stop it first.')
    const holder = opts.resumeId ? this.projectStates(projectPath).find((s) => s.sessionId === opts.resumeId) : undefined
    if (holder) throw new Error(`This conversation is already open in ${holder.agentName ?? 'another agent'}. An agent can only resume a session no other agent is running.`)
    const info = agentService.info
    if (!info.found || !info.path) throw new Error('The Claude Code CLI is required to run sessions. Install it from Help → Claude Code Setup.')
    await workspace.ensureProject(projectPath)
    const cwd = agent.worktree?.path ?? projectPath
    if (!existsSync(cwd)) throw new Error(`${agent.name}'s worktree folder is missing: ${cwd}. Remove the agent, or restore the folder with git worktree.`)

    const sessionId = opts.resumeId ?? randomUUID()
    const existing = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    if (existing?.archived) throw new Error('This session is archived. Unarchive it before resuming.')
    if (opts.resumeId && existing && (existing.cwd ?? projectPath).toLowerCase() !== cwd.toLowerCase()) {
      throw new Error(`This session ran in ${existing.cwd ?? projectPath}. Resume it with the agent that works in that folder.`)
    }

    const name = opts.name?.trim() || existing?.name || `${basename(projectPath)}${agentId === MAIN_AGENT ? '' : ` · ${agent.name}`} · ${new Date().toLocaleString()}`
    const key = this.key(projectPath, agentId)
    const state: LiveSessionState = {
      projectPath,
      agentId,
      agentName: agent.name,
      cwd,
      sessionId,
      sessionName: name,
      status: 'starting',
      startedAt: new Date().toISOString(),
      launchSignature: '',
      unseen: false
    }
    this.live.set(id, { state, transcriptMtime: 0, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, modeOverride: opts.permissionMode })

    const setup = cfg.worktreeSetup.trim()
    if (agent.worktree && agent.needsSetup && setup && !opts.skipSetup) {
      // The worktree's setup command runs in the agent's terminal first, then Claude Code starts there.
      state.settingUp = true
      state.statusMessage = `Setting up the worktree: ${setup}`
      const sh = shellCommand(setup)
      try {
        spawnPty(key, {
          file: sh.file,
          args: sh.args,
          cwd,
          env: childEnv(),
          quietExit: true,
          onExit: (code) => void this.afterSetup(projectPath, agentId, code, { sessionId, name, resume: !!opts.resumeId })
        })
      } catch (e) {
        this.live.delete(id)
        throw e
      }
      this.emitState(state)
      workspace.scheduleRefresh()
      return state
    }
    try {
      await this.launch(projectPath, agent, { sessionId, name, resume: !!opts.resumeId })
    } catch (e) {
      this.live.delete(id)
      emit({ type: 'session-status', state: { ...state, status: 'stopped' } })
      throw e
    }
    return state
  }

  private async afterSetup(projectPath: string, agentId: string, code: number, launch: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    let agent: AgentDef | undefined
    try {
      agent = (await this.agentDef(projectPath, agentId)).agent
    } catch {
      // Removed while setting up.
    }
    if (code !== 0 || !agent || l.stopRequested) {
      this.live.delete(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', settingUp: false } })
      if (agent && !l.stopRequested) toast('error', `${basename(projectPath)} · ${agent.name}: setup failed`, `The setup command exited with code ${code}. Its output is in the agent's terminal. Fix it and start the agent again, or start it without setup.`, undefined, projectPath)
      workspace.scheduleRefresh()
      return
    }
    await workspace.updateAgent(projectPath, agentId, { needsSetup: false }).catch(() => undefined)
    l.state.settingUp = false
    l.state.statusMessage = undefined
    try {
      await this.launch(projectPath, { ...agent, needsSetup: false }, launch)
    } catch (e) {
      this.live.delete(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped' } })
      toast('error', `Could not start ${agent.name}`, (e as Error).message, undefined, projectPath)
    }
  }

  /** Starts Claude Code for an agent whose live entry already exists. */
  private async launch(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agent.id)
    const l = this.live.get(id)!
    const state = l.state
    const cwd = state.cwd
    const { sessionId } = opts
    const info = agentService.info
    if (!info.path) throw new Error('The Claude Code CLI is required to run sessions.')

    if (opts.resume && !(await claudeCode.transcriptPath(cwd, sessionId))) {
      const backup = this.backupPath(projectPath, sessionId)
      if (existsSync(backup)) {
        const dest = claudeCode.defaultTranscriptPath(cwd, sessionId)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(backup, dest)
        log.info(`Restored transcript for ${sessionId} from Hive backup`)
      }
    }
    // Claude Code writes no transcript until the first message, so a session restarted before
    // anything was typed has nothing to resume — start it fresh under the same id instead.
    const resume = opts.resume && !!(await claudeCode.transcriptPath(cwd, sessionId))
    if (opts.resume && !resume) log.info(`No transcript for ${sessionId}; starting it fresh instead of resuming`)

    const eff = await this.effective(projectPath, agent)
    l.configuredMode = eff.permissionMode
    let mode = eff.permissionMode
    if (l.modeOverride && (l.modeOverride !== 'bypassPermissions' || config.settings.claude.enableBypassOption)) mode = l.modeOverride
    l.launchMode = mode
    state.permissionMode = mode ?? undefined
    const ctx = {
      projectPath,
      agentId: agent.id,
      workspacePath: workspace.path!,
      sessionId,
      resume,
      name: opts.name,
      skills: eff.skills,
      mcpServers: eff.mcpServers,
      model: eff.model,
      effort: eff.effort,
      permissionMode: mode,
      extraArgs: eff.extraArgs,
      hookUrl: this.hookUrl,
      env: childEnv({
        HIVE_HOOK_TOKEN: this.hookToken,
        HIVE_PROJECT: basename(projectPath),
        HIVE_PROJECT_PATH: projectPath,
        HIVE_WORKSPACE: workspace.path!,
        HIVE_SESSION_ID: sessionId,
        HIVE_AGENT: agent.name,
        ...this.apiEnv()
      })
    }
    await claudeCode.prepareLaunch(ctx)
    const cmd = claudeCode.buildCommand(info.path, ctx)
    state.launchSignature = this.signature(eff)
    l.defaultModel = !eff.model

    const proc = spawnPty(this.key(projectPath, agent.id), {
      file: cmd.file,
      args: cmd.args,
      cwd,
      env: cmd.env ?? ctx.env,
      // After a worktree's setup command, its output stays at the top of the terminal.
      continueBuffer: true,
      onData: (data) => {
        this.watchCompactOutput(id, data)
        this.watchModeOutput(id, data)
      },
      onExit: (code) => void this.onExit(projectPath, agent.id, sessionId, code)
    })
    state.pid = proc.pid
    l.backupTimer = setInterval(() => void this.backup(projectPath, agent.id, sessionId), 5000)
    await workspace.upsertSession(projectPath, {
      id: sessionId,
      name: opts.name,
      lastActiveAt: new Date().toISOString(),
      // The agent running it now; a session can move between agents that share a folder.
      agentId: agent.id !== MAIN_AGENT ? agent.id : undefined,
      ...(agent.worktree ? { cwd, branch: agent.worktree.branch } : {})
    })
    await workspace.updateAgent(projectPath, agent.id, { lastSessionId: sessionId }).catch(() => undefined)
    for (const other of projectAgents(await workspace.projectConfig(projectPath))) {
      if (other.id !== agent.id && other.lastSessionId === sessionId) await workspace.updateAgent(projectPath, other.id, { lastSessionId: undefined }).catch(() => undefined)
    }

    // Launched as active: starting a session implies working on the project.
    if (!workspace.activeNames().includes(basename(projectPath))) workspace.setActive(projectPath, true)
    this.emitState(state)
    workspace.scheduleRefresh()
  }

  /** Stops one agent's session, or every agent of the project when agentId is omitted. */
  stop(projectPath: string, agentId?: string): void {
    const agents = agentId ? [agentId] : this.projectStates(projectPath).map((s) => s.agentId)
    for (const a of agents) {
      const l = this.live.get(liveId(projectPath, a))
      if (l) l.stopRequested = true
      killPty(this.key(projectPath, a))
    }
  }

  stopAll(): void {
    for (const l of this.live.values()) killPty(this.key(l.state.projectPath, l.state.agentId))
  }

  /**
   * Stops every session and waits until each has been through onExit (final transcript backup,
   * session list update), or until the timeout, so quitting never loses the last messages or hangs.
   */
  async stopAllAndWait(timeoutMs = 3000): Promise<void> {
    const waits = [...this.live.keys()].map((k) => new Promise<void>((res) => this.exitWaiters.set(k, res)))
    this.stopAll()
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /**
   * Compacts a session's conversation now (Claude Code's /compact), optionally with focus instructions.
   * Only while the agent is idle: while it works the command would queue or interrupt, and while it
   * waits on a prompt the text would land in that prompt. Ctrl+U first clears anything half-typed
   * (Claude Code keeps it: Ctrl+Y pastes it back).
   */
  async compact(projectPath: string, focus?: string, agentId: string = MAIN_AGENT): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    if (l.compacting) throw new Error('This session is already compacting.')
    if (l.state.status !== 'ready' && l.state.status !== 'finished') {
      throw new Error(l.state.status === 'waiting' ? 'The agent is waiting for your answer. Compact after it has finished.' : 'The agent is busy. Compact once it has finished.')
    }
    const src = await claudeCode.transcriptPath(l.state.cwd, l.state.sessionId)
    const before = src ? ((await this.usageFor(src, l.state.sessionId))?.compactions.length ?? 0) : 0
    const key = this.key(projectPath, agentId)
    writePty(key, '\x15')
    await new Promise((r) => setTimeout(r, 150))
    const text = (focus ?? '').replace(/\s+/g, ' ').trim()
    // Written in one go, a long line counts as a paste in Claude Code, and pasted input is sent as a
    // message even when it starts with "/compact". So type the command on its own, then the focus in
    // small pieces; even if the focus still counts as pasted, the input begins with a typed command.
    writePty(key, '/compact')
    await new Promise((r) => setTimeout(r, 150))
    if (text) await typeInto(key, ` ${text}`)
    await new Promise((r) => setTimeout(r, 150))
    writePty(key, '\r')
    // Claude Code fires PreCompact as soon as a compaction starts. If that doesn't come (e.g. "not enough
    // messages to compact"), stop showing "Compacting…"; once started, allow up to 10 minutes.
    const timer = setTimeout(() => {
      if (!l.compacting?.started) this.finishCompacting(id)
    }, 20_000)
    l.compacting = { before, timer, started: false, output: '' }
    l.state.status = 'working'
    l.state.statusMessage = 'Compacting the conversation…'
    this.emitState(l.state)
  }

  /**
   * While a Hive-started compaction runs, watch the terminal for Claude Code refusing or failing it,
   * which sends no hook ("Not enough messages to compact.").
   */
  private watchCompactOutput(id: string, data: string): void {
    const c = this.live.get(id)?.compacting
    if (!c) return
    // Claude Code draws spaces as cursor moves (ESC[1C), so control sequences become spaces. Keep a
    // short tail so a message split across chunks still matches.
    c.output = (c.output + data.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
    if (/not enough messages to compact|error during compaction|compaction failed/i.test(c.output)) this.finishCompacting(id)
  }

  private finishCompacting(id: string): void {
    const l = this.live.get(id)
    if (!l?.compacting) return
    clearTimeout(l.compacting.timer)
    l.compacting = undefined
    if (l.state.status === 'working') {
      l.state.status = 'ready'
      l.state.statusMessage = undefined
      this.emitState(l.state)
    }
  }

  /** Reads the mode from Claude Code's footer as it redraws, so Shift+Tab in the terminal shows in Hive at once. */
  private watchModeOutput(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l) return
    l.modeTail = (l.modeTail + data.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).slice(-600)
    const mode = footerMode(l.modeTail)
    if (mode && mode !== l.state.permissionMode) {
      l.state.permissionMode = mode
      this.emitState(l.state)
    }
  }

  /**
   * Switches a running agent's permission mode the way you would by hand: Shift+Tab in its terminal
   * until the footer shows the mode. Not while it is asking a question (Shift+Tab could change the
   * answer). Modes outside Claude Code's Shift+Tab cycle need a restart (restartInMode).
   */
  async setPermissionMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<{ ok: boolean; restart?: boolean; message?: string }> {
    projectPath = workspace.assertProject(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    const st = l.state
    if (st.permissionMode === mode) return { ok: true }
    if (mode === 'bypassPermissions' && !config.settings.claude.enableBypassOption) throw new Error('Bypass permissions is turned off in Settings → Claude Code.')
    if (!canSwitchLive(mode, st.permissionMode, l.launchMode)) {
      return { ok: false, restart: true, message: `${permissionLabel(mode)} can't be switched to inside a running session. Restart the session in that mode; the conversation continues.` }
    }
    if (st.status === 'waiting') throw new Error('The agent is asking you something. Answer it first, then switch the mode.')
    if (st.status === 'starting') throw new Error('The session is still starting. Try again in a moment.')
    const key = this.key(projectPath, agentId)
    const seen = new Set<PermissionMode>()
    for (let i = 0; i < 8; i++) {
      const before = st.permissionMode
      if (before) seen.add(before)
      writePty(key, '\x1b[Z')
      const t = Date.now()
      while (Date.now() - t < 1500 && st.permissionMode === before) await new Promise((r) => setTimeout(r, 50))
      if (st.permissionMode === mode) {
        log.info(`${this.label(st)}: switched to ${mode}`)
        return { ok: true }
      }
      if (st.permissionMode === before) break
      // Back round to a mode already seen: the target isn't in this session's cycle.
      if (st.permissionMode && seen.has(st.permissionMode)) break
    }
    return { ok: false, restart: true, message: `Claude Code didn't offer ${permissionLabel(mode)} with Shift+Tab (it is now in ${st.permissionMode ? permissionLabel(st.permissionMode) : 'an unknown mode'}). Restart the session in that mode instead.` }
  }

  /** Stops the agent and resumes the same conversation in another permission mode. */
  async restartInMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) throw new Error('No session is running for this agent.')
    const { sessionId, sessionName } = l.state
    const exited = new Promise<void>((res) => this.exitWaiters.set(id, res))
    this.stop(projectPath, agentId)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    await this.start(projectPath, { resumeId: sessionId, name: sessionName, agentId, permissionMode: mode })
  }

  // A changed mode setting applies to new sessions; for running ones, Hive offers to switch them now.
  private modeOffers = new Map<string, { label: string; mode: PermissionMode }>()
  private modeOfferTimer: NodeJS.Timeout | null = null

  private noticeModeSetting(l: LiveSession, mode: PermissionMode | null): void {
    if (!mode || mode === l.configuredMode || mode === l.offeredMode) return
    if (mode === l.state.permissionMode) {
      // Already in it (switched by hand): nothing to offer.
      l.configuredMode = mode
      return
    }
    l.offeredMode = mode
    this.modeOffers.set(liveId(l.state.projectPath, l.state.agentId), { label: this.label(l.state), mode })
    if (this.modeOfferTimer) clearTimeout(this.modeOfferTimer)
    this.modeOfferTimer = setTimeout(() => {
      this.modeOfferTimer = null
      const offers = [...this.modeOffers.values()]
      this.modeOffers.clear()
      if (!offers.length) return
      const modes = [...new Set(offers.map((o) => permissionLabel(o.mode)))]
      const who = offers.length === 1 ? offers[0].label : `${offers.length} running agents (${offers.map((o) => o.label).join(', ')})`
      toast(
        'info',
        `Permission mode changed to ${modes.join(' / ')}`,
        `Switch ${who} now? Otherwise the new mode applies from ${offers.length === 1 ? 'its' : 'their'} next session.`,
        [{ label: 'Switch Now', command: 'session.applyPermissionModes' }]
      )
    }, 400)
  }

  /** "Switch Now": moves every running agent whose settings now say another mode into that mode. */
  async applyModeSettings(): Promise<{ switched: string[]; skipped: string[] }> {
    const switched: string[] = []
    const skipped: string[] = []
    for (const l of [...this.live.values()]) {
      const st = l.state
      if (st.settingUp) continue
      const { agent } = await this.agentDef(st.projectPath, st.agentId).catch(() => ({ agent: null }))
      if (!agent) continue
      const mode = (await this.effective(st.projectPath, agent)).permissionMode
      if (!mode || mode === l.configuredMode) continue
      l.configuredMode = mode
      if (mode === st.permissionMode) continue
      try {
        const r = await this.setPermissionMode(st.projectPath, st.agentId, mode)
        if (r.ok) switched.push(`${this.label(st)} → ${permissionLabel(mode)}`)
        else skipped.push(`${this.label(st)}: ${r.message}`)
      } catch (e) {
        skipped.push(`${this.label(st)}: ${(e as Error).message}`)
      }
    }
    return { switched, skipped }
  }

  /** Sessions that would be interrupted by quitting: an agent is working or waiting on a prompt. */
  busyStates(): LiveSessionState[] {
    return this.liveStates().filter((s) => s.status === 'working' || s.status === 'waiting')
  }

  private async onExit(projectPath: string, agentId: string, sessionId: string, code: number): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (l) {
      if (l.backupTimer) clearInterval(l.backupTimer)
      if (l.compacting) clearTimeout(l.compacting.timer)
      this.live.delete(id)
    }
    this.releaseLocks(id)
    await this.backup(projectPath, agentId, sessionId, true, l?.state.cwd).catch(() => undefined)
    if (await this.anyTranscript(projectPath, sessionId)) {
      await workspace.upsertSession(projectPath, { id: sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
    } else {
      // Nothing was ever said (e.g. closed at the login screen) — there is nothing to resume.
      await workspace
        .mutateSessions(projectPath, (f) => {
          f.sessions = f.sessions.filter((s) => s.id !== sessionId)
        })
        .catch(() => undefined)
    }
    emit({ type: 'session-exit', projectPath, agentId, sessionId, exitCode: code })
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
    emit({
      type: 'session-status',
      state: { projectPath, agentId, cwd: l?.state.cwd ?? projectPath, sessionId, status: 'stopped', startedAt: l?.state.startedAt ?? '', launchSignature: '', unseen: false }
    })
    workspace.scheduleRefresh()
  }

  /** Copies the live transcript into <project>/.hive/sessions so it survives Claude Code's own cleanup. */
  private async backup(projectPath: string, agentId: string, sessionId: string, force = false, cwd?: string): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    const folder = l?.state.cwd ?? cwd ?? projectPath
    const src = await claudeCode.transcriptPath(folder, sessionId)
    if (!src) return
    const s = await stat(src).catch(() => null)
    if (!s) return
    const mtime = s.mtimeMs
    if (!force && l && l.transcriptMtime === mtime) return
    if (l) l.transcriptMtime = mtime
    // Fallback if hooks never arrive: a transcript means the session is up.
    if (l && l.state.status === 'starting') {
      l.state.status = 'ready'
      this.emitState(l.state)
    }
    emit({ type: 'usage-changed', projectPath, sessionId })
    if (l?.compacting) {
      // Fallback if the SessionStart(compact) hook never arrives: a new compaction in the transcript.
      const u = await this.usageFor(src, sessionId)
      if (u && u.compactions.length > l.compacting.before) this.finishCompacting(liveId(projectPath, agentId))
    }
    if (l?.defaultModel) {
      const usage = await this.usageFor(src, sessionId)
      if (usage?.model) agentService.observeDefaultModel(usage.model)
    }
    if (!config.settings.sessions.backupTranscripts) return
    // A transcript can be many MB: while the agent works, copy it at most once a minute. The end of
    // each turn (Stop) and the session's exit force a copy, so nothing is left out.
    if (!force && l?.lastBackupAt && Date.now() - l.lastBackupAt < BACKUP_INTERVAL_MS) return
    if (l) l.lastBackupAt = Date.now()
    const dest = this.backupPath(projectPath, sessionId)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest).catch((e) => log.warn('backup failed', e))
  }

  private emitState(state: LiveSessionState): void {
    emit({ type: 'session-status', state: { ...state } })
  }

  private windowAttentive(): boolean {
    const w = this.getWindow()
    return !!w && w.isVisible() && w.isFocused() && !w.isMinimized()
  }

  private findBySession(sessionId: unknown): [string, LiveSession] | null {
    for (const e of this.live.entries()) if (e[1].state.sessionId === sessionId && !e[1].state.settingUp) return e
    return null
  }

  /** "hive" for a project with one agent, "hive · Agent 2" when it has several. */
  private label(st: LiveSessionState): string {
    const project = basename(st.projectPath)
    const count = workspace.info()?.projects.find((p) => p.path.toLowerCase() === st.projectPath.toLowerCase())?.agents.length ?? 1
    return count > 1 || st.agentId !== MAIN_AGENT ? `${project} · ${st.agentName ?? 'Agent'}` : project
  }

  /** Claude Code's status-line JSON: the session's model, effort and cost, and the plan's limits. */
  handleStatusLine(body: Record<string, any>): void {
    const usage = parsePlanUsage(body)
    if (usage) reportPlanUsage(usage)
    const l = this.findBySession(body.session_id)?.[1]
    if (!l) return
    const st = l.state
    const effort = typeof body.effort === 'string' ? body.effort : typeof body.effort?.level === 'string' ? body.effort.level : undefined
    const modelName = typeof body.model?.display_name === 'string' ? body.model.display_name : undefined
    const cost = Number(body.cost?.total_cost_usd)
    const costUsd = Number.isFinite(cost) ? cost : undefined
    if (effort === st.effort && modelName === st.modelName && costUsd === st.costUsd) return
    Object.assign(st, { effort, modelName, costUsd })
    this.emitState(st)
  }

  // -------------------------------------------------------------------------
  // File locks
  // -------------------------------------------------------------------------

  private lockMode(projectPath: string): FileLockMode {
    const p = workspace.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
    const own = p?.config.fileLocks
    return own && own !== 'inherit' ? own : config.settings.agents.fileLocks
  }

  /**
   * Claude Code's PreToolUse hook for file edits. The first agent to edit a file claims it; another
   * agent's edit of the same file is then blocked, sent to the user, or allowed with a warning,
   * depending on the lock mode. Claims are released when the holder's turn ends. Returns the hook's
   * reply, or null to let the edit go ahead as usual.
   */
  preToolUse(body: Record<string, any>): Record<string, unknown> | null {
    const found = this.findBySession(body.session_id)
    if (!found) return null
    const [id, l] = found
    const input = body.tool_input ?? {}
    const file: unknown = input.file_path ?? input.notebook_path
    if (typeof file !== 'string' || !file) return null
    const mode = this.lockMode(l.state.projectPath)
    if (mode === 'off') return null
    const abs = resolve(isAbsolute(file) ? file : join(typeof body.cwd === 'string' ? body.cwd : l.state.cwd, file))
    const key = abs.toLowerCase()
    const now = Date.now()
    const held = this.locks.get(key)
    const holder = held && held.liveId !== id ? this.live.get(held.liveId) : undefined
    if (holder && now - held!.at < LOCK_TTL_MS) {
      const rel = relative(holder.state.cwd, abs) || basename(abs)
      const who = holder.state.agentName ?? 'Another agent'
      const reason = `${who} is editing ${rel} right now (Hive file lock). Work on something else, or wait until ${who} has finished its task, then try again.`
      log.info(`Lock: ${l.state.agentName} → ${rel} held by ${who} (${mode})`)
      if (mode === 'warn') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Note: ${who} is also editing ${rel} right now. Check the file's current content before changing it, and keep your edit small.` } }
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode === 'ask' ? 'ask' : 'deny', permissionDecisionReason: reason } }
    }
    const fresh = !held || held.liveId !== id
    this.locks.set(key, { liveId: id, at: now, path: abs })
    if (fresh) this.publishLocks(id)
    return null
  }

  private releaseLocks(id: string): void {
    let changed = false
    for (const [k, v] of this.locks) {
      if (v.liveId === id) {
        this.locks.delete(k)
        changed = true
      }
    }
    if (changed) this.publishLocks(id)
  }

  private publishLocks(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    const files: string[] = []
    for (const v of this.locks.values()) if (v.liveId === id) files.push(relative(l.state.cwd, v.path).replace(/\\/g, '/'))
    l.state.lockedFiles = files.length ? files : undefined
    this.emitState(l.state)
  }

  /** Handles an HTTP hook call from Claude Code. */
  async handleHook(body: Record<string, any>): Promise<void> {
    const sessionId: string | undefined = body.session_id
    const event: string | undefined = body.hook_event_name
    if (!sessionId || !event) return
    const found = this.findBySession(sessionId)
    if (!found) return
    const [id, l] = found
    const st = l.state
    const label = this.label(st)
    const reported = hookMode(body.permission_mode)
    if (reported && reported !== st.permissionMode) {
      st.permissionMode = reported
      this.emitState(st)
    }
    let next: SessionStatus | null = null
    switch (event) {
      case 'SessionStart':
        next = st.status === 'starting' ? 'ready' : null
        break
      case 'PostCompact':
        if (l.compacting) this.finishCompacting(id)
        else if (st.status === 'working' && st.statusMessage?.startsWith('Compacting')) {
          next = 'ready'
          st.statusMessage = undefined
        }
        break
      case 'UserPromptSubmit':
        next = 'working'
        break
      case 'PostToolUse':
        next = st.status === 'waiting' || st.status === 'ready' || st.status === 'finished' ? 'working' : null
        break
      case 'Notification': {
        const kind: string = body.notification_type ?? body.type ?? ''
        const message: string = body.message ?? ''
        if (kind === 'idle_prompt') break
        if (kind === 'permission_prompt' || /permission|approve|waiting for your input/i.test(message)) {
          next = 'waiting'
          st.statusMessage = message || 'Waiting for your input'
          this.notify(st.projectPath, `${label} needs your input`, st.statusMessage, 'waiting')
        }
        break
      }
      case 'Stop':
        next = 'finished'
        st.statusMessage = undefined
        this.releaseLocks(id)
        await workspace.upsertSession(st.projectPath, { id: sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
        this.notify(st.projectPath, `${label} finished`, (body.last_assistant_message as string | undefined)?.slice(0, 180) ?? 'The agent has finished its task.', 'finished')
        void this.backup(st.projectPath, st.agentId, sessionId, true)
        break
      case 'PreCompact':
        if (l.compacting && !l.compacting.started) {
          clearTimeout(l.compacting.timer)
          l.compacting.started = true
          l.compacting.timer = setTimeout(() => this.finishCompacting(id), 10 * 60_000)
        }
        // Automatic compaction gets a heads-up; one Hive started is already shown as "Compacting…".
        if (!l.compacting) toast('info', `${label}: compacting conversation`, 'Claude Code is summarising the context to free up space.', undefined, st.projectPath)
        if (st.status !== 'working') {
          next = 'working'
          st.statusMessage = 'Compacting the conversation…'
        }
        break
      case 'SessionEnd':
        this.releaseLocks(id)
        next = 'stopped'
        break
    }
    if (next && next !== st.status) {
      st.status = next
      if (next === 'working' || next === 'ready') st.statusMessage = undefined
      if (next === 'finished' || next === 'waiting') st.unseen = !this.windowAttentive()
      this.emitState(st)
    }
  }

  private notify(projectPath: string, title: string, body: string, kind: 'finished' | 'waiting'): void {
    const n = config.settings.notifications
    void this.effective(projectPath)
      .then((eff) => {
        if (eff.chime) emit({ type: 'chime', projectPath })
      })
      .catch((e) => log.warn('chime: settings unavailable', e))
    if (!n.desktopNotifications) return
    if (kind === 'finished' && !n.notifyOnFinished) return
    if (kind === 'waiting' && !n.notifyOnWaiting) return
    if (n.onlyWhenUnfocused && this.windowAttentive()) return
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, silent: true, icon: notificationIcon() })
    // Each event gets its own notification, so several agents finishing together stack in Windows.
    // Keep a reference: a garbage-collected Notification no longer delivers its click.
    shownNotifications.add(note)
    if (shownNotifications.size > 50) shownNotifications.delete(shownNotifications.values().next().value!)
    note.on('click', () => {
      shownNotifications.delete(note)
      const w = this.getWindow()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
      emit({ type: 'menu-command', command: 'project.focus', args: [projectPath] })
    })
    note.show()
  }

  markSeen(projectPath: string): void {
    for (const st of this.projectStates(projectPath)) {
      if (st.unseen) {
        st.unseen = false
        this.emitState(st)
      }
    }
  }

  private async usageFor(path: string, sessionId: string): Promise<SessionUsage | null> {
    try {
      const s = await stat(path)
      const c = usageCache.get(path)
      if (c && c.mtime === s.mtimeMs && c.size === s.size) return c.usage
      const usage = parseTranscript(await readFile(path, 'utf8'), sessionId)
      usageCache.set(path, { mtime: s.mtimeMs, size: s.size, usage })
      return usage
    } catch {
      return null
    }
  }

  /**
   * Saves an image for the running session under <project>/.hive/images/<sessionId> and returns
   * its path, which is pasted into the terminal so the transcript records which image was sent.
   * Takes the clipboard image when no source file is given; returns null if there is none.
   */
  async saveImage(projectPath: string, sourceFile?: string, agentId: string = MAIN_AGENT): Promise<string | null> {
    projectPath = workspace.assertProject(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) throw new Error('No session is running for this agent.')
    let png: Buffer | null = null
    if (!sourceFile) {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return null
      png = Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())
    }
    const dir = join(projectPath, HIVE_DIR, 'images', l.state.sessionId)
    await mkdir(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    const ext = sourceFile ? extname(sourceFile).toLowerCase() : '.png'
    let dest = join(dir, `${stamp}${ext}`)
    for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stamp}-${i}${ext}`)
    if (png) await writeFile(dest, png)
    else await copyFile(sourceFile!, dest)
    return dest
  }

  /** Claude Code's transcript, or Hive's backup (active or archived) when Claude Code no longer has it. */
  async anyTranscript(projectPath: string, sessionId: string): Promise<string | null> {
    const t = await this.claudeTranscript(projectPath, sessionId)
    if (t) return t
    for (const archived of [false, true]) {
      const b = this.backupPath(projectPath, sessionId, archived)
      if (existsSync(b)) return b
    }
    return null
  }

  async usage(projectPath: string, sessionId: string): Promise<SessionUsage | null> {
    assertSessionId(sessionId)
    const p = await this.anyTranscript(projectPath, sessionId)
    return p ? this.usageFor(p, sessionId) : null
  }

  async list(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertProject(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    const external = await claudeCode.listSessions(projectPath)
    const ttl = config.settings.sessions.cacheTtl
    const items: SessionListItem[] = []
    const known = new Set(file.sessions.map((s) => s.id))
    for (const rec of file.sessions) {
      const transcript = await claudeCode.transcriptPath(rec.cwd ?? projectPath, rec.id)
      const hasBackup = existsSync(this.backupPath(projectPath, rec.id)) || existsSync(this.backupPath(projectPath, rec.id, true))
      const usage = await this.usage(projectPath, rec.id)
      items.push({
        ...rec,
        source: 'hive',
        title: usage?.title ?? null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript: !!transcript,
        hasBackup,
        usage,
        recache: usage ? recacheEstimate(usage, ttl) : null
      })
    }
    for (const ext of external) {
      if (known.has(ext.id)) continue
      const usage = await this.usageFor(ext.transcriptPath, ext.id)
      if (!usage || usage.requests === 0) continue
      items.push({
        id: ext.id,
        source: 'external',
        title: usage.title,
        lastActivity: usage.lastActivity ?? ext.modified,
        hasTranscript: true,
        hasBackup: false,
        usage,
        recache: recacheEstimate(usage, ttl)
      })
    }
    return items.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  }

  async archive(projectPath: string, sessionId: string, archived: boolean): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    if (archived && this.projectStates(projectPath).some((s) => s.sessionId === sessionId)) throw new Error('Stop the session before archiving it.')
    const active = this.backupPath(projectPath, sessionId)
    const arch = this.backupPath(projectPath, sessionId, true)
    await mkdir(dirname(arch), { recursive: true })
    await mkdir(dirname(active), { recursive: true })
    if (archived) {
      // Always take a fresh copy from Claude Code so the archive is complete.
      const src = await this.claudeTranscript(projectPath, sessionId)
      if (src) {
        await copyFile(src, arch)
        // The fresh copy is the archive; the older backup would only overwrite it.
        await rm(active, { force: true })
      } else if (existsSync(active)) await rename(active, arch)
    } else if (existsSync(arch)) {
      await rename(arch, active)
    }
    await workspace.upsertSession(projectPath, { id: sessionId, archived })
  }

  async rename(projectPath: string, sessionId: string, name: string): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    assertSessionId(sessionId)
    await workspace.upsertSession(projectPath, { id: sessionId, name: name.trim() })
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    if (live) {
      live.sessionName = name.trim()
      this.emitState(live)
    }
  }

  async adopt(projectPath: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    assertSessionId(sessionId)
    const usage = await this.usage(projectPath, sessionId)
    await workspace.upsertSession(projectPath, {
      id: sessionId,
      name: usage?.title ?? `Adopted session ${sessionId.slice(0, 8)}`,
      createdAt: usage?.firstActivity ?? new Date().toISOString(),
      lastActiveAt: usage?.lastActivity ?? new Date().toISOString()
    })
    const src = await claudeCode.transcriptPath(projectPath, sessionId)
    if (src && config.settings.sessions.backupTranscripts) await copyFile(src, this.backupPath(projectPath, sessionId)).catch(() => undefined)
  }
}

export const sessions = new SessionManager()
