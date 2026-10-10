// A lane's segmented bar in the Progress panel (#484): each card's segment from the board (column, blocked, review
// rounds), the hover text, folding a long lane's finished cards, and the header's numbers.
import { describe, expect, it } from 'vitest'
import { cardSegment, fitSegments, laneCards, laneSummary, reviewRounds, segmentsThatFit, type CardSegment } from '../src/shared/laneBar'
import type { TaskCard, TaskColumn } from '../src/shared/types'

const card = (number: number, column: TaskColumn, history: string[] = [], extra: Partial<TaskCard> = {}): TaskCard => ({
  number,
  title: `Card ${number}`,
  description: '',
  project: 'hive',
  agent: null,
  column,
  order: 0,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: history.map((what, i) => ({ at: new Date(1000 * (i + 1)).toISOString(), by: 'B1', what })),
  archived: false,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  ...extra
})

describe('a card segment', () => {
  it('takes its state from the column, blocked and On Hold first', () => {
    expect(cardSegment(1, card(1, 'todo')).state).toBe('todo')
    expect(cardSegment(1, card(1, 'doing')).state).toBe('doing')
    expect(cardSegment(1, card(1, 'review')).state).toBe('review')
    expect(cardSegment(1, card(1, 'passed')).state).toBe('passed')
    expect(cardSegment(1, card(1, 'done')).state).toBe('done')
    expect(cardSegment(1, card(1, 'hold')).state).toBe('blocked')
    expect(cardSegment(1, card(1, 'doing', [], { blocked: 'needs a decision' })).state).toBe('blocked')
    // Finished stays finished, blocked or not.
    expect(cardSegment(1, card(1, 'passed', [], { blocked: 'stale reason' })).state).toBe('passed')
  })

  it('counts rounds from the review verdicts', () => {
    const inReview = card(4, 'review', ['Created in Todo', 'Moved to Doing', 'Moved to Review'])
    expect(cardSegment(4, inReview)).toMatchObject({ state: 'review', failed: false, round: 1, label: '#4 Card 4 · Review, round 1' })
    // Failed and still in Review (the builder hasn't picked it up): round 1 failed.
    const failed = card(4, 'review', ['Moved to Review', 'Started reviewing', 'Review failed'])
    expect(cardSegment(4, failed)).toMatchObject({ state: 'review', failed: true, round: 1, label: '#4 Card 4 · Review, round 1 failed review' })
    // Being fixed in Doing: still the failed round.
    const fixing = card(4, 'doing', ['Moved to Review', 'Review failed', 'Moved to Doing'])
    expect(cardSegment(4, fixing)).toMatchObject({ state: 'doing', failed: true, round: 1 })
    // Back in Review (moved, or returned in place): its next round, no longer failed.
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Moved to Doing', 'Moved to Review']))).toMatchObject({ failed: false, round: 2 })
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Returned for review, round 2']))).toMatchObject({ failed: false, round: 2 })
    // Several notes in one history line.
    expect(cardSegment(4, card(4, 'review', ['Review failed', 'Review failed', 'Moved to Doing; Given to B1', 'Moved to Review']))).toMatchObject({ failed: false, round: 3 })
    // Passed after two failures: passed in round 3.
    expect(cardSegment(4, card(4, 'passed', ['Review failed', 'Moved to Review', 'Review failed', 'Moved to Review', 'Review passed; Moved to Passed']))).toMatchObject({ state: 'passed', failed: false, round: 3, label: '#4 Card 4 · Passed in round 3' })
    expect(cardSegment(4, card(4, 'todo')).round).toBeNull()
  })

  it('says why a blocked card is blocked, and a card not on the board', () => {
    expect(cardSegment(7, card(7, 'doing', [], { blocked: 'waiting for Darren' })).label).toBe('#7 Card 7 · Doing, round 1 · Blocked: waiting for Darren')
    expect(cardSegment(7, card(7, 'hold')).label).toBe('#7 Card 7 · On Hold, waiting for you')
    expect(cardSegment(9, undefined)).toMatchObject({ state: 'todo', label: '#9 · not on the board' })
  })

  it('reads the verdicts with their history', () => {
    expect(reviewRounds(card(1, 'review', ['Review failed', 'Started reviewing']))).toEqual({ failures: 1, failedNow: false, reviewed: true })
    expect(reviewRounds(card(1, 'todo'))).toEqual({ failures: 0, failedNow: false, reviewed: false })
  })
})

describe('a lane', () => {
  const tasks = [card(1, 'done'), card(2, 'passed'), card(3, 'review'), card(4, 'doing'), card(5, 'todo')]

  it('keeps the lane order and its header numbers', () => {
    const cards = laneCards([3, 1, 5, 2, 4], tasks)
    expect(cards.map((c) => c.number)).toEqual([3, 1, 5, 2, 4])
    expect(laneSummary(cards)).toEqual({ finished: 2, total: 5, current: 3 })
    expect(laneSummary(laneCards([1, 2], tasks))).toEqual({ finished: 2, total: 2, current: null })
  })

  it('shows every card while they fit, then folds the finished ones into one, then the last into "+n"', () => {
    const cards = laneCards([1, 2, 3, 4, 5], tasks)
    expect(fitSegments(cards, 5)).toBe(cards)
    const four = fitSegments(cards, 4)
    expect(four.map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual(['finished:1,2', 3, 4, 5])
    expect(four[0]).toMatchObject({ label: '2 finished: #1, #2' })
    const three = fitSegments(cards, 3)
    expect(three.map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual(['finished:1,2', 3, 'more:4,5'])
    // No finished cards to fold: straight to "+n".
    const todo: CardSegment[] = laneCards([3, 4, 5, 6, 7], tasks)
    expect(fitSegments(todo, 3).map((s) => (s.kind === 'card' ? s.number : `${s.kind}:${s.numbers.join()}`))).toEqual([3, 4, 'more:5,6,7'])
  })

  it('fits segments of at least 12 px with 2 px gaps, and never fewer than three', () => {
    expect(segmentsThatFit(240)).toBe(17)
    expect(segmentsThatFit(12)).toBe(3)
  })
})
