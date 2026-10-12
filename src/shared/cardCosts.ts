import type { AppSettings, SessionUsage, TaskCard, TaskColumn, TaskHold, UsageTokens } from './types'
import { estimateCost } from './prices'
import { TASK_COLUMNS } from './tasks'
import { reviewRounds } from './laneBar'
import { localDay } from './usageDays'
import { costText, money } from './usageTotals'
import type { UsageRow, UsageTimeline } from './usageTimeline'

/**
 * Cost per card and per lane (#602, Darren's decision of 11 Oct). Usage is the card's while an agent held it: its
 * builder while it is in Doing, its reviewer from its review's start to its verdict (TaskCard.held). What a lane's agents
 * used while holding no card is the lane's overhead (merges, watching, compactions). Each provider's usage is as it
 * reported it: Hive's estimates marked ≈, and what isn't known is unknown, never $0.
 */

/** Holds kept on a card: the newest. */
export const MAX_HOLDS = 100

// ---------------------------------------------------------------------------
// Who held a card when.
// ---------------------------------------------------------------------------

type Holder = Pick<TaskHold, 'agent' | 'name' | 'role'>

/** Who holds a card now: its agent while it is in Doing, its reviewer while it is reviewed. */
export function holdersNow(card: Pick<TaskCard, 'column' | 'agent' | 'agentName' | 'review'>): Holder[] {
  const out: Holder[] = []
  if (card.column === 'doing' && card.agent) out.push({ agent: card.agent, name: card.agentName ?? card.agent, role: 'build' })
  if (card.column === 'review' && card.review) out.push({ agent: card.review.agent, name: card.review.agentName, role: 'review' })
  return out
}

const sameHolder = (a: Holder, b: Holder): boolean => a.role === b.role && (a.agent && b.agent ? a.agent === b.agent : a.name.toLowerCase() === b.name.toLowerCase())

/** Ends the holds that no longer are and starts the new ones, at `at`. Returns the holds (does not change `held`). */
function moveHolds(held: TaskHold[], now: Holder[], at: string): TaskHold[] {
  const out = held.map((h) => ({ ...h }))
  const open = out.filter((h) => !h.to)
  for (const h of open) if (!now.some((n) => sameHolder(h, n))) h.to = at
  for (const n of now) if (!open.some((h) => sameHolder(h, n))) out.push({ ...(n.agent ? { agent: n.agent } : {}), name: n.name, role: n.role, from: at })
  return out
}

/**
 * Keeps a card's holds up to date as it is saved (tasks.ts saveCard): a hold that ended gets its end, a new one starts.
 * A card without holds yet (from before #602) gets them from its history first. Cards nobody ever held get none.
 */
export function trackHolds(card: TaskCard, at: string): void {
  const before = card.held ?? holdsFromHistory(card)
  const held = moveHolds(before, holdersNow(card), at).slice(-MAX_HOLDS)
  if (held.length || card.held) card.held = held
}

const COLUMN_BY_LABEL = new Map(TASK_COLUMNS.map((c) => [c.label.toLowerCase(), c.id]))
const MOVED = /^Moved to (?:the (?:top|bottom) of )?(On Hold|Todo|Doing|Review|Passed|Done)\b/
const CREATED = /^Created in (On Hold|Todo|Doing|Review|Passed|Done)\b/
/** "HB5 (hive)": an agent's name as history gives who did it. */
const agentNamed = (by: string): string => by.replace(/\s+\([^()]*\)$/, '')

/**
 * A card's holds as its history tells them, for a card from before Hive kept them: who it was given to and when it was
 * in Doing, who started reviewing it and their verdicts. By names (history has no ids), except where the name is the
 * card's agent's or reviewer's now. A history cut short (the oldest entries dropped) gives what it still has.
 */
