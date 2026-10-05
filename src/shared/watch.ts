/**
 * Waiting on cards (#128): what an agent waits for (cards, which changes count, a column to arrive in), what counts as a
 * change since it began waiting, and the one line Hive types to wake it. Pure, so the Agent API's waits, Hive's
 * wake-on-change watches and tests share it.
 *
 * A change is found by comparing each card with a snapshot taken when the wait began: its column, its latest comment's
 * time, its latest review verdict's time, its agent, and whether it is archived (or gone). A wait for a column alone
 * ("until it is in Review") counts only that: it is met as soon as the card is in that column, also if it already was,
 * and nothing else wakes it (a comment while the card is still in Doing doesn't). A column with `changes` naming
 * `column` is a move into it (only when it moves there), or any other change listed ("verdict or into Done").
 */
import type { TaskCard, TaskColumn } from './types'

const COLUMN_WORD: Record<TaskColumn, string> = { todo: 'Todo', doing: 'Doing', review: 'Review', done: 'Done' }

/** What counts as a change: a column move, a new comment, a review verdict, a change of agent. Default: any. */
export type WatchChange = 'column' | 'comment' | 'verdict' | 'agent'
export const WATCH_CHANGES: readonly WatchChange[] = ['column', 'comment', 'verdict', 'agent']

/** A wait's condition: the cards (numbers), which changes count, and optionally a column one of them must be in. */
export interface WatchCondition {
  cards: number[]
  changes: WatchChange[]
  column?: TaskColumn
  /**
   * With a column: a move into it, not just being in it (`changes` named `column` explicitly). A card already there
   * then waits until it leaves and comes back: a reviewer waiting for a failed card's next round.
   */
  moveInto?: true
}

/** At most this many cards in one wait. */
export const WATCH_MAX_CARDS = 20
/** A bounded wait's longest (seconds): under Codex's tool timeout for hive (900 s), with room for the reply. */
export const WAIT_MAX_SECONDS = 840
/** A watch's default overall limit with no change before Hive wakes the agent to say so (minutes), and the most allowed. */
export const WATCH_DEFAULT_LIMIT_MINUTES = 120
export const WATCH_MAX_LIMIT_MINUTES = 24 * 60

/** A card as a wait last saw it. */
export interface CardMark {
  column: TaskColumn | 'gone'
  /** Latest comment's and verdict's times (ms; 0: none), its agent ('' none), archived. */
  comment: number
  verdict: number
  agent: string
  archived: boolean
}

const VERDICT = /^Review (passed|failed)/

const COLUMNS = ['todo', 'doing', 'review', 'done'] as const
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A saved mark, checked (null: not one). */
export function readMark(v: unknown): CardMark | null {
  if (!isObj(v)) return null
  const column = v.column as CardMark['column']
  if (![...COLUMNS, 'gone'].includes(column) || !isTime(v.comment) || !isTime(v.verdict) || typeof v.agent !== 'string' || v.agent.length > 128 || typeof v.archived !== 'boolean') return null
  return { column, comment: v.comment, verdict: v.verdict, agent: v.agent, archived: v.archived }
}

/** A saved condition, checked (null: not one Hive would have made). */
export function readSavedCondition(v: unknown): WatchCondition | null {
  if (!isObj(v) || !Array.isArray(v.cards) || !Array.isArray(v.changes)) return null
  const cards = v.cards
  if (!cards.length || cards.length > WATCH_MAX_CARDS || cards.some((n) => !Number.isInteger(n) || (n as number) <= 0) || new Set(cards).size !== cards.length) return null
  const changes = v.changes
  if (!changes.length || changes.some((c) => !WATCH_CHANGES.includes(c as WatchChange)) || new Set(changes).size !== changes.length) return null
  if (v.column !== undefined && !COLUMNS.includes(v.column as TaskColumn)) return null
  if (v.moveInto !== undefined && (v.moveInto !== true || v.column === undefined)) return null
  // A column goes with `column` among the changes (as readCondition makes it).
  if (v.column !== undefined && !changes.includes('column')) return null
  return { cards: cards as number[], changes: changes as WatchChange[], ...(v.column ? { column: v.column as TaskColumn } : {}), ...(v.moveInto ? { moveInto: true as const } : {}) }
}

