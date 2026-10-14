import { useMemo } from 'react'
import { msg, tr } from '@shared/i18n'
import type { AgentInfo, ProjectInfo, TaskCard, TaskColumn } from '@shared/types'
import { agentDoingCards, agentReviewCards, columnColor } from '@shared/tasks'
import { cardsText } from '@shared/agentTable'
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
  return cardsText(cards)
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
      aria-label={label ?? tr(msg({ id: 'board.chip.open', defaultMessage: 'Open card #{card}', description: "A card chip's accessible name (on an agent's pane or row): opens the card. {card} is its number." }), { card: number })}
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
  const line = (c: TaskCard): string => tr(msg({ id: 'board.chip.card', defaultMessage: '#{card} {title}{decisions, plural, =0 {} one { (decisions: #)} other { (decisions: #)}}', description: "A card in the hover of an agent's card chip: its number, title (the user's own words) and how many decisions the user made about it (none: leave that branch empty)." }), { card: c.number, title: c.title, decisions: c.decisions?.length ?? 0 })
  const lines = [
    ...(doing.length ? [tr(msg({ id: 'board.chip.doing', defaultMessage: 'Working on (Doing):', description: "Heading in the hover of an agent's card chip, above the cards it works on. Doing is the board column." })), ...doing.map(line)] : []),
    ...(reviewing.length ? [tr(msg({ id: 'board.chip.reviewing', defaultMessage: 'Reviewing:', description: "Heading in the hover of an agent's card chip, above the cards it reviews." })), ...reviewing.map(line)] : []),
    tr(msg({ id: 'board.chip.clickToOpen', defaultMessage: 'Click to open #{card}.', description: "The last line of the hover of an agent's card chip. {card} is the card's number." }), { card: first.number })
  ]
  return <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>}>{chip}</Tooltip>
}
