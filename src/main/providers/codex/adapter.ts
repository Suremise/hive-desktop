import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'original-fs/promises'
import { existsSync, mkdirSync, readFileSync, statSync } from 'original-fs'
import { parse as parseToml } from 'smol-toml'
import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, ReadinessIssue, SubSession } from '../../../shared/types'
import { assertSessionId, isSessionId } from '../../../shared/defaults'
import type { StartHint } from '../../../shared/startFailure'
import { CODEX, CODEX_DESCRIPTOR, CODEX_MODE_FLAGS, CODEX_PERMISSION_MODES } from '../../../shared/codex'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { cleanSwaps, contentHash, ContentTooLarge, COPY_MARKER, CopyFailed, LinkNotCopied, sourceProblem, tooBigToDeliver, removePath, swapIn, withFileLock } from '../../fsutil'
import { createLogger, userText } from '../../logger'
import { findSecretWarnings } from '../../mcpSecrets'
import { EDITOR_EXTENSION_PATH, EDITOR_ROOTS, compareVersions, hookForwardCommand, promptArg, readFirstLine, run, toSpawnable } from '../common'
import type { BackgroundTaskEvent, CatalogRead, CommandSpec, ExternalSession, KeySteps, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { codexBackgroundMemo, codexBackgroundTasks, type CodexBackgroundMemo } from './background'
import { CodexConversationParser, CodexUsageParser, codexImageData, parseRollout, patchPaths, rolloutDetails, rolloutSubSession } from './rollout'
import { parseCodexModels } from './models'
import { PERMISSIONS_MENU_LABELS, permissionsMenuNumber } from './permissionsMenu'

const log = createLogger('codex')

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** A TOML file as an object; empty when missing or unreadable. Cached by modification time. */
const tomlCache = new Map<string, { mtime: number; data: Record<string, any> }>()
function readToml(path: string): Record<string, any> {
  try {
    const m = statSync(path).mtimeMs
    const c = tomlCache.get(path)
    if (c && c.mtime === m) return c.data
    const data = parseToml(readFileSync(path, 'utf8')) as Record<string, any>
    tomlCache.set(path, { mtime: m, data })
    return data
  } catch {
    return {}
  }
}

const userConfig = (): Record<string, any> => readToml(join(codexHome(), 'config.toml'))

/** Agent Setup's explanation of the two choices Codex's sandbox setup offers, for someone working in Hive. */
const SANDBOX_CHOICE = [
  "**Set up** opens Codex's sandbox setup, which offers two choices. With either, Codex agents in **Ask for approval** or **Approve for me** can edit files in their own folder (the project, or the agent's worktree) and run commands there without asking, and ask before going online or writing anywhere else. Hive's own features (status, file locks, handovers, shared notes) work the same with both.",
  "**Set up default sandbox** (recommended): commands run under two local Windows accounts Codex creates for them (`CodexSandboxOffline` and `CodexSandboxOnline`), with a firewall rule that keeps them offline unless you allow it. It isolates commands best. Windows asks for Administrator permission once.",
  '**Use non-admin sandbox**: needs no Administrator permission. Commands run under your own account with restricted rights. It protects your files and blocks internet access in most cases, but Codex warns it carries more risk if the agent is tricked by instructions hidden in a file or web page it reads (prompt injection). You can upgrade to the default sandbox from here later.'
]

/** A value as TOML, for -c overrides: strings, numbers, booleans, arrays and inline tables. */
export function toToml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(toToml).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toToml(x)}`)
      .join(',')}}`
  }
  return '""'
}

/** Keys used in hook trust records for hooks passed with -c (Codex's synthetic "session flags" layer). */
const SESSION_FLAGS = process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml'

/**
 * Which tool call a hook is about, the same in its PermissionRequest and PostToolUse (Codex sends no call id, and
 * adds a `description` to the request's input): the tool and its command, patch or questions.
 */
function toolCall(tool: string, input: Record<string, unknown>): string {
  return `${tool}\n${typeof input.command === 'string' ? input.command : JSON.stringify(input.questions ?? input.patch ?? '')}`
}

/** The first Codex version seen to title its terminal "Action Required" while a person must act (titleAttention). */
const ACTION_REQUIRED_SINCE = '0.160.0'
/**
 * Codex has loaded: its session header names the folder (`~\…`, `C:\…`, `\\server\…`) where it said "loading". The
 * setup task's keys wait for it: its prompt ("› Ask Codex to do anything") is drawn while it is still loading, and its
 * startup spinner only comes after (#235). Matched positively, so no part of "loading" (output can end anywhere) counts.
 */
export const CODEX_LOADED = /OpenAI Codex\s+\(v[^)]*\)[\s│]+(?:~|[A-Za-z]:|[\\/])/
/**
 * Codex's own terminal title items, set for Hive's sessions and its sandbox setup so a user's [tui].terminal_title
 * can't hide "Action Required" or the busy spinner.
 */
const TITLE_ITEMS = ['activity', 'project-name']

type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PermissionRequest' | 'Stop' | 'Interrupt' | 'PreCompact' | 'PostCompact' | 'SessionEnd'
const HOOKS: { event: HookEvent; label: string; matcher?: string; timeout: number }[] = [
  { event: 'SessionStart', label: 'session_start', timeout: 5 },
  { event: 'UserPromptSubmit', label: 'user_prompt_submit', timeout: 5 },
  // PreToolUse answers with a file-lock decision; request_user_input also comes through here.
  { event: 'PreToolUse', label: 'pre_tool_use', matcher: '*', timeout: 10 },
  { event: 'PostToolUse', label: 'post_tool_use', matcher: '*', timeout: 5 },
  { event: 'PermissionRequest', label: 'permission_request', matcher: '*', timeout: 5 },
  { event: 'Stop', label: 'stop', timeout: 5 },
  // Codex clamps these two to 3 seconds (and warns in the terminal about anything longer).
  { event: 'Interrupt', label: 'interrupt', timeout: 3 },
  { event: 'PreCompact', label: 'pre_compact', timeout: 5 },
  { event: 'PostCompact', label: 'post_compact', timeout: 5 },
  { event: 'SessionEnd', label: 'session_end', timeout: 3 }
]

