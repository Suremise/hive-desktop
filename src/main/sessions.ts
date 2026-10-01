import { randomUUID, randomBytes } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { BrowserWindow, Notification, clipboard, shell } from 'electron'
import { ASSISTANT_NAME } from '../shared/assistant'
import { assistantTools } from '../shared/assistantTools'
import { HIVE_DIR, agentPtyKey, assertSessionId, isSessionId, projectAgents, resumeRecord } from '../shared/defaults'
import { agentLaunchSettings, isProviderEnabled, modeAllowed, permissionLabel, providerDescriptor, providerSettings } from '../shared/providers'
import type {
  AgentDef,
  AgentInfo,
  EffortLevel,
  FileLockMode,
  KeptUsage,
  LiveSessionState,
  McpServerDef,
  PermissionMode,
  ProjectConfig,
  ProviderId,
  SessionListItem,
  SessionRecord,
  SessionStatus,
  SessionUsage
} from '../shared/types'
import { provider as providerAdapter, allProviders } from './providers'
import { recacheEstimate } from './providers/common'
import { estimateCost } from '../shared/prices'
import { withDayCosts } from '../shared/usageDays'
import type { LaunchSkill, ProviderAdapter, UsageParser } from './providers/types'
import { providerService } from './providerService'
import { config } from './config'
import { emit, emitTo, toast } from './events'
import { hashDir, hashText, splitArgs } from './fsutil'
import { createLogger } from './logger'
import { listMcp, toLaunchDef } from './mcp'
import { childEnv, killPty, spawnPty, writePty } from './ptyHost'
import { hiveSkills } from './skills'
import { notificationIcon } from './paths'
import { reportPlanUsage } from './planUsage'
import { inWorkspace, workspace, workspaceFor, workspaceOf } from './workspace'

const log = createLogger('sessions')

export interface HiveMcpProvider {
  (projectPath: string): McpServerDef | null
}

/** Minimum time between transcript backups while a turn is running. */
const BACKUP_INTERVAL_MS = 60_000
/** Minimum time between cost estimates while a turn is running (each parses the whole transcript). */
const COST_INTERVAL_MS = 30_000

interface LiveSession {
  state: LiveSessionState
  adapter: ProviderAdapter
  transcriptMtime: number
  /** Where the provider writes this session's transcript, once known (from a hook, or found by id). */
  transcriptPath?: string
  backupTimer?: NodeJS.Timeout
  /** When the transcript was last copied to .hive/sessions (see BACKUP_INTERVAL_MS). */
  lastBackupAt?: number
  /** Launched without a model choice, so its transcript shows the CLI's default model. */
  defaultModel: boolean
  /** Set while a Hive-requested compaction runs: compactions in the transcript before it, and a safety timer. */
  compacting?: { before: number; timer: NodeJS.Timeout; started: boolean; output: string }
  /** The user stopped it (e.g. during its worktree setup), so an early exit isn't reported as a failure. */
  stopRequested?: boolean
  /** Terminal output tail, to read the permission mode from the CLI's footer. */
  modeTail: string
  /** The mode it was launched in. */
  launchMode: PermissionMode | null
  /** The mode the settings asked for when it launched, or when the user last applied a settings change to it. */
  configuredMode: PermissionMode | null
  /** A settings change already offered to it, so the offer isn't repeated on every refresh. */
  offeredMode?: PermissionMode | null
  /** Launch in this mode instead of the configured one (Restart in mode). */
  modeOverride?: PermissionMode
  /** The session's display name, for recording it once the provider reports the session id. */
  name: string
  /** Bytes of the transcript already read for live details (providers with transcriptDetails). */
  detailsOffset?: number
  /** When the cost estimate was last worked out (providers that don't report cost). */
  costAt?: number
  /** Terminal output while a mode switch waits for the CLI's confirmation. */
  switchTail?: string
  /** The first task, for the launch's command line (cleared once launched). */
  initialPrompt?: string
  /** The CLI asked something before it started (e.g. whether to trust the folder): shown as waiting for the user. */
  askedAtStart?: boolean
}

export interface EffectiveSettings {
  provider: ProviderId
  skills: LaunchSkill[]
  skillHashes: Record<string, string>
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  chime: boolean
}

/** Files read once for a whole session list (instead of once per session). */
/** An agent start in progress, before (or while) its process spawns. */
interface PendingStart {
  projectPath: string
  /** The session being resumed, if any. */
  resumeId?: string
  /** Set by a stop, workspace close or quit: the start gives up at its next check. */
  cancelled: boolean
  /** Settles when the start has finished or given up. */
  done: Promise<unknown>
}

interface ListContext {
  records: SessionRecord[]
  cfg: ProjectConfig
}

/** A claim an agent holds on a file it edited, so another agent in the same folder doesn't edit it at the same time. */
interface FileLock {
  liveId: string
  at: number
  path: string
}

/** A lock is released when its agent's turn ends; this covers an agent that stalls without ending it. */
const LOCK_TTL_MS = 15 * 60_000

/**
 * Each transcript's usage, with the parser that read it: transcripts only grow, so a running session's is read
 * from where the last read stopped (a long session's transcript can be 100 MB) rather than from the start.
 */
interface UsageEntry {
  parser: UsageParser
  sessionId: string
  provider: ProviderId
  /** Bytes read so far, at a line boundary. */
  offset: number
  size: number
  mtime: number
  /** Worked out from the parser (with costs); null until asked for again after a change. */
  usage: SessionUsage | null
}
const usageCache = new Map<string, UsageEntry>()

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

/** A new session's automatic name: "<project> · <date>", with the agent's name when the project has several. */
function autoName(projectPath: string, agent: Pick<AgentDef, 'name'>, count: number): string {
  return `${basename(projectPath)}${count > 1 ? ` · ${agent.name}` : ''} · ${new Date().toLocaleString()}`
}

