/**
 * The short forms of Hive's replies to agents (the hive MCP tools) and the Agent API's opt-in short views. Every
 * character a tool returns goes into an agent's context and is paid for again on each later turn, so: a change
 * confirms what changed (and what the agent can't know: a new card's number, where a card is now), a listing
 * returns a short row per item, and full detail comes on request. No imports beyond shared code without side
 * effects: hive-mcp.js runs outside the app bundle.
 */
import type { TaskCard, TaskColumn } from './types'
import { columnLabel } from './tasks'

/** A card as the Agent API shows it: with what its agent is doing now, and why it is stalled. */
export interface TaskView extends Omit<TaskCard, 'agent'> {
  agent: { id: string; name: string; status: string; backgroundTasks: number } | null
  stalled: string | null
  /** With a review going on (TaskCard.review): why it has stalled (its reviewer removed or not running), if it has. */
  reviewStalled?: string
  /** For a project agent: the cards in blockedBy and links that are another project's (it sees only their numbers). */
  elsewhere?: number[]
}

/** A card in a listing (GET /v1/tasks?view=short): what it is and where it stands, without its text. */
export interface TaskRow {
  number: number
  title: string
  column: TaskColumn
  project: string
  agent: { name: string; status: string; backgroundTasks: number } | null
  labels: string[]
  blocked: string | null
  blockedBy: number[]
  /** Cards in blockedBy that are another project's (a project agent sees only their numbers). */
  elsewhere?: number[]
  stalled: string | null
  /** The agent reviewing it now (TaskCard.review), and why that has stalled if it has. */
  reviewing?: { name: string; stalled?: string }
  comments: number
  archived: boolean
}

export function taskRow(v: TaskView): TaskRow {
  return {
    number: v.number,
    title: v.title,
    column: v.column,
    project: v.project,
    agent: v.agent && { name: v.agent.name, status: v.agent.status, backgroundTasks: v.agent.backgroundTasks },
    labels: v.labels,
    blocked: v.blocked,
    blockedBy: v.blockedBy,
    ...(v.elsewhere?.length ? { elsewhere: v.elsewhere } : {}),
    stalled: v.stalled,
    ...(v.review ? { reviewing: { name: v.review.agentName, ...(v.reviewStalled ? { stalled: v.reviewStalled } : {}) } } : {}),
    comments: v.comments.length,
    archived: v.archived
  }
}

/** A card without its history (GET /v1/tasks/{n}?history=false): the description and comments stay. */
export function withoutHistory<T extends { history: unknown[] }>(v: T): Omit<T, 'history'> & { historyEntries: number } {
  const { history, ...rest } = v
  return { ...rest, historyEntries: history.length }
}

/** What a change did to a card (reply: "short"): the changes in words and where the card is now. */
export interface TaskChange {
  number: number
  title: string
  column: TaskColumn
  /** Its place in its column, 1 at the top; null when archived. */
  position: number | null
  of: number
  project: string
  agent: string | null
  changes: string[]
}

export const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

const place = (c: Pick<TaskChange, 'column' | 'position' | 'of'>): string => `${columnLabel(c.column)}${c.position ? ` (${ordinal(c.position)} of ${c.of})` : ''}`

/** "#61 created in Todo (51st of 51) for alpha, given to Coder: Lean replies". */
export function createdText(c: TaskChange): string {
  return `#${c.number} created in ${place(c)}${c.project ? ` for ${c.project}` : ''}${c.agent ? `, given to ${c.agent}` : ''}: ${c.title}`
}

/** "#60 Lean replies: Commented; Moved to Review. Now in Review (1st of 4), alpha, Coder." */
export function changedText(c: TaskChange): string {
  const what = c.changes.length ? c.changes.join('; ') : 'No change'
  return `#${c.number} ${c.title}: ${what}. Now in ${place(c)}${c.project ? `, ${c.project}` : ''}${c.agent ? `, ${c.agent}` : ''}.`
}

/** What a reorder did (reply: "short"). */
export interface TaskReorder {
  column: TaskColumn
  /** The cards put at the top, in order. */
  top: number[]
  /** How many cards the column has. */
  count: number
}

export function reorderText(r: TaskReorder): string {
  const rest = r.count - r.top.length
  return `${columnLabel(r.column)} now starts ${r.top.map((n) => `#${n}`).join(', ')}${rest > 0 ? `; its other ${rest} card${rest === 1 ? '' : 's'} keep their order below` : ''}.`
}

const STATUS: Record<string, string> = { ready: 'idle', finished: 'idle', background: 'waiting on background tasks', waiting: 'waiting for the user' }

