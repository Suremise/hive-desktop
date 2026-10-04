import type { TaskCard, TaskColumn } from './types'

/** The board's columns, in order. Fixed: the Assistant, agents and the API all work with these four. */
export const TASK_COLUMNS: { id: TaskColumn; label: string; description: string }[] = [
  { id: 'todo', label: 'Todo', description: 'Not started.' },
  { id: 'doing', label: 'Doing', description: 'Being worked on: its agent shows what it is doing now.' },
  { id: 'review', label: 'Review', description: 'Work done, waiting for you to check it.' },
  { id: 'done', label: 'Done', description: 'Finished. Only you move cards here; archive them when you no longer need to see them.' }
]

export const isTaskColumn = (v: unknown): v is TaskColumn => typeof v === 'string' && TASK_COLUMNS.some((c) => c.id === v)

export const columnLabel = (c: TaskColumn): string => TASK_COLUMNS.find((x) => x.id === c)?.label ?? c

/** Each column's colour (its heading, and a tint on its cards): slate blue, blue, purple and green. */
export const DEFAULT_COLUMN_COLORS: Record<TaskColumn, string> = { todo: '#7a88b8', doing: '#3b82f6', review: '#a371f7', done: '#2ea043' }

/** A column's colour from Settings → Board: the default unless it's a #rrggbb colour (it goes into CSS). */
export function columnColor(colors: Partial<Record<TaskColumn, string>> | undefined, c: TaskColumn): string {
  const v = colors?.[c]
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_COLUMN_COLORS[c]
}

/**
 * Why nobody is working on a Doing card, or null when someone is (or it isn't in Doing): it has no agent, its agent
 * was removed, or its agent isn't running. `agentNow` is its agent as it is now (null when removed). An agent that
 * has finished its turn isn't stalled: it is waiting for the user to look.
 */
export function stalledReason(card: Pick<TaskCard, 'column' | 'archived' | 'agent' | 'agentName'>, agentNow: { name: string; running: boolean } | null): string | null {
  if (card.archived || card.column !== 'doing') return null
  if (!card.agent) return 'In Doing, but no agent has it.'
  if (!agentNow) return `${card.agentName ?? 'Its agent'} was removed.`
  if (!agentNow.running) return `${agentNow.name} isn't running.`
  return null
}

/** Cards in board order: by column, then position. */
export function sortCards(cards: TaskCard[]): TaskCard[] {
  const col = (c: TaskCard): number => TASK_COLUMNS.findIndex((x) => x.id === c.column)
  return [...cards].sort((a, b) => col(a) - col(b) || a.order - b.order || a.number - b.number)
}

/** The board at a glance (the Workspace and project Overviews): counts of the cards that aren't archived. */
export interface TaskOverview {
  total: number
  todo: number
  doing: number
  review: number
  done: number
  stalled: number
  blocked: number
}

/** The overview of one project's cards, or of the whole board (project null). */
export function taskOverview(cards: readonly TaskCard[], project: string | null, stalled: (c: TaskCard) => boolean): TaskOverview {
  const open = cards.filter((c) => !c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase()))
  const n = (col: TaskColumn): number => open.filter((c) => c.column === col).length
  return { total: open.length, todo: n('todo'), doing: n('doing'), review: n('review'), done: n('done'), stalled: open.filter(stalled).length, blocked: open.filter((c) => c.blocked && c.column !== 'done').length }
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
  const again = opts.from === 'review' || opts.from === 'done'
  if (again) parts.push(`It was in ${opts.from === 'review' ? 'Review' : 'Done'} and is back in Doing for more work.`)
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
