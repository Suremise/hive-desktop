// Cost per card and per lane (#602): who held a card when, and what their sessions used then.
import { describe, expect, it } from 'vitest'
import { cardCostLine as costLine, cardRounds, holdsFromHistory, holdsOf, mergeSpans, partCost, scalePart, sharedSpans, sliceSession, subtractSpans, trackHolds, type CardCost, type SessionSlice } from '../src/shared/cardCosts'
import { MAX_ROWS, TimelineBuilder, readTimeline, secondOf, type UsageRow } from '../src/shared/usageTimeline'
import { ClaudeUsageParser } from '../src/main/providers/claude/usage'
import { parseRollout } from '../src/main/providers/codex/rollout'
import { parseEvents } from '../src/main/providers/copilot/events'
import { localDay, priceUsage } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionUsage, TaskCard, TaskHistoryEntry } from '../src/shared/types'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const MINUTE_MS = 60_000
const iso = (minutes: number): string => new Date(T0 + minutes * MINUTE_MS).toISOString()
const h = (minutes: number, by: string, what: string): TaskHistoryEntry => ({ at: iso(minutes), by, what })

const card = (over: Partial<TaskCard>): TaskCard => ({
  number: 7,
  title: 'A card',
  description: '',
  project: 'hive',
  agent: null,
  column: 'todo',
  order: 1,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: [],
  archived: false,
  createdAt: iso(0),
  createdBy: 'You',
  updatedAt: iso(0),
  ...over
})

// #607's history as it was: built by HB5, reviewed by HR5 in three rounds.
const LOOP = [
  h(0, 'Assistant', 'Created in On Hold'),
  h(1, 'Assistant', 'Moved to the bottom of Todo'),
  h(10, 'HB5 (hive)', 'Given to HB5'),
  h(10, 'HB5 (hive)', 'Moved to Doing'),
  h(40, 'HB5 (hive)', 'Moved to Review'),
  h(41, 'HR5 (hive)', 'Started reviewing'),
  h(45, 'HR5 (hive)', 'Review failed'),
  h(52, 'HB5 (hive)', 'Returned for review, round 2'),
  h(53, 'HR5 (hive)', 'Started reviewing'),
  h(56, 'HR5 (hive)', 'Review passed'),
  h(56, 'HR5 (hive)', 'Moved to Passed'),
  h(90, 'HB5 (hive)', 'Moved to Done')
]

