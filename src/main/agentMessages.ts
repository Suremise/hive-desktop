import type { QueuedMessage } from '../shared/types'
import { onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { onWakeRider, typeLine, type RideCheck, type Rider } from './watches'

/**
 * Messages left for an agent that can't take a prompt now (#530): it is working, waiting on its background tasks or
 * for the user, starting, or the user has just typed there. On 10 Oct the user pasted about ten of the Assistant's
 * messages into agents' panes because hive_prompt_agent refused every agent of a running card loop.
 *
 * A message goes in with the agent's next line, whichever comes first: a wake (a card or agent watch's line, a loop
 * wake), which it rides at the front of (watches.onWakeRider), so the agent has it before it acts on the wake; or a line
 * of its own once the agent is idle (ready, finished or watching), typed as a wake is (watches.typeLine: nobody typing
 * there, no earlier line waiting). A watching agent is idle, so a message wakes it at once, and its watch carries on
 * (typing doesn't end one): the line says so. Several waiting go in one line, in order.
 *
 * Each message keeps its sender's permission (the Assistant's: its Control level and its session, `allowed`), checked
 * before it is typed, before each piece and Enter, and until its CLI takes it (before the confirmation's Enter again,
 * watches.confirmTaken): one no longer allowed is refused, never typed or submitted; a line it was in that the CLI hasn't
 * taken is cleared then (when safe), and the wake it rode typed again alone. Kept in memory for
 * the agent's launch: a stop, a new launch or a restart of Hive drops them. One queue per agent, at most MAX_QUEUED,
 * each at most MESSAGE_MAX_CHARS; the latest outcomes kept for the agents' activity, at most MAX_OUTCOMES agents.
 */

const log = createLogger('messages')

export const MESSAGE_MAX_CHARS = 4000
export const MAX_QUEUED = 5
/** Agents whose latest outcome is kept for their activity (the oldest go first). */
export const MAX_OUTCOMES = 200

/** What became of a message: typed, cancelled (by whom), dropped (why: the launch ended), refused (its sender may no longer). */
export type MessageFate = 'delivered' | 'cancelled' | 'dropped' | 'refused'

interface Item {
  msg: QueuedMessage
  /** Null while its sender may still send it, else why not (the Assistant's Control turned down, its session ended). */
  allowed: () => string | null
  fate?: { what: MessageFate; detail?: string }
}

interface Queue {
  projectPath: string
  agentId: string
  runId: string
  agentName: string
  items: Item[]
}

/** What became of an agent's latest messages, for its activity. */
export interface MessageOutcome {
  at: string
  outcome: MessageFate
  count: number
  detail?: string
}

const queues = new Map<string, Queue>()
const outcomes = new Map<string, MessageOutcome>()
const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** The line a queue's messages are typed as (one line: the CLI's prompt), with the watch it keeps if it is watching. */
export function messageLine(items: readonly Pick<QueuedMessage, 'from' | 'text'>[], watchLabel: string | null): string {
  const from = [...new Set(items.map((m) => m.from))].join(' and ')
  const body = items.length === 1 ? `Message from ${from}: ${items[0].text}` : `${items.length} messages from ${from}: ${items.map((m, i) => `(${i + 1}) ${m.text}`).join(' ')}`
  const tail = watchLabel ? ` (Your watch is still on, ${watchLabel.charAt(0).toLowerCase()}${watchLabel.slice(1)}: do what this asks, then end your turn, and Hive wakes you when it changes.)` : ''
  return `[Hive] ${body}${tail}`
}

function setOutcome(q: Pick<Queue, 'projectPath' | 'agentId'>, o: Omit<MessageOutcome, 'at'>): void {
  const key = keyOf(q.projectPath, q.agentId)
  outcomes.delete(key)
  outcomes.set(key, { at: new Date().toISOString(), ...o })
  while (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value!)
}

/** Shows the queue on the agent (its pane, status replies). */
function show(q: Queue): void {
  sessions.setQueuedMessages(q.projectPath, q.agentId, q.items.length ? q.items.map((i) => i.msg) : null)
}

