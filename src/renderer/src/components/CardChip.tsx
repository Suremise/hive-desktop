import { useMemo } from 'react'
import type { AgentInfo, ProjectInfo, TaskCard, TaskColumn } from '@shared/types'
import { agentDoingCards, agentReviewCards, columnColor } from '@shared/tasks'
import { isAssistantPath, set, useStore } from '../store'
import { cx } from '../util'
import { Icon, Tooltip } from './ui'

/** The cards an agent has in Doing (what it is working on now), kept up to date with the board. */
export function useAgentCards(project: ProjectInfo, agentId: string): TaskCard[] {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => (isAssistantPath(project.path) ? [] : agentDoingCards(tasks, project.name, agentId)), [tasks, project.path, project.name, agentId])
}

/** The cards an agent is reviewing (TaskCard.review), kept up to date with the board. */
export function useAgentReviews(project: ProjectInfo, agentId: string): TaskCard[] {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => (isAssistantPath(project.path) ? [] : agentReviewCards(tasks, project.name, agentId)), [tasks, project.path, project.name, agentId])
}

/** "#4 Attention inbox" (+1 when it has more), for a tooltip or a status line; empty when it has none. */
export function cardText(cards: TaskCard[]): string {
  if (!cards.length) return ''
  return `#${cards[0].number} ${cards[0].title}${cards.length > 1 ? ` +${cards.length - 1}` : ''}`
}

/**
 * One card as a chip (#311, #399): its icon and `#n` (and title unless `short`), tinted with its column's colour
 * (Settings → Board), the eye for one in Review; a click opens the card. `more` adds "+n". The one chip for a card
 * everywhere: an agent's (CardChip), the Assistant's status line.
 */
export function TaskChip({ number, column, title, short, more = 0, label, onOpen }: { number: number; column: TaskColumn | null; title?: string; short?: boolean; more?: number; label?: string; onOpen?: () => void }) {
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  const review = column === 'review'
  const open = (): void => (onOpen ? onOpen() : set({ taskOpen: number }))
  return (
    <span
      className={cx('card-chip', colored && column && 'colored', short && 'short', review && 'review')}
      style={colored && column ? ({ '--col': columnColor(colors, column) } as React.CSSProperties) : undefined}
      data-task={number}
      data-column={column ?? undefined}
      data-review={review || undefined}
      role="button"
      tabIndex={0}
      aria-label={label ?? `Open card #${number}`}
      onClick={(e) => {
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        open()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name={review ? 'eye' : 'project'} />
      <span className="card-chip-number">#{number}</span>
      {!short && title && <span className="card-chip-title">{title}</span>}
      {more > 0 && <span className="card-chip-more">+{more}</span>}
    </span>
  )
}

/**
 * The card an agent is working on (its first in Doing): `#4 title`, or only `#4` when `short`. Tinted with the Doing
 * column's colour (Settings → Board); clicking opens the card. With none in Doing, the card it is reviewing, with an
 * eye, in the Review column's colour.
 */
export function CardChip({ project, a, short, tip = true }: { project: ProjectInfo; a: AgentInfo; short?: boolean; tip?: boolean }) {
  const doing = useAgentCards(project, a.id)
  const reviewing = useAgentReviews(project, a.id)
  const cards = [...doing, ...reviewing]
  if (!cards.length) return null
  const [first, ...more] = cards
  const review = !doing.length
  const chip = <TaskChip number={first.number} column={review ? 'review' : 'doing'} title={first.title} short={short} more={more.length} />
  if (!tip) return chip
  // Each card's decisions counted (#357): what the user decided about it, read in the card.
  const decided = (c: TaskCard): string => (c.decisions?.length ? ` (decisions: ${c.decisions.length})` : '')
  const list = (title: string, l: TaskCard[]): string => (l.length ? `${title}:\n${l.map((c) => `#${c.number} ${c.title}${decided(c)}`).join('\n')}\n` : '')
  return <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`${list('Working on (Doing)', doing)}${list('Reviewing', reviewing)}Click to open #${first.number}.`}</span>}>{chip}</Tooltip>
}