/**
 * Codex runs hook commands with PowerShell on Windows, where a quoted program path is an expression and
 * a bare @- is splatting: hookForwardCommand's form (curl.exe unquoted, "@-" quoted) works there. The header comes from
 * the launch's auth file, so the -c arguments (seen in process listings) carry no token (#345).
 */
function hookCommand(url: string, authFile: string): string {
  return hookForwardCommand(url, authFile)
}

const sortDeep = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v

/**
 * The trust hash Codex gives a hook: SHA-256 of the sorted JSON of its normalised definition
 * (codex-rs/hooks discovery.rs, version_for_toml). Checked against Codex itself once per version.
 */
export function hookHash(label: string, matcher: string | undefined, command: string, timeout: number): string {
  const id: Record<string, unknown> = { event_name: label, hooks: [{ type: 'command', command, timeout, async: false }] }
  if (matcher) id.matcher = matcher
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sortDeep(id))).digest('hex')
}

/** -c overrides for Hive's hooks, with the trust records that let them run without a review prompt. */
function hookOverrides(url: string, authFile: string, hashes?: Record<string, string>): string[] {
  const command = hookCommand(url, authFile)
  const args: string[] = []
  const state: Record<string, { trusted_hash: string }> = {}
  for (const h of HOOKS) {
    const handler = { type: 'command', command, timeout: h.timeout }
    args.push('-c', `hooks.${h.event}=${toToml([h.matcher ? { matcher: h.matcher, hooks: [handler] } : { hooks: [handler] }])}`)
    const key = `${SESSION_FLAGS}:${h.label}:0:0`
    state[key] = { trusted_hash: hashes?.[key] ?? hookHash(h.label, h.matcher, command, h.timeout) }
  }
  args.push('-c', `hooks.state=${toToml(state)}`)
  return args
}

/** Asks Codex (its app server) for the keys and hashes of the given hooks. */
async function hooksFromCodex(executable: string, hookArgs: string[], cwd: string): Promise<Record<string, string> | null> {
  return new Promise((resolveP) => {
    const s = toSpawnable(executable, ['app-server', ...hookArgs])
    const p = spawn(s.file, s.args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = (v: Record<string, string> | null): void => {
      clearTimeout(timer)
      p.kill()
      resolveP(v)
    }
    const timer = setTimeout(() => done(null), 20000)
    const send = (m: unknown): void => void p.stdin.write(JSON.stringify(m) + '\n')
    p.on('error', () => done(null))
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
        } else if (m.id === 2) {
          const out: Record<string, string> = {}
          for (const entry of m.result?.data ?? []) for (const h of entry.hooks ?? []) if (h.key && h.currentHash) out[h.key] = h.currentHash
          done(Object.keys(out).length ? out : null)
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hive', version: '1' } } })
  })
}

/** An MCP server definition (Claude Code's JSON format) as a Codex mcp_servers table; null if it can't be passed safely. */
export function codexMcpServer(name: string, def: McpServerDef): { table: Record<string, unknown> | null; warning?: string } {
  const ref = (v: unknown): string | null => {
    const m = typeof v === 'string' ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.trim()) : null
    return m ? (m[1] ?? m[2]) : null
  }
  // Secrets must be environment references: literal ones would appear on Codex's command line.
  if (findSecretWarnings(def).length) return { table: null, warning: `MCP server "${name}" has a literal secret, so Codex agents don't get it. Use an environment variable reference such as \${TOKEN}.` }
  if (def.url) {
    const table: Record<string, unknown> = { url: def.url, default_tools_approval_mode: 'approve' }
    const plain: Record<string, string> = {}
    const fromEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(def.headers ?? {})) {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(v))
      if (/^authorization$/i.test(k) && bearer && ref(bearer[1])) table.bearer_token_env_var = ref(bearer[1])
      else if (ref(v)) fromEnv[k] = ref(v)!
      else if (typeof v === 'string' && v.includes('${')) return { table: null, warning: `MCP server "${name}": header ${k} mixes text and a variable, which Codex can't pass on. Codex agents don't get this server.` }
      else plain[k] = String(v)
    }
    if (Object.keys(plain).length) table.http_headers = plain
    if (Object.keys(fromEnv).length) table.env_http_headers = fromEnv
    return { table }
  }
  if (!def.command) return { table: null }
  const table: Record<string, unknown> = { command: def.command, default_tools_approval_mode: 'approve' }
  // Hive's own tools can wait minutes (for agents to finish, or for the user to answer the Assistant).
  if (name === 'hive') table.tool_timeout_sec = 900
  if (def.args?.length) table.args = def.args.map(String)
  if (typeof def.cwd === 'string') table.cwd = def.cwd
  const env: Record<string, string> = {}
  const passThrough: string[] = []
  for (const [k, v] of Object.entries(def.env ?? {})) {
    const r = ref(v)
    if (r === k) passThrough.push(k)
    else if (r || (typeof v === 'string' && v.includes('${'))) return { table: null, warning: `MCP server "${name}": env ${k} takes its value from another variable, which Codex can't pass on. Name the variable ${k} itself.` }
    else env[k] = String(v)
  }
  if (Object.keys(env).length) table.env = env
  if (passThrough.length) table.env_vars = passThrough
  return { table }
}

