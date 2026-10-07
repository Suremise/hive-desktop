// An agent in a card loop that ends its turn with no card watch (#376): which of its cards are still in play, and what a
// stalled card says. (The e2e loopwatch suite runs it on fake Claude Code agents: the grace, the flag, the notice.)
import { describe, expect, it } from 'vitest'
import { cardsInPlay } from '../src/main/loopCheck'
import { notWatchingReason } from '../src/shared/tasks'
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
})