/** Takes items out of their queue with a fate (all of them by default), and records it as the agent's latest outcome. */
function settle(q: Queue, fate: MessageFate, detail?: string, items: Item[] = [...q.items]): void {
  if (!items.length) return
  for (const i of items) i.fate = { what: fate, ...(detail ? { detail } : {}) }
  q.items = q.items.filter((i) => !items.includes(i))
  if (!q.items.length && queues.get(keyOf(q.projectPath, q.agentId)) === q) queues.delete(keyOf(q.projectPath, q.agentId))
  show(q)
  setOutcome(q, { outcome: fate, count: items.length, ...(detail ? { detail } : {}) })
  log.info(`${items.length} message(s) for ${userText(q.agentName)} ${fate}${detail ? `: ${userText(detail)}` : ''}`)
}

/** Refuses the messages whose sender may no longer send them. True when some are left. */
function refuseDisallowed(q: Queue): boolean {
  for (const i of [...q.items]) {
    const why = i.allowed()
    if (why) settle(q, 'refused', why, [i])
  }
  return q.items.length > 0
}

/**
 * A typed line's check until its CLI takes it (#530 round 2 finding): whether these messages may all still be sent, and,
 * when not, the line was cleared: they are recorded as refused (they were typed, never submitted).
 */
function rideCheck(q: Queue, items: Item[], instead: string | null): RideCheck {
  return {
    still: () => items.every((i) => !i.allowed()),
    withdrawn: () => {
      const why = items.map((i) => i.allowed()).find(Boolean) ?? 'its sender may no longer send it'
      for (const i of items) i.fate = { what: 'refused', detail: why }
      setOutcome(q, { outcome: 'refused', count: items.length, detail: why })
      log.info(`${items.length} message(s) for ${userText(q.agentName)} withdrawn before their CLI took them: ${userText(why)}`)
    },
    instead
  }
}

/** The queue still as it was (same object, same items), each still allowed. */
const unchanged = (key: string, q: Queue, items: Item[]): boolean => queues.get(key) === q && q.items.length === items.length && items.every((i, n) => q.items[n] === i && !i.allowed())

/**
 * Leaves a message for a running agent (from: who it is from, as the line names it; allowed: whether its sender may still
 * send it, null when so). Typed now when it can be, else queued. What became of it by the time this returns: typed,
 * queued, or another fate (cancelled meanwhile, refused, dropped), never reported as typed. Refused (an Error) when it
 * isn't running, the text is empty or too long, or the queue is full.
 */
export async function leaveMessage(projectPath: string, agentId: string, agentName: string, from: string, text: string, allowed: () => string | null = () => null): Promise<{ fate: MessageFate | 'queued'; queued: number; detail?: string }> {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st) throw new Error(`${agentName} isn't running.`)
  const t = text.trim()
  if (!t) throw new Error('text is required')
  if (t.length > MESSAGE_MAX_CHARS) throw new Error(`A message is at most ${MESSAGE_MAX_CHARS} characters (this one has ${t.length}).`)
  const key = keyOf(projectPath, agentId)
  let q = queues.get(key)
  if (q && q.runId !== st.runId) {
    settle(q, 'dropped', 'its session was started again')
    q = undefined
  }
  if (q && q.items.length >= MAX_QUEUED) throw new Error(`${agentName} already has ${MAX_QUEUED} messages waiting, the most Hive keeps for an agent: wait until they are delivered (hive_agent_activity), or cancel them.`)
  if (!q) {
    q = { projectPath, agentId, runId: st.runId, agentName, items: [] }
    queues.set(key, q)
  }
  const item: Item = { msg: { from, text: t, at: new Date().toISOString() }, allowed }
  q.items.push(item)
  show(q)
  log.info(`Message queued for ${userText(agentName)} (${q.items.length} waiting)`)
  await attempt(key)
  if (!item.fate) return { fate: 'queued', queued: queues.get(key)?.items.length ?? 0 }
  return { fate: item.fate.what, queued: queues.get(key)?.items.length ?? 0, ...(item.fate.detail ? { detail: item.fate.detail } : {}) }
}

/** Cancels an agent's queued messages (by: who cancelled, for its outcome). How many there were. */
export function cancelMessages(projectPath: string, agentId: string, by: string): number {
  const q = queues.get(keyOf(projectPath, agentId))
  if (!q) return 0
  const n = q.items.length
  settle(q, 'cancelled', by)
  return n
}