/** Codex's MCP servers in one config file ([mcp_servers.<name>]), as Hive's definitions. */
function mcpServersIn(file: string): Record<string, McpServerDef> {
  const servers = readToml(file).mcp_servers
  if (!servers || typeof servers !== 'object') return {}
  const out: Record<string, McpServerDef> = {}
  for (const [name, s] of Object.entries(servers as Record<string, any>)) {
    if (!s || typeof s !== 'object') continue
    const def: McpServerDef = {}
    if (typeof s.command === 'string') def.command = s.command
    if (Array.isArray(s.args)) def.args = s.args.map(String)
    if (s.env && typeof s.env === 'object') def.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)]))
    for (const k of Array.isArray(s.env_vars) ? s.env_vars : []) def.env = { ...def.env, [k]: `\${${k}}` }
    if (typeof s.url === 'string') def.url = s.url
    if (s.http_headers && typeof s.http_headers === 'object') def.headers = Object.fromEntries(Object.entries(s.http_headers).map(([k, v]) => [k, String(v)]))
    if (typeof s.bearer_token_env_var === 'string') def.headers = { ...def.headers, Authorization: `Bearer \${${s.bearer_token_env_var}}` }
    if (typeof s.cwd === 'string') def.cwd = s.cwd
    out[name] = def
  }
  return out
}

/** Marks Hive's copies of workspace skills in .agents/skills (so only those are ever replaced or removed). */
const SKILL_MARKER = COPY_MARKER

/** Session id from a rollout file name (rollout-<local time>-<uuid>.jsonl). */
const idFromFile = (f: string): string | null => /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f)?.[1] ?? null

/** The hash in a Hive copy's marker ('' for one from before hashes), or null: not Hive's copy (or no folder). */
async function skillMarker(folder: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(folder, SKILL_MARKER), 'utf8')) as { hash?: string }).hash ?? ''
  } catch {
    return null
  }
}

/**
 * A skill not delivered this time, for `problem`: what Codex reads of it is Hive's copy from an earlier launch, if one is
 * there (its revision, and the problem says it kept it); a folder of the user's with its name is never Hive's delivery.
 */