function agentText(a: TaskRow['agent']): string {
  if (!a) return ''
  const bits = [STATUS[a.status] ?? a.status]
  if (a.backgroundTasks > 0 && a.status !== 'background') bits.push(`${a.backgroundTasks} background task${a.backgroundTasks === 1 ? '' : 's'}`)
  return `${a.name} (${bits.join(', ')})`
}

/** "#35 Number settings · alpha · Coder (working) · bug · blocked: … · after #12 · reviewing: Codex · 3 comments". */
export function taskRowText(r: TaskRow): string {
  const bits = [`#${r.number} ${r.title}`]
  if (r.project) bits.push(r.project)
  if (r.agent) bits.push(agentText(r.agent))
  if (r.labels.length) bits.push(r.labels.join(', '))
  if (r.blocked) bits.push(`blocked: ${r.blocked}`)
  if (r.blockedBy.length) bits.push(`after ${r.blockedBy.map((n) => (r.elsewhere?.includes(n) ? `#${n} (another project)` : `#${n}`)).join(', ')}`)
  if (r.stalled) bits.push(`stalled: ${r.stalled}`)
  if (r.reviewing) bits.push(`reviewing: ${r.reviewing.name}${r.reviewing.stalled ? ` (stalled: ${r.reviewing.stalled})` : ''}`)
  if (r.comments) bits.push(`${r.comments} comment${r.comments === 1 ? '' : 's'}`)
  return bits.join(' · ')
}

/** At most this many rows in one listing; the reply says how many more there are and how to narrow it. */
export const MAX_ROWS = 200

/** A listing of cards, by column in board order (top first), one line each. */
export function taskListText(rows: TaskRow[], opts: { archived?: boolean } = {}): string {
  if (!rows.length) return opts.archived ? 'No archived cards.' : 'No cards.'
  const shown = rows.slice(0, MAX_ROWS)
  const out: string[] = []
  let column: TaskColumn | null = null
  for (const r of shown) {
    if (r.column !== column) {
      column = r.column
      const n = rows.filter((x) => x.column === column).length
      out.push(`${out.length ? '\n' : ''}${opts.archived ? 'Archived, last in ' : ''}${columnLabel(column)} (${n}${opts.archived ? '' : ', top first'}):`)
    }
    out.push(taskRowText(r))
  }
  if (rows.length > shown.length) out.push(`\n…and ${rows.length - shown.length} more. Narrow it with project or column.`)
  out.push('\nhive_read_task gives a card in full.')
  return out.join('\n')
}

/** A project in a listing (GET /v1/projects?view=short). */
export interface ProjectRow {
  name: string
  workspace: string
  active: boolean
  branch: string | null
  agents: { name: string; provider: string; status: string; branch: string | null; backgroundTasks: number }[]
}

export function projectRowText(p: ProjectRow, many: boolean): string {
  const head = `${many ? `${p.workspace}/` : ''}${p.name} (${p.active ? 'on' : 'off'}${p.branch ? `, ${p.branch}` : ''})`
  if (!p.agents.length) return `${head}: no agents`
  const agents = p.agents.map((a) => `${a.name} [${a.provider}${a.branch ? `, ${a.branch}` : ''}] ${STATUS[a.status] ?? a.status}${a.backgroundTasks > 0 ? ` (${a.backgroundTasks} background)` : ''}`)
  return `${head}: ${agents.join('; ')}`
}

export function projectListText(rows: ProjectRow[]): string {
  if (!rows.length) return 'No projects.'
  const many = new Set(rows.map((r) => r.workspace)).size > 1
  return `${rows.map((r) => projectRowText(r, many)).join('\n')}\n\nhive_project_status gives one project in full (its agents' ids and sessions, its settings).`
}

/** The shared notes as a flat list of files (newest last-modified shown), not the folder tree. */
export interface NoteEntry {
  relPath: string
  isDir: boolean
  modified?: string
  children?: NoteEntry[]
}

export function notesListText(tree: NoteEntry[]): string {
  const files: string[] = []
  const walk = (list: NoteEntry[]): void => {
    for (const e of list) {
      if (e.isDir) walk(e.children ?? [])
      else files.push(`${e.relPath}${e.modified ? ` (${e.modified.slice(0, 10)})` : ''}`)
    }
  }
  walk(tree)
  return files.length ? `${files.join('\n')}\n\nhive_read_shared_note reads one.` : 'No shared notes yet.'
}

/** A note or handover to read: its path, then its text as it is (not inside a JSON string). */
export const noteText = (n: { path: string; content: string }): string => `${n.path}\n\n${n.content}`
