import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { sendPty } from './events'
import { argsForLog, createLogger, userText } from './logger'
import { allProviders } from './providers'

const log = createLogger('pty')
const MAX_BUFFER = 512 * 1024
/** A terminal's size until the window sets it. */
export const PTY_COLS = 120
export const PTY_ROWS = 32
/** How long a size refresh holds the terminal one row shorter before giving its size back (refreshPty). */
const REFRESH_MS = 80

interface PtyEntry {
  proc: IPty
  onResize?: (cols: number, rows: number) => void
  buffer: string[]
  size: number
  /** Asked to stop: until it exits, nothing more is sent to it, nor another kill (killPty). */
  killed?: boolean
  /** A size refresh is under way (refreshPty). */
  refresh?: ReturnType<typeof setTimeout>
  /** The size the window gave it during a refresh, which it ends at. */
  wanted?: { cols: number; rows: number }
}

const entries = new Map<string, PtyEntry>()
/**
 * The size the window last gave each terminal (its pane's), kept across its processes: a process started in it (a
 * restart, a mode switch, a fit that came before the process) starts at that size, not at PTY_COLS × PTY_ROWS, and so
 * draws its first screens at the pane's width rather than redrawing them at a resize (#486).
 */
const paneSizes = new Map<string, { cols: number; rows: number }>()

/** The size a process started in this terminal now gets: its pane's when the window has given one. */
export function startSize(key: string): { cols: number; rows: number } {
  return paneSizes.get(key) ?? { cols: PTY_COLS, rows: PTY_ROWS }
}

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
  /** The window resized the terminal. */
  onResize?: (cols: number, rows: number) => void
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
  const size = startSize(key)
  const proc = pty.spawn(opts.file, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols ?? size.cols,
    rows: opts.rows ?? size.rows,
    cwd: opts.cwd,
    env: opts.env,
    useConptyDll: false
  })
  const prior = opts.continueBuffer ? carried.get(key) ?? [] : []
  carried.delete(key)
  const entry: PtyEntry = { proc, onResize: opts.onResize, buffer: [...prior], size: prior.reduce((n, s) => n + s.length, 0) }
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
  const e = entries.get(key)
  if (e && !e.killed) e.proc.write(data)
}

export function resizePty(key: string, cols: number, rows: number): void {
  if (!(cols >= 2 && rows >= 2)) return
  cols = Math.floor(cols)
  rows = Math.floor(rows)
  // Kept with no process too: one started next in this terminal starts at it.
  paneSizes.set(key, { cols, rows })
  const e = entries.get(key)
  if (e?.refresh) e.wanted = { cols, rows }
  // An unchanged size isn't passed on: every resize makes a TUI like Claude Code redraw (#247).
  if (!e || e.killed || (e.proc.cols === cols && e.proc.rows === rows)) return
  setSize(key, e, cols, rows)
}

function setSize(key: string, e: PtyEntry, cols: number, rows: number): void {
  try {
    e.proc.resize(cols, rows)
    e.onResize?.(cols, rows)
  } catch (err) {
    log.warn(`resize ${userText(key)} failed`, err)
  }
}

/** A terminal's process's size now, for a view that shows it: drawn at any other size, its output lands in the wrong places. */
export function ptySize(key: string): { cols: number; rows: number } | null {
  const e = entries.get(key)
  return e ? { cols: e.proc.cols, rows: e.proc.rows } : null
}

/**
 * Makes a terminal's process redraw its screen at the size it has, as resizing the window by hand does: one row
 * shorter for a moment, then its size again. For a CLI whose full-screen interface a resize while it started can leave
 * drawn at the wrong width (capabilities.startupSizeRefresh, #486). A resize meanwhile is the size it ends at.
 */
export function refreshPty(key: string): void {
  const e = entries.get(key)
  if (!e || e.killed || e.refresh || e.proc.rows < 3) return
  const { cols, rows } = e.proc
  log.info(`size refresh ${userText(key)}: ${cols} × ${rows}`)
  setSize(key, e, cols, rows - 1)
  e.refresh = setTimeout(() => {
    e.refresh = undefined
    if (entries.get(key) !== e || e.killed) return
    const want = e.wanted ?? { cols, rows }
    e.wanted = undefined
    if (e.proc.cols !== want.cols || e.proc.rows !== want.rows) setSize(key, e, want.cols, want.rows)
  }, REFRESH_MS)
}

export function ptyBuffer(key: string): string {
  return entries.get(key)?.buffer.join('') ?? ''
}

export function hasPty(key: string): boolean {
  return entries.has(key)
}

/**
 * Stops a terminal's process, once. On Windows node-pty closes the pseudoconsole a moment after kill() (it first asks
 * which processes are attached), and a second kill before the first has finished closes it again: that corrupts the
 * heap and Hive's main process dies, with nothing in its log (#297). It happened whenever a session being stopped was
 * stopped again before it exited: Stop, then switching or closing the workspace or quitting at once (which stop every
 * live session). So a terminal is killed once and then left alone until it exits.
 */
export function killPty(key: string): void {
  const e = entries.get(key)
  if (!e || e.killed) return
  e.killed = true
  try {
    e.proc.kill()
  } catch (err) {
    e.killed = false
    log.warn(`kill ${userText(key)} failed`, err)
  }
}

export function killAll(): void {
  for (const key of [...entries.keys()]) killPty(key)
}

export function runningKeys(): string[] {
  return [...entries.keys()]
}
