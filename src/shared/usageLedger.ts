import type { AppSettings, DayUsage, ProviderId, SessionUsage, TaskCard, TaskHold, UsageTokens } from './types'
import { estimateCost, usesOwnPrices } from './prices'
import { localDay } from './usageDays'
import { TOKENS_SPREAD, TOKENS_UNKNOWN, chargeShares, rowModel, type UsageRow } from './usageTimeline'
import { emptyPart, holdsFromHistory, mergeSpans, sharedSpans, type CostPart, type Span } from './cardCosts'

/**
 * Usage history (#1106, Darren's decisions of 19 Oct): what each session used, recorded once as it happens and only ever
 * added to, so the Overview and every usage view read it rather than the CLIs' transcripts. A session's **rows**, one per
 * local day, model and card it worked on (and its role on it): tokens by kind, requests, prompts, compactions, and the
 * part of the cost known as an amount (the provider's charges, split between the requests they cover) with the tokens it
 * covers; the rest is priced when shown, with the prices of the time, so a price change needs nothing more. A card's
 * rows are its share of the session's use while the session's agent held it (TaskCard.held; shared equally while it held
 * several, ≈); the rest of the day is card 0. Pure: the usage worker makes rows from a parser's result, main prices them.
 */

export type LedgerRole = '' | 'build' | 'review'

export interface LedgerRow {
  day: string
  model: string
  /** The card it was used on (0: none). */
  card: number
  role: LedgerRole
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  prompts: number
  compactions: number
  /** The cost known as an amount: the provider's charges' share, or a kept usage's cost as it was priced when kept. */
  fixedUsd: number
  /** That amount is Hive's estimate (a kept usage's estimate). */
  fixedEstimated: boolean
  /** The tokens `fixedUsd` covers: the rest get Hive's estimate when priced. */
  covered: UsageTokens
  /** Requests whose tokens aren't known yet (Copilot's, until its launch exits). */
  tokensUnknown: number
  /** Its tokens are Hive's share of a total (spread over requests; a part of a step, a card held with others): ≈. */
  shared: boolean
}

/** One card an agent held while its session ran, in a role: its spans, each with how many cards it held then (k: shared 1/k). */
export interface SessionHold {
  card: number
  role: 'build' | 'review'
  parts: [k: number, spans: Span[]][]
}

const ZERO = (): UsageTokens => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
const KINDS = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'] as const
const rowTokens = (r: UsageRow): UsageTokens => ({ inputTokens: r[1], outputTokens: r[2], cacheWriteTokens: r[3], cacheReadTokens: r[4] })
const tokenSum = (t: UsageTokens): number => t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens

export const emptyRow = (day: string, model: string, card = 0, role: LedgerRole = ''): LedgerRow => ({ day, model, card, role, ...ZERO(), requests: 0, prompts: 0, compactions: 0, fixedUsd: 0, fixedEstimated: false, covered: ZERO(), tokensUnknown: 0, shared: false })

/** How much of [a, b) spans cover, in ms. */
function overlap(spans: Span[], a: number, b: number): number {
  let n = 0
  for (const [c, d] of spans) {
    if (d <= a) continue
    if (c >= b) break
    n += Math.min(b, d) - Math.max(a, c)
  }
  return n
}

const rowKey = (day: string, model: string, card: number, role: LedgerRole): string => `${day}|${model}|${card}|${role}`

/**
 * A session's rows from its parser's result (before costs: `days`, `costReports` and `timeline` as the parser gives
 * them) and the cards its agent held. Each day's totals are the parser's, split between the models its requests ran on
 * and the cards its agent held then in the proportions the timeline shows for that day (a timeline row's part on a card:
 * how much of it the card's holds cover, shared 1/k while it held k cards); what the day's timeline doesn't account for
 * goes to card 0 on the day's main model, with its prompts and compactions, so a day's rows always add up to the day, in
 * whole tokens and requests. A charge's share stays with the rows it covers.
 */
