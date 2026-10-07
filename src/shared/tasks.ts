import type { BoardFold, TaskCard, TaskColumn } from './types'

/**
 * The board's columns, in order. Fixed: the Assistant, agents and the API all work with these six (#170). On Hold is
 * parked work (the user's and the Assistant's), Passed is work that passed its review and waits to be merged, and Done
 * is merged.
 */
export const TASK_COLUMNS: { id: TaskColumn; label: string; description: string }[] = [
  { id: 'hold', label: 'On Hold', description: 'Parked: nobody picks these up until they move to Todo. Only you and the Assistant put cards here.' },
  { id: 'todo', label: 'Todo', description: 'Ready to start.' },
  { id: 'doing', label: 'Doing', description: 'Being worked on: its agent shows what it is doing now.' },
  { id: 'review', label: 'Review', description: 'Work done, waiting for its review.' },
  { id: 'passed', label: 'Passed', description: 'Passed its review, waiting to be merged. A reviewer moves a card here when it passes.' },
  { id: 'done', label: 'Done', description: 'Merged: its builder moves it here after merging (or you do). Archive cards when you no longer need to see them.' }
]

export const isTaskColumn = (v: unknown): v is TaskColumn => typeof v === 'string' && TASK_COLUMNS.some((c) => c.id === v)

export const columnLabel = (c: TaskColumn): string => TASK_COLUMNS.find((x) => x.id === c)?.label ?? c

/** The column ids, in order, and as an error message lists them ("hold, todo, doing, review, passed or done"). */
export const COLUMN_IDS: readonly TaskColumn[] = TASK_COLUMNS.map((c) => c.id)
export const COLUMN_CHOICES = `${COLUMN_IDS.slice(0, -1).join(', ')} or ${COLUMN_IDS.at(-1)}`

/** Each column's colour (its heading, and a tint on its cards): grey, slate blue, blue, purple, teal and green. */
export const DEFAULT_COLUMN_COLORS: Record<TaskColumn, string> = { hold: '#8b8f98', todo: '#7a88b8', doing: '#3b82f6', review: '#a371f7', passed: '#14b8a6', done: '#2ea043' }

/** The most workspaces whose board folds are kept (the latest changed), and the most folded cards a workspace keeps. */
export const BOARD_FOLD_WORKSPACES = 50
export const BOARD_FOLD_CARDS = 5000

/**
 * A change to one workspace's board fold (#170): columns collapsed or expanded, cards folded or unfolded, and the cards
 * still on the board (`known`: folds of any other card are dropped). A change, not the whole fold, so a window never
 * writes back what it read before another window changed it.
 */
export interface BoardFoldChange {
  columns?: { ids: TaskColumn[]; collapsed: boolean }
  cards?: { numbers: number[]; folded: boolean }
  known?: number[]
}

const cardNumbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [])

/**
 * Every workspace's board fold with one workspace's changed (by its path, in lower case): applied to what is saved now,
 * checked (known columns, card numbers, bounded), the workspace moved to the newest, and only the newest
 * BOARD_FOLD_WORKSPACES kept. An empty fold is removed.
 */
export function applyBoardFold(all: Record<string, BoardFold> | undefined, workspace: string, change: BoardFoldChange): Record<string, BoardFold> {
  const key = workspace.toLowerCase()
  const out = { ...all }
  const now = out[key] ?? {}
  const columns = new Set((Array.isArray(now.columns) ? now.columns : []).filter(isTaskColumn))
  const cards = new Set(cardNumbers(now.cards))
  if (change.columns) {
    for (const c of (Array.isArray(change.columns.ids) ? change.columns.ids : []).filter(isTaskColumn)) {
      if (change.columns.collapsed) columns.add(c)
      else columns.delete(c)
    }
  }
  if (change.cards) {
    for (const n of cardNumbers(change.cards.numbers)) {
      if (change.cards.folded) cards.add(n)
      else cards.delete(n)
    }
  }
  if (change.known) {
    const known = new Set(cardNumbers(change.known))
    for (const n of cards) if (!known.has(n)) cards.delete(n)
  }
  delete out[key]
  const kept = COLUMN_IDS.filter((c) => columns.has(c))
  const folded = [...cards].slice(-BOARD_FOLD_CARDS)
  if (kept.length || folded.length) out[key] = { ...(kept.length ? { columns: kept } : {}), ...(folded.length ? { cards: folded } : {}) }
  return Object.fromEntries(Object.entries(out).slice(-BOARD_FOLD_WORKSPACES))
}

