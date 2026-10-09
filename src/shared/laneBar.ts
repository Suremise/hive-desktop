import { columnLabel } from './tasks'
import type { TaskCard } from './types'

/**
 * A lane in the Progress panel (#484): a segmented bar, one equal-width segment per card in the lane's order, coloured
 * and patterned by where the card is. How a card reads there comes from the board alone (its column, blocked reason and
 * review verdicts), so a lane needs only its cards' numbers.
 */

/** A card's segment: Done, Passed, in Review, in Doing, still to do, or blocked / waiting for the user (On Hold). */
export type SegmentState = 'done' | 'passed' | 'review' | 'doing' | 'todo' | 'blocked'

export interface CardSegment {
  kind: 'card'
  number: number
  state: SegmentState
  /** Its latest review failed and it hasn't gone back for the next round yet. */
  failed: boolean
  /** The round it is in (Doing or Review), failed or passed in; null before its first round and when not on the board. */
  round: number | null
  /** Hover text: "#405 Built-in loop wakes · Review, round 2". */
  label: string
}

/** Finished cards folded into one segment ("✓ 6"), or the rest of a lane too long for its bar ("+4"). */
export interface FoldedSegment {
  kind: 'finished' | 'more'
  numbers: number[]
  label: string
}

export type LaneSegment = CardSegment | FoldedSegment

/** The narrowest a card's segment gets (px) before finished cards fold into one, and the gap between segments. */
export const SEGMENT_MIN_PX = 12
export const SEGMENT_GAP_PX = 2

const VERDICT = /^Review (passed|failed)/
/** What starts a card's next round after a failed review: back in Review (returned or moved), or a review starting. */
const NEXT_ROUND = /^(Returned for review|Moved to (the (top|bottom) of )?Review\b|Started reviewing)/

/** A history line's parts: one change can note several ("Moved to Review; Returned for review, round 2"). */
const parts = (what: string): string[] => what.split('; ')

const FINISHED: readonly SegmentState[] = ['done', 'passed']
export const isFinished = (s: SegmentState): boolean => FINISHED.includes(s)

function stateOf(c: TaskCard): SegmentState {
  if (c.column === 'done') return 'done'
  if (c.column === 'passed') return 'passed'
  if (c.blocked || c.column === 'hold') return 'blocked'
  if (c.column === 'review') return 'review'
  if (c.column === 'doing') return 'doing'
  return 'todo'
}

/** Its failed reviews, and whether the latest verdict failed with no next round started since. */
export function reviewRounds(c: TaskCard): { failures: number; failedNow: boolean; reviewed: boolean } {
  const lines = c.history.flatMap((h) => parts(h.what))
  const failures = lines.filter((l) => l.startsWith('Review failed')).length
  const last = lines.findLastIndex((l) => VERDICT.test(l))
  const failedNow = last >= 0 && lines[last].startsWith('Review failed') && !lines.slice(last + 1).some((l) => NEXT_ROUND.test(l))
  return { failures, failedNow, reviewed: last >= 0 }
}

/** A card number's segment, from the card as it is on the board (or not: archived and deleted cards may be missing). */
export function cardSegment(n: number, card: TaskCard | undefined): CardSegment {
  if (!card) return { kind: 'card', number: n, state: 'todo', failed: false, round: null, label: `#${n} · not on the board` }
  const state = stateOf(card)
  const { failures, failedNow, reviewed } = reviewRounds(card)
  const inRound = card.column === 'doing' || card.column === 'review'
  const failed = failedNow && inRound && !isFinished(state)
  // A failed card is in the round that failed until it goes back; a finished one passed in the round after its failures.
  const round = failed ? failures : inRound || (isFinished(state) && reviewed) ? failures + 1 : null
  const where = card.column === 'hold' ? 'On Hold, waiting for you' : columnLabel(card.column)
  let what = where
  if (failed) what = `${where}, round ${round} failed review`
  else if (round !== null && inRound) what = `${where}, round ${round}`
  else if (round !== null && round > 1) what = `${where} in round ${round}`
  if (card.blocked) what += ` · Blocked: ${card.blocked}`
  return { kind: 'card', number: n, state, failed, round, label: `#${n} ${card.title} · ${what}` }
}

/** Every card of a lane as a segment, in the lane's order. */
export function laneCards(numbers: readonly number[], tasks: readonly TaskCard[]): CardSegment[] {
  const byNumber = new Map(tasks.map((t) => [t.number, t]))
  return numbers.map((n) => cardSegment(n, byNumber.get(n)))
}

/** How many segments fit in a bar this wide (at least three: the finished fold, a card and the rest). */
export function segmentsThatFit(widthPx: number): number {
  return Math.max(3, Math.floor((widthPx + SEGMENT_GAP_PX) / (SEGMENT_MIN_PX + SEGMENT_GAP_PX)))
}

const cardList = (ns: number[]): string => (ns.length > 8 ? `${ns.slice(0, 8).map((n) => `#${n}`).join(', ')} and ${ns.length - 8} more` : ns.map((n) => `#${n}`).join(', '))

/**
 * The bar's segments when there's room for `max`: every card while they fit; past that, the finished cards (Passed and
 * Done) fold into one "✓ n" segment at the left, and if that isn't enough either, the last ones fold into "+n".
 */
export function fitSegments(cards: CardSegment[], max: number): LaneSegment[] {
  if (cards.length <= max) return cards
  const finished = cards.filter((c) => isFinished(c.state))
  const rest = cards.filter((c) => !isFinished(c.state))
  const out: LaneSegment[] = finished.length ? [{ kind: 'finished', numbers: finished.map((c) => c.number), label: `${finished.length} finished: ${cardList(finished.map((c) => c.number))}` }] : []
  const room = Math.max(1, max - out.length)
  if (rest.length <= room) return [...out, ...rest]
  const more = rest.slice(room - 1)
  return [...out, ...rest.slice(0, room - 1), { kind: 'more', numbers: more.map((c) => c.number), label: `${more.length} more: ${cardList(more.map((c) => c.number))}` }]
}

/** A lane's header numbers: its finished cards out of all, and the card it is on (the first unfinished, in order). */
export function laneSummary(cards: CardSegment[]): { finished: number; total: number; current: number | null } {
  return { finished: cards.filter((c) => isFinished(c.state)).length, total: cards.length, current: cards.find((c) => !isFinished(c.state))?.number ?? null }
}
