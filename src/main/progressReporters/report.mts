// Reporting a long run to the Hive that launched the agent (#136's Agent API: POST /v1/progress, PATCH
// /v1/progress/{id}, POST /v1/progress/{id}/finish), and remembering how long runs took, for estimates. Used by the
// hive-progress wrapper and by Hive's own test runners (tests/progress.mjs). Never fails and never prints: with no
// Hive, Hive unreachable or a refused call, the run just isn't shown.
// Plain Node runs this file directly (tests/e2e/run.mjs, with type stripping): Node built-ins only, and only
// TypeScript that can be erased (no enums, namespaces or parameter properties).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where reports go: the session's Agent API, with the agent's own token, so the run is shown as that agent's. */
export interface ProgressTarget {
  url: string
  token: string
  workspace: string
}

/**
 * The Hive this process can report to, or null: outside Hive, without the Agent API, turned off with HIVE_PROGRESS=0,
 * or inside a command hive-progress runs (HIVE_PROGRESS_WRAPPED=1), whose run is the wrapper's: a report of its own
 * would be a second row (it prints step lines instead, `wrappedLines`). The token is the agent's own (HIVE_API_TOKEN,
 * or the file Hive keeps it in).
 */
export function progressTarget(env: Record<string, string | undefined> = process.env): ProgressTarget | null {
  if (env.HIVE_PROGRESS === '0' || env.HIVE_PROGRESS_WRAPPED === '1') return null
  const url = env.HIVE_API_URL?.replace(/\/+$/, '')
  if (!url) return null
  let token = env.HIVE_API_TOKEN && !env.HIVE_API_TOKEN.includes('${') ? env.HIVE_API_TOKEN : ''
  if (!token && env.HIVE_API_TOKEN_FILE) {
    try {
      token = String(JSON.parse(readFileSync(env.HIVE_API_TOKEN_FILE, 'utf8')).token ?? '')
    } catch {
      token = ''
    }
  }
  return token ? { url, token, workspace: env.HIVE_WORKSPACE ?? '' } : null
}

/**
 * Inside a command hive-progress runs: where a reporter prints its steps as step lines for the wrapper's run (stdout),
 * instead of reporting a run of its own. Undefined otherwise.
 */
export function wrappedLines(env: Record<string, string | undefined> = process.env): ((line: string) => void) | undefined {
  return env.HIVE_PROGRESS_WRAPPED === '1' && env.HIVE_PROGRESS !== '0' ? (line) => void process.stdout.write(`${line}\n`) : undefined
}

// The API's terms (#136): `step` counts the steps finished (0 at the start, `total` at the end) and `stepName` names the
// one running now; `estimateMs` is the time left, counted from that report (an update without one keeps the deadline);
// `total` is set only when the run starts.
export interface ProgressStart {
  title: string
  /** Steps, when known. */
  total?: number
  step?: number
  stepName?: string
  /** The time it is expected to take. */
  estimateMs?: number
  /** The command line, as a label. */
  command?: string
}

export interface ProgressUpdate {
  /** Steps finished. */
  step?: number
  /** The step running now. */
  stepName?: string
  /** Time left from now. */
  estimateMs?: number
}

/** The fetch it calls (tests pass their own). */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

// The API's limits: it clips text itself, and refuses numbers out of range.
const MAX_TITLE = 120
const MAX_COMMAND = 200
const MAX_SUMMARY = 500
const MAX_TOTAL = 100_000
const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const count = (n: number | undefined, max: number): number | undefined => (n !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : undefined)

/**
 * One run being reported. It starts at once; updates are sent at most every `minIntervalMs` (the latest state wins),
 * in order; finishing drops what's pending and waits for the finish to be sent, at most `finishWaitMs`. With no
 * target, or a start Hive refused, it does nothing.
 */
export class ProgressRun {
  private readonly target: ProgressTarget | null
  private readonly fetchImpl: Fetch
  private readonly minIntervalMs: number
  private readonly id: Promise<string | null>
  private chain: Promise<unknown>
  private pending: ProgressUpdate | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSent = 0
  private finished = false
  /** Its steps (a step past them is refused), or the API's limit. */
  private readonly maxStep: number

  /** With no target: step lines for the wrapper it runs under (wrappedLines), or nothing. */
  private readonly lines: ((line: string) => void) | undefined
  private lineStep = -1