/** A column's colour from Settings → Board: the default unless it's a #rrggbb colour (it goes into CSS). */
export function columnColor(colors: Partial<Record<TaskColumn, string>> | undefined, c: TaskColumn): string {
  const v = colors?.[c]
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_COLUMN_COLORS[c]
}

/**
 * Why nobody is working on a Doing card, or null when someone is (or it isn't in Doing): it has no agent, its agent
 * was removed, or its agent isn't running. `agentNow` is its agent as it is now (null when removed). An agent that
 * has finished its turn isn't stalled: it is waiting for the user to look. Cards in any other column never are: nobody is
 * expected to be on them (On Hold and Passed included, #170).
 */
export function stalledReason(card: Pick<TaskCard, 'column' | 'archived' | 'agent' | 'agentName'>, agentNow: { name: string; running: boolean } | null): string | null {
  if (card.archived || card.column !== 'doing') return null
  if (!card.agent) return 'In Doing, but no agent has it.'
  if (!agentNow) return `${card.agentName ?? 'Its agent'} was removed.`
  if (!agentNow.running) return `${agentNow.name} isn't running.`
  return null
}

/**
 * When a card was archived (#249): its latest "Archived…" in its history (by the user, after its days in Done, or with
 * its project), else its last change. ISO.
 */
export function archivedAt(card: Pick<TaskCard, 'history' | 'updatedAt'>): string {
  return card.history.findLast((h) => h.what.startsWith('Archived'))?.at ?? card.updatedAt
}

/**
 * Where cards brought back from a bulk archive go in their column (#351): each just after the nearest card that was above
 * it then and is in the column now (on the board, or coming back with it), else just before the nearest one that was
 * below it, else at the top. `live`: the column's cards on the board now, top to bottom; `was`: the column as it was when
 * the batch was archived; `back`: the batch's cards coming back to it. Returns each one's new order; the others keep theirs.
 */
export function restoreOrders(live: { number: number; order: number }[], was: number[], back: number[]): Map<number, number> {
  const coming = new Set(back)
  const fixed = new Map(live.map((c) => [c.number, c.order]))
  const seq = live.map((c) => c.number)
  for (const [i, n] of was.entries()) {
    if (!coming.has(n) || fixed.has(n)) continue
    const above = was.slice(0, i).findLast((x) => seq.includes(x))
    const below = above === undefined ? was.slice(i + 1).find((x) => fixed.has(x)) : undefined
    seq.splice(above !== undefined ? seq.indexOf(above) + 1 : below !== undefined ? seq.indexOf(below) : 0, 0, n)
  }
  // A card coming back that the snapshot doesn't have (it shouldn't happen): at the top too.
  for (const n of back) if (!seq.includes(n) && !fixed.has(n)) seq.unshift(n)
  // Orders for each run of cards coming back, between the fixed cards around it.
  const out = new Map<number, number>()
  for (let i = 0; i < seq.length; ) {
    if (fixed.has(seq[i])) {
      i++
      continue
    }
    let j = i
    while (j < seq.length && !fixed.has(seq[j])) j++
    const before = i > 0 ? fixed.get(seq[i - 1]) : undefined
    const after = j < seq.length ? fixed.get(seq[j]) : undefined
    const k = j - i
    for (let x = 0; x < k; x++) {
      const order = before !== undefined && after !== undefined ? before + ((after - before) * (x + 1)) / (k + 1) : before !== undefined ? before + x + 1 : after !== undefined ? after - (k - x) : x + 1
      out.set(seq[i + x], order)
    }
    i = j
  }
  return out
}

/** History that starts work on a card: a move into Doing, or creating it there. */
const INTO_DOING = /^(Moved to (the (top|bottom) of )?Doing\b|Created in Doing\b)/

/** When work on a card last started (ms): its latest move into Doing; 0 when it never went there. */
export function workStartedAt(card: Pick<TaskCard, 'history'>): number {
  const h = card.history.findLast((x) => INTO_DOING.test(x.what))
  return h ? Date.parse(h.at) || 0 : 0
}

/** A decision recorded after work on the card last started (#357): the card dialog marks it "new since start". */
export function newSinceStart(card: Pick<TaskCard, 'history'>, d: { at: string }): boolean {
  const start = workStartedAt(card)
  return start > 0 && (Date.parse(d.at) || 0) > start
}

