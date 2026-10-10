import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { TaskCard, TaskHistoryEntry } from '../shared/types'
import { cardChange, loopWakeLine, wakeAbout } from '../shared/watch'
import { onHiveEvent } from './events'
import { listLanes } from './lanes'
import { createLogger, userText } from './logger'
import { getTask, noteOnCard, onLoopEvent, type LoopEvent, type TaskActor } from './tasks'
import { typeLine, watchCovers } from './watches'
import { workspaceFor, type WorkspaceService } from './workspace'

/**
 * Hive's loop wakes (#405): a card loop's routine handoffs, delivered by Hive whether or not the agent set a card watch.
 * A card arriving in Review wakes its reviewer; a verdict wakes its builder (the card's agent). Only for cards with a
 * reviewer (the reviewer of a running lane with the card, else the agent that last reviewed it), so a solo user never
 * sees one; never for the agent that made the change; left to the agent's own watch when one tells it of the change; and
 * off for a project whose Project Settings → Card loops → Wake reviewers and builders is off.
 *
 * Typed as a wake is (watches.typeLine): only while the agent is idle and nobody types there, checked to be taken. Until
 * then it waits, in memory, the latest per agent and card (a restart forgets it), at most a day. Each one typed is noted
 * in the card's history, as Hive.
 */

const log = createLogger('loopWakes')

interface Pending {
  ws: WorkspaceService
  projectPath: string
  agentId: string
  /** The agent's name on the board, for the card's history. */
  agentName: string
  n: number
  kind: LoopEvent['kind']
  /** The card's last history entry as the handoff left it: what came after is what was done about it since. */
  since: TaskHistoryEntry | null
  at: number
}

/** Pending wakes by agent and card: a newer handoff of the same card replaces the older one. */
const pending = new Map<string, Pending>()
const keyOf = (projectPath: string, agentId: string, n: number): string => `${projectPath.toLowerCase()}#${agentId}#${n}`
/** How long a wake waits for its agent to be idle (its session running) before it is dropped. */
const KEEP_MS = 24 * 60 * 60_000
/** A handoff's wake waits this long first, so a comment or move landing with it is in its line (a watch's settle). */
const SETTLE_MS = 1500
/** At most this many wakes wait at once (the oldest go first). */
const MAX_PENDING = 200

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const selfOf = (actor: TaskActor): string | null => (actor.kind === 'agent' && actor.self ? actor.self.agentId : null)

/** Whether a project lets Hive wake its loops' agents (Project Settings → Card loops; on unless turned off). */
async function wakesOn(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  return (await ws.projectConfig(projectPath).catch(() => null))?.loopWakes !== false
}

/**
 * A card's reviewer: the reviewer of a running lane that has the card, else the project's agent that last started
 * reviewing it (by its board name). Null: the card has none (no wakes for it).
 */
async function reviewerOf(ws: WorkspaceService, card: TaskCard, agents: { id: string; name: string }[]): Promise<string | null> {
  const lanes = await listLanes(ws, { project: card.project }).catch(() => [])
  const lane = lanes.find((l) => (l.state === 'active' || l.state === 'paused') && l.reviewer && l.cards.some((c) => c.number === card.number))
  if (lane?.reviewer) return lane.reviewer.id
  const last = card.history.findLast((h) => h.what === 'Started reviewing')
  return (last && agents.find((a) => same(`${a.name} (${card.project})`, last.by))?.id) || null
}

/**
 * Whose wake a handoff is, as the lane and the card are now: the card's reviewer for `review` (not a builder reviewing
 * its own card), its builder for `verdict`, while the card has a reviewer; an agent of the project. Null: no one's.
 */
async function targetOf(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopEvent['kind']): Promise<{ id: string; name: string } | null> {
  const agents = projectAgents(await ws.projectConfig(projectPath)).map((a) => ({ id: a.id, name: a.name }))
  const reviewer = await reviewerOf(ws, card, agents)
  if (!reviewer) return null
  const target = kind === 'review' ? reviewer : card.agent
  if (!target || (kind === 'review' && target === card.agent)) return null
  const agent = agents.find((a) => a.id === target)
  return agent ? { id: agent.id, name: `${agent.name} (${card.project})` } : null
}

/** Queues a wake for an agent (the latest per agent and card), unless its own watch tells it; tried after a settle. */
function enqueue(ws: WorkspaceService, projectPath: string, card: TaskCard, kind: LoopEvent['kind'], to: { id: string; name: string }, since: TaskHistoryEntry | null): void {
  if (watchCovers(projectPath, to.id, card.number, kind, card.column)) return
  const key = keyOf(projectPath, to.id, card.number)
  pending.delete(key)
  pending.set(key, { ws, projectPath, agentId: to.id, agentName: to.name, n: card.number, kind, since, at: Date.now() })
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
  setTimeout(() => void attempt(key).catch((err) => log.warn('a loop wake', err)), SETTLE_MS).unref?.()
}

/** A handoff saved (tasks.ts): whose wake it is, if anyone's, queued and tried after a settle. */
async function handoff(e: LoopEvent): Promise<void> {
  const { card, kind, actor } = e
  if (!e.ws.path || !card.project || card.archived) return
  const projectPath = join(e.ws.path, card.project)
  // The service itself, not the stand-in (tasks.ts's `workspace`): the wake is tried later, outside this change's call.
  const ws = workspaceFor(projectPath)
  if (!ws?.isProjectPath(projectPath) || !(await wakesOn(ws, projectPath))) return
  const to = await targetOf(ws, projectPath, card, kind)
  if (to && to.id !== selfOf(actor)) enqueue(ws, projectPath, card, kind, to, card.history.at(-1) ?? null)
}