export function ledgerRows(raw: SessionUsage, holds: SessionHold[], settings?: Pick<AppSettings, 'providers'> | null): LedgerRow[] {
  const fallback = raw.model ?? ''
  const t = raw.timeline
  const modelAt = (r: UsageRow): string => (t ? rowModel(t, r, raw.model) : raw.model) ?? ''
  const est = (model: string, tk: UsageTokens): number | null => estimateCost({ provider: raw.provider, model: model || null, ...tk }, settings)
  // The timeline's rows by day, then model, card and role: fractions of tokens, requests, charges and what they cover.
  const parts = new Map<string, Map<string, LedgerRow>>()
  const part = (day: string, model: string, card: number, role: LedgerRole): LedgerRow => {
    let m = parts.get(day)
    if (!m) parts.set(day, (m = new Map()))
    const k = rowKey(day, model, card, role)
    let r = m.get(k)
    if (!r) m.set(k, (r = emptyRow(day, model, card, role)))
    return r
  }
  if (t?.rows.length) {
    const shares = chargeShares(t, (r) => est(modelAt(r), rowTokens(r)))
    const step = t.step * 1000
    t.rows.forEach((r, i) => {
      const day = localDay(r[0] * 1000)
      if (!day) return
      const model = modelAt(r)
      const on: [number, LedgerRole, number][] = []
      let held = 0
      for (const h of holds) {
        let w = 0
        for (const [k, spans] of h.parts) w += overlap(spans, r[0] * 1000, r[0] * 1000 + step) / step / k
        if (w <= 0) continue
        on.push([h.card, h.role, w])
        held += w
      }
      // Never more than all of it (holds of one agent share each moment, so they don't add up past 1 but for rounding).
      const scale = held > 1 ? 1 / held : 1
      on.push([0, '', Math.max(0, 1 - held * scale)])
      for (const [card, role, w0] of on) {
        const w = card ? w0 * scale : w0
        if (w <= 0) continue
        const p = part(day, model, card, role)
        if (r[7] & TOKENS_UNKNOWN) p.tokensUnknown += r[5] * w
        else for (const k of KINDS) p[k] += rowTokens(r)[k] * w
        p.requests += r[5] * w
        if (r[6] >= 0) {
          p.fixedUsd += shares[i] * w
          for (const k of KINDS) p.covered[k] += rowTokens(r)[k] * w
        }
        if ((card && w < 1) || r[7] & TOKENS_SPREAD) p.shared = true
      }
    })
  }
  const out: LedgerRow[] = []
  const days = new Set([...Object.keys(raw.days ?? {}), ...parts.keys()])
  for (const day of days) {
    if (!day) continue
    const d = raw.days?.[day]
    const rows = [...(parts.get(day)?.values() ?? [])]
    // The day's main model: the one it used most (else the session's), whose card 0 takes what is left.
    const used = new Map<string, number>()
    for (const r of rows) used.set(r.model, (used.get(r.model) ?? 0) + tokenSum(r) + r.requests)
    const mainModel = [...used].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
    let main = rows.find((r) => r.model === mainModel && r.card === 0)
    if (!main) rows.push((main = emptyRow(day, mainModel)))
    if (d) {
      // The parser's day, in the timeline's proportions (per kind of token, and for requests).
      const total = (f: (r: LedgerRow) => number): number => rows.reduce((n, r) => n + f(r), 0)
      for (const k of KINDS) {
        const tk = total((r) => r[k])
        for (const r of rows) {
          const share = tk > 0 ? r[k] / tk : 0
          r.covered[k] = tk > 0 ? Math.min(d[k], d[k] * (r.covered[k] / tk)) : 0
          r[k] = d[k] * share
        }
      }
      const tq = total((r) => r.requests)
      for (const r of rows) r.requests = tq > 0 ? d.requests * (r.requests / tq) : 0
    }
    // Whole numbers: every row rounded, main takes the difference from the day (never below 0).
    for (const r of rows) {
      if (r === main) continue
      for (const k of KINDS) {
        r[k] = Math.round(r[k])
        r.covered[k] = Math.min(r[k], Math.round(r.covered[k]))
      }
      r.requests = Math.round(r.requests)
      r.tokensUnknown = Math.round(r.tokensUnknown)
    }
    const others = rows.filter((r) => r !== main)
    const sum = (f: (r: LedgerRow) => number): number => others.reduce((n, r) => n + f(r), 0)
    for (const k of KINDS) {
      const want = d ? d[k] : Math.round(main[k] + sum((r) => r[k]))
      main[k] = Math.max(0, want - sum((r) => r[k]))
      main.covered[k] = Math.min(main[k], Math.round(main.covered[k]))
    }
    main.requests = Math.max(0, (d ? d.requests : Math.round(main.requests + sum((r) => r.requests))) - sum((r) => r.requests))
    main.tokensUnknown = Math.round(main.tokensUnknown)
    if (d) {
      main.prompts = d.prompts
      main.compactions = d.compactions
    }
    out.push(...rows)
  }
  // No timeline (a result from before #602): each charge shared between the days it covers, by Hive's estimate (else tokens).
  if (!t?.rows.length && raw.costReports?.length) {
    const byDay = new Map(out.filter((r) => r.card === 0).map((r) => [r.day, r]))
    for (const rep of raw.costReports) {
      const entries = Object.entries(rep.days).filter(([day]) => byDay.has(day))
      const weights = entries.map(([, tk]) => est(fallback, tk) ?? 0)
      const byTokens = weights.every((w) => w === 0)
      const total = byTokens ? entries.reduce((n, [, tk]) => n + tokenSum(tk), 0) : weights.reduce((a, b) => a + b, 0)
      entries.forEach(([day, tk], i) => {
        const r = byDay.get(day)!
        for (const k of KINDS) r.covered[k] = Math.min(r[k], r.covered[k] + tk[k])
        if (total > 0) r.fixedUsd += rep.costUsd * ((byTokens ? tokenSum(tk) : weights[i]) / total)
      })
    }
  }
  return out.filter(hasUse)
}

