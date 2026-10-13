import { useMemo, type ReactNode } from 'react'
import { AGENT_LIMIT_DEFAULT } from '@shared/defaults'
import type { ProjectInfo, TaskCard } from '@shared/types'
import { agentCardText, agentRowsText, laneOrder, waitingFor, type TableLane } from '@shared/agentTable'
import { batchOutcome, removeWorktreeText, type BatchKind, type BatchWorktree } from '@shared/startAll'
import { statusText } from './ui'
import { cx } from '../util'
import { useLanes } from '../laneSource'
import { useStore } from '../store'

type Agent = ProjectInfo['agents'][number]

const plural = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`

/** An agent's row: its state in a few words, the card it works on (or reviews), and what it waits for. */
export function agentRow(p: ProjectInfo, a: Agent, tasks: readonly TaskCard[]): { state: string; card: string; waits: string } {
  const card = agentCardText(tasks, p.name, a.id)
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
      const r = agentRow(p, a, tasks)
      return `${a.name}: ${r.waits ? `Waiting for ${r.waits}` : r.state}${r.card ? ` · ${r.card}` : ''}`
    })
    .join('\n')
}

/**
 * A column of an agents table after Agent: its heading, its kind (a card's cell gets the most room; a short one, a state
 * or a project, never wraps in a dialog) and the words before its cell in the plain text (`agentRowsText`).
 */
export interface AgentColumn {
  label: string
  kind?: 'card' | 'short'
  prefix?: string
}

/** A row: the agent (its name and status dot; `off` when it isn't running) and one cell per column. */
export interface AgentTableRow {
  key: string
  name: string
  /** Its status dot's class ('stopped' when it isn't running). */
  dot: string
  off?: boolean
  cells: { text: string; warn?: boolean }[]
  /** Extra attributes for tests and styling (`data-agent` is always the name). */
  className?: string
}

/** A heading row across the table (the quit dialog's agents under their workspace), and its words in the plain text. */
export interface AgentTableGroup {
  key: string
  group: ReactNode
  text: string
  title?: string
  className?: string
}

/** A table's columns and rows: what it shows, and what its plain text says (`tableText`). */
export interface AgentTableData {
  columns: AgentColumn[]
  rows: (AgentTableRow | AgentTableGroup)[]
}

/** The table as plain text (#572): every cell it shows, a line an agent, for screen readers and a confirm's copy. */
export function tableText(d: AgentTableData): string {
  return agentRowsText(
    d.columns,
    d.rows.map((r) => ('group' in r ? { groupText: r.text } : r))
  )
}

/**
 * Agents as a table (#529, #572), for a tooltip or a dialog: Agent (with its status dot) and the columns given, each cell
 * one line cut with an ellipsis (an empty card "—"). The table never scrolls sideways: each column has a share of the
 * room its tooltip or dialog leaves (app.css, by the number of columns), and a longer cell, the agent's name too, is cut.
 * More agents than the default limit (up to 24, #562) take tighter rows, so they still fit a window's height.
 */
export function AgentRowsTable({ columns, rows, className, bodyClassName }: { columns: AgentColumn[]; rows: (AgentTableRow | AgentTableGroup)[]; className?: string; bodyClassName?: string }) {
  const agents = rows.filter((r): r is AgentTableRow => 'cells' in r).length
  return (
    <table className={cx('table agents-table', `cols-${columns.length + 1}`, agents > AGENT_LIMIT_DEFAULT && 'many', className)} data-agents={agents}>
      <thead>
        <tr>
          <th>Agent</th>
          {columns.map((c) => (
            <th key={c.label}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody className={bodyClassName}>
        {rows.map((r) =>
          'group' in r ? (
            <tr key={r.key} className={cx('agents-table-group', r.className)} title={r.title}>
              <td colSpan={columns.length + 1}>{r.group}</td>
            </tr>
          ) : (
            <tr key={r.key} data-agent={r.name} className={cx(r.off && 'off', r.className)}>
              <td className="agents-table-cut agents-table-name">
                <span>
                  <span className={cx('dot', r.dot)} />
                  {r.name}
                </span>
              </td>
              {columns.map((c, i) => (
                <td key={c.label} className={cx('agents-table-cut', c.kind === 'card' && 'agents-table-card', c.kind === 'short' && 'agents-table-short', r.cells[i]?.warn && 'agents-table-warn')}>
                  <span>{r.cells[i]?.text || (c.kind === 'card' ? '—' : '')}</span>
                </td>
              ))}
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

/** The columns the tables share, with their words in the plain text (#572). */
export const STATE_COLUMN: AgentColumn = { label: 'State', kind: 'short' }
export const CARD_COLUMN: AgentColumn = { label: 'Card', kind: 'card', prefix: 'card ' }
export const WAITING_COLUMN: AgentColumn = { label: 'Waiting for', prefix: 'waiting for ' }
export const PROJECT_COLUMN: AgentColumn = { label: 'Project', kind: 'short', prefix: 'in ' }

/**
 * A project's agents (#529): Agent · State · Card · Waiting for (only when one waits), in lane order (a builder, then
 * its reviewer). `only`: just these agents (ids), as Stop All lists the running ones (#572).
 */
export function projectAgentsData(p: ProjectInfo, tasks: readonly TaskCard[], lanes: readonly TableLane[], only?: readonly string[]): AgentTableData {
  const rows = laneOrder(p.agents, lanes)
    .filter((a) => !only || only.includes(a.id))
    .map((a) => ({ a, ...agentRow(p, a, tasks) }))
  const waits = rows.some((r) => r.waits)
  return {
    columns: [STATE_COLUMN, CARD_COLUMN, ...(waits ? [WAITING_COLUMN] : [])],
    rows: rows.map(({ a, state, card, waits: w }) => ({ key: a.id, name: a.name, dot: a.live?.status ?? 'stopped', off: !a.live, cells: [{ text: state }, { text: card }, ...(waits ? [{ text: w }] : [])] }))
  }
}

/** A project's agents as a table (#529), for a tooltip (`projectAgentsData`). */
export function AgentsTable({ project, tasks, lanes }: { project: ProjectInfo; tasks: readonly TaskCard[]; lanes: readonly TableLane[] }) {
  return <AgentRowsTable {...projectAgentsData(project, tasks, lanes)} />
}

/**
 * Start New (All), Archive and Start New (All) and Remove All's agents (#572): Agent · State · Card · Worktree (its
 * branch; Remove All's says whether the box can delete it) · What happens (stopped first when it runs, in the warning
 * colour when that interrupts something), in the project's order.
 */
export function batchAgentsData(p: ProjectInfo, tasks: readonly TaskCard[], kind: BatchKind, agents: readonly Agent[], check?: (agentId: string) => BatchWorktree['check']): AgentTableData {
  const trees = agents.some((a) => a.worktree)
  const rows = agents.map((a): AgentTableRow => {
    const r = agentRow(p, a, tasks)
    const outcome = batchOutcome(kind, a)
    const tree = a.worktree ? (kind === 'remove' ? removeWorktreeText({ branch: a.worktree.branch, check: check?.(a.id) }) : a.worktree.branch) : ''
    return { key: a.id, name: a.name, dot: a.live?.status ?? 'stopped', off: !a.live, cells: [{ text: r.state }, { text: r.card }, ...(trees ? [{ text: tree }] : []), { text: outcome.text, warn: outcome.warn }] }
  })
  return { columns: [STATE_COLUMN, CARD_COLUMN, ...(trees ? [{ label: 'Worktree', prefix: 'worktree ' }] : []), { label: 'What happens' }], rows }
}

/**
 * Agents in a dialog (#572): the table to see, hidden from screen readers, and its plain text (`tableText`, every cell
 * it shows) for them instead; a note under it.
 */
export function AgentsDetail({ data, note }: { data: AgentTableData; note?: string }) {
  return (
    <div className="agents-detail">
      <div aria-hidden="true">
        <AgentRowsTable {...data} />
      </div>
      <div className="visually-hidden">{tableText(data)}</div>
      {note && <div className="agents-detail-note">{note}</div>}
    </div>
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