async function keptCopy(dest: string, problem: string): Promise<SkillDelivery> {
  const kept = existsSync(dest) && (await skillMarker(dest)) !== null ? await contentHash(dest).catch(() => null) : null
  return { revision: kept, problem: kept ? `${problem}, so it kept its old copy` : problem }
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = CODEX
  readonly descriptor = CODEX_DESCRIPTOR
  /** A parent Codex session's identity, when Hive runs inside one. User configuration (CODEX_HOME…) is kept. */
  readonly envToStrip = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI']
  readonly compactFailure = null
  // SessionStart only comes with the first prompt; the composer's placeholder means Codex is up.
  readonly readyOutput = /Ask Codex to do anything/
  // Before a folder's first session: "Trust this folder? Codex can read, edit, and run files here…".
  readonly startupQuestion = /trust this folder/i
  readonly planToggleKey = '\x1b[Z'

  startHint(text: string): StartHint | null {
    if (/\bmodel\b/i.test(text) && /not found|invalid|unknown|not supported|does not exist/i.test(text)) return { hint: 'Codex doesn\'t know this model: choose another in Agent Settings.', fix: 'agent-settings' }
    // Hive's -c overrides and the user's own config.toml.
    if (/error loading config|config\.toml|error parsing -c|invalid value for|unknown variant|unexpected argument|unrecognized|for more information, try '--help'/i.test(text)) return { hint: 'Codex refused its settings: check Extra arguments in Agent Settings and Settings → Codex, and your config.toml.', fix: 'agent-settings' }
    if (/not logged in|codex login|please (sign|log) in|unauthorized|401/i.test(text)) return { hint: 'Codex isn\'t signed in: sign in in Agent Setup, then start it again.', fix: 'agent-setup' }
    if (/is not recognized|ENOENT|cannot find|sandbox/i.test(text)) return { hint: 'Codex looks broken or not set up: check it in Agent Setup.', fix: 'agent-setup' }
    return null
  }
  /** Codex versions whose hook hashes Hive has checked against Codex itself: true = Hive's own hash matches. */
  private hashCheck = new Map<string, boolean>()
  /** Versions whose app server didn't answer this run (not asked again until Hive restarts). */
  private unreachable = new Set<string>()
  /** Rollout files by session id, and each file's session_meta (id, cwd, and whose sub-session it is), by file mtime. */
  private paths = new Map<string, string>()
  private metas = new Map<string, { id: string; cwd: string; sub: SubSession | null; mtime: number }>()
  private titles: { mtime: number; map: Map<string, string> } | null = null

  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = providerSettings(config.settings, this.id).executablePath.trim()
    if (custom) out.push({ path: custom, source: 'settings' })
    const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], 5000)
    for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
    }
    if (process.platform === 'win32') {
      // The standalone installer adds this to the user PATH, which a Hive started before the install doesn't have yet.
      if (process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), source: 'standalone install' })
      if (process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'codex.cmd'), source: 'npm' })
    } else out.push({ path: join(homedir(), '.local', 'bin', 'codex'), source: 'standalone install' })
    return out
  }

  private async editorExtensionPresent(): Promise<boolean> {
    for (const root of EDITOR_ROOTS) {
      try {
        if ((await readdir(join(homedir(), root, 'extensions'))).some((d) => d.startsWith('openai.chatgpt-'))) return true
      } catch {
        // Editor not installed.
      }
    }
    return false
  }

  async locate(): Promise<AgentInstallInfo> {
    const info: AgentInstallInfo = { provider: this.id, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, rejected: [] }
    for (const c of await this.candidates()) {
      if (!existsSync(c.path)) continue
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
      Object.assign(info, { found: true, path: c.path, version: m[1], source: c.source })
      break
    }
    if (!info.found) info.editorExtensionOnly = await this.editorExtensionPresent()
    if (info.path) {
      const s = await run(info.path, ['login', 'status'], 10000)
      const text = `${s.stdout}\n${s.stderr}`
      if (/not logged in|logged out/i.test(text)) info.loggedIn = false
      else if (/logged in/i.test(text)) {
        info.loggedIn = true
        info.authMethod = /using (.+)/i.exec(text)?.[1]?.trim() ?? null
      }
    }
    return info
  }

  /** Codex's Windows sandbox is set up once (windows.sandbox in its config); without it every command needs approval. */
  sandboxReady(): boolean {
    return !!this.sandboxKind()
  }

  /** Which Windows sandbox Codex has: its default (admin) one, the non-admin one ('unelevated'), or none. */
  private sandboxKind(): string | null {
    if (process.platform !== 'win32') return 'n/a'
    const w = userConfig().windows
    return typeof w?.sandbox === 'string' && w.sandbox ? w.sandbox : null
  }

  diagnostics(): string[] {
    const kind = this.sandboxKind()
    const named: Record<string, string> = { elevated: 'default (admin)', unelevated: 'non-admin', 'n/a': 'not used on this system' }
    return [`Windows sandbox: ${kind === null ? 'not set up' : (named[kind] ?? (/^[\w-]{1,24}$/.test(kind) ? kind : 'unknown'))}`]
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    if (!info.found) return [{ id: 'not-installed', level: 'error', message: 'Codex is not installed.', action: { label: 'Install', task: 'install' } }]
    const out: ReadinessIssue[] = []
    const sandbox = this.sandboxKind()
    if (info.loggedIn === false) out.push({ id: 'signed-out', level: 'error', message: 'Codex is not signed in.', action: { label: 'Sign in', task: 'login' } })
    else if (!sandbox) out.push({ id: 'sandbox', level: 'warning', message: 'Codex needs a one-time setup of its Windows sandbox; until then it asks before every command.', action: { label: 'Set up', task: 'setup' }, detail: SANDBOX_CHOICE })
    else if (sandbox === 'unelevated') {
      out.push({
        id: 'sandbox-upgrade',
        level: 'info',
        message: 'Codex uses its non-admin sandbox.',
        action: { label: 'Upgrade', task: 'setup' },
        detail: ['**Upgrade** switches Codex to its default sandbox, which runs commands under separate Windows accounts instead of your own. Windows asks for Administrator permission once. Codex agents that are running keep their sandbox until they restart.']
      })
    }
    if (info.updateAvailable) out.push({ id: 'update', level: 'info', message: `Codex ${info.latestVersion} is available.`, action: { label: 'Update', task: 'update' } })
    return out
  }

  async latestVersion(): Promise<string | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch('https://api.github.com/repos/openai/codex/releases/latest', { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json' } })
      clearTimeout(t)
      if (!res.ok) return null
      const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? ''
      return /(\d+\.\d+\.\d+)/.exec(tag)?.[1] ?? null
    } catch {
      return null
    }
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  installCommand(): CommandSpec {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://chatgpt.com/codex/install.ps1 | iex'] }
    }
    return { file: '/bin/bash', args: ['-lc', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'] }
  }

  updateCommand(executable: string): CommandSpec {
    return { ...toSpawnable(executable, ['update']) }
  }

  loginCommand(executable: string): CommandSpec {
    return { ...toSpawnable(executable, ['login']) }
  }

  /**
   * The Windows sandbox setup is Codex's own prompt (the admin sandbox, or the non-admin one). Hive opens
   * Codex read-only in a folder of its own, trusted for this run only. With no sandbox yet, choosing "Ask for
   * approval" in /permissions brings up the prompt; /setup-default-sandbox only exists once the non-admin
   * sandbox is on (it upgrades that to the admin one).
   */
  setupCommand(executable: string): CommandSpec {
    const dir = join(tmpdir(), 'hive-codex-setup')
    mkdirSync(dir, { recursive: true })
    // The title items are pinned as for sessions: the busy wait below reads the spinner a user's own [tui].terminal_title could drop.
    const s = toSpawnable(executable, ['--no-daemon', '-C', dir, '-c', `projects=${toToml({ [dir]: { trust_level: 'trusted' } })}`, '-c', `tui.terminal_title=${toToml(TITLE_ITEMS)}`, ...CODEX_MODE_FLAGS['read-only']])
    const before = this.sandboxKind()
    const keys = before === 'unelevated'
      ? [{ keys: '/setup-default-sandbox', waitMs: 300 }, { keys: '\r' }]
      : this.modeMenuKeys('ask')
    // Codex stays open once the sandbox is set up: the task is done when its config names a new sandbox.
    const done = (): boolean => {
      const now = this.sandboxKind()
      return !!now && now !== before
    }
    // Codex puts a spinner in its window title while it works (also as it starts up, once it has loaded).
    return { ...s, keys, readyPattern: CODEX_LOADED, busyTitle: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, done }
  }

  /** Codex's model catalog (codex debug models, models.ts): the listed models in Codex's order, with their efforts. */
  async listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    const r = await run(executable, ['debug', 'models'], 30000, env)
    return r.code === 0 ? parseCodexModels(r.stdout) : null
  }

  configuredDefaultModel(): string | null {
    const m = userConfig().model
    return typeof m === 'string' && m.trim() ? m.trim() : null
  }

  /** model_reasoning_effort in Codex's own config.toml, which every model then uses unless Hive passes one. */
  configuredDefaultEffort(): string | null {
    const e = userConfig().model_reasoning_effort
    return typeof e === 'string' && e.trim() ? e.trim() : null
  }

  ownsModel(model: string): boolean {
    return /^(gpt-|o\d|codex)/i.test(model)
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  /** Hook hashes to trust for this launch: Hive's own, unless this Codex version hashes differently (then Codex's). */
  private hashesByRun = new Map<string, Record<string, string> | undefined>()

  /**
   * Copies the session's Hive skills into <cwd>/.agents/skills/hive-<name> (Codex has no per-launch skills folder),
   * removes Hive's copies of skills it no longer gets, and keeps them out of git. Hive's copies carry a marker file
   * (with the source's hash): folders without one are the user's and are never touched. An unchanged skill isn't
   * copied again, and a changed one is swapped in whole (swapIn), so another agent sharing the folder never reads
   * one half-copied; it does read the new version from then on (Codex reads a skill's files when it uses it). What a
   * swap interrupted by a crash left there is tidied first. Says what each skill's copy now is.
   */
  private syncSkills(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    // Codex agents sharing a folder start together (resuming after a restart): one copies at a time.
    return withFileLock(join(ctx.cwd, '.agents', 'skills'), () => this.syncSkillsNow(ctx))
  }

  private async syncSkillsNow(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    const dir = join(ctx.cwd, '.agents', 'skills')
    const out: Record<string, SkillDelivery> = {}
    const wanted = new Map(ctx.skills.map((s) => [`hive-${s.name}`, s]))
    if (!ctx.skills.length && !existsSync(dir)) return out
    await mkdir(dir, { recursive: true })
    // Under the same lock as the swaps: Hive's own leftovers only (dot-folders named for a swap).
    await cleanSwaps(dir)
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      // A copy Hive no longer gives that can't be removed now (a file in it open) goes at a later launch.
      if (f.startsWith('hive-') && !wanted.has(f) && (await skillMarker(join(dir, f))) !== null) await removePath(join(dir, f)).catch((e) => log.warn(`Could not remove ${userText(f)} for Codex; trying again next time`, e))
    }
    for (const [folder, s] of wanted) {
      // One skill's failure is its own: the others are still delivered, and each record says what Codex reads.
      try {
        out[s.name] = await this.deliverSkill(s, join(dir, folder), folder)
      } catch (e) {
        log.warn(`Could not copy skill ${userText(s.name)} for Codex`, e)
        out[s.name] = await keptCopy(join(dir, folder), 'it could not be copied')
      }
    }
    // Keeping the copies out of git: a failure here changes nothing about what was delivered.
    await this.excludeCopies(ctx.cwd).catch((e) => log.warn('Could not add Hive\'s Codex skill copies to git\'s exclude file', e))
    return out
  }

  /** One skill into its folder in .agents/skills (under syncSkills' lock): what Codex reads of it afterwards. */
  private async deliverSkill(s: LaunchContext['skills'][number], dest: string, folder: string): Promise<SkillDelivery> {
    // One identity for the source, Hive's copies and their markers: contentHash, which counts links (never following
    // them) and leaves the marker out. A marker from before (another hash) just means one more copy.
    let hash: string
    try {
      hash = await contentHash(s.sourcePath)
    } catch (e) {
      // Not copied. Hive's copy from an earlier launch stays, and is what Codex reads: its revision is what reached the
      // session. A folder of the user's with the name is theirs, not a delivery. Too big lasts until the skill is
      // smaller; a source that couldn't be read (gone, or being edited) may work at the next launch.
      if (e instanceof ContentTooLarge) return { ...(await keptCopy(dest, tooBigToDeliver(e))), lasting: true }
      log.warn(`Could not read skill ${userText(s.name)} for Codex`, e)
      return keptCopy(dest, sourceProblem(e, s.sourcePath))
    }
    const revision = (): Promise<string | null> => contentHash(dest).catch(() => null)
    // What Codex reads now: the copy's revision, or why it has none (never a silent null).
    const current = async (): Promise<SkillDelivery> => {
      try {
        return { revision: await contentHash(dest) }
      } catch (e) {
        return e instanceof ContentTooLarge ? { revision: null, problem: tooBigToDeliver(e), lasting: true } : { revision: null, problem: 'its copy could not be read' }
      }
    }
    const had = existsSync(dest) ? await skillMarker(dest) : undefined
    if (had === hash) return current()
    if (had === null) {
      // Not marked: the user's own folder, unless it is an unchanged copy from before markers.
      if ((await revision()) !== hash) {
        log.warn(`Not copying skill ${userText(s.name)} for Codex: ${userText(dest)} is not Hive's copy.`)
        return { revision: null, problem: `a folder of the user's in .agents/skills is named ${folder}`, lasting: true }
      }
      await writeFile(join(dest, SKILL_MARKER), JSON.stringify({ source: s.sourcePath, hash }) + '\n')
      return current()
    }
    try {
      // The copy is checked before it goes in (within the limits, as the source is read), and its marker and the record
      // are what was copied: the source may have changed since it was hashed above.
      const copied = await swapIn(s.sourcePath, dest, { prepare: (copy, rev) => writeFile(join(copy, SKILL_MARKER), JSON.stringify({ source: s.sourcePath, hash: rev }) + '\n') })
      return { revision: copied }
    } catch (e) {
      log.warn(`Could not update skill ${userText(s.name)} for Codex; it keeps the copy it has`, e)
      // A link the skill has that can't be made here, or a source grown past the limits while it was copied: a restart
      // won't change that. A source gone or unreadable while it was copied may work next time. Either way nothing was
      // replaced: what Codex reads is the copy that was there.
      if (e instanceof LinkNotCopied) return { ...(await keptCopy(dest, e.message)), lasting: true }
      if (e instanceof ContentTooLarge) return { ...(await keptCopy(dest, tooBigToDeliver(e))), lasting: true }
      if (e instanceof CopyFailed || !existsSync(s.sourcePath)) return keptCopy(dest, sourceProblem(e, s.sourcePath))
      // With a file in the old copy open, that copy stays until a later launch.
      const code = (e as NodeJS.ErrnoException).code
      const kept = existsSync(dest) ? await revision() : null
      if (!kept) return { revision: null, problem: 'it could not be copied' }
      // Windows won't move a folder with a file in it open (EBUSY, EPERM, EACCES): a running session is reading it.
      return { revision: kept, problem: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'its old copy was in use, so it kept that one' : `it could not be copied${code ? ` (${code})` : ''}, so it kept its old copy` }
    }
  }

  /** Keeps Hive's copies (and a swap's dot-folders) out of git, in the repository's info/exclude. */
  private async excludeCopies(cwd: string): Promise<void> {
    const common = await run('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], 5000)
    const gitDir = common.code === 0 ? common.stdout.trim() : ''
    if (!gitDir) return
    const exclude = join(isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir), 'info', 'exclude')
    const text = await readFile(exclude, 'utf8').catch(() => '')
    const lines = text.split(/\r?\n/)
    // Hive's copies, and the dot-folders a swap uses for a moment (left behind only by a crash, until the next launch).
    const missing = ['/.agents/skills/hive-*/', '/.agents/skills/.hive-*/'].filter((l) => !lines.includes(l))
    if (missing.length) {
      await mkdir(join(exclude, '..'), { recursive: true })
      await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${lines.some((l) => l.startsWith("# Hive's copies of workspace skills")) ? '' : "# Hive's copies of workspace skills for Codex (added by Hive)\n"}${missing.join('\n')}\n`)
    }
  }

  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(ctx.cwd, '.agents', 'skills', `hive-${skill}`)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    const delivered = await this.syncSkills(ctx).catch(async (e) => {
      // The folder couldn't be set up or locked: nothing was copied, and each skill is what was there before (a copy
      // Hive made at an earlier launch, read without the lock: another launch may be changing it).
      log.warn('Could not copy skills for Codex', e)
      const dir = join(ctx.cwd, '.agents', 'skills')
      const out: Record<string, SkillDelivery> = {}
      for (const s of ctx.skills) out[s.name] = await keptCopy(join(dir, `hive-${s.name}`), 'the skills could not be copied')
      return out
    })
    await this.checkHookHashes(ctx)
    return delivered
  }

  /** Which hook hashes to trust for this launch (hashesByRun): Hive's own, unless this Codex version hashes differently. */
  private async checkHookHashes(ctx: LaunchContext): Promise<void> {
    const version = (await run(ctx.executable, ['--version'], 10000)).stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? 'unknown'
    // Hooks only (without the trust records), to ask Codex what it calls and hashes them.
    const hooksOnly = hookOverrides(ctx.hookUrl, ctx.hookAuthFile).slice(0, -2)
    const known = this.hashCheck.get(version)
    if (known === true) return
    if (this.unreachable.has(version)) return
    const theirs = await hooksFromCodex(ctx.executable, hooksOnly, ctx.cwd)
    // Codex couldn't be asked: Hive's own hashes are the best guess. Don't wait for it again this run.
    if (!theirs) {
      this.unreachable.add(version)
      log.warn(`Codex ${version}: couldn't check hook hashes with its app server; using Hive's`)
      return
    }
    if (known === undefined) {
      const command = hookCommand(ctx.hookUrl, ctx.hookAuthFile)
      const same = HOOKS.every((h) => theirs[`${SESSION_FLAGS}:${h.label}:0:0`] === hookHash(h.label, h.matcher, command, h.timeout))
      this.hashCheck.set(version, same)
      if (same) return
      log.warn(`Codex ${version} hashes hooks differently from Hive; Hive asks Codex for the hashes on each launch`)
    }
    this.hashesByRun.set(ctx.runId, theirs)
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const args: string[] = []
    if (ctx.resume && ctx.sessionId) args.push('resume', ctx.sessionId)
    // Options come after "resume <id>": before it, Codex ignores them.
    args.push('--no-daemon')
    args.push(...hookOverrides(ctx.hookUrl, ctx.hookAuthFile, this.hashesByRun.get(ctx.runId)))
    this.hashesByRun.delete(ctx.runId)
    args.push('-c', `tui.terminal_title=${toToml(TITLE_ITEMS)}`)
    if (ctx.model) args.push('-m', ctx.model)
    if (ctx.effort) args.push('-c', `model_reasoning_effort=${toToml(ctx.effort)}`)
    args.push(...(CODEX_MODE_FLAGS[ctx.permissionMode ?? ''] ?? CODEX_MODE_FLAGS[CODEX_DESCRIPTOR.defaultPermissionMode]))
    const developer = [ctx.guidance, ctx.instructions].filter((t) => t && t.trim()).join('\n\n')
    if (developer) args.push('-c', `developer_instructions=${toToml(developer)}`)
    // Only the workspace's MCP servers: the user's own (and a project's own) are turned off, as for Claude Code.
    for (const [name, def] of Object.entries(ctx.mcpServers)) {
      const { table, warning } = codexMcpServer(name, def)
      if (warning) log.warn(warning)
      if (table) args.push('-c', `mcp_servers.${name}=${toToml(table)}`)
    }
    const own = new Set(Object.keys(ctx.mcpServers))
    const theirs = new Set([...Object.keys(mcpServersIn(join(codexHome(), 'config.toml'))), ...Object.keys(mcpServersIn(join(ctx.cwd, '.codex', 'config.toml')))])
    for (const name of theirs) {
      if (own.has(name)) continue
      if (/^[A-Za-z0-9_-]+$/.test(name)) args.push('-c', `mcp_servers.${name}.enabled=false`)
      else log.warn(`Codex MCP server ${userText(name)} can't be turned off for Hive sessions (its name needs quoting).`)
    }
    args.push(...ctx.extraArgs)
    // Codex takes a first prompt as its last argument (after "resume <id>" too) and starts on it.
    if (ctx.initialPrompt) args.push(promptArg(executable, ctx.initialPrompt))
    const s = toSpawnable(executable, args)
    return { file: s.file, args: s.args, env: ctx.env }
  }

  // -------------------------------------------------------------------------
  // Hooks and live details
  // -------------------------------------------------------------------------

  normalizeHook(body: Record<string, any>): NormalizedHook {
    const event = String(body.hook_event_name ?? '')
    const out: NormalizedHook = {
      event: { kind: 'ignore' },
      sessionId: typeof body.session_id === 'string' ? body.session_id : null,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : null,
      // Codex's permission_mode doesn't follow its presets or Plan mode; the rollout says (transcriptDetails).
      mode: null,
      editedPaths: []
    }
    const tool = String(body.tool_name ?? '')
    const input = body.tool_input ?? {}
    switch (event) {
      case 'SessionStart':
        out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
        break
      case 'UserPromptSubmit':
        out.event = { kind: 'prompt' }
        break
      case 'PreToolUse':
        if (tool === 'request_user_input' || tool === 'request_user_input_async') {
          // The async one returns at once and Codex carries on; the answer comes later as a prompt.
          const q = Array.isArray(input.questions) ? input.questions[0] : null
          out.event = { kind: 'ask', ask: { kind: 'question', blocking: tool === 'request_user_input', message: String(q?.question ?? q?.title ?? ''), call: toolCall(tool, input) } }
        } else {
          out.event = { kind: 'toolStart' }
          if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') out.editedPaths = patchPaths(String(input.command ?? input.patch ?? ''))
        }
        break
      case 'PostToolUse':
        out.event = { kind: 'toolEnd', call: toolCall(tool, input) }
        break
      case 'PermissionRequest': {
        const line = String(input.command ?? '').split('\n')[0]
        const what = tool === 'apply_patch' ? `edit ${patchPaths(String(input.command ?? '')).join(', ')}` : tool === 'Bash' ? `run ${line.length > 120 ? `${line.slice(0, 119)}…` : line}` : tool ? `use ${tool}` : 'continue'
        // Sent before anyone answers it: in Approve for me, Codex's auto-reviewer does (ModeOption.reviewed).
        out.event = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: `Codex asks to ${what}`, call: toolCall(tool, input) } }
        break
      }
      case 'Stop':
        out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
        break
      case 'Interrupt':
        out.event = { kind: 'interrupt' }
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

  /**
   * Codex titles its terminal "[ ! ] Action Required | <project>" (blinking with "[ . ]") exactly while a person
   * must act (an approval prompt, a question), and not while its auto-reviewer decides. Older versions than the one
   * Hive was tested with go by the hooks.
   */
  titleAttention(version: string | null): ((title: string) => boolean) | null {
    if (!version || compareVersions(version, ACTION_REQUIRED_SINCE) < 0) return null
    return (title) => /^\[ [!.] \] Action Required\b/.test(title)
  }

  transcriptDetails(appended: string): LiveDetails {
    return rolloutDetails(appended)
  }

  backgroundTasks(appended: string, memo: Record<string, unknown>): BackgroundTaskEvent[] {
    return codexBackgroundTasks(appended, (memo.codex ??= codexBackgroundMemo()) as CodexBackgroundMemo)
  }

  /**
   * Codex's /permissions menu numbers its presets, and typing a number picks one (arrow keys wrap around, so counting
   * presses is unreliable). Which number is read from the menu Codex draws, by the preset's label: Codex 0.161 reordered
   * the menu (#396, permissionsMenu.ts), and a label it doesn't show fails the pick rather than choosing another preset.
   * Hive confirms the result from the rollout's thread_settings_applied, which Codex writes at once.
   */
  modeMenuKeys(target: PermissionMode): KeySteps {
    return [
      { keys: '\x15', waitMs: 150 },
      { keys: '/permissions', waitMs: 200 },
      { keys: '\r', waitMs: 200 },
      { pick: (screen) => permissionsMenuNumber(screen, target), what: `"${PERMISSIONS_MENU_LABELS[target] ?? target}" in Codex's /permissions menu`, waitMs: 300 }
    ]
  }

  /** Codex prints "Permission selection requested: <preset>" as soon as a preset is picked. */
  modeFromOutput(tail: string): PermissionMode | null {
    const m = [...tail.matchAll(/Permission selection requested: (Read Only|Ask for approval|Approve for me|Full Access)/gi)].pop()
    if (!m) return null
    const said = m[1].toLowerCase()
    return CODEX_PERMISSION_MODES.find((x) => x.label.toLowerCase() === said || (said === 'full access' && x.value === 'full-access') || (said === 'read only' && x.value === 'read-only'))?.value ?? null
  }

  canSwitchLive(): boolean {
    return true
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  /** The rollout list, reused for a few seconds: a session list asks for it once per project and session. */
  private rolloutList: { at: number; home: string; list: Promise<string[]> } | null = null
  /** Sessions looked for and not found, so a deleted rollout doesn't mean walking every rollout again each time. */
  private misses = new Map<string, number>()

  private rollouts(): Promise<string[]> {
    const home = codexHome()
    if (this.rolloutList && this.rolloutList.home === home && Date.now() - this.rolloutList.at < 10_000) return this.rolloutList.list
    const list = this.walkRollouts()
    this.rolloutList = { at: Date.now(), home, list }
    return list
  }

  private async walkRollouts(): Promise<string[]> {
    const root = join(codexHome(), 'sessions')
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: import('original-fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p)
      }
    }
    await walk(root, 0)
    return out
  }

  /** The session_meta of a rollout (id, cwd), cached by path and modification time. */
  private async meta(path: string): Promise<{ id: string; cwd: string; sub: SubSession | null } | null> {
    try {
      const s = await stat(path)
      const c = this.metas.get(path)
      if (c && c.mtime === s.mtimeMs) return c
      const r = JSON.parse(await readFirstLine(path))
      const p = r?.payload ?? {}
      if (r?.type !== 'session_meta' || typeof p.cwd !== 'string') return null
      const m = { id: String(p.id ?? p.session_id ?? idFromFile(path) ?? ''), cwd: p.cwd, sub: rolloutSubSession(p), mtime: s.mtimeMs }
      this.metas.set(path, m)
      return m
    } catch {
      return null
    }
  }

  async transcriptPath(_folder: string, sessionId: string, recorded?: string): Promise<string | null> {
    assertSessionId(sessionId)
    if (recorded && existsSync(recorded)) return recorded
    const cached = this.paths.get(sessionId)
    if (cached && existsSync(cached)) return cached
    if (Date.now() - (this.misses.get(sessionId) ?? 0) < 60_000) return null
    for (const p of await this.rollouts()) {
      const id = idFromFile(p)
      if (id) this.paths.set(id, p)
    }
    const found = this.paths.get(sessionId)
    if (found && existsSync(found)) {
      this.misses.delete(sessionId)
      return found
    }
    this.misses.set(sessionId, Date.now())
    return null
  }

  /** Codex finds a session by the path it first wrote it to, so a backup only restores there. */
  restorePath(_folder: string, _sessionId: string, recorded?: string): string | null {
    return recorded ?? null
  }

  async listSessions(folder: string): Promise<ExternalSession[]> {
    const want = resolve(folder).toLowerCase()
    const out: ExternalSession[] = []
    for (const p of await this.rollouts()) {
      const m = await this.meta(p)
      if (!m || !isSessionId(m.id) || resolve(m.cwd).toLowerCase() !== want) continue
      const s = await stat(p).catch(() => null)
      if (s && s.size > 0) out.push({ id: m.id, transcriptPath: p, modified: s.mtime.toISOString(), ...(m.sub ? { sub: m.sub } : {}) })
    }
    return out
  }

  async subSessionOf(path: string): Promise<SubSession | null> {
    return (await this.meta(path))?.sub ?? null
  }

  /** Session names from Codex's session_index.jsonl ({id, thread_name}). */
  private title(sessionId: string): string | null {
    const file = join(codexHome(), 'session_index.jsonl')
    try {
      const m = statSync(file).mtimeMs
      if (!this.titles || this.titles.mtime !== m) {
        const map = new Map<string, string>()
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          try {
            const r = JSON.parse(line)
            if (typeof r.id === 'string' && typeof r.thread_name === 'string') map.set(r.id, r.thread_name)
          } catch {
            // skip
          }
        }
        this.titles = { mtime: m, map }
      }
      return this.titles.map.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  parseUsage(text: string, sessionId: string) {
    return parseRollout(text, sessionId, this.title(sessionId))
  }

  usageParser(sessionId: string): UsageParser {
    const p = new CodexUsageParser(sessionId)
    // The title is Codex's own (its session index), which can change as the rollout grows.
    return { feed: (text) => p.feed(text), result: () => p.result(this.title(sessionId)) }
  }

  conversationParser(projectPath: string): CodexConversationParser {
    return new CodexConversationParser(projectPath)
  }

  imageData = codexImageData

  exportSubtitle(sessionId: string, project: string): string {
    return `Codex session \`${sessionId}\` · project ${project}`
  }

  // -------------------------------------------------------------------------
  // Project files
  // -------------------------------------------------------------------------

  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const p = this.id
    const sources: MemorySource[] = [
      { provider: p, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false },
      { provider: p, id: 'user', label: 'User AGENTS.md (all projects)', path: join(codexHome(), 'AGENTS.md'), kind: 'claude-md', exists: false }
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    return sources
  }

  /** In Codex's folder, only the user AGENTS.md (editable) and skills (read-only). Never credentials or config. */
  fileAllowed(path: string, write: boolean): boolean {
    const home = resolve(codexHome()).toLowerCase()
    const abs = resolve(path).toLowerCase()
    if (!abs.startsWith(home + '\\') && !abs.startsWith(home + '/')) return false
    const rel = abs.slice(home.length + 1).replace(/\\/g, '/')
    if (rel === 'agents.md') return true
    return !write && rel.startsWith('skills/') && basename(rel) === 'skill.md'
  }

  skillRoots(): SkillRoots {
    return { machine: [join(codexHome(), 'skills')], plugins: null, local: join('.agents', 'skills'), hiveCopyPrefix: 'hive-' }
  }

  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    return mcpServersIn(join(projectPath, '.codex', 'config.toml'))
  }
}

export const codex = new CodexAdapter()