/** An agent's queued messages and what became of the last ones, for its activity. */
export function messagesOf(projectPath: string, agentId: string): { queued: QueuedMessage[]; last: MessageOutcome | null } {
  const key = keyOf(projectPath, agentId)
  return { queued: (queues.get(key)?.items ?? []).map((i) => i.msg), last: outcomes.get(key) ?? null }
}

/**
 * The queued messages that ride a wake typed into the agent (watches.onWakeRider), put first in its line: null when
 * none waits (or none is still allowed). Typed once: `taken` settles them as delivered; a change meanwhile (one
 * cancelled, refused or added) stops the wake's typing, and it is typed again later with the queue as it is then.
 */
function riderFor(projectPath: string, agentId: string): Rider | null {
  const key = keyOf(projectPath, agentId)
  const q = queues.get(key)
  const st = sessions.liveFor(projectPath, agentId)
  if (!q || !st || st.runId !== q.runId || !refuseDisallowed(q)) return null
  const items = [...q.items]
  const check = rideCheck(q, items, null)
  return {
    text: messageLine(items.map((i) => i.msg), null),
    still: () => unchanged(key, q, items),
    taken: () => {
      if (queues.get(key) === q) settle(q, 'delivered', undefined, items.filter((i) => q.items.includes(i)))
    },
    allowed: check.still,
    withdrawn: check.withdrawn
  }
}

const trying = new Map<string, Promise<void>>()

function attempt(key: string): Promise<void> {
  const running = trying.get(key)
  if (running) return running
  const run = attemptNow(key).finally(() => trying.delete(key))
  trying.set(key, run)
  return run
}

async function attemptNow(key: string): Promise<void> {
  const q = queues.get(key)
  if (!q) return
  const st = sessions.liveFor(q.projectPath, q.agentId)
  if (!st || st.runId !== q.runId) return settle(q, 'dropped', st ? 'its session was started again' : 'it stopped')
  if (!refuseDisallowed(q)) return
  const items = [...q.items]
  const line = messageLine(items.map((i) => i.msg), st.status === 'watching' && st.watch ? st.watch.label : null)
  // Typed only while these are still the messages waiting (none cancelled, refused or added meanwhile); its own line
  // carries no rider. A fired watch's line goes first, and takes these with it.
  const typed = await typeLine(q.projectPath, q.agentId, line, () => unchanged(key, q, items), { rider: false, ride: rideCheck(q, items, null) })
  if (typed && queues.get(key) === q) return settle(q, 'delivered', undefined, items.filter((i) => q.items.includes(i)))
  // Refused while it was being typed: settled as such now, not left to the next try.
  if (queues.get(key) === q) refuseDisallowed(q)
}

/** Tries the queues, all of them or one agent's. */
function tryQueued(projectPath?: string, agentId?: string): void {
  for (const [key, q] of queues) {
    if (projectPath && !(q.projectPath.toLowerCase() === projectPath.toLowerCase() && q.agentId === agentId)) continue
    void attempt(key).catch((e) => log.warn('delivering a message', e))
  }
}

let started = false
/** Delivers queued messages as agents become idle, and with their wakes (once, at start). */
export function initAgentMessages(): void {
  if (started) return
  started = true
  onWakeRider(riderFor)
  onHiveEvent((e) => {
    if (e.type !== 'session-status') return
    const s = e.state.status
    if (s === 'stopped') {
      const q = queues.get(keyOf(e.state.projectPath, e.state.agentId))
      if (q) settle(q, 'dropped', 'it stopped')
      return
    }
    if (s === 'ready' || s === 'finished' || s === 'watching') setTimeout(() => tryQueued(e.state.projectPath, e.state.agentId), 500)
  })
  // The user's pause after typing, a line taken: nothing tells of those, so the queues are tried again now and then.
  const timer = setInterval(() => tryQueued(), 5000)
  timer.unref?.()
}

/** Tries every queue now (what the tick does), for tests. */
export const tryMessages = async (): Promise<void> => {
  await Promise.all([...queues.keys()].map((k) => attempt(k)))
}
/** Wires the wake rider in without the status events, for tests. */
export const useRiderForTests = (): void => onWakeRider(riderFor)
/** Forgets every queue and outcome, for tests. */
export const clearMessages = (): void => {
  queues.clear()
  outcomes.clear()
}
/** How many agents' outcomes are kept, for tests. */
export const outcomeCount = (): number => outcomes.size