/** A card's mark now (null card: gone). */
export function markOf(card: TaskCard | null): CardMark {
  if (!card) return { column: 'gone', comment: 0, verdict: 0, agent: '', archived: false }
  const last = card.comments.at(-1)
  const verdict = card.history.filter((h) => VERDICT.test(h.what)).at(-1)
  return { column: card.column, comment: last ? Date.parse(last.at) || 0 : 0, verdict: verdict ? Date.parse(verdict.at) || 0 : 0, agent: card.agent ?? '', archived: card.archived }
}

/**
 * Whether a card moved into `column` after `since` (ISO), by its history ("Moved to Review", "Moved to the top of Review",
 * "Moved to Review, before #3"): a card that left and came back looks the same as one that never moved, by its marks.
 */
export function movedIntoSince(card: TaskCard | null, column: TaskColumn, since: string): boolean {
  if (!card) return false
  const w = COLUMN_WORD[column]
  // A failed card returned for review without leaving Review (#214) comes back into it as much as one moved there.
  const re = new RegExp(`^(Moved to (the (top|bottom) of )?${w}\\b|Created in ${w}\\b${column === 'review' ? '|Returned for review\\b' : ''})`)
  return card.history.some((h) => h.at > since && re.test(h.what))
}

/** A card's return for review in its history: "Returned for review, round 2". */
const RETURNED = /^Returned for review, round (\d+)/

/**
 * Whether a card in Review can be returned for review (#214): its latest review failed, and nothing has started another
 * round since (moved, reviewed again, reassigned, already returned). Its round then: one more than the reviews that
 * failed since it last passed one. Null: not returnable (moving it to Review is no change).
 */
export function returnRound(card: TaskCard): number | null {
  if (card.column !== 'review' || card.archived || card.review) return null
  const i = card.history.findLastIndex((h) => VERDICT.test(h.what))
  if (i < 0 || VERDICT.exec(card.history[i].what)![1] !== 'failed') return null
  if (card.history.slice(i + 1).some((h) => NEW_ROUND.test(h.what))) return null
  const passed = card.history.findLastIndex((h) => h.what.startsWith('Review passed'))
  return card.history.slice(passed + 1).filter((h) => h.what.startsWith('Review failed')).length + 1
}

/**
 * What changed on one card between two marks, of the kinds that count (a card gone or archived always counts). With a
 * column to move into, a column change counts when the card is there now and either its column differs from before or it
 * `moved` there meanwhile (left and came back).
 */
export function changesBetween(before: CardMark, after: CardMark, cond: Pick<WatchCondition, 'changes' | 'column' | 'moveInto'>, moved = false): WatchChange[] | 'gone' {
  if (after.column === 'gone' || (after.archived && !before.archived)) return 'gone'
  const kinds = new Set(cond.changes.length ? cond.changes : WATCH_CHANGES)
  const out: WatchChange[] = []
  const columnChanged = after.column !== before.column || (!!cond.moveInto && moved)
  if (kinds.has('column') && columnChanged && (!cond.column || after.column === cond.column)) out.push('column')
  if (kinds.has('comment') && after.comment > before.comment) out.push('comment')
  if (kinds.has('verdict') && after.verdict > before.verdict) out.push('verdict')
  if (kinds.has('agent') && after.agent !== before.agent) out.push('agent')
  return out
}

/** Whether a card already meets a column condition (a wait for "in Review" on a card in Review is met at once). */
export const alreadyThere = (mark: CardMark, cond: Pick<WatchCondition, 'column' | 'moveInto'>): boolean => !!cond.column && !cond.moveInto && mark.column === cond.column

/**
 * A wait's `since`: the marks of its cards, as a short opaque text an agent passes back so a change between two calls
 * is never missed. `n:column:comment:verdict:agent:archived`, comma-separated; times in base 36.
 */
export function encodeSince(marks: Map<number, CardMark>, at = Date.now()): string {
  return `@${at.toString(36)};` + [...marks]
    .map(([n, m]) => [n, m.column, m.comment.toString(36), m.verdict.toString(36), encodeURIComponent(m.agent), m.archived ? 1 : 0].join(':'))
    .join(',')
}

