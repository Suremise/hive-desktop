import { basename } from 'path'
import { workStartedAt } from '../shared/tasks'
import type { TaskCard } from '../shared/types'
import { onHiveEvent } from './events'
import { allTasks } from './tasks'
import type { WorkspaceService } from './workspace'

/**
 * The "new decision" flag (#357): a hive tool's reply to an agent working on a card (in Doing, its agent) or reviewing
 * one says when a decision was recorded or changed on it since the agent last read the card in full, or since its work
 * (or review) began. Only a flag: the skills say when to act on it (at the next checkpoint). Reads are kept in memory;
 * after a restart the start of the work is the baseline.
 */

/** When each agent last read each card in full: `<project path>#<agent id>` → card → ms. */
const reads = new Map<string, Map<number, number>>()
const keyOf = (agent: { projectPath: string; agentId: string }): string => `${agent.projectPath.toLowerCase()}#${agent.agentId}`

/** The agent read the card in full (hive_read_task): what it saw isn't new any more. */
export function noteCardRead(agent: { projectPath: string; agentId: string }, n: number, at = Date.now()): void {
  const key = keyOf(agent)
  const m = reads.get(key) ?? new Map<number, number>()
  m.set(n, at)
  reads.set(key, m)
  // Bounded: an agent that reads thousands of cards keeps its latest ones.
  if (m.size > 500) m.delete(m.keys().next().value!)
}

// The board as last read, per workspace, until it changes: an agent's every board call shouldn't read every card file.
const boards = new Map<string, Promise<TaskCard[]>>()
let changes = 0
let listening = false
function board(ws: WorkspaceService): Promise<TaskCard[]> {
  if (!listening) {
    listening = true
    onHiveEvent((e) => {
      if (e.type !== 'tasks-changed') return
      changes++
      boards.delete(e.workspacePath.toLowerCase())
    })
  }
  const key = ws.path!.toLowerCase()
  let p = boards.get(key)
  if (!p) {
    const at = changes
    p = allTasks(ws)
    boards.set(key, p)
    // A read the board changed under isn't kept for the next call.
    void p.then(
      () => at !== changes && boards.get(key) === p && boards.delete(key),
      () => boards.delete(key)
    )
  }
  return p
}

/** A review verdict this agent gave on the card (its name on the board), the latest: when it last finished reviewing it. */
const lastVerdict = (c: TaskCard, self: string): number => Date.parse(c.history.findLast((h) => h.by === self && /^Review (passed|failed)$/.test(h.what))?.at ?? '') || 0

/**
 * Where an agent's view of a card's decisions starts (ms), or null when the card isn't one of its: a card it works on (in
 * Doing, its agent: since it last read the card in full, or since the work began); one it reviews (since its last full
 * read, else its last verdict on it, else the review's start: starting another round doesn't make unread decisions
 * read); and one back in Review that it reviewed before (its next round: since its last read or verdict).
 */
function baseline(c: TaskCard, agentId: string, self: string, read: number | undefined): number | null {
  if (c.column === 'doing' && c.agent === agentId) return Math.max(read ?? 0, workStartedAt(c))
  const verdict = lastVerdict(c, self)
  if (c.review?.agent === agentId) return read ?? (verdict || Date.parse(c.review.since) || 0)
  if (c.column === 'review' && !c.review && verdict) return Math.max(read ?? 0, verdict)
  return null
}

/**
 * The agent's cards (baseline) with decisions new to it, and how many each: recorded by someone else, or changed by the
 * user, since its view of the card starts. `self` is the agent's name on the board: a decision it recorded itself isn't
 * news to it, but the user's change to one (the user alone edits them) always is.
 */
export async function newDecisions(ws: WorkspaceService, agent: { projectPath: string; agentId: string }, self: string): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!ws.path) return out
  const project = basename(agent.projectPath).toLowerCase()
  const seen = reads.get(keyOf(agent))
  const t = (iso: string | undefined): number => Date.parse(iso ?? '') || 0
  for (const c of await board(ws)) {
    if (c.archived || !c.decisions?.length || c.project.toLowerCase() !== project) continue
    const since = baseline(c, agent.agentId, self, seen?.get(c.number))
    if (since === null) continue
    const n = c.decisions.filter((d) => t(d.editedAt) > since || (d.recordedBy !== self && t(d.at) > since)).length
    if (n) out.set(c.number, n)
  }
  return out
}

/** When the agent last read the card in full (ms), or 0. */
export const lastCardRead = (agent: { projectPath: string; agentId: string }, n: number): number => reads.get(keyOf(agent))?.get(n) ?? 0

/** The line for a reply, or null when nothing is new. */
export function noticeText(cards: Map<number, number>): string | null {
  if (!cards.size) return null
  const parts = [...cards].map(([n, k]) => `#${n} has ${k} new decision${k === 1 ? '' : 's'}`)
  return `[Hive] ${parts.join(', ')} since you last read ${parts.length === 1 ? 'it' : 'them'}: read ${parts.length === 1 ? 'the card' : 'each card'} (hive_read_task) at your next checkpoint.`
}

/** The flag for an agent's reply, or null (newDecisions as a line). */
export async function decisionNotice(ws: WorkspaceService, agent: { projectPath: string; agentId: string }, self: string): Promise<string | null> {
  return noticeText(await newDecisions(ws, agent, self))
}
