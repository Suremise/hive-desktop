import type { SessionListItem } from './types'
import { dayOffset, localDay, usageFrom } from './usageDays'

/**
 * Totals for a period, shared by the project Overview, the Assistant's summary and the Workspace Overview, so they
 * all count the same way: by calendar day, each session only for what it did in the period.
 */

export type Period = 'today' | 'week' | 'month' | 'all'
export const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'all', label: 'All time' }
]

/** A period's first local day (calendar days: "7 days" is today and the six before); null for all time. */
export function periodFrom(p: Period, now: number): string | null {
  if (p === 'all') return null
  return dayOffset(now, p === 'today' ? 0 : p === 'week' ? -6 : -29)
}

/** Sessions with activity in a period (on or after its first day). */
export function activeIn(list: SessionListItem[], fromDay: string | null): SessionListItem[] {
  if (!fromDay) return list
  return list.filter((s) => (s.usage ? usageFrom(s.usage, fromDay).active : localDay(s.lastActivity ?? s.lastActiveAt) >= fromDay))
}

export interface Totals {
  sessions: number
  prompts: number
  compactions: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  cost: number
  /** Some of the cost is Hive's estimate. */
  estimated: boolean
  /** Sessions with a cost (reported or estimated). */
  priced: number
  /** Sessions with no cost at all (no price known for their model). */
  unpriced: number
}

/**
 * A total cost as shown: "≈ $1.20" when every session in it has a cost, "≈ $1.20 + ?" when some have none (a known
 * subtotal, incomplete), "Unknown" when none has: sessions Hive couldn't price never count as $0.
 */
export function costText(t: { cost: number; estimated: boolean; priced: number; unpriced: number }): string {
  if (t.unpriced && !t.priced) return 'Unknown'
  // Non-breaking spaces: "≈ $1.00 + ?" is one value, never split over lines (#241).
  return `${t.estimated ? '≈ ' : ''}${money(t.cost)}${t.unpriced ? ' + ?' : ''}`
}

/** Every token counted: new input, cache writes, input read from cache, and output. */
export const totalTokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output

/** What sessions used, all of it or from a day on (only what happened then, a day at a time). */
export function sumUsage(list: SessionListItem[], fromDay: string | null = null): Totals {
  const t: Totals = { sessions: 0, prompts: 0, compactions: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, cost: 0, estimated: false, priced: 0, unpriced: 0 }
  for (const s of activeIn(list, fromDay)) {
    t.sessions++
    if (!s.usage) continue
    const u = usageFrom(s.usage, fromDay)
    t.prompts += u.prompts
    t.compactions += u.compactions
    t.input += u.inputTokens
    t.cached += u.cacheReadTokens
    t.cacheWrite += u.cacheWriteTokens
    t.output += u.outputTokens
    if (u.costUsd === null) t.unpriced++
    else {
      t.priced++
      t.cost += u.costUsd
      if (u.costEstimated) t.estimated = true
    }
  }
  return t
}

export interface DayTotal {
  day: string
  tokens: number
  cost: number
  estimated: boolean
  /** Sessions that used something that day with a cost, and without one (see costText). */
  priced: number
  unpriced: number
  prompts: number
}

/** The days from `fromDay` to today, each empty. */
function emptyDays(fromDay: string, now: number): DayTotal[] {
  const out: DayTotal[] = []
  for (let i = 0; ; i++) {
    const day = dayOffset(Date.parse(`${fromDay}T12:00:00`), i)
    if (day > localDay(now)) break
    out.push({ day, tokens: 0, cost: 0, estimated: false, priced: 0, unpriced: 0, prompts: 0 })
  }
  return out
}

/** Each day's tokens, cost and prompts across sessions, from `fromDay` to today (days without use included). */
export function dailyTotals(list: SessionListItem[], fromDay: string, now: number): DayTotal[] {
  const out = emptyDays(fromDay, now)
  const byDay = new Map(out.map((d) => [d.day, d]))
  for (const s of list) {
    for (const [day, d] of Object.entries(s.usage?.days ?? {})) {
      const o = byDay.get(day)
      if (!o) continue
      o.tokens += d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens
      o.prompts += d.prompts
      if (d.costUsd !== null) {
        o.cost += d.costUsd
        o.priced++
      } else o.unpriced++
      if (d.costEstimated) o.estimated = true
    }
  }
  return out
}

/** A group of sessions for a stacked chart: a project, or the Assistant. */
export interface UsageGroup {
  key: string
  label: string
  items: SessionListItem[]
}

/**
 * Each day's totals split by group, for a chart stacked by project. The `top` groups that used the most tokens in
 * the period keep their own series, the rest add up to "Other". Series are in name order, so a group keeps its
 * place (and colour) while the set of top groups stays the same.
 */
export function stackedDaily(groups: UsageGroup[], fromDay: string, now: number, top = 6): { series: { key: string; label: string }[]; days: (DayTotal & { parts: number[] })[] } {
  const perGroup = groups.map((g) => ({ g, days: dailyTotals(g.items, fromDay, now) }))
  const sum = (days: DayTotal[]): number => days.reduce((n, d) => n + d.tokens, 0)
  const used = perGroup.filter((x) => sum(x.days) > 0).sort((a, b) => sum(b.days) - sum(a.days))
  const kept = used.slice(0, top).sort((a, b) => a.g.label.localeCompare(b.g.label))
  const rest = used.slice(top)
  const series = kept.map((x) => ({ key: x.g.key, label: x.g.label }))
  if (rest.length) series.push({ key: '', label: `Other (${rest.length})` })
  const days = emptyDays(fromDay, now).map((d, i) => {
    const parts = kept.map((x) => x.days[i].tokens)
    if (rest.length) parts.push(rest.reduce((n, x) => n + x.days[i].tokens, 0))
    const all = perGroup.map((x) => x.days[i])
    return {
      ...d,
      tokens: parts.reduce((a, b) => a + b, 0),
      cost: all.reduce((n, x) => n + x.cost, 0),
      estimated: all.some((x) => x.estimated),
      priced: all.reduce((n, x) => n + x.priced, 0),
      unpriced: all.reduce((n, x) => n + x.unpriced, 0),
      prompts: all.reduce((n, x) => n + x.prompts, 0),
      parts
    }
  })
  return { series, days }
}

/** A dollar amount: "$12.34", "$140", "< $0.01". */
export const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n > 0 && n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`)