/** Whether a row records anything. */
const hasUse = (r: LedgerRow): boolean => tokenSum(r) > 0 || r.requests > 0 || r.prompts > 0 || r.compactions > 0 || r.fixedUsd > 0 || r.tokensUnknown > 0

/**
 * A kept usage's rows (#1106's backfill: a deleted session's, or one whose transcript Clean Up let go): already priced,
 * with no timeline, so each day's cost is kept as it was worked out then (estimated where it was), and a card its agent
 * held while it was active gets an unknown part (`tokensUnknown`, no tokens), never $0.
 */
export function keptRows(usage: SessionUsage, holds: SessionHold[]): LedgerRow[] {
  const model = usage.model ?? ''
  const days: [string, DayUsage][] = usage.days && Object.keys(usage.days).length ? Object.entries(usage.days) : [[localDay(usage.lastActivity ?? usage.firstActivity), { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens, requests: usage.requests, prompts: usage.userMessages, compactions: usage.compactions.length, costUsd: usage.costUsd, costEstimated: usage.costEstimated }]]
  const out: LedgerRow[] = []
  for (const [day, d] of days) {
    if (!day) continue
    const r = emptyRow(day, model)
    for (const k of KINDS) r[k] = d[k]
    r.requests = d.requests
    r.prompts = d.prompts
    r.compactions = d.compactions
    if (d.costUsd !== null) {
      r.fixedUsd = d.costUsd
      r.fixedEstimated = d.costEstimated
      r.covered = { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens }
    }
    if (hasUse(r)) out.push(r)
  }
  const from = Date.parse(usage.firstActivity ?? usage.lastActivity ?? '')
  const to = Date.parse(usage.lastActivity ?? usage.firstActivity ?? '')
  if (Number.isFinite(from) && Number.isFinite(to)) {
    for (const h of holds) {
      // Active in the hold (its first and last activity, with a minute's margin): what it used on the card is unknown.
      const at = h.parts.flatMap(([, s]) => s).find(([a, b]) => b > from - 60_000 && a < Math.max(to, from + 1) + 60_000)
      if (!at) continue
      const r = emptyRow(localDay(Math.max(at[0], from)), model, h.card, h.role)
      r.tokensUnknown = 1
      out.push(r)
    }
  }
  return out
}