/** The card's history since a handoff (after the entry it left; that entry trimmed off since: by its time). */
function historySince(card: TaskCard, since: TaskHistoryEntry | null): TaskHistoryEntry[] {
  if (!since) return card.history
  const i = since.id ? card.history.findIndex((h) => h.id === since.id) : -1
  return i >= 0 ? card.history.slice(i + 1) : card.history.filter((h) => h.at > since.at)
}

/**
 * Whether a waiting wake still has something to tell, from the card as it is now and what was done since its handoff:
 * a reviewer's while the card is in Review and nobody has reviewed that round (no review started nor verdict given
 * since: a round reviewed and failed meanwhile is the builder's now, #405 round 2 finding); a builder's while the card
 * is still its own and, since the verdict, neither it acted on the card nor another round started. A later arrival
 * queues a wake of its own.
 */
function stillDue(p: Pending, card: TaskCard | null): boolean {
  if (!card || card.archived) return false
  const since = historySince(card, p.since)
  if (p.kind === 'review') return card.column === 'review' && !card.review && !since.some((h) => /^(Started reviewing|Review (passed|failed))$/.test(h.what))
  if (card.agent !== p.agentId) return false
  return !since.some((h) => same(h.by, p.agentName) || /^(Moved to (the (top|bottom) of )?Review\b|Returned for review|Started reviewing)/.test(h.what))
}

/** Counts the board's and lanes' changes: a wake checked or typed while one lands is stopped and worked out again. */
let rolesSeq = 0

/** Wakes being tried now, by key: a second try of one waits for that one. */
const trying = new Map<string, Promise<void>>()

/** Tries one waiting wake: typed (and noted on its card), dropped (no longer due, or its watch tells it), or kept. */
function attempt(key: string): Promise<void> {
  const running = trying.get(key)
  if (running) return running
  const run = attemptNow(key).finally(() => trying.delete(key))
  trying.set(key, run)
  return run
}

async function attemptNow(key: string): Promise<void> {
  const p = pending.get(key)
  if (!p) return
  // Its workspace closed, or switched to another folder: dropped.
  if (!p.ws.path || !p.ws.isProjectPath(p.projectPath) || Date.now() - p.at > KEEP_MS) {
    pending.delete(key)
    return
  }
  // Roles can change while it is checked or typed (the lane's reviewer, the card's agent): then it is worked out again.
  const seq = rolesSeq
  const card = await getTask(p.n, p.ws).catch(() => null)
  const drop = (): void => {
    if (pending.get(key) === p) pending.delete(key)
  }
  if (!card || !stillDue(p, card) || watchCovers(p.projectPath, p.agentId, p.n, p.kind, card.column) || !(await wakesOn(p.ws, p.projectPath))) return drop()
  // Only to whose wake it is now: another reviewer given the lane meanwhile gets it instead (#405 round 1 finding).
  const to = await targetOf(p.ws, p.projectPath, card, p.kind)
  if (to?.id !== p.agentId) {
    drop()
    if (to) enqueue(p.ws, p.projectPath, card, p.kind, to, p.since)
    return
  }
  const kinds: ('column' | 'verdict')[] = p.kind === 'review' ? ['column'] : ['verdict']
  const line = loopWakeLine({ ...cardChange(p.n, card, kinds), about: wakeAbout(card, kinds, p.agentId) }, p.kind)
  const typed = await typeLine(p.projectPath, p.agentId, line, () => pending.get(key) === p && rolesSeq === seq && !watchCovers(p.projectPath, p.agentId, p.n, p.kind, card.column))
  if (!typed) return
  if (pending.get(key) === p) pending.delete(key)
  await noteOnCard(p.n, `Woke ${p.agentName} ${p.kind === 'review' ? 'to review it' : 'with its verdict'} (a loop wake)`, p.ws).catch((e) => log.warn(`noting a loop wake on #${p.n}`, e))
  log.info(`Loop wake: #${p.n} to ${userText(p.agentName)}`)
}

/** Tries the waiting wakes, all of them or one agent's (its status changed). */
function tryPending(projectPath?: string, agentId?: string): void {
  for (const [key, p] of pending) {
    if (projectPath && !(same(p.projectPath, projectPath) && p.agentId === agentId)) continue
    void attempt(key).catch((e) => log.warn('a loop wake', e))
  }
}

let started = false
/** Wires loop wakes into the board's handoffs and the sessions' statuses (once, at start). */
export function initLoopWakes(): void {
  if (started) return
  started = true
  onLoopEvent((e) => void handoff(e).catch((err) => log.warn('a loop handoff', err)))
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed' || e.type === 'lanes-changed') rolesSeq++
    if (e.type !== 'session-status') return
    const s = e.state.status
    if (s === 'ready' || s === 'finished' || s === 'watching') setTimeout(() => tryPending(e.state.projectPath, e.state.agentId), 500)
  })
  const timer = setInterval(() => tryPending(), 5000)
  timer.unref?.()
}

/** The wakes waiting now (agent and card), for tests. */
export const pendingLoopWakes = (): { agentId: string; n: number; kind: LoopEvent['kind'] }[] => [...pending.values()].map((p) => ({ agentId: p.agentId, n: p.n, kind: p.kind }))
/** Tries every waiting wake now (what the tick does), for tests. */
export const tryLoopWakes = async (): Promise<void> => {
  await Promise.all([...pending.keys()].map((k) => attempt(k)))
}
/** Forgets every waiting wake, for tests. */
export const clearLoopWakes = (): void => pending.clear()
