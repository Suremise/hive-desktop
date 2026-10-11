import { useMemo } from 'react'
import type { ProjectInfo, TaskCard } from '@shared/types'
import { laneOrder, waitingFor, type TableLane } from '@shared/agentTable'
import { agentDoingCards, agentReviewCards } from '@shared/tasks'
import { cardText } from './CardChip'
import { statusText } from './ui'
import { cx } from '../util'
import { useLanes } from '../laneSource'
import { useStore } from '../store'

type Agent = ProjectInfo['agents'][number]

const plural = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`

/** An agent's row: its state in a few words, the card it works on (or reviews), and what it waits for. */
function row(p: ProjectInfo, a: Agent, tasks: TaskCard[]): { state: string; card: string; waits: string } {
  const doing = cardText(agentDoingCards(tasks, p.name, a.id))
  const reviewing = doing ? '' : cardText(agentReviewCards(tasks, p.name, a.id))
  const card = doing || (reviewing ? `reviewing ${reviewing}` : '')
  const l = a.live
  if (!l) return { state: 'Not running', card, waits: '' }
  if (l.status === 'watching' && l.watch) return { state: 'Watching', card, waits: waitingFor(l.watch) }
  if (l.status === 'background') return { state: `Waiting on ${plural(l.backgroundTasks ?? 0)}`, card, waits: '' }
  return { state: statusText(l), card, waits: '' }
}

/** The agents, one line each, for an accessible description and wherever text is wanted: "HB1: Working… · #402 Coordinator…". */
export function agentsText(p: ProjectInfo, tasks: TaskCard[], lanes: readonly TableLane[]): string {
  return laneOrder(p.agents, lanes)
    .map((a) => {
      const r = row(p, a, tasks)
      return `${a.name}: ${r.waits ? `Waiting for ${r.waits}` : r.state}${r.card ? ` · ${r.card}` : ''}`
    })
    .join('\n')
}

/**
 * A project's agents as a table (#529), for a tooltip: Agent (with its status dot) · State · Card (one line, cut with an
 * ellipsis) · Waiting for (only when one waits), in lane order (a builder, then its reviewer). The table never scrolls:
 * each column has a share of the room the window leaves (app.css), and a longer cell, the agent's name too, is cut.
 */
export function AgentsTable({ project: p, tasks, lanes }: { project: ProjectInfo; tasks: TaskCard[]; lanes: readonly TableLane[] }) {
  const rows = laneOrder(p.agents, lanes).map((a) => ({ a, ...row(p, a, tasks) }))
  const waits = rows.some((r) => r.waits)
  return (
    <table className="table agents-table" data-agents={rows.length}>
      <thead>
        <tr>
          <th>Agent</th>
          <th>State</th>
          <th>Card</th>
          {waits && <th>Waiting for</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ a, state, card, waits: w }) => (
          <tr key={a.id} data-agent={a.name} className={cx(!a.live && 'off')}>
            <td className="agents-table-cut agents-table-name">
              <span>
                <span className={cx('dot', a.live?.status ?? 'stopped')} />
                {a.name}
              </span>
            </td>
            <td className="agents-table-cut">
              <span>{state}</span>
            </td>
            <td className="agents-table-cut agents-table-card">
              <span>{card || '—'}</span>
            </td>
            {waits && (
              <td className="agents-table-cut">
                <span>{w}</span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The table for one project, reading the board and the lanes itself (the project header's status, shown on hover). */
export function ProjectAgentsTable({ project }: { project: ProjectInfo }) {
  const tasks = useStore((s) => s.tasks)
  const lanes = useLanes(false)
  return <AgentsTable project={project} tasks={tasks} lanes={lanes.filter((l) => l.project.toLowerCase() === project.path.toLowerCase())} />
}

/** The project's agents as text (`agentsText`), for a trigger's accessible description where the board isn't at hand ('' without a project). */
export function useAgentsText(project: ProjectInfo | null): string {
  const lanes = useLanes(false)
  const path = project?.path.toLowerCase()
  const mine = useMemo(() => lanes.filter((l) => l.project.toLowerCase() === path), [lanes, path])
  return useStore((s) => (project ? agentsText(project, s.tasks, mine) : ''))
}
