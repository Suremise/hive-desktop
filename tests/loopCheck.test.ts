// An agent in a card loop that ends its turn with no card watch (#376): which of its cards are still in play, and what a
// stalled card says. (The e2e loopwatch suite runs it on fake Claude Code agents: the grace, the flag, the notice.)
import { describe, expect, it } from 'vitest'
import { cardsInPlay, unwatched } from '../src/main/loopCheck'
import { providerDescriptor } from '../src/shared/providers'
import { notWatchingReason, REVIEW_WAIT_STALL_MS, reviewWaitReason } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'

const card = (number: number, over: Partial<TaskCard> = {}): TaskCard => ({ number, title: `Card ${number}`, project: 'alpha', column: 'todo', agent: null, archived: false, labels: [], blockedBy: [], links: [], comments: [], history: [], ...over }) as unknown as TaskCard

describe('cards in play for a loop agent (#376)', () => {
  const board = [
    card(1, { column: 'review' }), // watched, in Review
    card(2, { column: 'doing' }), // watched, in Doing
    card(3, { column: 'passed' }), // watched, passed: its part is over
    card(4, { column: 'review', archived: true }), // watched, archived
    card(5, { column: 'review', agent: 'a1' }), // its own card in Review
    card(6, { column: 'review', review: { agent: 'a1', agentName: 'R', since: '' } as never }), // one it is reviewing
    card(7, { column: 'doing', agent: 'a1' }), // its own card in Doing: it may be asking the user, not counted
    card(8, { column: 'review', agent: 'a1', project: 'beta' }), // another project's agent with the same id
    card(9, { column: 'review', agent: 'a2' }), // someone else's
    card(10, { column: 'review', project: 'beta' }) // watched, but moved to another project
  ]
  it('the cards it last watched in Doing or Review, and those in Review it is the agent or reviewer of', () => {
    expect(cardsInPlay(board, 'Alpha', 'a1', [1, 2, 3, 4, 10])).toEqual([1, 2, 5, 6])
    expect(cardsInPlay(board, 'alpha', 'a1', [])).toEqual([5, 6])
    expect(cardsInPlay(board, 'alpha', 'a3', [9])).toEqual([9])
    expect(cardsInPlay(board, 'alpha', 'a3', [3])).toEqual([])
  })

  it("a card shows as stalled while an agent left it with no watch, only in Doing or Review", () => {
    const agents = [{ name: 'Builder', project: 'alpha' }, { name: 'R6', project: 'alpha', notWatching: [333] }]
    expect(notWatchingReason(card(333, { column: 'review' }), agents)).toBe("R6 isn't watching #333: its turn ended with no card watch.")
    expect(notWatchingReason(card(333, { column: 'doing' }), agents)).toMatch(/^R6 isn't watching #333/)
    expect(notWatchingReason(card(333, { column: 'passed' }), agents)).toBeNull()
    expect(notWatchingReason(card(333, { column: 'review', archived: true }), agents)).toBeNull()
    expect(notWatchingReason(card(334, { column: 'review' }), agents)).toBeNull()
    // Moved to another project: its old project's agent isn't on it any more.
    expect(notWatchingReason(card(333, { column: 'review', project: 'beta' }), agents)).toBeNull()
  })

  it("an agent whose turn ended with background tasks running is not flagged where they wake it; where they don't (Codex), it is (#521)", () => {
    expect(unwatched({ provider: 'claude-code', status: 'finished' })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'ready' })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'finished', backgroundTasks: 1 })).toBe(false)
    expect(unwatched({ provider: 'claude-code', status: 'background', backgroundTasks: 1 })).toBe(false)
    // Codex tracks tasks but isn't woken when they end: nothing will wake it.
    expect(providerDescriptor('codex').capabilities.backgroundWakes).toBe(false)
    expect(unwatched({ provider: 'codex', status: 'finished', backgroundTasks: 1 })).toBe(true)
    expect(unwatched({ provider: 'claude-code', status: 'watching', watch: { cards: [1], changes: ['column'], label: '', since: '', limitAt: '' } })).toBe(false)
    expect(unwatched(null)).toBe(false)
  })
})

describe('a card in Review its watching reviewer has not started on (#521)', () => {
  const t0 = Date.parse('2026-10-10T07:39:57.143Z')
  const inReview = (over: Partial<TaskCard> = {}) => card(506, { column: 'review', agent: 'b2', history: [{ at: '2026-10-10T07:39:57.143Z', by: 'HB2 (alpha)', what: 'Moved to Review' }], ...over })
  const watchers = [{ name: 'HR2', project: 'alpha', agentId: 'r2', cards: [506, 509] }]
  it('stalled once it has waited the limit while an agent other than its own watches it', () => {
    expect(reviewWaitReason(inReview(), watchers, t0 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(reviewWaitReason(inReview(), watchers, t0 + REVIEW_WAIT_STALL_MS)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 15 min.")
    expect(reviewWaitReason(inReview(), watchers, t0 + 5 * 3600_000 + 5 * 60_000)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 5 h 5 min.")
    // Returned for review counts as coming into it.
    expect(reviewWaitReason(inReview({ history: [{ at: '2026-10-10T07:39:57.143Z', by: 'HB2 (alpha)', what: 'Returned for review, round 2' }] }), watchers, t0 + REVIEW_WAIT_STALL_MS)).toMatch(/^HR2 is watching #506/)
  })
  it("not while it is reviewed, blocked, elsewhere, archived, watched by none or only by its own agent, or another project's", () => {
    const late = t0 + 3600_000
    expect(reviewWaitReason(inReview({ review: { agent: 'r2', agentName: 'HR2', since: '' } as never }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ blocked: 'Asked the user' }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ column: 'doing' }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview({ archived: true }), watchers, late)).toBeNull()
    expect(reviewWaitReason(inReview(), [], late)).toBeNull()
    expect(reviewWaitReason(inReview(), [{ name: 'HB2', project: 'alpha', agentId: 'b2', cards: [506] }], late)).toBeNull()
    expect(reviewWaitReason(inReview(), [{ ...watchers[0], project: 'beta' }], late)).toBeNull()
    expect(reviewWaitReason(inReview({ history: [] }), watchers, late)).toBeNull()
  })
  it('not for a round already reviewed: a failed card waiting in Review for its fixes; its next return can stall again (round 1 finding)', () => {
    const h = (s: number, by: string, what: string) => ({ at: new Date(t0 + s * 1000).toISOString(), by, what })
    const failed = [h(0, 'HB2 (alpha)', 'Moved to Review'), h(1, 'HR2 (alpha)', 'Started reviewing'), h(2, 'HR2 (alpha)', 'Review failed')]
    expect(reviewWaitReason(inReview({ history: failed }), watchers, t0 + 3600_000)).toBeNull()
    expect(reviewWaitReason(inReview({ history: failed.slice(0, 2) }), watchers, t0 + 3600_000)).toBeNull()
    // Returned for review (round 2) and nobody starts on it: stalled once it has waited the limit.
    const back = [...failed, h(600, 'HB2 (alpha)', 'Returned for review, round 2')]
    expect(reviewWaitReason(inReview({ history: back }), watchers, t0 + 600_000 + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
    expect(reviewWaitReason(inReview({ history: back }), watchers, t0 + 600_000 + REVIEW_WAIT_STALL_MS)).toBe("HR2 is watching #506 but hasn't started reviewing it: in Review for 15 min.")
  })
})
