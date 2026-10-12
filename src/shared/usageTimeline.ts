import type { UsageTokens } from './types'

/**
 * A session's usage over time (#602), so it can be split by when it happened: a card's cost is what its agents used
 * while they held it. Kept in usage-cache.json with the parser's result, never sent to the window with the session's
 * usage. Rows of `step` seconds with any use, oldest first: [their start (seconds since the epoch, a multiple of step),
 * input, output, cache write, cache read, requests], and the cost the provider charged in them (USD) where it reports
 * that as it goes (Copilot's credits). A second each (about a row per request), so a card's hold ends where its
 * agent's request did; a session with more rows than MAX_ROWS has them merged into longer steps (10 s, 100 s…).
 */
export type UsageRow = [start: number, input: number, output: number, cacheWrite: number, cacheRead: number, requests: number, cost?: number]

export interface UsageTimeline {
  /** Each row's length in seconds: 1, or 10, 100… for a session with very many requests. */
  step: number
  rows: UsageRow[]
}

/** The most rows a session keeps (about 0.7 MB in usage-cache.json): more are merged into longer steps. */
export const MAX_ROWS = 20_000

/** A timestamp's second since the epoch; null for a missing or invalid one. */
export function secondOf(t: string | number | null | undefined): number | null {
  if (t === null || t === undefined || t === '') return null
  const ms = typeof t === 'number' ? t : Date.parse(t)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** Sums usage by second as a parser reads it. */
export class TimelineBuilder {
  private bySecond = new Map<number, UsageRow>()

  private row(t: string | number | null | undefined): UsageRow | null {
    const s = secondOf(t)
    if (s === null) return null
    let r = this.bySecond.get(s)
    if (!r) this.bySecond.set(s, (r = [s, 0, 0, 0, 0, 0]))
    return r
  }

  /** Adds tokens (and requests) at a time; a missing or invalid time is left out. */
  add(t: string | number | null | undefined, tokens: Partial<UsageTokens>, requests = 0): void {
    const r = this.row(t)
    if (!r) return
    r[1] += tokens.inputTokens ?? 0
    r[2] += tokens.outputTokens ?? 0
    r[3] += tokens.cacheWriteTokens ?? 0
    r[4] += tokens.cacheReadTokens ?? 0
    r[5] += requests
  }

  /** Adds what the provider charged at a time (USD). */
  addCost(t: string | number | null | undefined, usd: number): void {
    const r = this.row(t)
    if (r && usd > 0) r[6] = (r[6] ?? 0) + usd
  }

  /**
   * Adds tokens the provider gave only in total (Copilot's, when a launch ends) over the seconds of the requests they
   * were for, in proportion to each second's requests (whole tokens, the remainder on the last); with no such seconds, at
   * time `t`. The split is Hive's, so a card's tokens from it are approximate (its cost is from the charges).
   */
  spread(bySecond: Map<number, number>, tokens: UsageTokens, t: string | number | null | undefined): void {
    const total = [...bySecond.values()].reduce((a, b) => a + b, 0)
    if (!total) return this.add(t, tokens)
    const keys = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const
    const given = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
    const seconds = [...bySecond.entries()].sort((a, b) => a[0] - b[0])
    seconds.forEach(([s, n], i) => {
      const last = i === seconds.length - 1
      const part = Object.fromEntries(keys.map((k) => [k, last ? tokens[k] - given[k] : Math.floor((tokens[k] * n) / total)])) as unknown as UsageTokens
      for (const k of keys) given[k] += part[k]
      this.add(s * 1000, part)
    })
  }

  /** The timeline so far (copies: the parser keeps reading), merged into longer steps past MAX_ROWS. */
  timeline(): UsageTimeline {
    let step = 1
    let rows = [...this.bySecond.values()].sort((a, b) => a[0] - b[0]).map((r) => [...r] as UsageRow)
    while (rows.length > MAX_ROWS) {
      step *= 10
      rows = mergeRows(rows, step)
    }
    return { step, rows }
  }
}

/** Rows merged into steps of `step` seconds. */
function mergeRows(rows: UsageRow[], step: number): UsageRow[] {
  const out: UsageRow[] = []
  for (const r of rows) {
    const start = Math.floor(r[0] / step) * step
    const last = out[out.length - 1]
    if (last && last[0] === start) {
      for (let i = 1; i <= 5; i++) last[i] = (last[i] ?? 0) + (r[i] ?? 0)
      if (r[6] !== undefined) last[6] = (last[6] ?? 0) + r[6]
    } else out.push([start, r[1], r[2], r[3], r[4], r[5], ...(r[6] !== undefined ? [r[6]] : [])] as UsageRow)
  }
  return out
}

/** A timeline read back from usage-cache.json, if it is one (anything else: none). */
export function readTimeline(v: unknown): UsageTimeline | null {
  if (!v || typeof v !== 'object') return null
  const { step, rows } = v as { step?: unknown; rows?: unknown }
  if (typeof step !== 'number' || !(step >= 1) || !Array.isArray(rows)) return null
  return rows.every((r) => Array.isArray(r) && (r.length === 6 || r.length === 7) && r.every((x) => typeof x === 'number' && Number.isFinite(x))) ? { step, rows: rows as UsageRow[] } : null
}