  constructor(target: ProgressTarget | null, start: ProgressStart, opts: { minIntervalMs?: number; fetch?: Fetch; lines?: (line: string) => void } = {}) {
    this.target = target
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
    this.minIntervalMs = opts.minIntervalMs ?? 500
    const total = count(start.total, MAX_TOTAL) || undefined
    this.maxStep = total ?? MAX_TOTAL
    const step = count(start.step, this.maxStep)
    const estimateMs = count(start.estimateMs, MAX_ESTIMATE_MS)
    const body = {
      title: clip(start.title.trim() || 'Run', MAX_TITLE),
      ...(total !== undefined ? { total } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(start.stepName ? { stepName: clip(start.stepName, MAX_TITLE) } : {}),
      ...(estimateMs !== undefined ? { estimateMs } : {}),
      ...(start.command ? { command: clip(start.command, MAX_COMMAND) } : {})
    }
    this.id = target
      ? this.send('POST', '/v1/progress', body, 3000).then((r) => (r && typeof (r as { id?: unknown }).id === 'string' ? (r as { id: string }).id : null))
      : Promise.resolve(null)
    this.chain = this.id
    this.lines = target ? undefined : opts.lines
    if (this.lines && total !== undefined) this.line(step ?? 0, start.stepName, total)
  }

  /** A step line: `step` counts the steps finished (the API's terms); the line names the one starting, from 1. */
  private line(step: number, name: string | undefined, total?: number): void {
    const starting = Math.min(step + 1, this.maxStep)
    if (starting === this.lineStep && name === undefined) return
    this.lineStep = starting
    this.lines!(`##hive-progress step=${starting}${total !== undefined ? ` total=${total}` : ''}${name ? ` name=${clip(name, MAX_TITLE)}` : ''}`)
  }

  /** Whether it is being reported (Hive took the start). */
  reporting(): Promise<boolean> {
    return this.id.then((id) => id !== null)
  }

  update(u: ProgressUpdate): void {
    if (this.lines && !this.finished) {
      const step = count(u.step, this.maxStep)
      if (step !== undefined || u.stepName !== undefined) this.line(step ?? Math.max(0, this.lineStep - 1), u.stepName)
      return
    }
    if (!this.target || this.finished) return
    const next: ProgressUpdate = { ...this.pending }
    if (count(u.step, this.maxStep) !== undefined) next.step = count(u.step, this.maxStep)
    if (count(u.estimateMs, MAX_ESTIMATE_MS) !== undefined) next.estimateMs = count(u.estimateMs, MAX_ESTIMATE_MS)
    if (u.stepName !== undefined) next.stepName = clip(u.stepName, MAX_TITLE)
    this.pending = next
    if (this.timer) return
    const wait = Math.max(0, this.lastSent + this.minIntervalMs - Date.now())
    this.timer = setTimeout(() => this.flush(), wait)
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    const u = this.pending
    this.pending = null
    if (!u || this.finished) return
    this.lastSent = Date.now()
    this.chain = this.chain.then(() => this.id).then((id) => (id ? this.send('PATCH', `/v1/progress/${encodeURIComponent(id)}`, u, 2000) : null))
  }

  /** Ends the run: ok or not, with an optional summary ("11 passed, 1 failed"). Never rejects. */
  async finish(ok: boolean, summary?: string, finishWaitMs = 3000): Promise<void> {
    if (!this.target || this.finished) return
    this.finished = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    const done = this.chain
      .then(() => this.id)
      .then((id) => (id ? this.send('POST', `/v1/progress/${encodeURIComponent(id)}/finish`, { ok, ...(summary ? { summary: clip(summary, MAX_SUMMARY) } : {}) }, finishWaitMs) : null))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, finishWaitMs + 250)))])
    clearTimeout(timer)
  }

  private async send(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const t = this.target
    if (!t) return null
    try {
      const res = await this.fetchImpl(t.url + path, {
        method,
        headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', ...(t.workspace ? { 'X-Hive-Workspace': encodeURIComponent(t.workspace) } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
      return res.ok ? await res.json().catch(() => ({})) : null
    } catch {
      return null
    }
  }
}

// Timings: how long a run (a command in a folder, a test suite) took the last few times, for its estimate.

interface TimingsFile {
  version: 1
  runs: Record<string, { ms: number[]; at: number }>
}

const KEEP_RUNS = 5
const KEEP_KEYS = 300

function readTimings(file: string): TimingsFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TimingsFile>
    if (raw && raw.version === 1 && raw.runs && typeof raw.runs === 'object') return { version: 1, runs: raw.runs }
  } catch {
    // none yet, or damaged: start again
  }
  return { version: 1, runs: {} }
}

/** The usual time for `key`: the median of its last few runs, or undefined before its first. */
export function estimateFor(file: string, key: string): number | undefined {
  const ms = readTimings(file).runs[key.slice(0, 300)]?.ms
  if (!Array.isArray(ms)) return undefined
  const ok = ms.filter((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  return ok.length ? ok[Math.floor((ok.length - 1) / 2)] : undefined
}

/** Remembers one run of `key` (best effort: a failed write only loses the estimate). Keeps the newest keys. */
export function recordTiming(file: string, key: string, ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return
  try {
    const t = readTimings(file)
    const k = key.slice(0, 300)
    const before = Array.isArray(t.runs[k]?.ms) ? t.runs[k].ms : []
    t.runs[k] = { ms: [...before, Math.round(ms)].slice(-KEEP_RUNS), at: now }
    const keys = Object.keys(t.runs)
    if (keys.length > KEEP_KEYS) {
      for (const old of keys.sort((a, b) => (t.runs[a].at ?? 0) - (t.runs[b].at ?? 0)).slice(0, keys.length - KEEP_KEYS)) delete t.runs[old]
    }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(t))
    renameSync(tmp, file)
  } catch {
    // estimates are a nicety
  }
}