describe('holds', () => {
  it('reads who held a card when from its history', () => {
    const held = holdsFromHistory(card({ history: LOOP, agent: 'a-1', agentName: 'HB5', column: 'done' }))
    expect(held).toEqual([
      { agent: 'a-1', name: 'HB5', role: 'build', from: iso(10), to: iso(40) },
      { name: 'HR5', role: 'review', from: iso(41), to: iso(45) },
      { name: 'HR5', role: 'review', from: iso(53), to: iso(56) }
    ])
  })

  it('counts the time between a failed review and the return as nobody’s (a card in Review is not in Doing)', () => {
    // Moved back to Doing to fix, then returned: the builder holds it again for the fix.
    const history = [...LOOP.slice(0, 7), h(46, 'HB5 (hive)', 'Moved to Doing'), h(52, 'HB5 (hive)', 'Moved to Review; Returned for review, round 2'), h(53, 'HR5 (hive)', 'Started reviewing')]
    const held = holdsFromHistory(card({ history, agent: 'a-1', agentName: 'HB5' }))
    expect(held.filter((x) => x.role === 'build').map((x) => [x.from, x.to])).toEqual([
      [iso(10), iso(40)],
      [iso(46), iso(52)]
    ])
    expect(held.at(-1)).toMatchObject({ role: 'review', from: iso(53) })
    expect(held.at(-1)!.to).toBeUndefined()
  })

  it('keeps holds as the card changes, starting from its history', () => {
    const c = card({ history: LOOP.slice(0, 4), agent: 'a-1', agentName: 'HB5', column: 'doing' })
    trackHolds(c, iso(20))
    expect(c.held).toEqual([{ agent: 'a-1', name: 'HB5', role: 'build', from: iso(10) }])
    c.column = 'review'
    trackHolds(c, iso(40))
    c.review = { agent: 'a-2', agentName: 'HR5', since: iso(41) }
    trackHolds(c, iso(41))
    expect(c.held).toEqual([
      { agent: 'a-1', name: 'HB5', role: 'build', from: iso(10), to: iso(40) },
      { agent: 'a-2', name: 'HR5', role: 'review', from: iso(41) }
    ])
    // Saved again with nothing changed: nothing new.
    trackHolds(c, iso(42))
    expect(c.held).toHaveLength(2)
  })

  it('gives a card nobody held no holds', () => {
    const c = card({ history: LOOP.slice(0, 2) })
    trackHolds(c, iso(5))
    expect(c.held).toBeUndefined()
  })

  it('reads only well-formed holds from a file', () => {
    expect(holdsOf(undefined)).toEqual({})
    expect(holdsOf([{ name: 'B', role: 'build', from: iso(0) }, { name: 'B', role: 'boss', from: iso(0) }, { role: 'build', from: iso(0) }, { name: 'B', role: 'review', from: 'soon', to: iso(1) }])).toEqual({ held: [{ name: 'B', role: 'build', from: iso(0) }] })
  })

  it('counts review rounds', () => {
    expect(cardRounds(card({ history: LOOP, column: 'done' }))).toBe(2)
    expect(cardRounds(card({ history: LOOP.slice(0, 7), column: 'review' }))).toBe(1)
    expect(cardRounds(card({ history: LOOP.slice(0, 8), column: 'review' }))).toBe(2)
    expect(cardRounds(card({ history: LOOP.slice(0, 4), column: 'doing' }))).toBe(0)
  })
})

describe('spans', () => {
  it('merges and subtracts', () => {
    expect(mergeSpans([[5, 9], [1, 3], [2, 4], [9, 9]])).toEqual([[1, 4], [5, 9]])
    expect(subtractSpans([[0, 10]], [[2, 3], [5, 7]])).toEqual([[0, 2], [3, 5], [7, 10]])
    expect(subtractSpans([[0, 10]], [[0, 10]])).toEqual([])
  })

  it('shares time an agent held several cards between them', () => {
    // Held 0–10; another card 4–6 and a third 5–20: 0–4 alone, 4–5 with one other, 5–6 with two, 6–10 with one.
    const shared = sharedSpans([[0, 10]], [[[4, 6]], [[5, 20]]])
    expect(Object.fromEntries(shared)).toEqual({ 1: [[0, 4]], 2: [[4, 5], [6, 10]], 3: [[5, 6]] })
    expect(Object.fromEntries(sharedSpans([[0, 10]], []))).toEqual({ 1: [[0, 10]] })
    const part = { inputTokens: 10, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 2, requests: 2, cost: 1, estimated: true, priced: 1, unpriced: 0 }
    expect(scalePart(part, 0.5)).toEqual({ ...part, inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, requests: 1, cost: 0.5 })
  })
})