/** A row's cost with today's prices: its known amount, and Hive's estimate for the tokens it doesn't cover (null: none known). */
export function rowCost(r: LedgerRow, provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): { usd: number | null; estimated: boolean } {
  const model = r.model || null
  const est = (t: UsageTokens): number | null => estimateCost({ provider, model, ...t }, settings)
  const all: UsageTokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens }
  const fixed = r.fixedUsd > 0 || tokenSum(r.covered) > 0
  // The user's own prices (#436): Hive's estimate for all of it, where it has a price.
  if (usesOwnPrices(provider, settings)) {
    const e = est(all)
    if (e !== null) return { usd: e, estimated: true }
  }
  const rest: UsageTokens = { inputTokens: Math.max(0, r.inputTokens - r.covered.inputTokens), outputTokens: Math.max(0, r.outputTokens - r.covered.outputTokens), cacheWriteTokens: Math.max(0, r.cacheWriteTokens - r.covered.cacheWriteTokens), cacheReadTokens: Math.max(0, r.cacheReadTokens - r.covered.cacheReadTokens) }
  if (!fixed) {
    // A row with no use but prompts or compactions: as a day without tokens is priced (0 where the model has a price).
    const e = est(rest)
    return { usd: e, estimated: e !== null && tokenSum(rest) > 0 }
  }
  if (tokenSum(rest) <= 0) return { usd: r.fixedUsd, estimated: r.fixedEstimated }
  const e = est(rest)
  return { usd: r.fixedUsd + (e ?? 0), estimated: r.fixedEstimated || (e !== null && e > 0) }
}

/** The fields of a session's usage that aren't sums of its rows: what the history keeps beside them. */
export type UsageSummary = Omit<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'requests' | 'costUsd' | 'costEstimated' | 'costUnreported' | 'days' | 'costReports' | 'timeline'>

/** What the history keeps of a parser's result beside its rows. */
export function summaryOf(u: SessionUsage): UsageSummary {
  const { inputTokens: _i, outputTokens: _o, cacheWriteTokens: _w, cacheReadTokens: _r, requests: _q, costUsd: _c, costEstimated: _e, costUnreported: _u, days: _d, costReports: _cr, timeline: _t, ...summary } = u
  return summary
}

/**
 * A session's usage from its history, priced now: its summary with the rows' sums, each day's tokens, prompts and cost,
 * and the session's cost (each day's, added up: null when no day has one).
 */
export function usageFromRows(summary: UsageSummary, rows: LedgerRow[], settings?: Pick<AppSettings, 'providers'> | null): SessionUsage {
  const days: Record<string, DayUsage> = {}
  const usage: SessionUsage = { ...summary, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, costUsd: null, costEstimated: false, days }
  for (const r of rows) {
    const d = (days[r.day] ??= { ...ZERO(), requests: 0, prompts: 0, compactions: 0, costUsd: null, costEstimated: false })
    for (const k of KINDS) {
      d[k] += r[k]
      usage[k] += r[k]
    }
    d.requests += r.requests
    usage.requests += r.requests
    d.prompts += r.prompts
    d.compactions += r.compactions
    const c = rowCost(r, summary.provider, settings)
    if (c.usd !== null) {
      d.costUsd = (d.costUsd ?? 0) + c.usd
      if (c.estimated) d.costEstimated = true
    }
  }
  for (const d of Object.values(days)) {
    if (d.costUsd === null) continue
    usage.costUsd = (usage.costUsd ?? 0) + d.costUsd
    if (d.costEstimated) usage.costEstimated = true
  }
  return usage
}

