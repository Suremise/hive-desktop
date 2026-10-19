import { monitorEventLoopDelay } from 'perf_hooks'
import { app, powerMonitor } from 'electron'
import { createLogger } from './logger'

/**
 * Notes in hive.log when the main process was busy long enough to be felt (every terminal's typing goes through it), at
 * most once a minute, so pauses can be matched with what Hive was doing (#1109). The delay is Node's event loop delay
 * (`monitorEventLoopDelay`: its timer, every 20 ms, catches a block wherever it falls), read every half second. A gap
 * that spans the PC's sleep isn't a stall: the warning waits a few seconds, and a suspend or resume during it drops it
 * (one info line instead). The line names the work that overlapped the stall: IPC calls, Agent API requests and hooks,
 * each by its fixed name (a channel, a route template, a hook's event: never the user's text), with how long it took,
 * and the main thread's CPU time over it (a stall with little CPU was waiting: on the disk, a child process, a lock).
 */

const log = createLogger('main')

export const stallClock = { mono: (): number => performance.now() }

interface Work {
  /** A fixed name, or how to make it once it is known (an API request's route, found after it began). */
  label: string | (() => string)
  start: number
  end: number | null
}

/** Work under way, and the latest ended (enough to cover a burst of calls during a stall). */
const running = new Set<Work>()
const ended: Work[] = []
const ENDED_KEPT = 200
/** The work a stall overlapped, kept as it is found, so later traffic pushing it out of `ended` can't lose its cause. */
const HELD_PER_STALL = 20

/** Marks work as begun (a fixed name, never the user's text); call what it returns when it has ended. */
export function beginWork(label: Work['label']): () => void {
  const w: Work = { label, start: stallClock.mono(), end: null }
  running.add(w)
  return () => {
    if (w.end !== null) return
    w.end = stallClock.mono()
    running.delete(w)
    ended.push(w)
    if (ended.length > ENDED_KEPT) ended.shift()
  }
}

// Labels from what a request says: only names Hive knows, so nothing a client sends reaches the log.
const HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'Interrupt', 'ErrorOccurred', 'PreCompact', 'PostCompact'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** A hook as a stall names it: its event if it is one the CLIs send, or the status line. */
export function hookLabel(statusLine: boolean, body: unknown): string {
  if (statusLine) return 'hook status line'
  const event = (body as { hook_event_name?: unknown } | null)?.hook_event_name
  return `hook ${typeof event === 'string' && HOOK_EVENTS.has(event) ? event : '(other event)'}`
}

/** An Agent API request as a stall names it: its method and route template (the router's, never the URL). */
export function apiLabel(method: string | undefined, route: string): string {
  return `api ${METHODS.has(method ?? '') ? method : 'other'} ${route}`
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

const overlapOf = (w: Work, from: number, to: number, now: number): number => Math.min(to, w.end ?? now) - Math.max(from, w.start)

/** The work that overlapped [from, to] (with `held`, found earlier), the most overlap first. */
function overlapping(from: number, to: number, held: Work[] = []): Work[] {
  const now = stallClock.mono()
  const o = (w: Work): number => overlapOf(w, from, to, now)
  return [...new Set([...held, ...running, ...ended])].filter((w) => o(w) > 0).sort((a, b) => o(b) - o(a) || b.start - a.start)
}

/** The work that overlapped [from, to], the most overlap first: at most `max` described, and how many more. */
export function workDuring(from: number, to: number, max = 3, held: Work[] = []): { work: string[]; more: number } {
  const now = stallClock.mono()
  const found = overlapping(from, to, held)
  const work = found.slice(0, max).map((w) => `${typeof w.label === 'string' ? w.label : w.label()} (${seconds((w.end ?? now) - w.start)}${w.end === null ? ', still running' : ''})`)
  return { work, more: found.length - work.length }
}

export interface StallDeps {
  now(): number
  /** The longest event loop delay since the last call, in ms (and starts measuring afresh). */
  longestDelayMs(): number
  /** The main thread's CPU time so far in ms, or null where Node can't tell. */
  cpuMs(): number | null
  defer(fn: () => void, ms: number): void
  warn(line: string): void
  info(line: string): void
}

export const STALL_TIMING = { every: 500, over: 250, settleMs: 3000, quietMs: 60_000 }

/** The watch itself, with what it reads given (unit tests fake them): tick() every `every` ms, power() on a suspend or resume. */
export function stallWatcher(d: StallDeps, t = STALL_TIMING): { tick(): void; power(): void } {
  let last = d.now()
  let cpuLast = d.cpuMs()
  let logged = -Infinity
  let unlogged = 0
  const power: number[] = []
  return {
    power(): void {
      power.push(d.now())
      if (power.length > 20) power.shift()
    },
    tick(): void {
      const now = d.now()
      const cpu = d.cpuMs()
      const cpuUsed = cpu !== null && cpuLast !== null ? cpu - cpuLast : null
      // The loop delay, or how late this timer itself is (whichever is longer: the histogram's timer may only fire next).
      const delay = Math.max(d.longestDelayMs(), now - last - t.every)
      const since = last
      last = now
      cpuLast = cpu
      if (delay <= t.over) return
      const from = Math.min(since, now - delay)
      const span = [now - delay - t.every, now] as const
      const held = overlapping(...span).slice(0, HELD_PER_STALL)
      // Decided a little later: the resume may be told after the first timer that ran late, and work that was held up
      // ends just after.
      d.defer(() => {
        const ms = Math.round(delay)
        if (power.some((p) => p >= from - 1000)) return d.info(`The main process was paused for ${ms} ms while the PC slept: not counted as busy`)
        if (d.now() - logged < t.quietMs) {
          unlogged++
          return
        }
        logged = d.now()
        const { work, more } = workDuring(...span, 3, held)
        const parts = [cpuUsed === null ? '' : ` (main thread CPU ${Math.round(Math.min(cpuUsed, delay + t.every))} ms)`]
        parts.push(work.length ? `; during it: ${work.join(', ')}${more ? ` and ${more} more` : ''}` : '; no IPC call, Agent API request or hook was under way')
        if (unlogged) parts.push(`; ${unlogged} more stall(s) since the last warning, not logged`)
        unlogged = 0
        d.warn(`The main process was busy for ${ms} ms${parts.join('')}`)
      }, t.settleMs)
    }
  }
}

export function watchMainStalls(): void {
  const delays = monitorEventLoopDelay({ resolution: 20 })
  delays.enable()
  // Tests (unpackaged builds): HIVE_TEST_STALL_QUIET_MS shortens the minute between warnings, so a stall at start
  // doesn't hide the one a suite makes.
  const quietMs = (!app.isPackaged && Number(process.env.HIVE_TEST_STALL_QUIET_MS)) || STALL_TIMING.quietMs
  const thread = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  const watch = stallWatcher({
    now: () => stallClock.mono(),
    longestDelayMs: () => {
      const ms = delays.max / 1e6
      delays.reset()
      return ms
    },
    cpuMs: () => {
      if (!thread) return null
      const u = thread.call(process)
      return (u.user + u.system) / 1000
    },
    defer: (fn, ms) => setTimeout(fn, ms).unref(),
    warn: (line) => log.warn(line),
    info: (line) => log.info(line)
  }, { ...STALL_TIMING, quietMs })
  powerMonitor.on('suspend', () => watch.power())
  powerMonitor.on('resume', () => watch.power())
  setInterval(() => watch.tick(), STALL_TIMING.every).unref()
}
