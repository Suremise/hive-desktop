import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, basename } from 'path'
import { mkdir, readdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { AgentInstallInfo, MemorySource } from '../../shared/types'
import { HIVE_DIR, MAIN_AGENT } from '../../shared/defaults'
import { config } from '../config'
import { copyDir, isDir, removePath, writeJsonAtomic, hashDir } from '../fsutil'
import { createLogger } from '../logger'
import { encodeProjectPath } from './transcript'
import type { AgentAdapter, CommandSpec, ExternalSession, LaunchContext } from './types'

const log = createLogger('claude-code')

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'] as const

/** Tools that edit files: PreToolUse checks them against other agents' file locks. */
export const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit'

/**
 * SessionStart only supports command hooks (not http), so it forwards its JSON (stdin) to Hive's
 * hook server with curl, which ships with Windows 10+. The token is written literally so the
 * command works whichever shell Claude Code runs it in.
 */
export function sessionStartCommand(hookUrl: string, token: string): string {
  // Forward slashes: valid for Windows and safe from backslash-escaping if the shell is bash.
  const curl = process.platform === 'win32' ? `"${join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe').split('\\').join('/')}"` : 'curl'
  return `${curl} -s -m 5 -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- "${hookUrl}"`
}

function run(file: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = /\.(cmd|bat)$/i.test(file)
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1 })
    })
  })
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const EDITOR_EXTENSION_PATH = /[\\/]\.(vscode|vscode-insiders|cursor|windsurf)[\\/]extensions[\\/]/i

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Wraps .cmd/.bat launchers so node-pty can start them. */
export function toSpawnable(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }
  }
  return { file, args }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code'
  readonly displayName = 'Claude Code'

  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = config.settings.claude.executablePath.trim()
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
    for (const root of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
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

  /**
   * Generated skills, MCP config and hooks for a launch. Each agent has its own folder, because a launch
   * replaces the folder while the project's other agents may still be reading theirs.
   */
  launchDir(projectPath: string, agentId: string = MAIN_AGENT): string {
    return join(projectPath, HIVE_DIR, agentId === MAIN_AGENT ? 'launch' : `launch-${agentId}`)
  }

  /** Rebuilds <project>/.hive/launch with exactly the enabled skills, MCP servers and Hive's hooks. */
  async prepareLaunch(ctx: LaunchContext): Promise<void> {
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    await removePath(dir)
    const pluginDir = join(dir, 'plugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeJsonAtomic(join(pluginDir, '.claude-plugin', 'plugin.json'), {
      name: 'hive',
      version: '1.0.0',
      description: 'Skills enabled for this project by Hive. Regenerated on every session launch — do not edit.'
    })
    const hashes: Record<string, string> = {}
    for (const skill of ctx.skills) {
      const dest = join(pluginDir, 'skills', skill.name)
      await copyDir(skill.sourcePath, dest)
      hashes[`skill:${skill.name}`] = await hashDir(skill.sourcePath)
    }
    await writeJsonAtomic(join(dir, 'mcp.json'), { mcpServers: ctx.mcpServers })

    const hook = {
      type: 'http',
      url: ctx.hookUrl,
      timeout: 5,
      headers: { Authorization: 'Bearer $HIVE_HOOK_TOKEN' },
      allowedEnvVars: ['HIVE_HOOK_TOKEN']
    }
    const hooks: Record<string, unknown[]> = {}
    for (const ev of HOOK_EVENTS) {
      if (ev === 'SessionStart') {
        hooks[ev] = [{ hooks: [{ type: 'command', command: sessionStartCommand(ctx.hookUrl, ctx.env.HIVE_HOOK_TOKEN ?? ''), timeout: 5 }] }]
        continue
      }
      // PreToolUse answers with a lock decision, so it gets a longer timeout; if Hive doesn't answer, the edit goes ahead.
      if (ev === 'PreToolUse') hooks[ev] = [{ matcher: EDIT_TOOLS, hooks: [{ ...hook, timeout: 10 }] }]
      else hooks[ev] = [ev === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }]
    }
    // The status line forwards Claude Code's status JSON (model, effort, cost, plan limits) to Hive and
    // prints nothing, so no line is added to the terminal.
    const statusLine = { type: 'command', command: sessionStartCommand(`${ctx.hookUrl}?statusline`, ctx.env.HIVE_HOOK_TOKEN ?? ''), padding: 0 }
    await writeJsonAtomic(join(dir, 'settings.json'), { hooks, statusLine })
    await writeJsonAtomic(join(ctx.projectPath, HIVE_DIR, 'sync.json'), { launchedAt: new Date().toISOString(), hashes })
    await writeFile(
      join(dir, 'README.txt'),
      'This folder is generated by Hive each time a session starts. Edits here are overwritten.\n'
    )
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    const args: string[] = []
    if (ctx.resume) args.push('--resume', ctx.sessionId)
    else args.push('--session-id', ctx.sessionId)
    if (ctx.name) args.push('--name', ctx.name)
    args.push('--plugin-dir', join(dir, 'plugin'))
    args.push('--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config')
    args.push('--settings', join(dir, 'settings.json'))
    if (ctx.model) args.push('--model', ctx.model)
    if (ctx.effort) args.push('--effort', ctx.effort)
    if (ctx.permissionMode) args.push('--permission-mode', ctx.permissionMode)
    args.push(...ctx.extraArgs)
    const s = toSpawnable(executable, args)
    return { file: s.file, args: s.args, env: ctx.env }
  }

  async transcriptDir(projectPath: string): Promise<string | null> {
    const root = join(claudeHome(), 'projects')
    const encoded = encodeProjectPath(projectPath).toLowerCase()
    try {
      const match = (await readdir(root)).find((d) => d.toLowerCase() === encoded)
      return match ? join(root, match) : null
    } catch {
      return null
    }
  }

  async transcriptPath(projectPath: string, sessionId: string): Promise<string | null> {
    const dir = await this.transcriptDir(projectPath)
    if (!dir) return null
    const p = join(dir, `${sessionId}.jsonl`)
    return existsSync(p) ? p : null
  }

  /** Where a transcript would be written for a project that has none yet. */
  defaultTranscriptPath(projectPath: string, sessionId: string): string {
    return join(claudeHome(), 'projects', encodeProjectPath(projectPath), `${sessionId}.jsonl`)
  }

  async listSessions(projectPath: string): Promise<ExternalSession[]> {
    const dir = await this.transcriptDir(projectPath)
    if (!dir) return []
    const out: ExternalSession[] = []
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue
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

  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const sources: MemorySource[] = [
      { id: 'project', label: 'CLAUDE.md', path: join(projectPath, 'CLAUDE.md'), kind: 'claude-md', exists: false },
      { id: 'project-dot', label: '.claude/CLAUDE.md', path: join(projectPath, '.claude', 'CLAUDE.md'), kind: 'claude-md', exists: false },
      { id: 'local', label: 'CLAUDE.local.md', path: join(projectPath, 'CLAUDE.local.md'), kind: 'local-md', exists: false },
      { id: 'user', label: 'User CLAUDE.md (all projects)', path: join(claudeHome(), 'CLAUDE.md'), kind: 'claude-md', exists: false }
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    const dir = await this.transcriptDir(projectPath)
    const memDir = dir ? join(dir, 'memory') : null
    if (memDir && (await isDir(memDir))) {
      const files = (await readdir(memDir)).filter((f) => f.endsWith('.md')).sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      for (const f of files) {
        sources.push({ id: `auto:${f}`, label: f, path: join(memDir, f), kind: 'auto-memory', exists: true })
      }
    }
    return sources
  }
}

export const claudeCode = new ClaudeCodeAdapter()
