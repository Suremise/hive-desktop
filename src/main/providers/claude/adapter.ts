import { homedir } from 'os'
import { join, basename } from 'path'
import { mkdir, readdir, stat, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import type { AgentInstallInfo, McpServerDef, MemorySource, PathDataCopy, PlanLimit, PlanUsage, ReadinessIssue } from '../../../shared/types'
import { HIVE_DIR, assertSessionId, isSessionId } from '../../../shared/defaults'
import { CLAUDE_CODE, CLAUDE_DESCRIPTOR, baseModel, canSwitchLive, footerMode, hookMode } from '../../../shared/claude'
import { providerSettings } from '../../../shared/providers'
import { samePath } from '../../../shared/movePaths'
import { config } from '../../config'
import { claudeFileAllowed, contentHash, ContentTooLarge, copyMissing, copySkillTree, sourceProblem, tooBigToDeliver, isDir, linksNotCopied, readJson, removePath, writeJsonAtomic } from '../../fsutil'
import { createLogger } from '../../logger'
import { EDITOR_EXTENSION_PATH, EDITOR_ROOTS, compareVersions, hookForwardCommand, promptArg, run, runsThroughCmd, toSpawnable } from '../common'
import type { StartHint } from '../../../shared/startFailure'
import type { BackgroundTaskEvent, CatalogRead, CommandSpec, ExternalSession, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots } from '../types'
import { claudeBackgroundTasks } from './background'
import { ConversationParser, claudeImageData } from './conversation'
import { readClaudeModels } from './models'
import { ClaudeUsageParser, encodeProjectPath, parseTranscript } from './usage'

const log = createLogger('claude-code')

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'] as const

/** Tools that edit files: PreToolUse checks them against other agents' file locks. */
export const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit'

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Subscription limits from Claude Code's status line (rate_limits.five_hour / seven_day); null for API-key accounts. */
export function parseClaudePlanUsage(payload: Record<string, unknown>, now = new Date()): PlanUsage | null {
  const rl = payload.rate_limits as Record<string, unknown> | undefined
  if (!rl || typeof rl !== 'object') return null
  const limits: PlanLimit[] = []
  const add = (raw: unknown, id: string, label: string, windowMinutes: number): void => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    const pct = Number(r.used_percentage)
    if (!Number.isFinite(pct)) return
    limits.push({ id, label, windowMinutes, usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: toIso(r.resets_at) })
  }
  add(rl.five_hour, 'five_hour', '5-hour', 300)
  add(rl.seven_day, 'seven_day', 'weekly', 10080)
  return limits.length ? { provider: CLAUDE_CODE, plan: null, limits, updatedAt: now.toISOString() } : null
}

