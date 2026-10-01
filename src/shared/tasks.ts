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

/**
 * What an agent is given when a card is started: the card in full, and what to do with it on the board. With
 * Hive's tools it can read the comments and move the card itself; without them, the card is all it has.
 */
export function taskPrompt(card: TaskCard, withTools: boolean): string {
  const parts = [`Work on task #${card.number} from the Hive task board: ${card.title}`]
  if (card.description.trim()) parts.push(card.description.trim())
  if (card.blockedBy.length) parts.push(`It depends on ${card.blockedBy.map((n) => `#${n}`).join(', ')}.`)
  if (withTools) {
    parts.push(
      `${card.comments.length ? 'Read its comments first with hive_read_task. ' : ''}Keep the card up to date with hive_update_task: comment on progress worth knowing, set blocked with a reason if you can't go on, and when the work is done, move it to review with a comment saying what you did. Never move it to done: the user does that.`
    )
  }
  return parts.join('\n\n')
}
