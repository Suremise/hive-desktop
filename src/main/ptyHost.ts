import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { sendPty } from './events'
import { argsForLog, createLogger, userText } from './logger'
import { allProviders } from './providers'

const log = createLogger('pty')
const MAX_BUFFER = 512 * 1024

interface PtyEntry {
  proc: IPty
  buffer: string[]
  size: number
}

const entries = new Map<string, PtyEntry>()

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
  /** `output`: the end of what the process printed (e.g. why it refused to start). */
  onExit?: (code: number, output: string) => void
  onData?: (data: string) => void
  /** Don't tell the renderer when it exits: another process continues in the same terminal (a worktree's setup command, then the agent). */
  quietExit?: boolean
  /** Start from what the key's previous process printed, so the terminal replays both after a reload. */
  continueBuffer?: boolean
}

/** Output of processes that exited quietly, for the process that continues in their terminal. */
const carried = new Map<string, string[]>()

/** Builds a child environment from Hive's own, minus variables that would change how child Electron apps behave. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  // If Hive itself was started from inside an agent's session, don't leak that session's identity
  // (each provider lists its variables). User configuration is kept.
  const sessionVars = new Set(allProviders().flatMap((p) => p.envToStrip))
  for (const k of Object.keys(env)) if (sessionVars.has(k) || k.startsWith('HIVE_')) delete env[k]
  env.TERM_PROGRAM = 'Hive'
  env.COLORTERM = 'truecolor'
  return { ...env, ...extra }
}

/** An argument as logged: bearer tokens hidden (Codex's hooks carry one), long values shortened. */
export function forLog(arg: string): string {
  const safe = arg.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***').replace(/(HIVE_[A-Z_]*TOKEN=)\S+/g, '$1***')
  return safe.length > 300 ? `${safe.slice(0, 300)}… (${safe.length} characters)` : safe
}

export function spawnPty(key: string, opts: SpawnOptions): IPty {
  if (entries.has(key)) throw new Error(`A process is already running for ${key}`)
  log.info(`spawn ${userText(key)}: ${opts.file} ${JSON.stringify(argsForLog(opts.args.map(forLog)))}`)
  const proc = pty.spawn(opts.file, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    cwd: opts.cwd,
    env: opts.env,
    useConptyDll: false
  })
  const prior = opts.continueBuffer ? carried.get(key) ?? [] : []
  carried.delete(key)
  const entry: PtyEntry = { proc, buffer: [...prior], size: prior.reduce((n, s) => n + s.length, 0) }
  entries.set(key, entry)
  proc.onData((data) => {
    entry.buffer.push(data)
    entry.size += data.length
    while (entry.size > MAX_BUFFER && entry.buffer.length > 1) entry.size -= entry.buffer.shift()!.length
    sendPty('pty:data', key, data)
    opts.onData?.(data)
  })
  proc.onExit(({ exitCode }) => {
    log.info(`exit ${userText(key)}: ${exitCode}`)
    if (entries.get(key)?.proc === proc) entries.delete(key)
    if (opts.quietExit) carried.set(key, entry.buffer)
    else sendPty('pty:exit', key, exitCode)
    opts.onExit?.(exitCode, entry.buffer.join('').slice(-8000))
  })
  return proc
}

export function writePty(key: string, data: string): void {
  entries.get(key)?.proc.write(data)
}

export function resizePty(key: string, cols: number, rows: number): void {
  const e = entries.get(key)
  if (!e || cols < 2 || rows < 2) return
  try {
    e.proc.resize(Math.floor(cols), Math.floor(rows))
  } catch (err) {
    log.warn(`resize ${userText(key)} failed`, err)
  }
}

export function ptyBuffer(key: string): string {
  return entries.get(key)?.buffer.join('') ?? ''
}

export function hasPty(key: string): boolean {
  return entries.has(key)
}

export function killPty(key: string): void {
  const e = entries.get(key)
  if (!e) return
  try {
    e.proc.kill()
  } catch (err) {
    log.warn(`kill ${userText(key)} failed`, err)
  }
}

export function killAll(): void {
  for (const key of [...entries.keys()]) killPty(key)
}

export function runningKeys(): string[] {
  return [...entries.keys()]
}