describe('minutes', () => {
  it('sums usage by second and spreads totals over requests', () => {
    const m = new TimelineBuilder()
    m.add(iso(0), { inputTokens: 10 }, 1)
    m.add(new Date(T0 + 400).toISOString(), { outputTokens: 5 }, 1)
    m.add(undefined, { inputTokens: 99 })
    m.addCost(iso(1), 0.5)
    m.spread(new Map([[secondOf(iso(2))!, 1], [secondOf(iso(3))!, 3]]), { inputTokens: 101, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, iso(9))
    expect(m.timeline()).toEqual({
      step: 1,
      rows: [
        [secondOf(iso(0)), 10, 5, 0, 0, 2],
        [secondOf(iso(1)), 0, 0, 0, 0, 0, 0.5],
        [secondOf(iso(2)), 25, 0, 0, 0, 0],
        [secondOf(iso(3)), 76, 0, 0, 0, 0]
      ]
    })
    expect(readTimeline(m.timeline())).not.toBeNull()
    expect(readTimeline({ step: 1, rows: [[1, 2, 3]] })).toBeNull()
    expect(readTimeline({ step: 0, rows: [] })).toBeNull()
    expect(readTimeline('x')).toBeNull()
  })

  it('merges a very long session into longer steps, keeping its totals', () => {
    const m = new TimelineBuilder()
    for (let i = 0; i <= MAX_ROWS; i++) m.add(T0 + i * 1000, { inputTokens: 1 }, 1)
    const t = m.timeline()
    expect(t.step).toBe(10)
    expect(t.rows.length).toBeLessThanOrEqual(MAX_ROWS)
    expect(t.rows.every((r) => r[0] % 10 === 0)).toBe(true)
    expect(t.rows.reduce((n, r) => n + r[1], 0)).toBe(MAX_ROWS + 1)
  })

  it('come from each provider’s parser', () => {
    const p = new ClaudeUsageParser('s')
    const reply = (ts: string, id: string, n: number) => ({ type: 'assistant', requestId: id, timestamp: ts, message: { model: 'claude-sonnet-5-5', usage: { input_tokens: n, output_tokens: n } } })
    p.feed([reply(iso(0), 'r1', 10), reply(iso(0), 'r1', 10), reply(iso(5), 'r2', 20)].map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect(p.result().timeline?.rows).toEqual([
      [secondOf(iso(0)), 10, 10, 0, 0, 1],
      [secondOf(iso(5)), 20, 20, 0, 0, 1]
    ])

    const tc = (ts: string, input: number, output: number) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } })
    const codex = parseRollout([tc(iso(0), 100, 10), tc(iso(3), 250, 30)].map((l) => JSON.stringify(l)).join('\n'), 'c')
    expect(codex.timeline?.rows).toEqual([
      [secondOf(iso(0)), 100, 10, 0, 0, 1],
      [secondOf(iso(3)), 150, 20, 0, 0, 1]
    ])

    const line = (type: string, timestamp: string, data: Record<string, unknown>): string => JSON.stringify({ type, data, timestamp }) + '\n'
    const copilot = parseEvents(
      line('assistant.message', iso(0), {}) + line('assistant.message', iso(2), {}) + line('session.usage_checkpoint', iso(2), { totalNanoAiu: 2e9 }) + line('session.shutdown', iso(4), { modelMetrics: { 'gpt-4.1': { usage: { inputTokens: 100, outputTokens: 20 } } } }),
      'p'
    )
    // Requests and charges as they came; the launch's tokens, given at its end, over its requests' seconds.
    expect(copilot.timeline?.rows).toEqual([
      [secondOf(iso(0)), 50, 10, 0, 0, 1],
      [secondOf(iso(2)), 50, 10, 0, 0, 1, 0.02]
    ])
  })

  it('are left out of priced usage', () => {
    const p = new ClaudeUsageParser('s')
    p.feed(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: iso(0), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } } }) + '\n')
    const { timeline: _t, ...raw } = p.result()
    expect(priceUsage(raw, DEFAULT_SETTINGS).timeline).toBeUndefined()
  })
})

