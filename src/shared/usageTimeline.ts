import type { UsageTokens } from './types'

/**
 * A session's usage over time (#602), so it can be split by when it happened: a card's cost is what its agents used
 * while they held it. Kept in usage-cache.json with the parser's result, never sent to the window with the session's
 * usage. Rows of `step` seconds with any use, oldest first: [their start (seconds since the epoch, a multiple of step),
 * input, output, cache write, cache read, requests, the cost report covering them, flags]. A second each (about a row
 * per request), so a card's hold ends where its agent's request did; a session with more rows than MAX_ROWS has them
 * merged into longer steps (10 s, 100 s…).
 *
 * `reports` are the charges the provider reported, each with the requests it covers (a row's report: its index, or -1
 * for none): Claude Code's running total, each increase covering the requests since the last; Copilot's credits at each
 * turn's checkpoint, covering the requests since the one before. A charge is split only between the requests it covers,
 * so a later one never changes what an earlier card cost. Rows with no report are Hive's estimate (≈).
 */
export type UsageRow = [start: number, input: number, output: number, cacheWrite: number, cacheRead: number, requests: number, report: number, flags: number]

/** A row's tokens are a share Hive worked out of a total the provider gave for several requests (Copilot's, at exit). */
export const TOKENS_SPREAD = 1
/** A row's tokens aren't known yet (Copilot's, until the launch exits): unknown, never 0. */
export const TOKENS_UNKNOWN = 2

export interface UsageTimeline {
  /** Each row's length in seconds: 1, or 10, 100… for a session with very many requests. */
  step: number
  rows: UsageRow[]
  /** Each report's charge (USD), by index. */
  reports: number[]
}

/** The most rows a session keeps (about 0.8 MB in usage-cache.json): more are merged into longer steps. */
export const MAX_ROWS = 20_000

/** A timestamp's second since the epoch; null for a missing or invalid one. */
export function secondOf(t: string | number | null | undefined): number | null {
  if (t === null || t === undefined || t === '') return null
  const ms = typeof t === 'number' ? t : Date.parse(t)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const rowKey = (start: number, report: number, flags: number): string => `${start}|${report}|${flags}`

/** Sums usage by second (and report and flags) as a parser reads it. */
export class TimelineBuilder {
  private rows = new Map<string, UsageRow>()

  /** Adds tokens and requests at a time, covered by a report (-1: none); a missing or invalid time is left out. */
  add(t: string | number | null | undefined, tokens: Partial<UsageTokens>, requests = 0, report = -1, flags = 0): void {
    const s = secondOf(t)
    if (s === null) return
    const key = rowKey(s, report, flags)
    let r = this.rows.get(key)
    if (!r) this.rows.set(key, (r = [s, 0, 0, 0, 0, 0, report, flags]))
    r[1] += tokens.inputTokens ?? 0
    r[2] += tokens.outputTokens ?? 0
    r[3] += tokens.cacheWriteTokens ?? 0
    r[4] += tokens.cacheReadTokens ?? 0
    r[5] += requests
  }

  /**
   * The timeline so far with the reports (copies: the parser keeps reading), and `extra` rows not kept (requests whose
   * tokens aren't known yet), merged into longer steps past MAX_ROWS.
   */
  timeline(reports: number[] = [], extra: UsageRow[] = []): UsageTimeline {
    let step = 1
    let rows = [...this.rows.values(), ...extra].sort((a, b) => a[0] - b[0]).map((r) => [...r] as UsageRow)
    while (rows.length > MAX_ROWS) {
      step *= 10
      rows = mergeRows(rows, step)
    }
    return { step, rows, reports: [...reports] }
  }
}

/** Rows merged into steps of `step` seconds (each report and flag kept apart). */
function mergeRows(rows: UsageRow[], step: number): UsageRow[] {
  const by = new Map<string, UsageRow>()
  for (const r of rows) {
    const start = Math.floor(r[0] / step) * step
    const key = rowKey(start, r[6], r[7])
    const m = by.get(key)
    if (m) for (let i = 1; i <= 5; i++) m[i] = (m[i] ?? 0) + (r[i] ?? 0)
    else by.set(key, [start, r[1], r[2], r[3], r[4], r[5], r[6], r[7]])
  }
  return [...by.values()].sort((a, b) => a[0] - b[0])
}

/**
 * Requests whose tokens the provider gives only as a total later (Copilot's, at exit), as rows of their second and
 * report: `count` requests each.
 */
export function pendingRows(requests: { second: number; report: number }[]): UsageRow[] {
  const by = new Map<string, UsageRow>()
  for (const q of requests) {
    const key = rowKey(q.second, q.report, TOKENS_UNKNOWN)
    const r = by.get(key)
    if (r) r[5]++
    else by.set(key, [q.second, 0, 0, 0, 0, 1, q.report, TOKENS_UNKNOWN])
  }
  return [...by.values()]
}

/**
 * Spreads tokens given as one total over the requests they were for, in proportion to each (second, report)'s requests
 * (whole tokens, the remainder on the last), as TOKENS_SPREAD rows; with no requests, at time `t`.
 */
export function spreadTokens(b: TimelineBuilder, requests: { second: number; report: number }[], tokens: UsageTokens, t: string | number | null | undefined): void {
  if (!requests.length) return b.add(t, tokens, 0, -1, TOKENS_SPREAD)
  const groups = pendingRows(requests).sort((x, y) => x[0] - y[0])
  const keys = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const
  const given = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
  groups.forEach((g, i) => {
    const last = i === groups.length - 1
    const part = Object.fromEntries(keys.map((k) => [k, last ? tokens[k] - given[k] : Math.floor((tokens[k] * g[5]) / requests.length)])) as unknown as UsageTokens
    for (const k of keys) given[k] += part[k]
    b.add(g[0] * 1000, part, g[5], g[6], TOKENS_SPREAD)
  })
}

/** A timeline read back from usage-cache.json, if it is one (anything else: none, and the transcript is read again). */
export function readTimeline(v: unknown): UsageTimeline | null {
  if (!v || typeof v !== 'object') return null
  const { step, rows, reports } = v as { step?: unknown; rows?: unknown; reports?: unknown }
  if (typeof step !== 'number' || !(step >= 1) || !Array.isArray(rows) || !Array.isArray(reports)) return null
  if (!reports.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  const ok = rows.every((r) => Array.isArray(r) && r.length === 8 && r.every((x) => typeof x === 'number' && Number.isFinite(x)) && r[6] < reports.length)
  return ok ? { step, rows: rows as UsageRow[], reports: reports as number[] } : null
}