/** Marks read back from `since`, and when it was taken (null: not one Hive wrote). */
export function decodeSince(since: string): { marks: Map<number, CardMark>; at: number } | null {
  if (typeof since !== 'string' || since.length > 4000) return null
  const head = /^@([0-9a-z]+);/.exec(since)
  if (!head) return null
  const at = parseInt(head[1], 36)
  if (!Number.isFinite(at)) return null
  const out = new Map<number, CardMark>()
  for (const part of since.slice(head[0].length).split(',').filter(Boolean)) {
    const [n, column, comment, verdict, agent, archived] = part.split(':')
    const num = Number(n)
    if (!Number.isInteger(num) || num <= 0 || !['todo', 'doing', 'review', 'done', 'gone'].includes(column)) return null
    const c = parseInt(comment, 36)
    const v = parseInt(verdict, 36)
    if (!Number.isFinite(c) || !Number.isFinite(v) || (archived !== '0' && archived !== '1')) return null
    let a: string
    try {
      a = decodeURIComponent(agent ?? '')
    } catch {
      return null
    }
    out.set(num, { column: column as CardMark['column'], comment: c, verdict: v, agent: a, archived: archived === '1' })
  }
  return { marks: out, at }
}

/** The changes a reply reports for one card: its number, column now, who changed it last, and its latest comment's author and first line. */
export interface CardChange {
  number: number
  column: TaskColumn | 'gone'
  changes: WatchChange[] | 'gone'
  by: string | null
  comment: { by: string; firstLine: string } | null
  /** For a wake line only (wakeAbout): whose card it is and the review's verdict. */
  about?: WakeAbout
}

/**
 * What a wake line adds so it can't be misread: `owner`, the agent of the card when another agent has it (its name;
 * null on the watcher's own card or one without an agent), and the review's verdict with its reviewer, when it is what
 * changed or, on another agent's card in Done, when that review passed it there.
 */
export interface WakeAbout {
  owner: string | null
  verdict: { passed: boolean; by: string } | null
  /** The round a failed card came back into Review for, when it was returned without leaving Review (#214). */
  returned?: number
}

/**
 * History that starts another round of work or review (back to work, in Review again, a review started, another agent),
 * after which an earlier verdict no longer speaks for the card.
 */
const NEW_ROUND = /^(Moved to (the (top|bottom) of )?(Todo|Doing|Review)\b|Created in |Given to |Taken from |Moved to the workspace|Started reviewing|Returned for review)/

const INTO_REVIEW = /^(Moved to (the (top|bottom) of )?Review\b|Created in Review\b|Returned for review\b)/

/** A wake's context for the agent `watcher` (its id), from the card as it is now. */
export function wakeAbout(card: TaskCard | null, changes: WatchChange[] | 'gone', watcher: string): WakeAbout {
  if (!card || changes === 'gone') return { owner: null, verdict: null }
  const owner = card.agent && card.agent !== watcher ? (card.agentName ?? card.agent) : null
  // The latest verdict, only while nothing has started another round since (back to Doing, reviewed again, reassigned):
  // one from an earlier build never speaks for work done after it. History is in the order it happened.
  const i = card.history.findLastIndex((h) => VERDICT.test(h.what))
  const current = i >= 0 && !card.history.slice(i + 1).some((h) => NEW_ROUND.test(h.what)) ? card.history[i] : null
  const passed = current ? VERDICT.exec(current.what)![1] === 'passed' : false
  // Done on another agent's card names its review only when that review passed it; moved there by hand, none.
  const wanted = changes.includes('verdict') || (!!owner && card.column === 'done' && passed)
  // Into Review by a return for review (#214): its latest arrival there says so.
  const arrival = changes.includes('column') && card.column === 'review' ? card.history.findLast((h) => INTO_REVIEW.test(h.what)) : undefined
  const returned = arrival ? RETURNED.exec(arrival.what) : null
  return { owner, verdict: wanted && current ? { passed, by: current.by } : null, ...(returned ? { returned: Number(returned[1]) } : {}) }
}

