import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { parse as parseToml } from 'smol-toml'
import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, ReadinessIssue } from '../../../shared/types'
import { assertSessionId, isSessionId } from '../../../shared/defaults'
import { CODEX, CODEX_DESCRIPTOR, CODEX_MODE_FLAGS, CODEX_PERMISSION_MODES } from '../../../shared/codex'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { copyDir, hashDir, removePath } from '../../fsutil'
import { createLogger } from '../../logger'
import { findSecretWarnings } from '../../mcpSecrets'
import { EDITOR_EXTENSION_PATH, EDITOR_ROOTS, compareVersions, hookForwardCommand, run, toSpawnable } from '../common'
import type { CommandSpec, ExternalSession, KeySteps, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillRoots } from '../types'
import { CodexConversationParser, codexImageData, parseRollout, patchPaths, rolloutDetails } from './rollout'

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
 * a bare @- is splatting: so curl.exe unquoted (it is on PATH) and "@-" quoted.
 */
function hookCommand(url: string, token: string): string {
  if (process.platform !== 'win32') return hookForwardCommand(url, token)
  return `curl.exe -s -m 5 -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary "@-" "${url}"`
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
function hookOverrides(url: string, token: string, hashes?: Record<string, string>): string[] {
  const command = hookCommand(url, token)
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

/** The first line of a file (Codex's session_meta), read without loading the whole transcript. */
async function firstLine(path: string, max = 1 << 20): Promise<string> {
  const fh = await open(path, 'r')
  try {
    let out = ''
    const buf = Buffer.alloc(64 * 1024)
    let pos = 0
    while (out.length < max) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      const chunk = buf.toString('utf8', 0, bytesRead)
      const nl = chunk.indexOf('\n')
      if (nl >= 0) return out + chunk.slice(0, nl)
      out += chunk
      pos += bytesRead
    }
    return out
  } finally {
    await fh.close()
  }
}

/** Marks Hive's copies of workspace skills in .agents/skills (so only those are ever replaced or removed). */
const SKILL_MARKER = '.hive-copy'

/** Session id from a rollout file name (rollout-<local time>-<uuid>.jsonl). */
const idFromFile = (f: string): string | null => /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f)?.[1] ?? null

