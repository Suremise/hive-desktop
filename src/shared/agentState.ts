import { asksYou } from './inbox'
import { msg, type Msg } from './i18n'
import type { LiveSessionState } from './types'

/**
 * An agent's state as the session page marks it (#973, Hive 0.9.0): four states, each drawn with its own shape as well
 * as its colour (StateMark), so they read apart without colour. Projected from what Hive already knows (the status
 * word, a question, a stall, a card blocked on the user); it detects nothing of its own.
 * - waiting: waiting for you (a permission prompt, a question, a sign-in, a card blocked on you): a diamond;
 * - stalled: nothing will move it on (its CLI failed, its turn has been silent with its state unknown, or it left the
 *   cards it loops on unwatched): a square;
 * - working: a turn, its start, a compaction or background tasks running: a pulsing dot;
 * - idle: ready, finished, watching cards, stopped or no session: a ring.
 */
export type AgentState = 'waiting' | 'stalled' | 'working' | 'idle'

/** Most urgent first: how marks are sorted, and which one stands for several (a summary). */
export const AGENT_STATES: readonly AgentState[] = ['waiting', 'stalled', 'working', 'idle']

/** What the board knows of the agent's cards, where the caller has them. */
export interface AgentStateExtras {
  /** A card it holds is blocked on the user. */
  blocked?: boolean
  /** A card it holds or reviews is stalled (the board's stalledReason). */
  stalled?: boolean
}

type StateFields = Pick<LiveSessionState, 'status' | 'question' | 'turn' | 'notWatching'>

/** The state an agent's mark shows; no session at all is idle. */
export function agentState(live: StateFields | null | undefined, extras: AgentStateExtras = {}): AgentState {
  if (asksYou(live) || extras.blocked) return 'waiting'
  if (extras.stalled) return 'stalled'
  if (!live) return 'idle'
  if (live.status === 'error' || live.turn?.state === 'unknown' || (live.notWatching?.length ?? 0) > 0) return 'stalled'
  if (live.status === 'working' || live.status === 'starting' || live.status === 'background') return 'working'
  return 'idle'
}

/** Each state's name, one for every place a mark is shown (its accessible name, a legend, a summary's tooltip). */
export const AGENT_STATE_LABEL: Record<AgentState, Msg> = {
  waiting: msg({ id: 'session.state.waiting', defaultMessage: 'Waiting for you', description: "An agent's state, shown as a diamond: it asks you something (a permission, a question, a sign-in) or a card it has is blocked on you." }),
  stalled: msg({ id: 'session.state.stalled', defaultMessage: 'Stalled', description: "An agent's state, shown as a square: nothing will move it on by itself (its coding agent failed, it has gone silent, or it stopped watching its cards)." }),
  working: msg({ id: 'session.state.working', defaultMessage: 'Working', description: "An agent's state, shown as a pulsing dot: it is working (a turn, starting, or background tasks)." }),
  idle: msg({ id: 'session.state.idle', defaultMessage: 'Idle', description: "An agent's state, shown as a ring: ready, finished, waiting on cards, or stopped." })
}

/** How many agents are in each state. */
export function stateCounts(states: Iterable<AgentState>): Record<AgentState, number> {
  const n: Record<AgentState, number> = { waiting: 0, stalled: 0, working: 0, idle: 0 }
  for (const s of states) n[s]++
  return n
}

/** The most urgent of several states (a summary's mark); idle when there are none. */
export function mostUrgent(states: Iterable<AgentState>): AgentState {
  const n = stateCounts(states)
  return AGENT_STATES.find((s) => n[s] > 0) ?? 'idle'
}
