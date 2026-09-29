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

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e)
  }
}