const liveId = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** The provider a session record belongs to (records from before providers are Claude Code's). */
const recordProvider = (rec: Pick<SessionRecord, 'agent'> | undefined): ProviderId => rec?.agent || 'claude-code'

class SessionManager {
  private live = new Map<string, LiveSession>()
  /** runId → liveId: hooks name their launch, so they reach the right agent even before the session id is known. */
  private runs = new Map<string, string>()
  private locks = new Map<string, FileLock>()
  /** "Ask me" locks for CLIs without an approval reply: `<liveId>|<path>` the user allowed, or was asked about. */
  private lockAllowed = new Set<string>()
  private lockAsked = new Set<string>()
  readonly hookToken = randomBytes(24).toString('hex')
  hookUrl = ''
  apiEnv: () => Record<string, string> = () => ({})
  hiveMcp: HiveMcpProvider = () => null
  /** Hive's guidance for agents (the hive MCP server's instructions), for providers that need it at launch. */
  hiveGuidance: (projectPath: string) => Promise<string> = async () => ''
  /** Before each Hive Assistant launch (its workspace gets a new Agent API token). */
  onAssistantLaunch: (projectPath: string) => Promise<void> = async () => undefined
  /** The user sent the Hive Assistant a message (a new turn). */
  onAssistantPrompt: (projectPath: string) => void = () => undefined
  /** When the user last typed in each terminal (by pty key), so nothing else types over them. */
  private userInput = new Map<string, number>()
  /** The Hive Assistant's instructions for a launch (who it is, and its persona's), and the persona's name. */
  assistantInstructions: (projectPath: string, agent: AgentDef) => Promise<{ text: string; persona: string }> = async () => ({ text: '', persona: '' })
  /** The project's newest handover in the shared notes (relative path and modified time), or null. */
  latestHandover: (projectPath: string) => Promise<{ relPath: string; modified: string } | null> = async () => null
  private exitWaiters = new Map<string, () => void>()
  /**
   * Agents being started (by liveId), so two starts at once can't both get through, and so stopping the
   * agent, closing its workspace or quitting can cancel a start that hasn't spawned its process yet.
   */
  private starting = new Map<string, PendingStart>()
  /** Hive is quitting: no new agent starts. */
  private shuttingDown = false
  /** The window showing a project (several windows each show one workspace). */
  private getWindow: (projectPath?: string) => BrowserWindow | null = () => null

  setWindowProvider(fn: (projectPath?: string) => BrowserWindow | null): void {
    this.getWindow = fn
  }

  key(projectPath: string, agentId: string): string {
    return agentPtyKey(projectPath, agentId)
  }

  /** The agent a call that names none means: the project's only agent. */
  async soleAgent(projectPath: string): Promise<string> {
    const agents = projectAgents(await workspace.projectConfig(projectPath))
    if (agents.length === 1) return agents[0].id
    throw new Error(agents.length ? 'This project has several agents: choose which one.' : 'This project has no agents yet. Add one first.')
  }

  liveCount(provider?: ProviderId): number {
    return provider ? [...this.live.values()].filter((l) => l.state.provider === provider).length : this.live.size
  }

  liveStates(): LiveSessionState[] {
    return [...this.live.values()].map((l) => l.state)
  }

  /** One agent's session; without agentId, the project's first running agent's. */
  liveFor(projectPath: string, agentId?: string): LiveSessionState | null {
    if (agentId) return this.live.get(liveId(projectPath, agentId))?.state ?? null
    return this.projectStates(projectPath)[0] ?? null
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
    return inWorkspace(workspaceOf(projectPath), () => this.effectiveHere(projectPath, agent))
  }

  private async effectiveHere(projectPath: string, agent?: AgentDef): Promise<EffectiveSettings> {
    const s = config.settings
    const pc = await workspace.projectConfig(projectPath)
    // Every Hive skill reaches every agent: there are no skill switches (the old enabled/disabled lists are ignored).
    const skills: LaunchSkill[] = []
    const skillHashes: Record<string, string> = {}
    for (const sk of await hiveSkills()) {
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
    // The Assistant looks after the workspace with Hive's own tools: no skills, and not the projects' MCP servers.
    if (workspace.isAssistantHome(projectPath)) {
      skills.length = 0
      for (const k of Object.keys(skillHashes)) delete skillHashes[k]
      for (const k of Object.keys(mcpServers)) if (k !== 'hive') delete mcpServers[k]
    }

    const l = agentLaunchSettings(agent ?? projectAgents(pc)[0], pc, s)
    const extraArgs = l.extraArgs.flatMap((a) => splitArgs(a))
    const chime = pc.chime === 'inherit' ? s.notifications.chimeEnabled : pc.chime === 'on'
    return { provider: l.provider, skills, skillHashes, mcpServers, model: l.model, effort: l.effort, permissionMode: l.permissionMode, extraArgs, chime }
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
    const openIds = new Set(this.projectStates(projectPath).map((s) => s.sessionId).filter(Boolean))
    const ids = new Set(projectAgents(cfg).map((a) => a.id))
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
      const provider = agentLaunchSettings(a, cfg, config.settings).provider
      // The Assistant's sessions ran in the workspace folder, not its home.
      const folder = workspace.isAssistantHome(projectPath) ? (workspaceOf(projectPath).path ?? projectPath) : projectPath
      const r = l ? null : resumeRecord(folder, a, records.filter((x) => recordProvider(x) === provider), openIds, ids)
      agents.push({ ...a, live: l?.state ?? null, restartNeeded, resume: r && { id: r.id, name: r.name, lastActiveAt: r.lastActiveAt } })
    }
    const primary = agents.find((a) => a.live)
    return { live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, agents }
  }

  private backupPath(projectPath: string, sessionId: string, archived = false): string {
    return join(projectPath, HIVE_DIR, archived ? 'archive' : 'sessions', `${assertSessionId(sessionId)}.jsonl`)
  }

  /** Works out usage again (e.g. after price changes, so estimates are recomputed); what was read is kept. */
  clearUsageCache(): void {
    for (const c of usageCache.values()) c.usage = null
  }

  /**
   * Where a session's transcript is: the provider knows (by folder, or by the path it reported), and a
   * worktree agent's sessions ran in its worktree. The session's own record comes first.
   */
  async providerTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<{ path: string; provider: ProviderId } | null> {
    const rec = (ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions).find((s) => s.id === sessionId)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    const ids = rec ? [recordProvider(rec)] : live ? [live.provider] : allProviders().map((p) => p.id)
    const cfg = ctx?.cfg ?? (await workspace.projectConfig(projectPath))
    const folders = [rec?.cwd, projectPath, ...projectAgents(cfg).map((a) => a.worktree?.path)].filter((f): f is string => !!f)
    const unique = [...new Map(folders.map((f) => [f.toLowerCase(), f])).values()]
    for (const id of ids) {
      let adapter: ProviderAdapter
      try {
        adapter = providerAdapter(id)
      } catch {
        continue
      }
      for (const f of unique) {
        const t = await adapter.transcriptPath(f, sessionId, rec?.transcriptPath)
        if (t) return { path: t, provider: id }
      }
    }
    return null
  }

  async start(projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string }): Promise<LiveSessionState> {
    this.assertStartsAllowed(projectPath)
    projectPath = workspace.assertSessionHost(projectPath)
    if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
    const agentId = opts.agentId || (await this.soleAgent(projectPath))
    const id = liveId(projectPath, agentId)
    // Checked and reserved before anything is awaited: a double click, or the UI and the Agent API at
    // once, must not start the agent twice (the second start would orphan the first process).
    if (this.live.has(id) || this.starting.has(id)) throw new Error('This agent is already running or starting. Stop it first.')
    // Two terminals on one conversation would both append to its transcript.
    if (opts.resumeId && [...this.starting.values()].some((p) => p.resumeId === opts.resumeId)) throw new Error('This conversation is already being opened in another agent.')
    const pending: PendingStart = { projectPath, resumeId: opts.resumeId, cancelled: false, done: Promise.resolve() }
    this.starting.set(id, pending)
    const run = this.startReserved(projectPath, agentId, id, opts)
    pending.done = run.catch(() => undefined)
    try {
      return await run
    } finally {
      this.starting.delete(id)
    }
  }

  /** Refuses a start while Hive quits, or while the project's workspace is closing or switching. */
  private assertStartsAllowed(projectPath: string): void {
    if (this.shuttingDown || workspaceFor(projectPath)?.closing) throw new Error("Hive is stopping this workspace's agents, so none can start now.")
  }

  /** Projects with an agent starting (not yet in liveStates). */
  pendingStarts(): string[] {
    return [...this.starting.values()].map((p) => p.projectPath)
  }

  /** Throws if the start was cancelled while it awaited something (the agent stopped, its workspace closed). */
  private assertStarting(id: string): void {
    if (this.starting.get(id)?.cancelled) throw new Error('The agent was stopped before it had started.')
  }

  private async startReserved(projectPath: string, agentId: string, id: string, opts: { resumeId?: string; name?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string }): Promise<LiveSessionState> {
    const { agent, cfg, count } = await this.agentDef(projectPath, agentId)
    this.assertStarting(id)
    if (this.live.has(id)) throw new Error(count > 1 ? `${agent.name} is already running. Stop it first.` : 'A session is already running for this project. Stop it first.')
    const holder = opts.resumeId ? this.projectStates(projectPath).find((s) => s.sessionId === opts.resumeId) : undefined
    if (holder) throw new Error(`This conversation is already open in ${holder.agentName ?? 'another agent'}. An agent can only resume a session no other agent is running.`)
    const providerId = agentLaunchSettings(agent, cfg, config.settings).provider
    const adapter = providerAdapter(providerId)
    const name = adapter.descriptor.name
    if (!isProviderEnabled(config.settings, providerId)) throw new Error(`${name} is turned off. Turn it on in Settings → Providers to run ${agent.name}.`)
    const info = providerService.info(providerId)
    if (!info.found || !info.path) throw new Error(`${name} is required to run ${agent.name}. Install it from Help → Agent Setup.`)
    await workspace.ensureProject(projectPath)
    // The Assistant works in the workspace folder, where it can read every project.
    const assistant = workspace.isAssistantHome(projectPath)
    const cwd = assistant ? workspaceOf(projectPath).path! : (agent.worktree?.path ?? projectPath)
    if (!existsSync(cwd)) throw new Error(`${agent.name}'s worktree folder is missing: ${cwd}. Remove the agent, or restore the folder with git worktree.`)

    const existing = opts.resumeId ? (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === opts.resumeId) : undefined
    this.assertStarting(id)
    if (existing?.archived) throw new Error('This session is archived. Unarchive it before resuming.')
    if (opts.resumeId && existing && recordProvider(existing) !== providerId) {
      throw new Error(`This conversation ran in ${providerDescriptor(recordProvider(existing)).name}, and ${agent.name} runs ${name}. Conversations can't move between providers: continue it with a handover instead.`)
    }
    if (opts.resumeId && existing && (existing.cwd ?? projectPath).toLowerCase() !== cwd.toLowerCase()) {
      throw new Error(`This session ran in ${existing.cwd ?? projectPath}. Resume it with the agent that works in that folder.`)
    }
    // Providers that choose their own session id report it once started (see the start hook).
    const sessionId = opts.resumeId ?? (adapter.descriptor.capabilities.fixedSessionId ? randomUUID() : '')

    const persona = assistant ? (await this.assistantInstructions(projectPath, agent).catch(() => null))?.persona : undefined
    const sessionName = opts.name?.trim() || existing?.name || (assistant ? `${ASSISTANT_NAME}${persona ? ` · ${persona}` : ''} · ${new Date().toLocaleString()}` : autoName(projectPath, agent, count))
    const key = this.key(projectPath, agentId)
    const runId = randomBytes(12).toString('hex')
    const state: LiveSessionState = {
      provider: providerId,
      runId,
      projectPath,
      agentId,
      agentName: agent.name,
      cwd,
      sessionId,
      sessionName,
      status: 'starting',
      startedAt: new Date().toISOString(),
      launchSignature: '',
      unseen: false
    }
    this.live.set(id, { state, adapter, transcriptMtime: 0, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, modeOverride: opts.permissionMode, name: sessionName, transcriptPath: existing?.transcriptPath, initialPrompt: opts.prompt?.trim() || undefined })
    this.runs.set(runId, id)

    const setup = cfg.worktreeSetup.trim()
    if (agent.worktree && agent.needsSetup && setup && !opts.skipSetup) {
      // The worktree's setup command runs in the agent's terminal first, then the agent starts there.
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
          onExit: (code) => void this.afterSetup(projectPath, agentId, code, { sessionId, name: sessionName, resume: !!opts.resumeId })
        })
      } catch (e) {
        this.forget(id)
        throw e
      }
      this.emitState(state)
      workspaceOf(projectPath).scheduleRefresh()
      return state
    }
    try {
      await this.launch(projectPath, agent, { sessionId, name: sessionName, resume: !!opts.resumeId })
    } catch (e) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...state, status: 'stopped' } })
      throw e
    }
    return state
  }

  private forget(id: string): void {
    const l = this.live.get(id)
    if (l) this.runs.delete(l.state.runId)
    this.live.delete(id)
    // A start given up before its process spawned has no exit to wait for.
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
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
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', settingUp: false } })
      if (agent && !l.stopRequested) toast('error', `${basename(projectPath)} · ${agent.name}: setup failed`, `The setup command exited with code ${code}. Its output is in the agent's terminal. Fix it and start the agent again, or start it without setup.`, undefined, projectPath)
      workspaceOf(projectPath).scheduleRefresh()
      return
    }
    await workspace.updateAgent(projectPath, agentId, { needsSetup: false }).catch(() => undefined)
    l.state.settingUp = false
    l.state.statusMessage = undefined
    try {
      await this.launch(projectPath, { ...agent, needsSetup: false }, launch)
    } catch (e) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped' } })
      toast('error', `Could not start ${agent.name}`, (e as Error).message, undefined, projectPath)
    }
  }

  /** Starts the agent's CLI for an agent whose live entry already exists. */
  private async launch(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agent.id)
    const l = this.live.get(id)!
    const { state, adapter } = l
    const cwd = state.cwd
    const { sessionId } = opts
    const info = providerService.info(adapter.id)
    if (!info.path) throw new Error(`${adapter.descriptor.name} is required to run sessions.`)

    let resume = opts.resume
    if (resume) {
      const recorded = l.transcriptPath
      if (!(await adapter.transcriptPath(cwd, sessionId, recorded))) {
        // The provider has deleted it: put Hive's backup back where the provider looks for it.
        const backup = this.backupPath(projectPath, sessionId)
        const dest = adapter.restorePath(cwd, sessionId, recorded)
        if (dest && existsSync(backup)) {
          await mkdir(dirname(dest), { recursive: true })
          await copyFile(backup, dest)
          log.info(`Restored transcript for ${sessionId} from Hive backup`)
        }
      }
      // A session restarted before anything was typed has no transcript: start it fresh under the same id
      // where the provider allows choosing it, else as a new session.
      resume = !!(await adapter.transcriptPath(cwd, sessionId, recorded))
      if (!resume) {
        log.info(`No transcript for ${sessionId}; starting it fresh instead of resuming`)
        if (!adapter.descriptor.capabilities.fixedSessionId) state.sessionId = ''
      }
    }

    const eff = await this.effective(projectPath, agent)
    l.configuredMode = eff.permissionMode
    let mode = eff.permissionMode
    if (l.modeOverride && modeAllowed(adapter.id, l.modeOverride, config.settings)) mode = l.modeOverride
    l.launchMode = mode
    state.permissionMode = mode ?? undefined
    const ctx = {
      projectPath,
      agentId: agent.id,
      executable: info.path,
      cwd,
      workspacePath: workspaceOf(projectPath).path!,
      runId: state.runId,
      sessionId: state.sessionId,
      resume,
      name: opts.name,
      skills: eff.skills,
      mcpServers: eff.mcpServers,
      model: eff.model,
      effort: eff.effort,
      permissionMode: mode,
      extraArgs: eff.extraArgs,
      hookUrl: `${this.hookUrl}?run=${state.runId}`,
      guidance: await this.hiveGuidance(projectPath).catch(() => ''),
      instructions: workspace.isAssistantHome(projectPath) ? (await this.assistantInstructions(projectPath, agent).catch(() => null))?.text : undefined,
      trustedHiveTools: workspace.isAssistantHome(projectPath) ? assistantTools(config.settings.assistant?.control) : undefined,
      initialPrompt: l.initialPrompt,
      allowBackgroundSessions: providerSettings(config.settings, adapter.id).allowBackgroundSessions,
      env: childEnv({
        HIVE_HOOK_TOKEN: this.hookToken,
        HIVE_PROJECT: basename(projectPath),
        HIVE_PROJECT_PATH: projectPath,
        HIVE_WORKSPACE: workspaceOf(projectPath).path!,
        HIVE_RUN_ID: state.runId,
        ...(state.sessionId ? { HIVE_SESSION_ID: state.sessionId } : {}),
        HIVE_AGENT: agent.name,
        HIVE_PROVIDER: adapter.id,
        // Not for the Assistant: it reaches the API through its hive tools, with its own token.
        ...(workspace.isAssistantHome(projectPath) ? {} : this.apiEnv())
      })
    }
    await adapter.prepareLaunch(ctx)
    if (workspace.isAssistantHome(projectPath)) await this.onAssistantLaunch(projectPath)
    // Checked after the last await, just before spawning: stopped, its workspace closed or switched, or the
    // provider turned off while this launch was being prepared, it must not start a process.
    if (l.stopRequested || this.live.get(id) !== l || this.starting.get(id)?.cancelled || !workspaceFor(projectPath) || this.shuttingDown || workspaceFor(projectPath)?.closing) throw new Error('The agent was stopped before it had started.')
    if (!isProviderEnabled(config.settings, adapter.id)) throw new Error(`${adapter.descriptor.name} was turned off while ${agent.name} was starting.`)
    const cmd = adapter.buildCommand(info.path, ctx)
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
        if (l.switchTail !== undefined) l.switchTail = (l.switchTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
        this.watchCompactOutput(id, data)
        this.watchModeOutput(id, data)
        this.watchReadyOutput(id, data)
      },
      onExit: (code, output) => void this.onExit(projectPath, agent.id, state.runId, code, output)
    })
    state.pid = proc.pid
    l.initialPrompt = undefined
    l.backupTimer = setInterval(() => void this.backup(projectPath, agent.id), 5000)
    if (state.sessionId) await this.recordSession(projectPath, agent, l)

    // Launched as active: starting a session implies working on the project.
    if (!workspace.isAssistantHome(projectPath) && !workspaceOf(projectPath).activeNames().includes(basename(projectPath))) workspace.setActive(projectPath, true)
    this.emitState(state)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /** Records the running session in sessions.json and as the agent's session to resume. */
  private async recordSession(projectPath: string, agent: Pick<AgentDef, 'id' | 'worktree'>, l: LiveSession): Promise<void> {
    const { state } = l
    const sessionId = state.sessionId
    // Images pasted before the provider named the session wait in the launch's folder: move them to the session's.
    const early = join(projectPath, HIVE_DIR, 'images', `run-${state.runId}`)
    if (existsSync(early)) {
      const dest = join(projectPath, HIVE_DIR, 'images', sessionId)
      await mkdir(dest, { recursive: true }).catch(() => undefined)
      for (const f of await readdir(early).catch(() => [] as string[])) await rename(join(early, f), join(dest, f)).catch((e) => log.warn(`Could not move ${f}`, e))
      await rm(early, { recursive: true, force: true }).catch(() => undefined)
    }
    await workspace.upsertSession(projectPath, {
      id: sessionId,
      agent: state.provider,
      name: l.name,
      lastActiveAt: new Date().toISOString(),
      // The agent running it now; a session can move between agents that share a folder.
      agentId: agent.id,
      // Providers that choose their own ids file transcripts by date, not folder: remember where.
      ...(l.transcriptPath && !l.adapter.descriptor.capabilities.fixedSessionId ? { transcriptPath: l.transcriptPath } : {}),
      // Where it ran, when not the project folder (a worktree, or the Assistant's workspace folder).
      ...(state.cwd.toLowerCase() !== projectPath.toLowerCase() ? { cwd: state.cwd } : {}),
      ...(agent.worktree ? { branch: agent.worktree.branch } : {})
    })
    await workspace.updateAgent(projectPath, agent.id, { lastSessionId: sessionId }).catch(() => undefined)
    for (const other of projectAgents(await workspace.projectConfig(projectPath))) {
      if (other.id !== agent.id && other.lastSessionId === sessionId) await workspace.updateAgent(projectPath, other.id, { lastSessionId: undefined }).catch(() => undefined)
    }
  }

  /** Stops one agent's session, or every agent of the project when agentId is omitted. */
  stop(projectPath: string, agentId?: string): void {
    const agents = agentId ? [agentId] : this.projectStates(projectPath).map((s) => s.agentId)
    for (const a of agents) {
      const l = this.live.get(liveId(projectPath, a))
      if (l) l.stopRequested = true
      killPty(this.key(projectPath, a))
    }
    // Starts still being prepared (no process yet) give up at their next check.
    for (const [k, p] of this.starting) if (p.projectPath.toLowerCase() === projectPath.toLowerCase() && (!agentId || k === liveId(projectPath, agentId))) p.cancelled = true
  }

  /** Stops every running agent of one provider (e.g. when the provider is turned off). */
  stopProvider(provider: ProviderId): void {
    for (const l of [...this.live.values()]) if (l.state.provider === provider) this.stop(l.state.projectPath, l.state.agentId)
  }

  stopAll(): void {
    for (const l of this.live.values()) killPty(this.key(l.state.projectPath, l.state.agentId))
  }

  /**
   * Stops every session and waits until each has been through onExit (final transcript backup,
   * session list update), or until the timeout, so quitting never loses the last messages or hangs.
   */
  async stopAllAndWait(timeoutMs = 3000): Promise<void> {
    this.shuttingDown = true
    return this.stopWhereAndWait(() => true, timeoutMs)
  }

  /**
   * Stops the sessions matching `which` (e.g. one window's workspace) and waits for them as stopAllAndWait
   * does. Starts in progress for matching projects are cancelled and waited for too.
   */
  async stopWhereAndWait(which: (s: { projectPath: string }) => boolean, timeoutMs = 3000): Promise<void> {
    const pending = [...this.starting.values()].filter((p) => which(p))
    for (const p of pending) p.cancelled = true
    const chosen = [...this.live.entries()].filter(([, l]) => which(l.state))
    const waits = chosen.map(([k]) => k).map(
      (k) =>
        new Promise<void>((res) => {
          const previous = this.exitWaiters.get(k)
          this.exitWaiters.set(k, () => {
            previous?.()
            res()
          })
        })
    )
    for (const [, l] of chosen) {
      l.stopRequested = true
      killPty(this.key(l.state.projectPath, l.state.agentId))
    }
    await Promise.race([Promise.all([...waits, ...pending.map((p) => p.done)]), new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /**
   * Compacts a session's conversation now (the CLI's /compact), optionally with focus instructions.
   * Only while the agent is idle: while it works the command would queue or interrupt, and while it
   * waits on a prompt the text would land in that prompt. Ctrl+U first clears anything half-typed.
   */
  async compact(projectPath: string, focus?: string, agentId?: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    agentId ||= await this.soleAgent(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    if (l.compacting) throw new Error('This session is already compacting.')
    if (l.state.status !== 'ready' && l.state.status !== 'finished') {
      throw new Error(l.state.status === 'waiting' ? 'The agent is waiting for your answer. Compact after it has finished.' : 'The agent is busy. Compact once it has finished.')
    }
    const src = await this.liveTranscript(l)
    const before = src ? ((await this.usageFor(src, l.state.sessionId, l.state.provider))?.compactions.length ?? 0) : 0
    const key = this.key(projectPath, agentId)
    writePty(key, '\x15')
    await new Promise((r) => setTimeout(r, 150))
    const text = l.adapter.descriptor.capabilities.compactFocus ? (focus ?? '').replace(/\s+/g, ' ').trim() : ''
    // Written in one go, a long line counts as a paste, and pasted input is sent as a message even when
    // it starts with "/compact". So type the command on its own, then the focus in small pieces.
    writePty(key, '/compact')
    await new Promise((r) => setTimeout(r, 150))
    if (text) await typeInto(key, ` ${text}`)
    await new Promise((r) => setTimeout(r, 150))
    writePty(key, '\r')
    // PreCompact comes as soon as a compaction starts. If it doesn't (e.g. "not enough messages to
    // compact"), stop showing "Compacting…"; once started, allow up to 10 minutes.
    const timer = setTimeout(() => {
      if (!l.compacting?.started) this.finishCompacting(id)
    }, 20_000)
    l.compacting = { before, timer, started: false, output: '' }
    l.state.status = 'working'
    l.state.statusMessage = 'Compacting the conversation…'
    this.emitState(l.state)
  }

  /**
   * While a Hive-started compaction runs, watch the terminal for the CLI refusing or failing it,
   * which sends no hook ("Not enough messages to compact.").
   */
  private watchCompactOutput(id: string, data: string): void {
    const l = this.live.get(id)
    const c = l?.compacting
    if (!l || !c || !l.adapter.compactFailure) return
    // Terminal UIs draw spaces as cursor moves (ESC[1C), so control sequences become spaces. Keep a
    // short tail so a message split across chunks still matches.
    c.output = (c.output + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
    if (l.adapter.compactFailure.test(c.output)) this.finishCompacting(id)
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

  /** For CLIs whose first hook waits for the first prompt: the prompt showing in the terminal means ready. */
  private watchReadyOutput(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l || (l.state.status !== 'starting' && !l.askedAtStart) || (!l.adapter.readyOutput && !l.adapter.startupQuestion)) return
    l.modeTail = (l.modeTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).slice(-600)
    const text = l.modeTail.replace(/\s+/g, ' ')
    const asked = l.adapter.startupQuestion?.exec(text)
    if (l.state.status === 'starting' && asked) {
      l.askedAtStart = true
      l.modeTail = ''
      l.state.status = 'waiting'
      l.state.statusMessage = asked[0].includes('trust') ? 'Asks whether to trust this folder' : 'Asks something before it starts'
      this.notify(l.state.projectPath, `${this.label(l.state)} needs your input`, l.state.statusMessage, 'waiting')
      this.emitState(l.state)
    } else if (l.adapter.readyOutput?.test(text)) {
      this.startupAnswered(l)
      l.state.status = 'ready'
      this.emitState(l.state)
    }
  }

  /** The question before the start was answered: the agent is starting again. */
  private startupAnswered(l: LiveSession): void {
    if (!l.askedAtStart) return
    l.askedAtStart = false
    l.state.statusMessage = undefined
  }

  /** Reads the mode from the CLI's footer as it redraws, so a mode change in the terminal shows in Hive at once. */
  private watchModeOutput(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l?.adapter.footerMode) return
    l.modeTail = (l.modeTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).slice(-600)
    const mode = l.adapter.footerMode(l.modeTail)
    if (mode && mode !== l.state.permissionMode) {
      l.state.permissionMode = mode
      this.emitState(l.state)
    }
  }

  /**
   * Switches a running agent's permission mode the way you would by hand (Claude Code: Shift+Tab in its
   * terminal until the footer shows the mode). Not while it is asking a question (the keys could change
   * the answer). Modes the provider can't switch to live need a restart (restartInMode).
   */
  async setPermissionMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<{ ok: boolean; restart?: boolean; message?: string }> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    const st = l.state
    const p = st.provider
    const name = l.adapter.descriptor.name
    if (st.permissionMode === mode) return { ok: true }
    if (!modeAllowed(p, mode, config.settings)) throw new Error(`${permissionLabel(p, mode)} is turned off in Settings → ${name}.`)
    const how = l.adapter.descriptor.capabilities.liveModeSwitch
    if (how === 'none' || !l.adapter.canSwitchLive(mode, st.permissionMode, l.launchMode)) {
      return { ok: false, restart: true, message: `${permissionLabel(p, mode)} can't be switched to inside a running session. Restart the session in that mode; the conversation continues.` }
    }
    if (st.status === 'waiting') throw new Error('The agent is asking you something. Answer it first, then switch the mode.')
    if (st.status === 'starting') throw new Error('The session is still starting. Try again in a moment.')
    const key = this.key(projectPath, agentId)
    if (how === 'menu' && l.adapter.modeMenuKeys) {
      // The CLI's own menu (Codex: /permissions). Only while idle: typed into a working agent it would queue.
      if (st.status === 'working') throw new Error(`${name} is working. Switch the mode once it has finished.`)
      const before = st.permissionMode
      st.modeSwitching = mode
      l.switchTail = ''
      this.emitState(st)
      for (const step of l.adapter.modeMenuKeys(mode)) {
        writePty(key, step.keys)
        await new Promise((r) => setTimeout(r, step.waitMs ?? 60))
      }
      // The CLI records the new settings in its transcript at once: read them back rather than assume.
      const src = await this.liveTranscript(l)
      if (!src || !l.adapter.transcriptDetails) {
        // Nothing to read yet (no message sent): shown as asked; the first turn's settings correct it.
        st.modeSwitching = undefined
        st.permissionMode = mode
        this.emitState(st)
        return { ok: true }
      }
      for (let t = Date.now(); Date.now() - t < 12_000; ) {
        const s = await stat(src).catch(() => null)
        if (s) await this.readDetails(l, src, s.size)
        if (st.permissionMode === mode) break
        // The CLI's own confirmation in the terminal comes first (the transcript record a few seconds later).
        const said = l.adapter.modeFromOutput?.(l.switchTail ?? '')
        if (said) {
          st.permissionMode = said
          if (said === mode) break
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      l.switchTail = undefined
      st.modeSwitching = undefined
      if (st.permissionMode !== mode) {
        st.permissionMode = before
        this.emitState(st)
        log.warn(`${this.label(st)}: ${name} didn't confirm switching to ${mode}`)
        return { ok: false, message: `${name} didn't confirm switching to ${permissionLabel(p, mode)}. Check its terminal, or use /permissions there.` }
      }
      this.emitState(st)
      log.info(`${this.label(st)}: switched to ${mode} with the mode menu (confirmed)`)
      return { ok: true }
    }
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
    return { ok: false, restart: true, message: `${name} didn't offer ${permissionLabel(p, mode)} with Shift+Tab (it is now in ${st.permissionMode ? permissionLabel(p, st.permissionMode) : 'an unknown mode'}). Restart the session in that mode instead.` }
  }

  /** Waits for an agent's live status to satisfy `test`, or gives up after `ms`. */
  private async waitStatus(projectPath: string, agentId: string, test: (s: LiveSessionState | null) => boolean, ms: number): Promise<LiveSessionState | null> {
    const t = Date.now()
    for (;;) {
      const st = this.live.get(liveId(projectPath, agentId))?.state ?? null
      if (test(st)) return st
      if (Date.now() - t > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /** The user typed in a terminal (Hive's own typing goes through sendPrompt, not here). */
  noteUserInput(key: string, data: string): void {
    // xterm's own replies (focus in/out, cursor reports) aren't typing.
    if (data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1bO?./g, '')) this.userInput.set(key, Date.now())
  }

  /** When the user last typed in an agent's terminal (ms since the epoch), or 0. */
  userTypedAt(projectPath: string, agentId: string): number {
    return this.userInput.get(this.key(projectPath, agentId)) ?? 0
  }

  /** Files an agent holds a lock on (it is editing them this turn). */
  locksFor(projectPath: string, agentId: string): string[] {
    const id = liveId(projectPath, agentId)
    return [...this.locks.values()].filter((x) => x.liveId === id).map((x) => x.path)
  }

  /** Types a message into an agent's terminal and sends it. */
  async sendPrompt(projectPath: string, agentId: string, text: string): Promise<void> {
    const key = this.key(projectPath, agentId)
    writePty(key, '\x15')
    await new Promise((r) => setTimeout(r, 150))
    await typeInto(key, text.replace(/\s+/g, ' ').trim())
    await new Promise((r) => setTimeout(r, 300))
    writePty(key, '\r')
  }

  /**
   * Hands one agent's work over to another (any provider): the source writes a handover with Hive's
   * hive_create_handover tool, then the target starts and picks it up with hive_read_latest_handover.
   * Conversations can't move between providers; a handover carries the work instead.
   */
  async handOver(projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    if (fromAgentId === toAgentId) throw new Error('Choose another agent to hand the work over to.')
    if (!this.hiveMcp(projectPath)) throw new Error('Handing over needs Hive\'s tools in sessions: turn on "Provide Hive tools to sessions" in Settings → Agent API.')
    const { agent: to } = await this.agentDef(projectPath, toAgentId)
    const { agent: from } = await this.agentDef(projectPath, fromAgentId)
    const source = this.live.get(liveId(projectPath, fromAgentId))?.state ?? null
    const fromSession = source?.sessionId || from.lastSessionId || ''
    if (opts.handover) {
      if (!source) throw new Error(`${from.name} isn't running. Resume it to write a handover, or hand over the latest handover.`)
      if (source.status !== 'ready' && source.status !== 'finished') throw new Error(`${from.name} is busy. Hand over once it has finished.`)
      // Proof, not status: the target starts only once a handover newer than this one exists.
      const before = await this.latestHandover(projectPath)
      const isNew = (h: { relPath: string; modified: string } | null): boolean => !!h && (!before || h.relPath !== before.relPath || h.modified > before.modified)
      toast('info', `${from.name} is writing a handover`, `${to.name} continues from it when it's done.`, undefined, projectPath)
      await this.sendPrompt(
        projectPath,
        fromAgentId,
        `Please write a handover of this work with the hive_create_handover tool, so that another agent (${to.name}) can continue it: the goal, what is done, decisions made and why, the current state, open problems and the next steps. Then stop.`
      )
      const t0 = Date.now()
      let idleSince = 0
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        if (isNew(await this.latestHandover(projectPath).catch(() => null))) break
        const st = this.live.get(liveId(projectPath, fromAgentId))?.state
        if (!st) throw new Error(`${from.name} stopped before writing a handover.`)
        if (st.status === 'waiting') throw new Error(`${from.name} is asking you something before it can write the handover. Answer it, then hand over again without a new handover.`)
        // Finished without one (the file can land a moment after the turn ends): give it 20 seconds.
        idleSince = st.status === 'finished' || st.status === 'ready' ? idleSince || Date.now() : 0
        if (idleSince && Date.now() - idleSince > 20_000 && Date.now() - t0 > 30_000) throw new Error(`${from.name} finished without writing a handover. Ask it to write one, then hand over again without a new handover.`)
        if (Date.now() - t0 > 15 * 60_000) throw new Error(`${from.name} didn't write its handover in 15 minutes.`)
      }
    }
    // The target: started fresh when idle, or given the message in its running session.
    let target = this.live.get(liveId(projectPath, toAgentId))?.state ?? null
    if (target && target.status !== 'ready' && target.status !== 'finished') throw new Error(`${to.name} is busy. Hand over once it has finished.`)
    if (!target) {
      await this.start(projectPath, { agentId: toAgentId })
      // Minutes, not seconds: the CLI may first ask something (e.g. whether to trust the folder).
      target = await this.waitStatus(projectPath, toAgentId, (s) => !s || s.status === 'ready', 5 * 60_000).catch(() => null)
      if (!target) throw new Error(`${to.name} didn't become ready. Answer any question in its terminal, then hand over again without a new handover.`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    await this.sendPrompt(projectPath, toAgentId, `Read the latest handover for this project with the hive_read_latest_handover tool and continue the work from it. It was written by ${from.name}.`)
    // Link the sessions once the target's id is known (Codex reports it with the first prompt).
    const linked = await this.waitStatus(projectPath, toAgentId, (s) => !s || !!s.sessionId, 60_000).catch(() => null)
    if (linked?.sessionId && fromSession) await workspace.upsertSession(projectPath, { id: linked.sessionId, handedOverFrom: fromSession }).catch(() => undefined)
  }

  /** Turns a running agent's Plan mode on or off (providers where it is a toggle, e.g. Codex's Shift+Tab). */
  async setPlanMode(projectPath: string, agentId: string, on: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    if (!l.adapter.planToggleKey) throw new Error(`${l.adapter.descriptor.name} has no Plan mode toggle.`)
    if (l.state.status === 'waiting') throw new Error('The agent is asking you something. Answer it first.')
    if (!!l.state.planMode === on) return
    writePty(this.key(projectPath, agentId), l.adapter.planToggleKey)
    l.state.planMode = on
    this.emitState(l.state)
  }

  /** Stops the agent and resumes the same conversation in another permission mode. */
  async restartInMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) throw new Error('No session is running for this agent.')
    const { sessionId, sessionName } = l.state
    // A session nobody has typed in yet has no conversation (its transcript, if any, holds no messages,
    // and the CLI answers "no conversation found" to --resume): start a new one in the mode instead.
    const usage = sessionId ? await this.usage(projectPath, sessionId).catch(() => null) : null
    const resumable = !!sessionId && (usage?.userMessages ?? 0) > 0
    const previous = this.exitWaiters.get(id)
    const exited = new Promise<void>((res) =>
      this.exitWaiters.set(id, () => {
        previous?.()
        res()
      })
    )
    this.stop(projectPath, agentId)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    await this.start(projectPath, { resumeId: resumable ? sessionId : undefined, name: sessionName, agentId, permissionMode: mode })
  }

  // A changed mode setting applies to new sessions; for running ones, Hive offers to switch them now.
  private modeOffers = new Map<string, { label: string; mode: string }>()
  private modeOfferTimer: NodeJS.Timeout | null = null

  private noticeModeSetting(l: LiveSession, mode: PermissionMode | null): void {
    if (!mode || mode === l.configuredMode || mode === l.offeredMode) return
    if (mode === l.state.permissionMode) {
      // Already in it (switched by hand): nothing to offer.
      l.configuredMode = mode
      return
    }
    l.offeredMode = mode
    this.modeOffers.set(liveId(l.state.projectPath, l.state.agentId), { label: this.label(l.state), mode: permissionLabel(l.state.provider, mode) })
    if (this.modeOfferTimer) clearTimeout(this.modeOfferTimer)
    this.modeOfferTimer = setTimeout(() => {
      this.modeOfferTimer = null
      const offers = [...this.modeOffers.values()]
      this.modeOffers.clear()
      if (!offers.length) return
      const modes = [...new Set(offers.map((o) => o.mode))]
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
        if (r.ok) switched.push(`${this.label(st)} → ${permissionLabel(st.provider, mode)}`)
        else skipped.push(`${this.label(st)}: ${r.message}`)
      } catch (e) {
        skipped.push(`${this.label(st)}: ${(e as Error).message}`)
      }
    }
    return { switched, skipped }
  }

  /** Stops the CLI's background job holding a conversation, then resumes the conversation in this agent. */
  async stopBackgroundAndResume(projectPath: string, agentId: string, jobId: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const { agent, cfg } = await this.agentDef(projectPath, agentId)
    const adapter = providerAdapter(agentLaunchSettings(agent, cfg, config.settings).provider)
    const info = providerService.info(adapter.id)
    if (!adapter.stopBackgroundJob || !info.path) throw new Error(`${adapter.descriptor.name} can't stop background sessions.`)
    await adapter.stopBackgroundJob(info.path, jobId)
    // The job lets go of the conversation as it exits.
    await new Promise((r) => setTimeout(r, 1500))
    await this.start(projectPath, { agentId, resumeId: sessionId })
  }

  /** Sessions that would be interrupted by quitting: an agent is working or waiting on a prompt. */
  busyStates(): LiveSessionState[] {
    return this.liveStates().filter((s) => s.status === 'working' || s.status === 'waiting')
  }

  private async onExit(projectPath: string, agentId: string, runId: string, code: number, output = ''): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    const sessionId = l?.state.sessionId ?? ''
    // The CLI refused to open a conversation it is running as a background job (e.g. Claude Code's agent view):
    // say so, and offer to stop that job and resume here.
    const job = l && !l.stopRequested && sessionId ? l.adapter.backgroundJobIn?.(output) : null
    if (l && job) {
      toast(
        'warning',
        `${this.label(l.state)}: the session is running in the background`,
        `${l.adapter.descriptor.name} moved this conversation into its background service (job ${job}), so it can't be opened here until that job is stopped. The conversation is kept.`,
        [{ label: 'Stop It and Resume', command: 'session.stopBackgroundAndResume', args: [projectPath, agentId, job, sessionId] }],
        projectPath
      )
    }
    if (l) {
      if (l.backupTimer) clearInterval(l.backupTimer)
      if (l.compacting) clearTimeout(l.compacting.timer)
      await this.backup(projectPath, agentId, true).catch(() => undefined)
      this.live.delete(id)
    }
    this.runs.delete(runId)
    this.releaseLocks(id)
    if (sessionId) {
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
    }
    emit({ type: 'session-exit', projectPath, agentId, sessionId, exitCode: code })
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
    emit({
      type: 'session-status',
      state: { provider: l?.state.provider ?? '', runId, projectPath, agentId, cwd: l?.state.cwd ?? projectPath, sessionId, status: 'stopped', startedAt: l?.state.startedAt ?? '', launchSignature: '', unseen: false }
    })
    workspaceOf(projectPath).scheduleRefresh()
  }

  /** The running session's transcript, once the provider has written one. */
  private async liveTranscript(l: LiveSession): Promise<string | null> {
    if (!l.state.sessionId) return null
    if (l.transcriptPath && existsSync(l.transcriptPath)) return l.transcriptPath
    const t = await l.adapter.transcriptPath(l.state.cwd, l.state.sessionId, l.transcriptPath)
    if (t) l.transcriptPath = t
    return t
  }

  /** Copies the live transcript into <project>/.hive/sessions so it survives the CLI's own cleanup. */
  private async backup(projectPath: string, agentId: string, force = false): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return
    const sessionId = l.state.sessionId
    const src = await this.liveTranscript(l)
    if (!src) return
    const s = await stat(src).catch(() => null)
    if (!s) return
    const mtime = s.mtimeMs
    if (!force && l.transcriptMtime === mtime) return
    l.transcriptMtime = mtime
    // Fallback if hooks never arrive: a transcript means the session is up.
    if (l.state.status === 'starting') {
      l.state.status = 'ready'
      this.emitState(l.state)
    }
    emit({ type: 'usage-changed', projectPath, sessionId })
    await this.readDetails(l, src, s.size)
    if (l.compacting) {
      // Fallback if the compaction hooks never arrive: a new compaction in the transcript.
      const u = await this.usageFor(src, sessionId, l.state.provider)
      if (u && u.compactions.length > l.compacting.before) this.finishCompacting(liveId(projectPath, agentId))
    }
    if (l.defaultModel) {
      const usage = await this.usageFor(src, sessionId, l.state.provider)
      if (usage?.model) {
        providerService.observeDefaultModel(l.state.provider, usage.model)
        l.defaultModel = false
      }
    }
    // The estimate re-reads the whole transcript: every 30 seconds while the agent works, and at each turn's end.
    if (!l.adapter.descriptor.capabilities.reportsCost && (force || Date.now() - (l.costAt ?? 0) > COST_INTERVAL_MS)) {
      l.costAt = Date.now()
      const usage = await this.usageFor(src, sessionId, l.state.provider)
      if (usage?.costUsd != null && (usage.costUsd !== l.state.costUsd || !l.state.costEstimated)) {
        Object.assign(l.state, { costUsd: usage.costUsd, costEstimated: usage.costEstimated })
        this.emitState(l.state)
      }
    }
    if (!config.settings.sessions.backupTranscripts) return
    // A transcript can be many MB: while the agent works, copy it at most once a minute. The end of
    // each turn (Stop) and the session's exit force a copy, so nothing is left out.
    if (!force && l.lastBackupAt && Date.now() - l.lastBackupAt < BACKUP_INTERVAL_MS) return
    l.lastBackupAt = Date.now()
    const dest = this.backupPath(projectPath, sessionId)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest).catch((e) => log.warn('backup failed', e))
  }

  /** Live details from what the provider appended to its transcript since the last look (Codex). */
  private async readDetails(l: LiveSession, path: string, size: number): Promise<void> {
    if (!l.adapter.transcriptDetails) return
    const from = l.detailsOffset ?? 0
    if (size <= from) {
      if (size < from) l.detailsOffset = 0
      return
    }
    // The tail is enough: details only ever need the latest records.
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8', 0, bytesRead)
      const end = text.lastIndexOf('\n')
      if (end < 0) return
      l.detailsOffset = start + Buffer.byteLength(text.slice(0, end + 1))
      this.applyDetails(l, l.adapter.transcriptDetails(text.slice(0, end + 1)))
    } finally {
      await fh.close()
    }
  }

  private emitState(state: LiveSessionState): void {
    emit({ type: 'session-status', state: { ...state } })
  }

  /** Whether the user is looking at the window showing this project. */
  private windowAttentive(projectPath: string): boolean {
    const w = this.getWindow(projectPath)
    return !!w && w.isVisible() && w.isFocused() && !w.isMinimized()
  }

  /** The launch a hook call belongs to: named by its run id, else (older launch folders) by session id. */
  private findLaunch(runId: string | null, sessionId: unknown): [string, LiveSession] | null {
    if (runId) {
      const id = this.runs.get(runId)
      const l = id ? this.live.get(id) : undefined
      return id && l && !l.state.settingUp ? [id, l] : null
    }
    if (typeof sessionId !== 'string' || !sessionId) return null
    for (const e of this.live.entries()) if (e[1].state.sessionId === sessionId && !e[1].state.settingUp) return e
    return null
  }

  /** "hive" for a project with one agent, "hive · Agent 2" when it has several. */
  private label(st: LiveSessionState): string {
    if (workspace.isAssistantHome(st.projectPath)) return ASSISTANT_NAME
    const project = basename(st.projectPath)
    const count = workspaceOf(st.projectPath).info()?.projects.find((p) => p.path.toLowerCase() === st.projectPath.toLowerCase())?.agents.length ?? 1
    return count > 1 ? `${project} · ${st.agentName ?? 'Agent'}` : project
  }

  /** A provider's status report (Claude Code's status line): the session's model, effort and cost, and the plan's limits. */
  handleStatusLine(runId: string | null, body: Record<string, any>): void {
    const found = this.findLaunch(runId, body.session_id)
    if (!found?.[1].adapter.statusLine) return
    const l = found[1]
    this.applyDetails(l, l.adapter.statusLine!(body))
  }

  private applyDetails(l: LiveSession, d: ReturnType<NonNullable<ProviderAdapter['statusLine']>>): void {
    if (d.planUsage) reportPlanUsage(l.state.provider, d.planUsage)
    const st = l.state
    const next = { effort: d.effort ?? st.effort, modelName: d.modelName ?? st.modelName, costUsd: d.costUsd ?? st.costUsd, planMode: d.planMode ?? st.planMode, permissionMode: d.permissionMode ?? st.permissionMode, contextWindow: d.contextWindow ?? st.contextWindow }
    if (
      next.effort === st.effort &&
      next.modelName === st.modelName &&
      next.costUsd === st.costUsd &&
      next.planMode === st.planMode &&
      next.permissionMode === st.permissionMode &&
      next.contextWindow === st.contextWindow
    )
      return
    const windowChanged = next.contextWindow !== st.contextWindow
    Object.assign(st, next)
    this.emitState(st)
    // Usage shown in the renderer carries the window: have it read again.
    if (windowChanged && st.sessionId) emit({ type: 'usage-changed', projectPath: st.projectPath, sessionId: st.sessionId })
  }

  // -------------------------------------------------------------------------
  // File locks
  // -------------------------------------------------------------------------

  private lockMode(projectPath: string): FileLockMode {
    const p = workspaceOf(projectPath).info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
    const own = p?.config.fileLocks
    return own && own !== 'inherit' ? own : config.settings.agents.fileLocks
  }

  /**
   * The reply to a hook that is about to edit files (PreToolUse). The first agent to edit a file claims
   * it; another agent's edit of the same file is then blocked, sent to the user, or allowed with a
   * warning, depending on the lock mode. Claims are released when the holder's turn ends. Returns the
   * hook's reply, or null to let the edit go ahead as usual.
   */
  preToolUse(runId: string | null, body: Record<string, any>): Record<string, unknown> | null {
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return null
    const [id, l] = found
    const hook = l.adapter.normalizeHook(body)
    if (hook.event.kind !== 'toolStart' || !hook.editedPaths.length) return null
    const mode = this.lockMode(l.state.projectPath)
    if (mode === 'off') return null
    const base = typeof body.cwd === 'string' && body.cwd ? body.cwd : l.state.cwd
    const files = hook.editedPaths.map((f) => resolve(isAbsolute(f) ? f : join(base, f)))
    const now = Date.now()
    for (const abs of files) {
      const held = this.locks.get(abs.toLowerCase())
      const holder = held && held.liveId !== id ? this.live.get(held.liveId) : undefined
      if (!holder || now - held!.at >= LOCK_TTL_MS) continue
      const rel = relative(holder.state.cwd, abs) || basename(abs)
      const who = holder.state.agentName ?? 'Another agent'
      log.info(`Lock: ${l.state.agentName} → ${rel} held by ${who} (${mode})`)
      if (mode === 'warn') {
        return l.adapter.lockReply({ kind: 'warn', context: `Note: ${who} is also editing ${rel} right now. Check the file's current content before changing it, and keep your edit small.` })
      }
      if (mode === 'ask' && !l.adapter.descriptor.capabilities.lockAsk) {
        // The CLI can't show its own approval for this, so Hive asks the user and the agent waits.
        const key = `${id}|${abs.toLowerCase()}`
        if (this.lockAllowed.has(key)) continue
        if (!this.lockAsked.has(key)) {
          this.lockAsked.add(key)
          toast('warning', `${this.label(l.state)} wants to edit ${rel}`, `${who} is editing it right now. Allow ${l.state.agentName ?? 'the agent'} to edit it too?`, [{ label: 'Allow', command: 'session.allowLockedEdit', args: [l.state.projectPath, l.state.agentId, abs] }], l.state.projectPath)
        }
        return l.adapter.lockReply({
          kind: 'deny',
          reason: `${who} is editing ${rel} right now (Hive file lock). Hive has asked the user whether you may edit it too. Stop and wait: don't work around this. When the user says go ahead, try the edit again.`
        })
      }
      const reason = `${who} is editing ${rel} right now (Hive file lock). Work on something else, or wait until ${who} has finished its task, then try again.`
      return l.adapter.lockReply({ kind: mode === 'ask' ? 'ask' : 'deny', reason })
    }
    let fresh = false
    for (const abs of files) {
      const held = this.locks.get(abs.toLowerCase())
      if (!held || held.liveId !== id) fresh = true
      this.locks.set(abs.toLowerCase(), { liveId: id, at: now, path: abs })
    }
    if (fresh) this.publishLocks(id)
    return null
  }

  /** "Allow" on an "Ask me" lock notification: lets the agent edit the file, and tells it to go ahead if it is waiting. */
  async allowLockedEdit(projectPath: string, agentId: string, path: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    this.lockAllowed.add(`${id}|${resolve(path).toLowerCase()}`)
    if (l.state.status === 'ready' || l.state.status === 'finished') {
      await this.sendPrompt(projectPath, agentId, `The user allowed you to edit ${relative(l.state.cwd, path) || basename(path)} while the other agent works on it. Go ahead with the edit.`)
    }
  }

  private releaseLocks(id: string): void {
    for (const set of [this.lockAllowed, this.lockAsked]) {
      for (const k of set) if (k.startsWith(`${id}|`)) set.delete(k)
    }
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

  /** Handles a hook call from an agent's CLI (already answered; see preToolUse). */
  async handleHook(runId: string | null, body: Record<string, any>): Promise<void> {
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return
    const [id, l] = found
    const st = l.state
    const hook = l.adapter.normalizeHook(body)
    const label = this.label(st)
    // The user started or opened another conversation in the CLI (/clear, /new, /resume): follow it. Only a
    // prompt switches, since helpers the CLI runs for itself (subagents) can report other session ids.
    if (hook.event.kind === 'prompt' && st.sessionId && hook.sessionId && hook.sessionId !== st.sessionId && isSessionId(hook.sessionId)) {
      await this.switchSession(l, hook.sessionId, hook.transcriptPath)
    } else if (hook.transcriptPath && hook.transcriptPath !== l.transcriptPath) l.transcriptPath = hook.transcriptPath
    // Providers that choose their own session id report it here (the first hook of the launch).
    if (!st.sessionId && hook.sessionId) {
      try {
        st.sessionId = assertSessionId(hook.sessionId)
        const { agent } = await this.agentDef(st.projectPath, st.agentId)
        await this.recordSession(st.projectPath, agent, l)
        this.emitState(st)
        workspaceOf(st.projectPath).scheduleRefresh()
      } catch (e) {
        log.warn(`${label}: could not record session ${hook.sessionId}`, e)
      }
    }
    if (hook.mode && hook.mode !== st.permissionMode) {
      st.permissionMode = hook.mode
      this.emitState(st)
    }
    const ev = hook.event
    let next: SessionStatus | null = null
    switch (ev.kind) {
      case 'start':
        next = st.status === 'starting' || l.askedAtStart ? 'ready' : null
        this.startupAnswered(l)
        break
      case 'compactEnd':
        if (l.compacting) this.finishCompacting(id)
        else if (st.status === 'working' && st.statusMessage?.startsWith('Compacting')) {
          next = 'ready'
          st.statusMessage = undefined
        }
        break
      case 'prompt':
        next = 'working'
        this.startupAnswered(l)
        if (workspace.isAssistantHome(st.projectPath)) this.onAssistantPrompt(st.projectPath)
        break
      case 'toolEnd':
        next = st.status === 'waiting' || st.status === 'ready' || st.status === 'finished' ? 'working' : null
        break
      case 'needsInput':
        next = 'waiting'
        st.statusMessage = ev.message
        this.notify(st.projectPath, `${label} needs your input`, st.statusMessage, 'waiting')
        break
      case 'stop':
        next = 'finished'
        st.statusMessage = undefined
        this.releaseLocks(id)
        if (st.sessionId) await workspace.upsertSession(st.projectPath, { id: st.sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
        this.notify(st.projectPath, `${label} finished`, ev.lastMessage?.slice(0, 180) ?? 'The agent has finished its task.', 'finished')
        void this.backup(st.projectPath, st.agentId, true)
        break
      case 'interrupt':
        // Interrupted turns end without Stop: the agent is idle again, and its claims go.
        next = 'ready'
        st.statusMessage = undefined
        this.releaseLocks(id)
        break
      case 'compactStart':
        if (l.compacting && !l.compacting.started) {
          clearTimeout(l.compacting.timer)
          l.compacting.started = true
          l.compacting.timer = setTimeout(() => this.finishCompacting(id), 10 * 60_000)
        }
        // Automatic compaction gets a heads-up; one Hive started is already shown as "Compacting…".
        if (!l.compacting) toast('info', `${label}: compacting conversation`, `${l.adapter.descriptor.name} is summarising the context to free up space.`, undefined, st.projectPath)
        if (st.status !== 'working') {
          next = 'working'
          st.statusMessage = 'Compacting the conversation…'
        }
        break
      case 'end':
        this.releaseLocks(id)
        next = 'stopped'
        break
    }
    if (next && next !== st.status) {
      st.status = next
      if (next === 'working' || next === 'ready') st.statusMessage = undefined
      if (next === 'finished' || next === 'waiting') st.unseen = !this.windowAttentive(st.projectPath)
      this.emitState(st)
    }
  }

  /** Moves a running agent to the conversation the CLI switched to: the old one is backed up, the new one recorded. */
  private async switchSession(l: LiveSession, sessionId: string, transcriptPath: string | null): Promise<void> {
    const st = l.state
    const old = st.sessionId
    await this.backup(st.projectPath, st.agentId, true).catch(() => undefined)
    await workspace.upsertSession(st.projectPath, { id: old, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
    log.info(`${this.label(st)}: the CLI moved from session ${old} to ${sessionId}`)
    try {
      const { agent, count } = await this.agentDef(st.projectPath, st.agentId)
      const existing = (await workspace.sessionsFile(st.projectPath)).sessions.find((s) => s.id === sessionId)
      st.sessionId = sessionId
      l.name = existing?.name || autoName(st.projectPath, agent, count)
      st.sessionName = l.name
      l.transcriptPath = transcriptPath ?? existing?.transcriptPath
      l.transcriptMtime = 0
      l.detailsOffset = 0
      l.lastBackupAt = undefined
      st.costUsd = undefined
      st.costEstimated = undefined
      this.releaseLocks(liveId(st.projectPath, st.agentId))
      await this.recordSession(st.projectPath, agent, l)
    } catch (e) {
      log.warn(`${this.label(st)}: could not record session ${sessionId}`, e)
    }
    this.emitState(st)
    workspaceOf(st.projectPath).scheduleRefresh()
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
    if (n.onlyWhenUnfocused && this.windowAttentive(projectPath)) return
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, silent: true, icon: notificationIcon() })
    // Each event gets its own notification, so several agents finishing together stack in Windows.
    // Keep a reference: a garbage-collected Notification no longer delivers its click.
    shownNotifications.add(note)
    if (shownNotifications.size > 50) shownNotifications.delete(shownNotifications.values().next().value!)
    note.on('click', () => {
      shownNotifications.delete(note)
      const w = this.getWindow(projectPath)
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        emitTo(w, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
      }
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

  private async usageFor(path: string, sessionId: string, provider: ProviderId): Promise<SessionUsage | null> {
    try {
      const s = await stat(path)
      let c = usageCache.get(path)
      if (c && c.mtime === s.mtimeMs && c.size === s.size && c.usage) return c.usage
      // A file that shrank or was rewritten (or is now another session's) is read again from the start.
      if (c && (c.sessionId !== sessionId || c.provider !== provider || s.size < c.offset || (s.size === c.size && s.mtimeMs !== c.mtime))) c = undefined
      if (!c) {
        c = { parser: providerAdapter(provider).usageParser(sessionId), sessionId, provider, offset: 0, size: 0, mtime: 0, usage: null }
        usageCache.set(path, c)
      }
      if (s.size > c.offset) {
        const fh = await open(path, 'r')
        try {
          const buf = Buffer.alloc(s.size - c.offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, c.offset)
          // Whole lines only: a line still being written is read next time.
          const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
          if (end >= 0) {
            c.parser.feed(buf.subarray(0, end + 1).toString('utf8'))
            c.offset += end + 1
          }
        } finally {
          await fh.close()
        }
      }
      c.size = s.size
      c.mtime = s.mtimeMs
      const usage = c.parser.result()
      this.checkUnderstood(provider, usage, s.size)
      // Providers that don't report a cost get Hive's estimate from their token counts (prices: Settings → provider).
      if (usage.costUsd === null) {
        const est = estimateCost(usage, config.settings)
        if (est !== null) Object.assign(usage, { costUsd: est, costEstimated: true })
      } else if (usage.costUnreported) {
        // The provider reports its cost only now and then: the tokens since get Hive's estimate on top.
        const est = estimateCost({ ...usage, ...usage.costUnreported }, config.settings)
        if (est) Object.assign(usage, { costUsd: usage.costUsd + est, costEstimated: true })
      }
      // Each day's share, for the Overview's periods.
      withDayCosts(usage, config.settings)
      c.usage = usage
      return usage
    } catch {
      return null
    }
  }

  /** Providers and versions already warned about (see checkUnderstood). */
  private warnedFormats = new Set<string>()

  /**
   * A large transcript in which Hive found no requests at all most likely means the CLI changed its
   * format: say so once per provider version, rather than quietly showing zeros.
   */
  private checkUnderstood(provider: ProviderId, usage: SessionUsage, size: number): void {
    if (usage.requests > 0 || size < 200_000) return
    const key = `${provider}|${usage.cliVersion ?? '?'}`
    if (this.warnedFormats.has(key)) return
    this.warnedFormats.add(key)
    const name = providerDescriptor(provider).name
    log.warn(`${name} ${usage.cliVersion ?? ''}: a ${Math.round(size / 1024)} KB transcript showed no usage (${usage.sessionId})`)
    toast('warning', `Hive may not fully understand this ${name} version`, `A ${name}${usage.cliVersion ? ` ${usage.cliVersion}` : ''} session with activity showed no token use, so the Overview and costs may be incomplete. A Hive update will fix it.`)
  }

  /**
   * Saves an image for the running session under <project>/.hive/images/<sessionId> and returns
   * its path, which is pasted into the terminal so the transcript records which image was sent.
   * Takes the clipboard image when no source file is given; returns null if there is none.
   */
  async saveImage(projectPath: string, sourceFile?: string, agentId?: string): Promise<string | null> {
    projectPath = workspace.assertSessionHost(projectPath)
    agentId ||= await this.soleAgent(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) throw new Error('No session is running for this agent.')
    let png: Buffer | null = null
    // A file given by the window (a drop, Insert into Session) must be an image, from the workspace or pasted/dropped from outside it.
    if (sourceFile && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(sourceFile)) throw new Error('Only images can be added to a session this way.')
    if (!sourceFile) {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return null
      png = Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())
    }
    // Until the provider reports the session id, images go in a folder named after the launch.
    const dir = join(projectPath, HIVE_DIR, 'images', l.state.sessionId || `run-${l.state.runId}`)
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

  /** The provider's transcript, or Hive's backup (active or archived) when the provider no longer has it. */
  async anyTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<string | null> {
    const t = await this.providerTranscript(projectPath, sessionId, ctx)
    if (t) return t.path
    for (const archived of [false, true]) {
      const b = this.backupPath(projectPath, sessionId, archived)
      if (existsSync(b)) return b
    }
    return null
  }

  /** The provider a session of this project belongs to. */
  async sessionProvider(projectPath: string, sessionId: string, ctx?: ListContext): Promise<ProviderId> {
    const rec = (ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions).find((s) => s.id === sessionId)
    if (rec) return recordProvider(rec)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    if (live) return live.provider
    return (await this.providerTranscript(projectPath, sessionId, ctx))?.provider ?? 'claude-code'
  }

  async usage(projectPath: string, sessionId: string, ctx?: ListContext): Promise<SessionUsage | null> {
    assertSessionId(sessionId)
    const p = await this.anyTranscript(projectPath, sessionId, ctx)
    const usage = p ? await this.usageFor(p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx)) : null
    // A transcript without the context window (Claude Code's): the running session's status line has it.
    if (usage && !usage.contextWindow) {
      const window = [...this.live.values()].find((l) => l.state.sessionId === sessionId)?.state.contextWindow
      if (window) return { ...usage, contextWindow: window }
    }
    return usage
  }

  async list(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    // Read once for the whole list, not once per session.
    const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath) }
    const ttl = config.settings.sessions.cacheTtl
    const items: SessionListItem[] = []
    // Deleted sessions stay hidden, though the CLI still has their transcripts.
    const known = new Set([...file.sessions.map((s) => s.id), ...(file.deleted ?? [])])
    for (const rec of file.sessions) {
      const provider = recordProvider(rec)
      let hasTranscript = false
      try {
        hasTranscript = !!(await providerAdapter(provider).transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath))
      } catch {
        // A provider this version doesn't know.
      }
      const hasBackup = existsSync(this.backupPath(projectPath, rec.id)) || existsSync(this.backupPath(projectPath, rec.id, true))
      const usage = await this.usage(projectPath, rec.id, ctx)
      items.push({
        ...rec,
        provider,
        source: 'hive',
        title: usage?.title ?? null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript,
        hasBackup,
        usage,
        recache: usage && providerDescriptor(provider).capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null
      })
    }
    for (const adapter of allProviders()) {
      for (const ext of await adapter.listSessions(projectPath).catch(() => [])) {
        if (known.has(ext.id)) continue
        known.add(ext.id)
        const usage = await this.usageFor(ext.transcriptPath, ext.id, adapter.id)
        if (!usage || usage.requests === 0) continue
        items.push({
          id: ext.id,
          provider: adapter.id,
          source: 'external',
          title: usage.title,
          lastActivity: usage.lastActivity ?? ext.modified,
          hasTranscript: true,
          hasBackup: false,
          usage,
          recache: adapter.descriptor.capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null
        })
      }
    }
    return items.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  }

  async archive(projectPath: string, sessionId: string, archived: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    if (archived && this.projectStates(projectPath).some((s) => s.sessionId === sessionId)) throw new Error('Stop the session before archiving it.')
    const active = this.backupPath(projectPath, sessionId)
    const arch = this.backupPath(projectPath, sessionId, true)
    await mkdir(dirname(arch), { recursive: true })
    await mkdir(dirname(active), { recursive: true })
    if (archived) {
      // Always take a fresh copy from the provider so the archive is complete.
      const src = await this.providerTranscript(projectPath, sessionId)
      if (src) {
        await copyFile(src.path, arch)
        // The fresh copy is the archive; the older backup would only overwrite it.
        await rm(active, { force: true })
      } else if (existsSync(active)) await rename(active, arch)
    } else if (existsSync(arch)) {
      await rename(arch, active)
    }
    await workspace.upsertSession(projectPath, { id: sessionId, archived })
  }

  /**
   * Deletes a session from Hive: its record and Hive's copies of the transcript (to the Recycle Bin). The CLI's
   * own transcript is left alone (Hive doesn't change the CLIs' files), so Hive remembers the id to keep it hidden.
   */
  async delete(projectPath: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    if (this.projectStates(projectPath).some((s) => s.sessionId === sessionId)) throw new Error('Stop the session before deleting it.')
    // What it used stays in the project's totals: read before its copies go.
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    const used = rec ? await this.usage(projectPath, sessionId).catch(() => null) : null
    const kept: KeptUsage | null = rec && used ? { id: sessionId, provider: recordProvider(rec), agentId: rec.agentId, cwd: rec.cwd, name: rec.name, usage: { ...used, lastPrompt: null, costUnreported: undefined } } : null
    for (const archived of [false, true]) {
      const b = this.backupPath(projectPath, sessionId, archived)
      if (existsSync(b)) await shell.trashItem(b)
    }
    await workspace.mutateSessions(projectPath, (f) => {
      f.sessions = f.sessions.filter((s) => s.id !== sessionId)
      if (!f.deleted?.includes(sessionId)) f.deleted = [...(f.deleted ?? []), sessionId]
      if (kept) f.deletedUsage = [...(f.deletedUsage ?? []).filter((k) => k.id !== sessionId), kept]
    })
    for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
      if (a.lastSessionId === sessionId) await workspace.updateAgent(projectPath, a.id, { lastSessionId: undefined }).catch(() => undefined)
    }
    log.info(`Deleted session ${sessionId} in ${projectPath}`)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /** Deleted sessions' usage, as list items for totals (never shown in the session lists). */
  async keptUsage(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    return ((await workspace.sessionsFile(projectPath)).deletedUsage ?? []).map((k) => ({
      id: k.id,
      provider: k.provider,
      source: 'hive' as const,
      agentId: k.agentId,
      cwd: k.cwd,
      name: k.name,
      archived: true,
      deleted: true,
      title: null,
      lastActivity: k.usage.lastActivity,
      hasTranscript: false,
      hasBackup: false,
      usage: k.usage,
      recache: null
    }))
  }

  async rename(projectPath: string, sessionId: string, name: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    await workspace.upsertSession(projectPath, { id: sessionId, name: name.trim() })
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    if (live) {
      live.sessionName = name.trim()
      this.emitState(live)
    }
  }

  async adopt(projectPath: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    const src = await this.providerTranscript(projectPath, sessionId)
    const provider = src?.provider ?? 'claude-code'
    const usage = src ? await this.usageFor(src.path, sessionId, provider) : null
    await workspace.upsertSession(projectPath, {
      id: sessionId,
      agent: provider,
      name: usage?.title ?? `Adopted session ${sessionId.slice(0, 8)}`,
      createdAt: usage?.firstActivity ?? new Date().toISOString(),
      lastActiveAt: usage?.lastActivity ?? new Date().toISOString(),
      ...(src && !providerDescriptor(provider).capabilities.fixedSessionId ? { transcriptPath: src.path } : {})
    })
    if (src && config.settings.sessions.backupTranscripts) await copyFile(src.path, this.backupPath(projectPath, sessionId)).catch(() => undefined)
  }
}

export const sessions = new SessionManager()