export class CodexAdapter implements ProviderAdapter {
  readonly id = CODEX
  readonly descriptor = CODEX_DESCRIPTOR
  /** A parent Codex session's identity, when Hive runs inside one. User configuration (CODEX_HOME…) is kept. */
  readonly envToStrip = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI']
  readonly compactFailure = null
  // SessionStart only comes with the first prompt; the composer's placeholder means Codex is up.
  readonly readyOutput = /Ask Codex to do anything/
  readonly planToggleKey = '\x1b[Z'
  /** Codex versions whose hook hashes Hive has checked against Codex itself: true = Hive's own hash matches. */
  private hashCheck = new Map<string, boolean>()
  /** Versions whose app server didn't answer this run (not asked again until Hive restarts). */
  private unreachable = new Set<string>()
  /** Rollout files by session id, and each file's session_meta (id, cwd). */
  private paths = new Map<string, string>()
  private metas = new Map<string, { id: string; cwd: string; mtime: number }>()
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
    const s = toSpawnable(executable, ['--no-daemon', '-C', dir, '-c', `projects=${toToml({ [dir]: { trust_level: 'trusted' } })}`, ...CODEX_MODE_FLAGS['read-only']])
    const keys = userConfig().windows?.sandbox === 'unelevated'
      ? [{ keys: '/setup-default-sandbox', waitMs: 300 }, { keys: '\r' }]
      : this.modeMenuKeys('ask')
    return { ...s, keys, readyPattern: /Ask Codex|›/ }
  }

  /** Codex's model catalog (codex debug models): the listed models, in Codex's order. */
  async listModels(executable: string): Promise<{ value: string; label: string }[] | null> {
    const r = await run(executable, ['debug', 'models'], 30000)
    if (r.code !== 0) return null
    try {
      const list = (JSON.parse(r.stdout) as { models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[] }).models ?? []
      const out = list
        .filter((m) => typeof m.slug === 'string' && m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((m) => ({ value: m.slug!, label: m.display_name?.replace(/-/g, ' ').replace(/^GPT /, 'GPT-') || m.slug! }))
      return out.length ? out : null
    } catch {
      return null
    }
  }

  configuredDefaultModel(): string | null {
    const m = userConfig().model
    return typeof m === 'string' && m.trim() ? m.trim() : null
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
   * Copies the enabled workspace skills into <cwd>/.agents/skills/hive-<name> (Codex has no per-launch
   * skills folder), removes Hive's copies that are no longer enabled, and keeps them out of git. Hive's
   * copies carry a marker file (with the source's hash): folders without one are the user's and are never
   * touched, and an unchanged skill isn't copied again (another agent may be reading it).
   */
  private async syncSkills(ctx: LaunchContext): Promise<void> {
    const dir = join(ctx.cwd, '.agents', 'skills')
    const wanted = new Map(ctx.skills.map((s) => [`hive-${s.name}`, s]))
    if (!ctx.skills.length && !existsSync(dir)) return
    await mkdir(dir, { recursive: true })
    const marker = async (folder: string): Promise<string | null> => {
      try {
        return (JSON.parse(await readFile(join(folder, SKILL_MARKER), 'utf8')) as { hash?: string }).hash ?? ''
      } catch {
        return null
      }
    }
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith('hive-') && !wanted.has(f) && (await marker(join(dir, f))) !== null) await removePath(join(dir, f))
    }
    for (const [folder, s] of wanted) {
      const dest = join(dir, folder)
      const hash = await hashDir(s.sourcePath)
      const had = existsSync(dest) ? await marker(dest) : undefined
      if (had === hash) continue
      if (had === null) {
        // Not marked: the user's own folder, unless it is an unchanged copy from before markers.
        if ((await hashDir(dest).catch(() => '')) !== hash) {
          log.warn(`Not copying skill "${s.name}" for Codex: ${dest} is not Hive's copy.`)
          continue
        }
      } else {
        await removePath(dest)
        await copyDir(s.sourcePath, dest)
      }
      await writeFile(join(dest, SKILL_MARKER), JSON.stringify({ source: s.sourcePath, hash }) + '\n')
    }
    const common = await run('git', ['-C', ctx.cwd, 'rev-parse', '--git-common-dir'], 5000)
    const gitDir = common.code === 0 ? common.stdout.trim() : ''
    if (!gitDir) return
    const exclude = join(isAbsolute(gitDir) ? gitDir : resolve(ctx.cwd, gitDir), 'info', 'exclude')
    const text = await readFile(exclude, 'utf8').catch(() => '')
    if (!text.split(/\r?\n/).includes('/.agents/skills/hive-*/')) {
      await mkdir(join(exclude, '..'), { recursive: true })
      await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# Hive's copies of workspace skills for Codex (added by Hive)\n/.agents/skills/hive-*/\n`)
    }
  }

  async prepareLaunch(ctx: LaunchContext): Promise<void> {
    await this.syncSkills(ctx).catch((e) => log.warn('Could not copy skills for Codex', e))
    const version = (await run(ctx.executable, ['--version'], 10000)).stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? 'unknown'
    const token = ctx.env.HIVE_HOOK_TOKEN ?? ''
    // Hooks only (without the trust records), to ask Codex what it calls and hashes them.
    const hooksOnly = hookOverrides(ctx.hookUrl, token).slice(0, -2)
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
      const command = hookCommand(ctx.hookUrl, token)
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
    args.push(...hookOverrides(ctx.hookUrl, ctx.env.HIVE_HOOK_TOKEN ?? '', this.hashesByRun.get(ctx.runId)))
    this.hashesByRun.delete(ctx.runId)
    if (ctx.model) args.push('-m', ctx.model)
    if (ctx.effort) args.push('-c', `model_reasoning_effort=${toToml(ctx.effort)}`)
    args.push(...(CODEX_MODE_FLAGS[ctx.permissionMode ?? ''] ?? CODEX_MODE_FLAGS[CODEX_DESCRIPTOR.defaultPermissionMode]))
    if (ctx.guidance) args.push('-c', `developer_instructions=${toToml(ctx.guidance)}`)
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
      else log.warn(`Codex MCP server "${name}" can't be turned off for Hive sessions (its name needs quoting).`)
    }
    args.push(...ctx.extraArgs)
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
        if (tool.startsWith('request_user_input')) {
          const q = Array.isArray(input.questions) ? input.questions[0] : null
          out.event = { kind: 'needsInput', message: String(q?.question ?? q?.title ?? 'Codex is asking you something') }
        } else {
          out.event = { kind: 'toolStart' }
          if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') out.editedPaths = patchPaths(String(input.command ?? input.patch ?? ''))
        }
        break
      case 'PostToolUse':
        out.event = { kind: 'toolEnd' }
        break
      case 'PermissionRequest': {
        const what = tool === 'apply_patch' ? `edit ${patchPaths(String(input.command ?? '')).join(', ')}` : tool === 'Bash' ? `run ${String(input.command ?? '').split('\n')[0].slice(0, 120)}` : tool ? `use ${tool}` : 'continue'
        out.event = { kind: 'needsInput', message: `Codex asks to ${what}` }
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

  transcriptDetails(appended: string): LiveDetails {
    return rolloutDetails(appended)
  }

  /**
   * Codex's /permissions menu numbers the presets in CODEX_PERMISSION_MODES order, and typing the number
   * picks one (arrow keys wrap around, so counting presses is unreliable). Hive confirms the result from the
   * rollout's thread_settings_applied, which Codex writes at once.
   */
  modeMenuKeys(target: PermissionMode): KeySteps {
    const index = CODEX_PERMISSION_MODES.findIndex((m) => m.value === target)
    return [
      { keys: '\x15', waitMs: 150 },
      { keys: '/permissions', waitMs: 200 },
      { keys: '\r', waitMs: 900 },
      { keys: String(index + 1), waitMs: 300 }
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
      let entries: import('fs').Dirent[]
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
  private async meta(path: string): Promise<{ id: string; cwd: string } | null> {
    try {
      const s = await stat(path)
      const c = this.metas.get(path)
      if (c && c.mtime === s.mtimeMs) return c
      const r = JSON.parse(await firstLine(path))
      const p = r?.payload ?? {}
      if (r?.type !== 'session_meta' || typeof p.cwd !== 'string') return null
      const m = { id: String(p.id ?? p.session_id ?? idFromFile(path) ?? ''), cwd: p.cwd, mtime: s.mtimeMs }
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
      if (s && s.size > 0) out.push({ id: m.id, transcriptPath: p, modified: s.mtime.toISOString() })
    }
    return out
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
