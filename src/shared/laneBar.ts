import { columnLabel } from './tasks'
import type { LaneCard, LaneState, TaskCard } from './types'

/**
 * A lane in the Progress panel (#484): a segmented bar, one equal-width segment per card in the lane's order, coloured
 * and patterned by where the card is. How a card reads there comes from the board alone (its column, blocked reason and
 * review verdicts), so a lane needs only its cards' numbers.
 */

/**
 * A card's segment: Done, Passed, in Review, in Doing, still to do, or blocked / waiting for the user (On Hold); or, in a
 * lane that ended without a record of its cards, unrecorded (not known, #512).
 */
export type SegmentState = 'done' | 'passed' | 'review' | 'doing' | 'todo' | 'blocked' | 'unrecorded'

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
  /**
   * What its marks mean (#706), each a line under the label in its hover and after it in its accessible name: a failed
   * review's red underline ("#650: review failed (round 4): waiting for round 5", then the reviewer's gist) and the red
   * cross-hatching of a blocked or On Hold card (its reason's first line).
   */
  notes: string[]
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

/** The longest a note's quoted line (a blocked reason, a reviewer's gist) runs in a segment's hover before it is cut. */
export const SEGMENT_NOTE_MAX = 160

/** A text's first line that isn't blank, cut to SEGMENT_NOTE_MAX. */
function oneLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > SEGMENT_NOTE_MAX ? `${line.slice(0, SEGMENT_NOTE_MAX - 1)}…` : line
}

/** How long after a verdict its comment is taken as the verdict's: both are saved in the same change. */
const VERDICT_COMMENT_MS = 10_000