/** resets_at arrives as epoch seconds (or ms, or an ISO string); normalise to ISO. */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = CLAUDE_CODE
  readonly descriptor = CLAUDE_DESCRIPTOR
  /** If Hive itself was started from inside a Claude Code session, don't leak that session's identity. User configuration such as CLAUDE_CODE_GIT_BASH_PATH is kept. */
  readonly envToStrip = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'MCP_CONNECTION_NONBLOCKING']
  readonly compactFailure = /not enough messages to compact|error during compaction|compaction failed/i
  // Before a folder's first session: "Is this a project you created or one you trust? … trust this folder".
  readonly startupQuestion = /trust this folder/i

  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = providerSettings(config.settings, this.id).executablePath.trim()
    if (custom) out.push({ path: custom, source: 'settings' })

    const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], 5000)
    for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      // Prefer real executables over extension-less shims that node-pty cannot start on Windows.
      if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
    }
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
    out.push({ path: join(homedir(), '.local', 'bin', exe), source: 'native install' })
    if (process.platform === 'win32' && process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'claude.cmd'), source: 'npm' })
    return out
  }

  /** True if an editor extension (VS Code, Cursor…) ships its own Claude Code — used only to explain why it isn't used. */
  private async editorExtensionPresent(): Promise<boolean> {
    for (const root of EDITOR_ROOTS) {
      try {
        if ((await readdir(join(homedir(), root, 'extensions'))).some((d) => d.startsWith('anthropic.claude-code-'))) return true
      } catch {
        // Editor not installed.
      }
    }
    return false
  }

  async locate(): Promise<AgentInstallInfo> {
    const info: AgentInstallInfo = {
      provider: this.id,
      found: false,
      path: null,
      version: null,
      source: null,
      latestVersion: null,
      updateAvailable: false,
      loggedIn: null,
      authMethod: null,
      rejected: []
    }
    for (const c of await this.candidates()) {
      if (!existsSync(c.path)) continue
      // Hive requires the standalone CLI. Editor extensions bundle their own copy that moves on every
      // extension update and can't be updated with `claude update`, so it is never used — even if set manually.
      if (EDITOR_EXTENSION_PATH.test(c.path)) {
        info.rejected!.push(c.path)
        continue
      }
      const r = await run(c.path, ['--version'])
      const m = r.stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)
      if (!m) {
        log.warn(`Candidate ${c.path} did not report a version`, r.stderr.slice(0, 200))
        continue
      }
      info.found = true
      info.path = c.path
      info.version = m[1]
      info.source = c.source
      break
    }
    if (!info.found) info.editorExtensionOnly = await this.editorExtensionPresent()
    if (info.path) {
      const auth = await run(info.path, ['auth', 'status', '--json'], 10000)
      try {
        const j = JSON.parse(auth.stdout)
        info.loggedIn = !!j.loggedIn
        info.authMethod = j.authMethod ?? null
      } catch {
        info.loggedIn = null
      }
    }
    return info
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    if (!info.found) return [{ id: 'not-installed', level: 'error', message: 'Claude Code is not installed.', action: { label: 'Install', task: 'install' } }]
    const out: ReadinessIssue[] = []
    if (info.loggedIn === false) out.push({ id: 'signed-out', level: 'error', message: 'Claude Code is not signed in.', action: { label: 'Sign in', task: 'login' } })
    if (info.updateAvailable) out.push({ id: 'update', level: 'info', message: `Claude Code ${info.latestVersion} is available.`, action: { label: 'Update', task: 'update' } })
    return out
  }

  async latestVersion(): Promise<string | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return null
      return ((await res.json()) as { version?: string }).version ?? null
    } catch {
      return null
    }
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  installCommand(): CommandSpec {
    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']
      }
    }
    return { file: '/bin/bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }
  }

  updateCommand(executable: string): CommandSpec {
    return { file: executable, args: ['update'] }
  }

  loginCommand(executable: string): CommandSpec {
    return { file: executable, args: ['auth', 'login'] }
  }

  /** Claude Code's own default: "model" in ~/.claude/settings.json. */
  configuredDefaultModel(): string | null {
    try {
      const m = JSON.parse(readFileSync(join(claudeHome(), 'settings.json'), 'utf8')).model
      if (typeof m === 'string' && m.trim()) return m.trim()
    } catch {
      // no settings file, or no model in it
    }
    return null
  }

  ownsModel(model: string): boolean {
    return /^claude-/i.test(model)
  }

  /** Claude Code's models from its initialize reply (models.ts), in the sessions' environment. */
  listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    return readClaudeModels(executable, env)
  }

  /**
   * Generated skills, MCP config and hooks for a launch. Each agent has its own folder, because a launch
   * replaces the folder while the project's other agents may still be reading theirs.
   */
  launchDir(projectPath: string, agentId: string): string {
    return join(projectPath, HIVE_DIR, `launch-${agentId}`)
  }

  /** Rebuilds the agent's launch folder with exactly the session's Hive skills, MCP servers and Hive's hooks. */
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(this.launchDir(ctx.projectPath, ctx.agentId), 'plugin', 'skills', skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    await removePath(dir)
    const pluginDir = join(dir, 'plugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeJsonAtomic(join(pluginDir, '.claude-plugin', 'plugin.json'), {
      name: 'hive',
      version: '1.0.0',
      description: "The workspace's Hive skills for this session. Regenerated by Hive on every launch — do not edit."
    })
    const hashes: Record<string, string> = {}
    // Each agent's own copies: what it gets is what was copied here (its revision read back from the copy).
    const delivered: Record<string, SkillDelivery> = {}
    for (const skill of ctx.skills) {
      const dest = join(pluginDir, 'skills', skill.name)
      // A skill over the hashing limits isn't copied (the launch folder starts empty, so the session has no copy of it).
      // Checked on the source first, which reads no more than the limits, and on the copy, which may have grown since.
      // One skill's failure is its own: the launch folder started empty, so a skill not copied is one the session
      // doesn't have (revision null, and why).
      const fail = async (e: unknown): Promise<void> => {
        await removePath(dest).catch(() => undefined)
        delivered[skill.name] = e instanceof ContentTooLarge ? { revision: null, problem: tooBigToDeliver(e), lasting: true } : { revision: null, problem: sourceProblem(e, skill.sourcePath) }
      }
      try {
        hashes[`skill:${skill.name}`] = await contentHash(skill.sourcePath)
      } catch (e) {
        await fail(e)
        continue
      }
      // Links stay links, to the same place, so the copy is the same content as the workspace's skill. A link it can't
      // make (Windows needs a privilege for a link to a file) is left out, with every other file of the skill copied.
      // The copy keeps the limits as it reads the source (which may have changed since it was hashed), and what the
      // session gets is the copy's own revision.
      let skipped: string[]
      let revision: string
      try {
        skipped = await copySkillTree(skill.sourcePath, dest)
        revision = await contentHash(dest)
      } catch (e) {
        await fail(e)
        continue
      }
      delivered[skill.name] = skipped.length ? { revision, problem: linksNotCopied(skipped), lasting: true } : { revision }
    }
    await writeJsonAtomic(join(dir, 'mcp.json'), { mcpServers: ctx.mcpServers })

    const hook = {
      type: 'http',
      url: ctx.hookUrl,
      timeout: 5,
      headers: { Authorization: 'Bearer $HIVE_HOOK_TOKEN' },
      allowedEnvVars: ['HIVE_HOOK_TOKEN']
    }
    const token = ctx.env.HIVE_HOOK_TOKEN ?? ''
    const hooks: Record<string, unknown[]> = {}
    for (const ev of HOOK_EVENTS) {
      // SessionStart only supports command hooks (not http), so it forwards its JSON with curl.
      if (ev === 'SessionStart') {
        hooks[ev] = [{ hooks: [{ type: 'command', command: hookForwardCommand(ctx.hookUrl, token), timeout: 5 }] }]
        continue
      }
      // PreToolUse answers with a lock decision, so it gets a longer timeout; if Hive doesn't answer, the edit goes ahead.
      if (ev === 'PreToolUse') hooks[ev] = [{ matcher: EDIT_TOOLS, hooks: [{ ...hook, timeout: 10 }] }]
      else hooks[ev] = [ev === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }]
    }
    // The status line forwards Claude Code's status JSON (model, effort, cost, plan limits) to Hive and
    // prints nothing, so no line is added to the terminal.
    const statusLine = { type: 'command', command: hookForwardCommand(`${ctx.hookUrl}&statusline`, token), padding: 0 }
    await writeJsonAtomic(join(dir, 'settings.json'), { hooks, statusLine })
    await writeJsonAtomic(join(dir, 'sync.json'), { launchedAt: new Date().toISOString(), hashes })
    // Instructions for this launch (the Hive Assistant's) are appended to Claude Code's system prompt from a file.
    if (ctx.instructions) await writeFile(join(dir, 'instructions.md'), ctx.instructions)
    await writeFile(
      join(dir, 'README.txt'),
      'This folder is generated by Hive each time a session starts. Edits here are overwritten.\n'
    )
    return delivered
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    const args: string[] = []
    if (ctx.resume) args.push('--resume', ctx.sessionId)
    else args.push('--session-id', ctx.sessionId)
    if (ctx.name) args.push('--name', runsThroughCmd(executable) ? ctx.name.replace(/["%^&|<>!]/g, ' ').replace(/\s+/g, ' ').trim() : ctx.name)
    args.push('--plugin-dir', join(dir, 'plugin'))
    args.push('--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config')
    args.push('--settings', join(dir, 'settings.json'))
    if (ctx.instructions) args.push('--append-system-prompt-file', join(dir, 'instructions.md'))
    if (ctx.trustedHiveTools?.length && ctx.mcpServers.hive) args.push('--allowedTools', ctx.trustedHiveTools.map((t) => `mcp__hive__${t}`).join(','))
    // With 1M turned off, Claude Code rejects a "[1m]" model as unrecognised (2.1.287): run the base model.
    if (ctx.model) args.push('--model', ctx.use200kContext ? baseModel(ctx.model) : ctx.model)
    if (ctx.effort) args.push('--effort', ctx.effort)
    if (ctx.permissionMode) args.push('--permission-mode', ctx.permissionMode)
    args.push(...ctx.extraArgs)
    // Claude Code takes a first message as its last argument and starts on it.
    if (ctx.initialPrompt) args.push(promptArg(executable, ctx.initialPrompt))
    const s = toSpawnable(executable, args)
    // Agent view (← on an empty prompt) moves the session into Claude Code's background service, out of Hive's
    // reach: Stop would only close the terminal and the session would keep running. Off unless the user allows it.
    const env = { ...ctx.env }
    if (!ctx.allowBackgroundSessions) env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1'
    if (ctx.use200kContext) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    return { file: s.file, args: s.args, env }
  }

  backgroundTasks(appended: string): BackgroundTaskEvent[] {
    return claudeBackgroundTasks(appended)
  }

  startHint(text: string): StartHint | null {
    if (/\bmodel\b/i.test(text) && /not found|invalid|unknown|not available|does not exist|isn't available/i.test(text)) return { hint: 'Claude Code doesn\'t know this model: choose another in Agent Settings.', fix: 'agent-settings' }
    // Its argument parser: "error: unknown option '--x'", "error: option '--effort <level>' argument 'x' is invalid".
    if (/unknown option|unknown command|error: option|too many arguments|missing required argument|is invalid\. Allowed choices/i.test(text)) return { hint: 'Claude Code refused an argument: check Extra arguments in Agent Settings and Settings → Claude Code.', fix: 'agent-settings' }
    if (/not logged in|please (run )?\/?login|invalid api key|authentication|OAuth/i.test(text)) return { hint: 'Claude Code isn\'t signed in: start it again and sign in in its terminal.', fix: 'terminal' }
    if (/is not recognized|ENOENT|cannot find module|MODULE_NOT_FOUND/i.test(text)) return { hint: 'Claude Code looks broken or missing: reinstall or update it in Agent Setup.', fix: 'agent-setup' }
    return null
  }

  backgroundJobIn(output: string): string | null {
    // Claude Code names the job to attach to: "… running in the background … claude attach <id>".
    const text = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, ' ')
    return /background/i.test(text) ? (/\bclaude attach ([A-Za-z0-9-]{4,64})\b/.exec(text)?.[1] ?? null) : null
  }

  async stopBackgroundJob(executable: string, jobId: string): Promise<void> {
    const r = await run(executable, ['stop', jobId], 20000)
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `claude stop ${jobId} failed`)
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  normalizeHook(body: Record<string, any>): NormalizedHook {
    const event = String(body.hook_event_name ?? '')
    const out: NormalizedHook = {
      event: { kind: 'ignore' },
      sessionId: typeof body.session_id === 'string' ? body.session_id : null,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : null,
      mode: hookMode(body.permission_mode),
      editedPaths: []
    }
    switch (event) {
      case 'SessionStart':
        out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
        break
      case 'UserPromptSubmit':
        out.event = { kind: 'prompt' }
        break
      case 'PreToolUse': {
        out.event = { kind: 'toolStart' }
        const input = body.tool_input ?? {}
        const file: unknown = input.file_path ?? input.notebook_path
        if (typeof file === 'string' && file) out.editedPaths = [file]
        break
      }
      case 'PostToolUse':
        out.event = { kind: 'toolEnd' }
        break
      case 'Notification': {
        const kind: string = body.notification_type ?? body.type ?? ''
        const message: string = body.message ?? ''
        if (kind !== 'idle_prompt' && (kind === 'permission_prompt' || /permission|approve|waiting for your input/i.test(message))) {
          // Claude Code sends this when it shows the user a prompt, so none of its modes is `reviewed`.
          out.event = { kind: 'ask', ask: { kind: kind === 'permission_prompt' ? 'permission' : 'question', blocking: true, message: message || 'Waiting for your input' } }
        }
        break
      }
      case 'Stop':
        out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
        break
      case 'PreCompact':
        out.event = { kind: 'compactStart', trigger: String(body.trigger ?? 'auto') }
        break
      case 'PostCompact':
        out.event = { kind: 'compactEnd' }
        break
      case 'SessionEnd':
        out.event = { kind: 'end' }
        break
    }
    return out
  }

  lockReply(d: LockDecision): Record<string, unknown> {
    if (d.kind === 'warn') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context } }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.kind, permissionDecisionReason: d.reason } }
  }

  /** Claude Code's status-line JSON: the session's model, effort, cost and context window, and the plan's limits. */
  statusLine(body: Record<string, any>): LiveDetails {
    const effort = typeof body.effort === 'string' ? body.effort : typeof body.effort?.level === 'string' ? body.effort.level : undefined
    const modelName = typeof body.model?.display_name === 'string' ? body.model.display_name : undefined
    const modelId = typeof body.model?.id === 'string' ? body.model.id : undefined
    const cost = Number(body.cost?.total_cost_usd)
    const window = Number(body.context_window?.context_window_size)
    return { effort, modelName, modelId, costUsd: Number.isFinite(cost) ? cost : undefined, contextWindow: window > 0 ? window : undefined, planUsage: parseClaudePlanUsage(body) }
  }

  footerMode(screen: string): string | null {
    return footerMode(screen)
  }

  canSwitchLive(target: string, current: string | undefined, launched: string | null | undefined): boolean {
    return canSwitchLive(target, current, launched)
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  async transcriptDir(folder: string): Promise<string | null> {
    const root = join(claudeHome(), 'projects')
    const encoded = encodeProjectPath(folder).toLowerCase()
    try {
      const match = (await readdir(root)).find((d) => d.toLowerCase() === encoded)
      return match ? join(root, match) : null
    } catch {
      return null
    }
  }

  async transcriptPath(folder: string, sessionId: string): Promise<string | null> {
    const dir = await this.transcriptDir(folder)
    if (!dir) return null
    const p = join(dir, `${assertSessionId(sessionId)}.jsonl`)
    return existsSync(p) ? p : null
  }

  /** Where a transcript would be written for a folder that has none yet. */
  restorePath(folder: string, sessionId: string): string {
    return join(claudeHome(), 'projects', encodeProjectPath(folder), `${assertSessionId(sessionId)}.jsonl`)
  }

  /** A moved folder's transcripts and auto memory (memory/), copied to the folder named for its new path (#146). */
  async copyPathData(from: string, to: string, apply: boolean): Promise<PathDataCopy | null> {
    const src = await this.transcriptDir(from)
    if (!src) return null
    const dest = (await this.transcriptDir(to)) ?? join(claudeHome(), 'projects', encodeProjectPath(to))
    if (samePath(src, dest)) return null
    const r = await copyMissing(src, dest, apply)
    return { provider: this.id, from: src, to: dest, copy: r.copy, kept: r.kept, ...(r.failed.length ? { failed: r.failed } : {}) }
  }

  async listSessions(folder: string): Promise<ExternalSession[]> {
    const dir = await this.transcriptDir(folder)
    if (!dir) return []
    const out: ExternalSession[] = []
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.jsonl') || !isSessionId(basename(f, '.jsonl'))) continue
      const p = join(dir, f)
      try {
        const s = await stat(p)
        if (s.isFile() && s.size > 0) out.push({ id: basename(f, '.jsonl'), transcriptPath: p, modified: s.mtime.toISOString() })
      } catch {
        // Removed between readdir and stat.
      }
    }
    return out
  }

  parseUsage(text: string, sessionId: string) {
    return parseTranscript(text, sessionId)
  }

  usageParser(sessionId: string): ClaudeUsageParser {
    return new ClaudeUsageParser(sessionId)
  }

  conversationParser(projectPath: string): ConversationParser {
    return new ConversationParser(projectPath)
  }

  imageData = claudeImageData

  exportSubtitle(sessionId: string, project: string): string {
    return `Claude Code session \`${sessionId}\` · project ${project}`
  }

  // -------------------------------------------------------------------------
  // Project files
  // -------------------------------------------------------------------------

  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const p = this.id
    const sources: MemorySource[] = [
      { provider: p, id: 'project', label: 'CLAUDE.md', path: join(projectPath, 'CLAUDE.md'), kind: 'claude-md', exists: false },
      { provider: p, id: 'project-dot', label: '.claude/CLAUDE.md', path: join(projectPath, '.claude', 'CLAUDE.md'), kind: 'claude-md', exists: false },
      { provider: p, id: 'local', label: 'CLAUDE.local.md', path: join(projectPath, 'CLAUDE.local.md'), kind: 'local-md', exists: false },
      { provider: p, id: 'user', label: 'User CLAUDE.md (all projects)', path: join(claudeHome(), 'CLAUDE.md'), kind: 'claude-md', exists: false }
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    const dir = await this.transcriptDir(projectPath)
    const memDir = dir ? join(dir, 'memory') : null
    if (memDir && (await isDir(memDir))) {
      const files = (await readdir(memDir)).filter((f) => f.endsWith('.md')).sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      for (const f of files) {
        sources.push({ provider: p, id: `auto:${f}`, label: f, path: join(memDir, f), kind: 'auto-memory', exists: true })
      }
    }
    return sources
  }

  fileAllowed(path: string, write: boolean): boolean {
    return claudeFileAllowed(path, write, claudeHome())
  }

  skillRoots(): SkillRoots {
    return { machine: [join(claudeHome(), 'skills')], plugins: join(claudeHome(), 'plugins'), local: join('.claude', 'skills'), hiveCopyPrefix: null }
  }

  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    const j = await readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(projectPath, '.mcp.json'), {})
    return j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {}
  }
}

export const claudeCode = new ClaudeCodeAdapter()
