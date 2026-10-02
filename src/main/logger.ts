import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
let logFile: string | null = null

export function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function file(): string {
  if (!logFile) {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'hive.log')
  }
  return logFile
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra !== undefined ? ` ${safeJson(extra)}` : ''
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${detail}\n`
  if (!app.isPackaged) (level === 'error' ? console.error : console.log)(line.trimEnd())
  try {
    const f = file()
    if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, f.replace(/\.log$/, '.1.log'))
    appendFileSync(f, line)
  } catch {
    // Logging must never crash the app.
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * The user's own text in a log line (a card title, a name, a path, a prompt), between Unicode isolate marks
 * (invisible when the log is read). Help → Copy Diagnostics replaces each marked span (shared/redact.ts).
 */
export function userText(text: unknown): string {
  return `\u2068${String(text).replace(/[\u2068\u2069\r\n]/g, ' ')}\u2069`
}

/** Flags whose values are Hive's own choices (ids, models, modes), never the user's text. */
const PLAIN_VALUE_FLAGS = new Set(['--session-id', '--resume', 'resume', '--model', '-m', '--effort', '--permission-mode', '-s', '--sandbox', '-a', '--ask-for-approval', '--allowedTools'])

/**
 * A command line's arguments as logged: flags, and the values of the flags above, stay; every other value is the
 * user's text by default (a prompt, a session name, instructions, a path) and is marked, whatever it looks like.
 * Codex's `-c key=value` keeps its key, unless the key names an MCP server. A value written into its flag
 * (`--name=x`, `-c=key=value`) is treated the same. cmd.exe's own switches stay.
 */
export function argsForLog(args: string[]): string[] {
  const value = (flag: string | undefined, v: string): string => {
    if (flag && PLAIN_VALUE_FLAGS.has(flag) && /^[\w.:,[\]-]{1,200}$/.test(v)) return v
    if (flag === '-c' || flag === '--config') {
      const key = /^([A-Za-z_][\w.]*)=/.exec(v)?.[1]
      if (key && !key.startsWith('mcp_servers')) return `${key}=${userText(v.slice(key.length + 1))}`
    }
    return userText(v)
  }
  return args.map((arg, i) => {
    const inline = /^(-[^=\s]+)=([^]*)$/.exec(arg)
    if (inline) return `${inline[1]}=${value(inline[1], inline[2])}`
    if (arg.startsWith('-') || /^\/[a-z]$/i.test(arg) || (arg === 'resume' && /^[\w-]{8,}$/.test(args[i + 1] ?? ''))) return arg
    return value(args[i - 1], arg)
  })
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e)
  }
}