/** A card matches the board's search: its number (#12 or 12), title, description, labels, project or agent. */
export function cardMatches(c: Pick<TaskCard, 'number' | 'title' | 'description' | 'project' | 'agentName' | 'labels'>, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  if (/^#?\d+$/.test(s)) return c.number === Number(s.replace('#', ''))
  return [c.title, c.description, c.project, c.agentName ?? '', ...c.labels].some((x) => x.toLowerCase().includes(s))
}

/** Cards in board order: by column, then position. */
export function sortCards(cards: TaskCard[]): TaskCard[] {
  const col = (c: TaskCard): number => TASK_COLUMNS.findIndex((x) => x.id === c.column)
  return [...cards].sort((a, b) => col(a) - col(b) || a.order - b.order || a.number - b.number)
}

/** The board at a glance (the Workspace and project Overviews): counts of the cards that aren't archived. */
export interface TaskOverview {
  total: number
  hold: number
  todo: number
  doing: number
  review: number
  passed: number
  done: number
  stalled: number
  blocked: number
}

/** The overview of one project's cards, or of the whole board (project null). */
export function taskOverview(cards: readonly TaskCard[], project: string | null, stalled: (c: TaskCard) => boolean): TaskOverview {
  const open = cards.filter((c) => !c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase()))
  const n = (col: TaskColumn): number => open.filter((c) => c.column === col).length
  return { total: open.length, hold: n('hold'), todo: n('todo'), doing: n('doing'), review: n('review'), passed: n('passed'), done: n('done'), stalled: open.filter(stalled).length, blocked: open.filter((c) => c.blocked && c.column !== 'done').length }
}

/** The cards an agent of a project has in Doing (not archived), in board order: what it is working on now. */
export function agentDoingCards(cards: readonly TaskCard[], project: string, agentId: string): TaskCard[] {
  const p = project.toLowerCase()
  return sortCards(cards.filter((c) => !c.archived && c.column === 'doing' && c.agent === agentId && c.project.toLowerCase() === p))
}

/** The cards an agent of a project is reviewing (TaskCard.review), in board order. */
export function agentReviewCards(cards: readonly TaskCard[], project: string, agentId: string): TaskCard[] {
  const p = project.toLowerCase()
  return sortCards(cards.filter((c) => !c.archived && c.review?.agent === agentId && c.project.toLowerCase() === p))
}

/** Why a card's review isn't going on (its reviewer removed, or not running), or null while it is or there's none. */
export function reviewStalled(card: Pick<TaskCard, 'review' | 'archived'>, reviewerNow: { name: string; running: boolean } | null): string | null {
  if (!card.review || card.archived) return null
  if (!reviewerNow) return `${card.review.agentName} was removed.`
  if (!reviewerNow.running) return `${reviewerNow.name} isn't running.`
  return null
}

/** How much of a card's latest comment a restarted card's prompt carries (the rest is a hive_read_task away). */
const PROMPT_COMMENT_MAX = 4000

/**
 * What an agent is given when a card is started: the card's own words (title, description, what it depends on), and
 * for more work on a card from Review or Done the feedback it came back with (the latest comment) and the user's note.
 * How to carry a card through is the work-on-card skill's (and, briefly, Hive's session contract), so with Hive's
 * tools the prompt only points there; without them the card is all the agent has. from: the column it was started
 * from; note: what to do now.
 */
export function taskPrompt(card: TaskCard, withTools: boolean, opts: { from?: TaskColumn; note?: string } = {}): string {
  const parts = [`Work on task #${card.number} from the Hive task board: ${card.title}`]
  const again = opts.from === 'review' || opts.from === 'passed' || opts.from === 'done'
  if (again) parts.push(`It was in ${columnLabel(opts.from!)} and is back in Doing for more work.`)
  if (opts.note?.trim()) parts.push(opts.note.trim())
  if (card.description.trim()) parts.push(card.description.trim())
  if (card.blockedBy.length) parts.push(`It depends on ${card.blockedBy.map((n) => `#${n}`).join(', ')}.`)
  const latest = card.comments[card.comments.length - 1]
  if (again && latest?.text.trim()) {
    const text = latest.text.trim()
    parts.push(`Its latest comment (${latest.by}, ${latest.at.slice(0, 10)}):\n\n${text.length > PROMPT_COMMENT_MAX ? `${text.slice(0, PROMPT_COMMENT_MAX)}… (cut short: hive_read_task has it all)` : text}`)
  }
  if (withTools) parts.push(`Use the work-on-card skill.${card.comments.length ? ` The card has ${card.comments.length} comment${card.comments.length === 1 ? '' : 's'}: read ${again ? 'the rest' : 'them'} with hive_read_task.` : ''}`)
  return parts.join('\n\n')
}