/**
 * A session's rows on one card, as a cost part (shared/cardCosts.ts): their tokens and requests, their cost now (≈ where
 * a share), unknown where a row's tokens or cost aren't known. Null when it has none.
 */
export function rowsPart(rows: LedgerRow[], provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): CostPart | null {
  if (!rows.length) return null
  const out = emptyPart()
  let known = false
  let unknown = false
  let tokensUnknown = false
  for (const r of rows) {
    for (const k of KINDS) out[k] += r[k]
    out.requests += r.requests
    if (r.tokensUnknown > 0) tokensUnknown = true
    if (r.shared) out.tokensEstimated = true
    if (tokenSum(r) === 0 && r.fixedUsd === 0) {
      if (r.tokensUnknown > 0) unknown = true
      continue
    }
    const c = rowCost(r, provider, settings)
    if (c.usd === null) unknown = true
    else {
      known = true
      out.cost += c.usd
      if (c.estimated || r.shared) out.estimated = true
    }
  }
  out.priced = known ? 1 : 0
  out.unpriced = unknown ? 1 : 0
  out.tokensUnknown = tokensUnknown ? 1 : 0
  return out
}

// ---------------------------------------------------------------------------
// The cards a session's agent held.
// ---------------------------------------------------------------------------

/** Who a session was: its agent's id and name as its record has them. */
export interface SessionWho {
  agentId?: string
  agentName?: string
}

/** A card's holds: kept on it, or (a card no change has saved since #602) from its history. */
export const holdsOfCard = (c: TaskCard): TaskHold[] => c.held ?? holdsFromHistory(c)

const ms = (iso: string | undefined | null, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

/**
 * Whether a hold is a session's agent's: by the agent's id; a hold from history with only a name, by the agents named so
 * now (`named`: their ids) or, for a session whose record has no id, the name it kept.
 */
export function holdIsSessions(h: Pick<TaskHold, 'agent' | 'name'>, s: SessionWho, named: (name: string) => string[]): boolean {
  if (h.agent) return s.agentId === h.agent
  if (s.agentId) return named(h.name).includes(s.agentId)
  return !!s.agentName && s.agentName.toLowerCase() === h.name.toLowerCase()
}

/**
 * The cards a session's agent held in its project (`cards`: the project's, archived ones too), each role apart, with how
 * many cards it held at each time (by the holds' agent name, as cost per card has always shared them): what it used
 * while holding k cards is 1/k each's.
 */
export function sessionHolds(cards: TaskCard[], s: SessionWho, named: (name: string) => string[], now: number): SessionHold[] {
  const byName = new Map<string, Map<number, Span[]>>()
  for (const c of cards) {
    for (const h of holdsOfCard(c)) {
      const m = byName.get(h.name.toLowerCase()) ?? new Map<number, Span[]>()
      m.set(c.number, [...(m.get(c.number) ?? []), [ms(h.from, now), ms(h.to, now)]])
      byName.set(h.name.toLowerCase(), m)
    }
  }
  for (const m of byName.values()) for (const [n, spans] of m) m.set(n, mergeSpans(spans))
  const out: SessionHold[] = []
  for (const c of cards) {
    const groups = new Map<string, { role: 'build' | 'review'; name: string; spans: Span[] }>()
    for (const h of holdsOfCard(c)) {
      if (!holdIsSessions(h, s, named)) continue
      const g = groups.get(h.role) ?? { role: h.role, name: h.name, spans: [] }
      g.spans.push([ms(h.from, now), ms(h.to, now)])
      groups.set(h.role, g)
    }
    for (const g of groups.values()) {
      const spans = mergeSpans(g.spans)
      if (!spans.length) continue
      const others = [...(byName.get(g.name.toLowerCase())?.entries() ?? [])].filter(([n]) => n !== c.number).map(([, sp]) => sp)
      out.push({ card: c.number, role: g.role, parts: [...sharedSpans(spans, others).entries()] })
    }
  }
  return out
}