/** The first line of the comment its reviewer gave with its latest failed verdict, if any (#706). */
export function failedVerdictGist(c: Pick<TaskCard, 'history' | 'comments'>): string | null {
  const v = c.history.findLast((h) => parts(h.what).some((p) => p.startsWith('Review failed')))
  const at = v ? Date.parse(v.at) : NaN
  if (!v || Number.isNaN(at)) return null
  const said = c.comments.find((x) => x.by === v.by && Date.parse(x.at) >= at && Date.parse(x.at) - at <= VERDICT_COMMENT_MS)
  // Plain text in a tooltip: a heading's marks and bold dropped.
  const line = said ? oneLine(said.text.replace(/^\s*#+\s+/gm, '').replace(/\*\*|__/g, '')) : ''
  return line || null
}

/**
 * Why a blocked segment is hatched (#706): "#7: blocked: <its reason's first line>", "#7: On Hold: <reason>", or with no
 * reason, On Hold until the user moves it; null for an ended lane's card On Hold with none (its label says it all).
 */
function blockedNote(n: number, hold: boolean, blocked: string | null, live: boolean): string | null {
  const reason = blocked ? oneLine(blocked) : ''
  if (reason) return `#${n}: ${hold ? 'On Hold' : 'blocked'}: ${reason}`
  if (!hold) return `#${n}: blocked`
  return live ? `#${n}: On Hold: waiting for you to move it on` : null
}

/** A card segment's accessible name: its label and its notes (#706). */
export function segmentName(s: CardSegment): string {
  return [s.label, ...s.notes].join('. ')
}

/** A card number's segment, from the card as it is on the board (or not: archived and deleted cards may be missing). */
export function cardSegment(n: number, card: TaskCard | undefined): CardSegment {
  if (!card) return { kind: 'card', number: n, state: 'todo', failed: false, round: null, label: `#${n} · not on the board`, notes: [] }
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
  const notes: string[] = []
  // The red underline: which round failed and what comes next, then the reviewer's own one-line gist.
  if (failed) {
    notes.push(`#${n}: review failed (round ${round}): waiting for round ${(round ?? 0) + 1}`)
    const gist = failedVerdictGist(card)
    if (gist) notes.push(`Reviewer: ${gist}`)
  }
  // The red cross-hatching: why it can't go on.
  const why = state === 'blocked' ? blockedNote(n, card.column === 'hold', card.blocked, true) : null
  if (why) notes.push(why)
  return { kind: 'card', number: n, state, failed, round, label: `#${n} ${card.title} · ${what}`, notes }
}

/** A lane card's state as the lane last read it (LaneCard): a gone card reads as still to do, as one not on the board. */
export function laneCardState(c: LaneCard): SegmentState {
  if (c.column === 'unrecorded') return 'unrecorded'
  if (c.column === 'done') return 'done'
  if (c.column === 'passed') return 'passed'
  if (c.blocked || c.column === 'hold') return 'blocked'
  if (c.column === 'review') return 'review'
  if (c.column === 'doing') return 'doing'
  return 'todo'
}

/**
 * A segment as the lane left it when it ended or was abandoned (#512): frozen, so a card another lane works on now never
 * shows as worked here too. The lane keeps no review verdicts, so a frozen segment marks no failed round.
 */
export function frozenSegment(c: LaneCard): CardSegment {
  const state = laneCardState(c)
  if (c.column === 'gone') return { kind: 'card', number: c.number, state, failed: false, round: null, label: `#${c.number} · not on the board when the lane ended`, notes: [] }
  // Ended without a record of its cards: said so, rather than the board's now presented as when it ended.
  if (c.column === 'unrecorded') return { kind: 'card', number: c.number, state, failed: false, round: null, label: `#${c.number}${c.title ? ` ${c.title}` : ''} · not recorded: the lane ended before Hive kept where its cards were`, notes: [] }
  const where = c.column === 'hold' ? 'On Hold' : columnLabel(c.column)
  const inRound = c.column === 'doing' || c.column === 'review'
  const round = inRound || isFinished(state) ? c.round : null
  let what = where
  if (round !== null && inRound) what = `${where}, round ${round}`
  else if (round !== null && round > 1) what = `${where} in round ${round}`
  const why = state === 'blocked' ? blockedNote(c.number, c.column === 'hold', c.blocked, false) : null
  return { kind: 'card', number: c.number, state, failed: false, round, label: `#${c.number} ${c.title} · ${what}, when the lane ended`, notes: why ? [why] : [] }
}

/**
 * The card a lane is on (#512): the one its builder is building (the first in Doing that isn't blocked), else the first
 * in Review, else the first still to do. `waiting`: the lane can't go on until the user answers: its first unfinished
 * card is blocked (or On Hold) and no other is in Doing or Review; that card is then the current one. A builder that
 * moved on to the next card while a blocked one waits is working, not waiting. `finished` defaults to Passed or Done.
 */
export function currentCard(cards: readonly { number: number; state: SegmentState; finished?: boolean }[]): { current: number | null; waiting: boolean } {
  const open = cards.filter((c) => !(c.finished ?? isFinished(c.state)))
  if (!open.length) return { current: null, waiting: false }
  const free = open.filter((c) => c.state !== 'blocked')
  const worked = free.find((c) => c.state === 'doing') ?? free.find((c) => c.state === 'review')
  if (open[0].state === 'blocked' && !worked) return { current: open[0].number, waiting: true }
  return { current: (worked ?? free[0] ?? open[0]).number, waiting: false }
}

const GROUP: Record<LaneState, number> = { active: 0, paused: 1, ended: 2, abandoned: 2 }

/** The panel's order of lanes (#512): running ones, then paused ones, then ended and abandoned ones; newest first in each. */
export function panelOrder<T extends { state: LaneState; startedAt: string; endedAt: string | null }>(lanes: readonly T[]): T[] {
  const at = (l: T): string => (GROUP[l.state] === 2 ? (l.endedAt ?? l.startedAt) : l.startedAt)
  return [...lanes].sort((a, b) => GROUP[a.state] - GROUP[b.state] || at(b).localeCompare(at(a)))
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

/** A lane's header numbers: its finished cards out of all, and the card it is on (currentCard). */
export function laneSummary(cards: CardSegment[]): { finished: number; total: number; current: number | null } {
  return { finished: cards.filter((c) => isFinished(c.state)).length, total: cards.length, current: currentCard(cards).current }
}

/**
 * How many lanes the Progress panel's lanes section shows before it scrolls (#569): up to four by default (Settings →
 * Advanced → Progress panel: lanes shown, and a workspace's own: #367, the `fallback` below); the user drags
 * the section's top edge (or presses Up and Down on it) for more or fewer, in whole lanes, kept per workspace. With fewer
 * lanes than that, the section is only as tall as they are.
 */
export const DEFAULT_LANE_ROWS = 4

/** The height the runs above keep (px) when the lanes are dragged up: about a run and a half. */
export const RUNS_KEEP_PX = 120

/** A kept choice as a whole number of lanes, at least one; the default (`fallback`) when there is none (or it isn't a number). */
export function chosenLaneRows(kept: number | null | undefined, fallback = DEFAULT_LANE_ROWS): number {
  return typeof kept === 'number' && Number.isFinite(kept) ? Math.max(1, Math.round(kept)) : fallback
}

/** The lanes shown: the choice, but never more than there are (no empty space) and at least one. */
export function lanesShown(kept: number | null | undefined, count: number, fallback = DEFAULT_LANE_ROWS): number {
  return Math.max(1, Math.min(count, chosenLaneRows(kept, fallback)))
}

/**
 * The most lanes the section can show: no more than there are, nor than fit in `roomPx` (the list's height now and what
 * the runs above can give up, keeping RUNS_KEEP_PX) at `pitchPx` a lane; always at least one.
 */
export function maxLaneRows(count: number, roomPx: number, pitchPx: number): number {
  const fit = pitchPx > 0 ? Math.floor((roomPx + 1) / pitchPx) : count
  return Math.max(1, Math.min(count, fit))
}

/**
 * The lanes shown now: the choice, but no more than fit in `roomPx` (null: not measured yet), so a panel too short for
 * the choice shows whole lanes and leaves the runs their room; the choice itself is kept for when there is room again.
 * `max` is the most that fit, the splitter's maximum.
 */
export function laneRowsNow(kept: number | null | undefined, count: number, roomPx: number | null, pitchPx: number, fallback = DEFAULT_LANE_ROWS): { chosen: number; shown: number; max: number } {
  const chosen = lanesShown(kept, count, fallback)
  const max = roomPx === null ? count : maxLaneRows(count, roomPx, pitchPx)
  return { chosen, shown: Math.min(chosen, max), max }
}

/** Dragging the top edge by `dyPx` (negative is up, showing more) from `startRows`, snapped to whole lanes. */
export function draggedLaneRows(startRows: number, dyPx: number, pitchPx: number, max: number): number {
  const rows = pitchPx > 0 ? Math.round(startRows - dyPx / pitchPx) : startRows
  return Math.max(1, Math.min(max, rows))
}

/** A key on the focused edge: Up shows a lane more, Down one fewer, Home one, End as many as fit; null for other keys. */
export function keyedLaneRows(rows: number, key: string, max: number): number | null {
  const next = key === 'ArrowUp' ? rows + 1 : key === 'ArrowDown' ? rows - 1 : key === 'Home' ? 1 : key === 'End' ? max : null
  return next === null ? null : Math.max(1, Math.min(max, next))
}