export function holdsFromHistory(card: Pick<TaskCard, 'history' | 'agent' | 'agentName' | 'review'>): TaskHold[] {
  let held: TaskHold[] = []
  let column: TaskColumn | null = null
  let builder: string | null = null
  let reviewer: string | null = null
  const idOf = (name: string, role: TaskHold['role']): string | undefined => {
    const now = role === 'build' ? card.agent && { id: card.agent, name: card.agentName } : card.review && { id: card.review.agent, name: card.review.agentName }
    return now && now.name?.toLowerCase() === name.toLowerCase() ? now.id : undefined
  }
  for (const h of card.history) {
    for (const part of h.what.split('; ')) {
      const created = CREATED.exec(part)
      const moved = MOVED.exec(part)
      if (created) column = COLUMN_BY_LABEL.get(created[1].toLowerCase()) ?? column
      // Made in Doing for an agent: the card's own agent then (its history doesn't name it).
      if (created && column === 'doing' && card.agentName) builder = card.agentName
      if (moved) column = COLUMN_BY_LABEL.get(moved[1].toLowerCase()) ?? column
      if (part.startsWith('Returned for review')) column = 'review'
      if (part.startsWith('Given to ')) builder = part.slice('Given to '.length).trim()
      if (part.startsWith('Taken from ')) builder = null
      if (part.startsWith('Started reviewing')) reviewer = agentNamed(h.by)
      if (/^Review (passed|failed)/.test(part) || /^Review by .* stopped/.test(part)) reviewer = null
      if (column !== 'review') reviewer = null
    }
    const now: Holder[] = []
    if (column === 'doing' && builder) now.push({ agent: idOf(builder, 'build'), name: builder, role: 'build' })
    if (reviewer) now.push({ agent: idOf(reviewer, 'review'), name: reviewer, role: 'review' })
    held = moveHolds(held, now, h.at)
  }
  return held.slice(-MAX_HOLDS)
}

/** Reads a card's holds from its file: only well-formed ones (the files can be edited by hand). */
export function holdsOf(v: unknown): { held?: TaskHold[] } {
  if (!Array.isArray(v)) return {}
  const held = v.flatMap((h): TaskHold[] =>
    h && typeof h.name === 'string' && (h.role === 'build' || h.role === 'review') && typeof h.from === 'string' && Number.isFinite(Date.parse(h.from))
      ? [{ ...(typeof h.agent === 'string' && h.agent ? { agent: h.agent } : {}), name: h.name, role: h.role, from: h.from, ...(typeof h.to === 'string' && Number.isFinite(Date.parse(h.to)) ? { to: h.to } : {}) }]
      : []
  )
  return { held: held.slice(-MAX_HOLDS) }
}

/**
 * How many review rounds a card has had: none until it first goes to Review; then each failed review is a round, and
 * the one under way (or passed) is the next.
 */
export function cardRounds(card: Pick<TaskCard, 'history' | 'column'>): number {
  const lines = card.history.flatMap((h) => h.what.split('; '))
  const toReview = lines.some((l) => /^(Moved to (the (top|bottom) of )?Review\b|Returned for review|Started reviewing|Review (passed|failed))/.test(l))
  if (!toReview && card.column !== 'review') return 0
  const { failures, failedNow } = reviewRounds(card as TaskCard)
  return failedNow ? failures : failures + 1
}

// ---------------------------------------------------------------------------
// Usage over spans of time.
// ---------------------------------------------------------------------------

/** Spans of time in ms, [from, to): merged, so nothing is counted twice. */
export type Span = [number, number]

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** `spans` with `minus` taken out (both merged). */
export function subtractSpans(spans: Span[], minus: Span[]): Span[] {
  const out: Span[] = []
  for (const [a0, b] of spans) {
    let a = a0
    for (const [c, d] of minus) {
      if (d <= a || c >= b) continue
      if (c > a) out.push([a, c])
      a = Math.max(a, d)
      if (a >= b) break
    }
    if (a < b) out.push([a, b])
  }
  return out
}