describe('sliceSession', () => {
  // Minute-long rows (a merged timeline's), so a span can cover part of one.
  const rows: UsageRow[] = [
    [secondOf(iso(0))!, 100, 10, 0, 0, 1],
    [secondOf(iso(10))!, 300, 30, 0, 0, 3]
  ]
  const usage = (over: Partial<SessionUsage> = {}): SessionUsage =>
    priceUsage({ provider: 'codex', sessionId: 'c', title: null, model: 'gpt-5.5', cliVersion: null, inputTokens: 400, outputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 4, reasoningTokens: 0, contextTokens: 0, contextWindow: null, compactions: [], cacheTtlSeconds: 0, firstActivity: iso(0), lastActivity: iso(10), userMessages: 1, lastPrompt: null, costUsd: null, costEstimated: false, days: { [localDay(T0)]: { inputTokens: 400, outputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 4, prompts: 1, compactions: 0, costUsd: null, costEstimated: false } }, ...over }, DEFAULT_SETTINGS)
  const slice = (u: SessionUsage | null, r: UsageRow[] | null = rows): SessionSlice => ({ usage: u, timeline: r && { step: 60, rows: r }, from: T0, to: T0 + 11 * MINUTE_MS })

  it('gives a span its rows and its share of the day’s cost', () => {
    const u = usage()
    const whole = sliceSession(slice(u), [[T0, T0 + 11 * MINUTE_MS]], DEFAULT_SETTINGS)!
    const first = sliceSession(slice(u), [[T0, T0 + 5 * MINUTE_MS]], DEFAULT_SETTINGS)!
    expect(first).toMatchObject({ inputTokens: 100, outputTokens: 10, requests: 1, priced: 1, unpriced: 0, estimated: true })
    expect(whole.cost).toBeCloseTo(u.costUsd!, 10)
    expect(first.cost).toBeCloseTo(u.costUsd! / 4, 10)
    // Half a row: half of it.
    expect(sliceSession(slice(u), [[T0 + 30_000, T0 + 5 * MINUTE_MS]], DEFAULT_SETTINGS)).toMatchObject({ inputTokens: 50, outputTokens: 5 })
    // Not active in the span at all.
    expect(sliceSession(slice(u), [[T0 + 2 * MINUTE_MS, T0 + 5 * MINUTE_MS]], DEFAULT_SETTINGS)).toBeNull()
  })

  it('says unknown where it can’t place usage in time or has no price, never $0', () => {
    expect(sliceSession(slice(usage(), null), [[T0, T0 + MINUTE_MS]], DEFAULT_SETTINGS)).toMatchObject({ unpriced: 1, priced: 0 })
    const unpriced = sliceSession(slice(usage({ model: 'no-such-model' })), [[T0, T0 + MINUTE_MS]], DEFAULT_SETTINGS)!
    expect(unpriced).toMatchObject({ unpriced: 1, priced: 0, inputTokens: 100 })
    expect(partCost(unpriced)).toBe('Unknown')
  })

  it('shares a day’s charges by when they were made', () => {
    const charged: UsageRow[] = [
      [secondOf(iso(0))!, 0, 0, 0, 0, 1, 0.01],
      [secondOf(iso(10))!, 1000, 100, 0, 0, 1, 0.03]
    ]
    const u = usage({ provider: 'copilot', costReports: [{ costUsd: 0.04, days: { [localDay(T0)]: { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 } } }], costUsd: 0.04 })
    expect(sliceSession(slice(u, charged), [[T0, T0 + MINUTE_MS]], DEFAULT_SETTINGS)!.cost).toBeCloseTo(0.01, 10)
  })
})

describe('cost line', () => {
  it('reads as the decision says', () => {
    // costText's non-breaking spaces, as plain ones.
    const cardCostLine = (c: CardCost): string => costLine(c).replace(/ /g, ' ')
    const part = { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 1, cost: 1.84, estimated: true, priced: 2, unpriced: 0 }
    const c = { number: 1, title: 't', project: 'hive', column: 'done', rounds: 2, build: part, review: part, total: part, lastHeld: null, unmatched: 0 } satisfies CardCost
    expect(cardCostLine(c)).toBe('cost: ≈ $1.84 · 2 rounds')
    expect(cardCostLine({ ...c, rounds: 0, total: { ...part, priced: 0, unpriced: 1 } })).toBe('cost: Unknown')
    expect(cardCostLine({ ...c, rounds: 1, total: { ...part, estimated: false, unpriced: 1 } })).toBe('cost: $1.84 + ? · 1 round')
  })
})
