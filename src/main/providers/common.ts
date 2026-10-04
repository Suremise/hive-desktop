import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, delimiter, dirname, join } from 'path'
import type { RecacheEstimate, SessionUsage } from '../../shared/types'

/** Helpers shared by provider adapters. */

export function run(file: string, args: string[], timeoutMs = 15000, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = /\.(cmd|bat)$/i.test(file)
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell, encoding: 'utf8', env }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1 })
    })
  })
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Copies of a CLI that belong to an editor extension (VS Code, Cursor…), which Hive never uses. */
export const EDITOR_EXTENSION_PATH = /[\\/]\.(vscode|vscode-insiders|cursor|windsurf)[\\/]extensions[\\/]/i

export const EDITOR_ROOTS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']

/** The longest command line cmd.exe runs; CreateProcess, which starts an .exe directly, allows 32,767 characters. */
export const CMD_MAX_CHARS = 8191

/**
 * npm's launcher for a Node package's bin (cmd-shim), line by line, with the last line's script path left open: it
 * runs that script with node.exe beside it or `node` on PATH, and passes on exactly its arguments (%*).
 */
const NPM_SHIM_LINES = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  'SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  'SET "_prog=node"',
  'SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')'
]
const NPM_SHIM_RUN = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\([^"%*?<>|&^]+\.[cm]?js)" %\*$/
const ONE_LINE_RUN = /^@node "%~dp0\\?([^"%*?<>|&^]+\.[cm]?js)" %\*$/

/**
 * The node and script a Node CLI's .cmd launcher runs, so Hive can start them directly instead of through cmd.exe (and
 * its 8,191-character command line, which the Hive Assistant's Codex launch is longer than). Only launchers that do
 * nothing else are taken, matched whole: npm's (NPM_SHIM_LINES) and the bare one-line `@node "%~dp0cli.cjs" %*`. One
 * that sets anything, passes its own arguments or Node flags, or runs another interpreter gives null and still goes
 * through cmd.exe, since starting its script directly would leave that out.
 */
export function shimTarget(cmdFile: string, env: NodeJS.ProcessEnv = process.env): { node: string; script: string } | null {
  let text: string
  try {
    if (statSync(cmdFile).size > 64 * 1024) return null
    text = readFileSync(cmdFile, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const dir = dirname(cmdFile)
  let rel: string | undefined
  let besideFirst = false
  if (lines.length === 1) rel = ONE_LINE_RUN.exec(lines[0])?.[1]
  else if (lines.length === NPM_SHIM_LINES.length + 1 && NPM_SHIM_LINES.every((l, i) => lines[i] === l)) {
    rel = NPM_SHIM_RUN.exec(lines[NPM_SHIM_LINES.length])?.[1]
    besideFirst = true
  }
  if (!rel) return null
  const script = join(dir, rel)
  if (!existsSync(script)) return null
  const beside = join(dir, 'node.exe')
  const node = besideFirst && existsSync(beside) ? beside : onPath('node.exe', env)
  return node ? { node, script } : null
}

/** A program on PATH (as cmd.exe would find it), or null. */
function onPath(exe: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? env.Path ?? ''
  for (const d of path.split(delimiter)) {
    if (!d) continue
    const f = join(d.replace(/^"|"$/g, ''), exe)
    if (existsSync(f)) return f
  }
  return null
}

/** Whether Hive starts this executable through cmd.exe (a .cmd/.bat it can't start directly). */
export function runsThroughCmd(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file) && !shimTarget(file)
}

/**
 * How to start a CLI with node-pty: an .exe as it is; a Node CLI's .cmd launcher as its node and script (shimTarget);
 * any other .cmd/.bat through cmd.exe, refused with a clear error when the command line is longer than cmd.exe takes.
 */
export function toSpawnable(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const direct = shimTarget(file)
    if (direct) return { file: direct.node, args: [direct.script, ...args] }
    const out = { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }
    const length = commandLineLength(out.file, out.args)
    if (length > CMD_MAX_CHARS) {
      throw new Error(`${basename(file)} has to run through cmd.exe, which takes a command line of at most ${CMD_MAX_CHARS.toLocaleString('en')} characters, and this launch needs about ${length.toLocaleString('en')}. Set the CLI's path in Settings to its .exe (or install the standalone CLI), which has no such limit.`)
    }
    return out
  }
  return { file, args }
}

/** About how long a Windows command line is with these arguments, quoted as CreateProcess needs (an estimate, on the long side). */
export function commandLineLength(file: string, args: string[]): number {
  const quoted = (a: string): number => (/[\s"]/.test(a) || !a ? a.length + 2 + (a.match(/["\\]/g)?.length ?? 0) : a.length)
  return [file, ...args].reduce((n, a) => n + quoted(a) + 1, 0)
}

/**
 * A shell command that forwards a hook's JSON (stdin) to Hive's hook server with curl, which ships
 * with Windows 10+. For hooks a CLI can only run as commands. The token is written literally so the
 * command works whichever shell the CLI runs it in; forward slashes keep bash from eating backslashes.
 */
/**
 * A first task as the CLI's last argument. A .cmd/.bat Hive can't start directly runs through cmd.exe, which can't pass
 * newlines or its special characters safely, so there it becomes one plain line (a Node CLI's launcher is started as
 * node and its script, which take it as it is). A leading dash would read as an option.
 */
export function promptArg(executable: string, text: string): string {
  let t = runsThroughCmd(executable) ? text.replace(/["%^&|<>!]/g, ' ').replace(/\s+/g, ' ').trim() : text.trim()
  if (t.startsWith('-')) t = `Task: ${t}`
  return t
}

export function hookForwardCommand(hookUrl: string, token: string): string {
  const curl = process.platform === 'win32' ? `"${join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe').split('\\').join('/')}"` : 'curl'
  return `${curl} -s -m 5 -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- "${hookUrl}"`
}

/** Estimates how many tokens resuming a session will write to the prompt cache (providers with a cache TTL). */
export function recacheEstimate(usage: SessionUsage, ttlOverride: 'auto' | '5m' | '1h', now = Date.now()): RecacheEstimate {
  const ttlSeconds = ttlOverride === '5m' ? 300 : ttlOverride === '1h' ? 3600 : usage.cacheTtlSeconds
  const last = usage.lastActivity ? Date.parse(usage.lastActivity) : 0
  const elapsed = last ? (now - last) / 1000 : Infinity
  const warm = elapsed < ttlSeconds
  return {
    tokens: usage.contextTokens,
    warm,
    secondsLeft: warm ? Math.max(0, Math.round(ttlSeconds - elapsed)) : 0,
    ttlSeconds
  }
}