/** How much of [a, b) the spans cover, in ms. */
function overlap(spans: Span[], a: number, b: number): number {
  let n = 0
  for (const [c, d] of spans) {
    if (d <= a) continue
    if (c >= b) break
    n += Math.min(b, d) - Math.max(a, c)
  }
  return n
}

/** Usage and its cost, summed over sessions' parts. `priced` and `unpriced` count the parts with a cost and without one. */
export interface CostPart {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  cost: number
  /** Some of the cost is Hive's estimate (≈). */
  estimated: boolean
  priced: number
  /** Parts whose cost isn't known (no price for the model, or usage Hive can't place in time): never counted as $0. */
  unpriced: number
}

export const emptyPart = (): CostPart => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, cost: 0, estimated: false, priced: 0, unpriced: 0 })

export function addPart(to: CostPart, p: CostPart): CostPart {
  to.inputTokens += p.inputTokens
  to.outputTokens += p.outputTokens
  to.cacheWriteTokens += p.cacheWriteTokens
  to.cacheReadTokens += p.cacheReadTokens
  to.requests += p.requests
  to.cost += p.cost
  to.estimated ||= p.estimated
  to.priced += p.priced
  to.unpriced += p.unpriced
  return to
}

const rowTokens = (r: UsageRow): UsageTokens => ({ inputTokens: r[1], outputTokens: r[2], cacheWriteTokens: r[3], cacheReadTokens: r[4] })
const tokenSum = (t: UsageTokens): number => t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens

/** A session as the cost of cards reads it: its usage with day costs (priced), its timeline, and when it was active. */
export interface SessionSlice {
  usage: SessionUsage | null
  timeline: UsageTimeline | null
  /** When it was active, for one without usage or a timeline: whether it falls in a span at all. */
  from: number
  to: number
}

/**
 * What a session used in some spans of time: each row of its timeline (a second, mostly) by how much of it the spans
 * cover, and each day's cost shared over its rows the way that day's cost was made (the provider's charges where it
 * reports them by turn, else Hive's estimate for the tokens, else the tokens), so a day's rows add up to its cost in the
 * Overview. A session active in the spans whose timeline or usage Hive doesn't have is an unknown part. Null when it
 * wasn't active in them.
 */
export function sliceSession(s: SessionSlice, spans: Span[], settings?: Pick<AppSettings, 'providers'> | null): CostPart | null {
  if (!spans.length) return null
  if (!s.usage || !s.timeline) return overlap(spans, s.from, Math.max(s.to, s.from + 1)) > 0 ? { ...emptyPart(), unpriced: 1 } : null
  // Not active near the spans at all (a minute's margin: its first and last activity are its main conversation's).
  if (s.to >= s.from && overlap(spans, s.from - 60_000, s.to + 60_000) === 0) return null
  const usage = s.usage
  const est = (t: UsageTokens): number => estimateCost({ provider: usage.provider, model: usage.model, ...t }, settings) ?? 0
  // Each day's rows and how they share its cost.
  const step = s.timeline.step * 1000
  const byDay = new Map<string, UsageRow[]>()
  for (const r of s.timeline.rows) {
    const day = localDay(r[0] * 1000)
    const rows = byDay.get(day)
    if (rows) rows.push(r)
    else byDay.set(day, [r])
  }
  const out = emptyPart()
  let active = false
  for (const [day, rows] of byDay) {
    const covered = rows.map((r) => overlap(spans, r[0] * 1000, r[0] * 1000 + step) / step)
    if (!covered.some((f) => f > 0)) continue
    active = true
    const charged = rows.some((r) => (r[6] ?? 0) > 0)
    const estimates = rows.map((r) => est(rowTokens(r)))
    const priced = estimates.some((e) => e > 0)
    const weight = (r: UsageRow, i: number): number => (charged ? (r[6] ?? 0) : priced ? estimates[i] : tokenSum(rowTokens(r)))
    let total = 0
    let mine = 0
    rows.forEach((r, i) => {
      const f = covered[i]
      total += weight(r, i)
      mine += weight(r, i) * f
      out.inputTokens += r[1] * f
      out.outputTokens += r[2] * f
      out.cacheWriteTokens += r[3] * f
      out.cacheReadTokens += r[4] * f
      out.requests += r[5] * f
    })
    // The day's cost as priced (usageDays.ts); a session without days has one cost for all of it.
    const d = usage.days?.[day] ?? (usage.days ? null : { costUsd: usage.costUsd, costEstimated: usage.costEstimated })
    if (!d || d.costUsd === null) out.unpriced++
    else {
      out.priced++
      if (total > 0) out.cost += d.costUsd * (mine / total)
      if (d.costEstimated) out.estimated = true
    }
  }
  return active ? out : null
}

