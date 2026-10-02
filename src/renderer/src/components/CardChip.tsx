import { useMemo } from 'react'
import type { AgentInfo, ProjectInfo, TaskCard } from '@shared/types'
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
 * The card an agent is working on (its first in Doing): `#4 title`, or only `#4` when `short`. Tinted with the Doing
 * column's colour (Settings → Board); clicking opens the card. With none in Doing, the card it is reviewing, with an
 * eye, in the Review column's colour.
 */
export function CardChip({ project, a, short, tip = true }: { project: ProjectInfo; a: AgentInfo; short?: boolean; tip?: boolean }) {
  const doing = useAgentCards(project, a.id)
  const reviewing = useAgentReviews(project, a.id)
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  const cards = [...doing, ...reviewing]
  if (!cards.length) return null
  const [first, ...more] = cards
  const review = !doing.length
  const chip = (
    <span
      className={cx('card-chip', colored && 'colored', short && 'short', review && 'review')}
      style={colored ? ({ '--col': columnColor(colors, review ? 'review' : 'doing') } as React.CSSProperties) : undefined}
      data-task={first.number}
      data-review={review || undefined}
      onClick={(e) => {
        e.stopPropagation()
        set({ taskOpen: first.number })
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name={review ? 'eye' : 'project'} />
      <span className="card-chip-number">#{first.number}</span>
      {!short && <span className="card-chip-title">{first.title}</span>}
      {more.length > 0 && <span className="card-chip-more">+{more.length}</span>}
    </span>
  )
  if (!tip) return chip
  const list = (title: string, l: TaskCard[]): string => (l.length ? `${title}:\n${l.map((c) => `#${c.number} ${c.title}`).join('\n')}\n` : '')
  return <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`${list('Working on (Doing)', doing)}${list('Reviewing', reviewing)}Click to open #${first.number}.`}</span>}>{chip}</Tooltip>
}
