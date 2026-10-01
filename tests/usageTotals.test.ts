// Period totals shared by the project Overview and the Workspace Overview, and the chart stacked by project.
import { describe, expect, it } from 'vitest'
import type { DayUsage, SessionListItem } from '../src/shared/types'
import { emptyDay } from '../src/shared/usageDays'
import { periodFrom, stackedDaily, sumUsage, totalTokens } from '../src/shared/usageTotals'

const NOW = Date.parse('2026-10-01T15:00:00')

/** A session with `tokens` input tokens on each of the given days. */
function session(days: Record<string, number>, provider: 'claude-code' | 'codex' = 'claude-code'): SessionListItem {
  const byDay: Record<string, DayUsage> = {}
  for (const [day, n] of Object.entries(days)) byDay[day] = { ...emptyDay(), inputTokens: n, prompts: 1, costUsd: n / 1000, costEstimated: true }
  const total = Object.values(days).reduce((a, b) => a + b, 0)
  const last = Object.keys(days).sort().at(-1)!
  return {
    id: `s-${Math.random()}`,
    provider,
    source: 'hive',
    title: null,
    lastActivity: `${last}T12:00:00.000Z`,
    hasTranscript: true,
    hasBackup: false,
    recache: null,
    usage: {
      provider,
      sessionId: 'x',
      title: null,
      model: null,
      cliVersion: null,
      inputTokens: total,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 1,
      reasoningTokens: 0,
      contextTokens: 0,
      contextWindow: null,
      compactions: [],
      cacheTtlSeconds: 300,
      firstActivity: null,
      lastActivity: `${last}T12:00:00.000Z`,
      userMessages: Object.keys(days).length,
      lastPrompt: null,
      costUsd: total / 1000,
      costEstimated: true,
      days: byDay
    }
  }
}

describe('period totals', () => {
  it('counts only the days in the period', () => {
    const s = session({ '2026-09-20': 500, '2026-09-30': 200, '2026-10-01': 100 })
    expect(totalTokens(sumUsage([s], periodFrom('week', NOW)))).toBe(300)
    expect(totalTokens(sumUsage([s], periodFrom('today', NOW)))).toBe(100)
    expect(totalTokens(sumUsage([s], periodFrom('all', NOW)))).toBe(800)
    expect(sumUsage([session({ '2026-09-01': 5 })], periodFrom('week', NOW)).sessions).toBe(0)
  })
})

describe('chart stacked by project', () => {
  const groups = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'].map((name, i) => ({ key: name, label: name, items: [session({ '2026-09-30': (i + 1) * 100, '2026-10-01': 10 })] }))

  it('keeps the six biggest in name order and adds up the rest as Other', () => {
    const { series, days } = stackedDaily(groups, periodFrom('week', NOW)!, NOW)
    // The two smallest (alpha 100, beta 200) go to Other.
    expect(series.map((s) => s.label)).toEqual(['delta', 'eps', 'eta', 'gamma', 'theta', 'zeta', 'Other (2)'])
    expect(days).toHaveLength(7)
    const sep30 = days.find((d) => d.day === '2026-09-30')!
    expect(sep30.parts.at(-1)).toBe(300)
    expect(sep30.tokens).toBe(groups.reduce((n, _, i) => n + (i + 1) * 100, 0))
    expect(days.find((d) => d.day === '2026-10-01')!.prompts).toBe(8)
  })

  it('leaves out groups with nothing in the period, and needs no Other for six or fewer', () => {
    const few = [...groups.slice(0, 3), { key: 'idle', label: 'idle', items: [session({ '2026-08-01': 999 })] }]
    const { series } = stackedDaily(few, periodFrom('week', NOW)!, NOW)
    expect(series.map((s) => s.key)).toEqual(['alpha', 'beta', 'gamma'])
  })
})