// ---------------------------------------------------------------------------
// Cards and lanes.
// ---------------------------------------------------------------------------

export interface CardCost {
  number: number
  title: string
  project: string
  column: TaskColumn
  rounds: number
  /** Its builders' part (while in Doing) and its reviewers' (while reviewing). */
  build: CostPart
  review: CostPart
  total: CostPart
  /** When it was last held (ISO), or now while it is. */
  lastHeld: string | null
  /** Holds whose agent has no session Hive knows of: their usage is unknown. */
  unmatched: number
}

export interface LaneCost {
  id: string
  /** What the lane's agents used from its start to its end (or now). */
  total: CostPart
  /** While holding a card. */
  onCards: CostPart
  /** While holding none: merges, watching, compactions. */
  overhead: CostPart
  /** Its cards that passed or are done. */
  finished: number
}

/** Tokens and requests as whole numbers (a row partly in a span gives fractions). */
export const roundPart = (p: CostPart): CostPart => ({
  ...p,
  inputTokens: Math.round(p.inputTokens),
  outputTokens: Math.round(p.outputTokens),
  cacheWriteTokens: Math.round(p.cacheWriteTokens),
  cacheReadTokens: Math.round(p.cacheReadTokens),
  requests: Math.round(p.requests)
})

/** A part's cost as shown: "≈ $1.84", "$1.20 + ?" (some unknown), "Unknown" (none known); "—" for nothing at all. */
export function partCost(p: CostPart): string {
  if (!p.priced && !p.unpriced) return '—'
  return costText({ cost: p.cost, estimated: p.estimated, priced: p.priced, unpriced: p.unpriced })
}

/** "cost: ≈ $1.84 · 2 rounds" (the card's own line). */
export function cardCostLine(c: CardCost): string {
  const rounds = c.rounds ? ` · ${c.rounds} round${c.rounds === 1 ? '' : 's'}` : ''
  return `cost: ${partCost(c.total)}${rounds}`
}

const tok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)))

/** A part's tokens in words, for a hover: "in 12K · out 3K · cache write 40K · cache read 1.2M · 31 requests". */
export function partTokens(p: CostPart): string {
  if (!p.priced && !p.unpriced) return 'nothing used'
  const tokens = `in ${tok(p.inputTokens)} · out ${tok(p.outputTokens)} · cache write ${tok(p.cacheWriteTokens)} · cache read ${tok(p.cacheReadTokens)} · ${Math.round(p.requests)} request${Math.round(p.requests) === 1 ? '' : 's'}`
  return p.unpriced && !p.priced ? `unknown${p.inputTokens + p.outputTokens ? ` (${tokens} known)` : ''}` : tokens
}

/** Cost per finished card ("≈ $2.10 a card"), when any finished and the cost is known. */
export function perFinished(l: LaneCost): string | null {
  if (!l.finished || !l.total.priced) return null
  return `${l.total.estimated ? '≈ ' : ''}${money(l.total.cost / l.finished)}${l.total.unpriced ? ' + ?' : ''} a finished card`
}