/** The most characters a name takes in a wake line (an agent's, a reviewer's, a comment's author): one line, cut with "…". */
const NAME_MAX = 40
const shortName = (name: string): string => {
  const chars = [...name.replace(/\s+/g, ' ').trim()]
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('')}…` : chars.join('')
}

/** A wake line's most bytes as saved (JSON-quoted). */
export const WAKE_MAX_BYTES = 1000
const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length

const firstLine = (text: string, max = 160): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A change, for a reply or a wake line. */
export function cardChange(n: number, card: TaskCard | null, changes: WatchChange[] | 'gone'): CardChange {
  const last = card?.comments.at(-1)
  const by = card ? ([...card.history].sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.by ?? null) : null
  return { number: n, column: card ? card.column : 'gone', changes, by, comment: last ? { by: last.by, firstLine: firstLine(last.text) } : null }
}

const columnWord = (c: TaskColumn | 'gone'): string => (c === 'gone' ? 'gone' : COLUMN_WORD[c])

/**
 * The one line Hive types to wake a watching agent: the card (and whose, when it isn't the watcher's), where it is now
 * (with the reviewer's verdict when that changed; Done on another agent's card says it isn't merged), and its latest
 * comment's author and first line, then what to do. Kept to one short line (the CLI sends a new line at once).
 */
export function wakeLine(change: CardChange, more = 0): string {
  const about = change.about
  // Gone also covers a card moved out of what the agent may see (another project): nothing about it is said then.
  const owner = about?.owner && change.changes !== 'gone' ? ` (${shortName(about.owner)}'s card)` : ''
  const verdict = about?.verdict ? `: ${shortName(about.verdict.by)} ${about.verdict.passed ? 'passed' : 'failed'} it` : ''
  // Done means the review passed (or the user moved it there), not that the work is merged.
  const merged = about?.owner && change.column === 'done' ? " (Done isn't merged)" : ''
  const where =
    change.changes === 'gone'
      ? ' is gone from your board (archived, deleted or moved to another project)'
      : about?.returned
        ? `${owner} was returned for review (round ${about.returned})${verdict}`
        : `${owner} is in ${columnWord(change.column)}${verdict}${merged}`
  const others = more ? ` (and ${more} more watched card${more === 1 ? '' : 's'} changed)` : ''
  const head = `[Hive] #${change.number}${where}`
  const tail = `${others}. Your card watch has ended: carry on (hive_read_task with latestComment for the comment in full).`
  if (!change.comment) return head + tail
  // The card, its state and what to do always fit (names are short); the comment's first line gives way, cut with "…".
  const by = shortName(change.comment.by)
  let text = [...change.comment.firstLine]
  const line = (cut: boolean): string => `${head}; latest comment by ${by}: "${text.join('')}${cut ? '…' : ''}"${tail}`
  if (jsonBytes(line(false)) <= WAKE_MAX_BYTES) return line(false)
  while (text.length && jsonBytes(line(true)) > WAKE_MAX_BYTES) text = text.slice(0, -1)
  return line(true)
}

/** The line Hive types when a watch's overall limit passes with no change. */
export function limitLine(cond: WatchCondition, minutes: number): string {
  return `[Hive] No change on ${cards(cond.cards)} in ${minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`}: your card watch has ended. Tell the user (hive_notify) and ask what to do.`
}

const cards = (ns: number[]): string => ns.map((n) => `#${n}`).join(', ')

/** What a watching agent shows (its header, tab, the Agent API): "Waiting for #12 → Review", "Waiting for #12, #13". */
export function watchLabel(cond: Pick<WatchCondition, 'cards' | 'column'>): string {
  return `Waiting for ${cards(cond.cards)}${cond.column ? ` → ${columnWord(cond.column)}` : ''}`
}

/** A condition from untrusted arguments, or an error saying what is wrong. */
export function readCondition(args: { cards?: unknown; changes?: unknown; until?: unknown; column?: unknown }): WatchCondition | string {
  const raw = Array.isArray(args.cards) ? args.cards : []
  const ns = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  if (!ns.length || ns.length !== raw.length) return 'cards must be card numbers (at least one, no repeats)'
  if (ns.length > WATCH_MAX_CARDS) return `at most ${WATCH_MAX_CARDS} cards`
  const column = args.column
  if (column !== undefined && !COLUMNS.includes(column as TaskColumn)) return 'column must be todo, doing, review or done'
  const list = args.changes ?? args.until
  const given = list !== undefined && list !== 'any'
  // A column alone: arriving in it is all that counts. Otherwise the kinds listed (default: any).
  const changes = !given ? (column ? ['column'] : [...WATCH_CHANGES]) : Array.isArray(list) ? [...new Set(list)] : [list]
  if (!changes.length || changes.some((c) => !WATCH_CHANGES.includes(c as WatchChange))) return `changes must be any of ${WATCH_CHANGES.join(', ')}`
  if (column && !changes.includes('column')) return 'with column, changes must include "column" (or leave changes out to wait only for the card to be in that column)'
  // A column with `column` named among the changes: a move into it (a card already there waits for it to come back).
  const moveInto = !!column && given
  return { cards: ns, changes: changes as WatchChange[], ...(column ? { column: column as TaskColumn } : {}), ...(moveInto ? { moveInto: true as const } : {}) }
}
