import { COMPACTING_MESSAGE } from './defaults'
import type { LiveSessionState, RuntimeFacts } from './types'

/**
 * An agent's runtime as separate facts (#648), rather than one word standing for several. Each is stored where Hive
 * learns it (LiveSessionState.runtime, .turn and .backgroundTasks), never read back from the status word: the labels
 * are projected from them (runtimeLabel), with Hive's policy on top (a watch makes an idle agent "watching"; how its
 * last turn ended and assigned work are the board's and the status word's). Unknown is its own value, never idle: a
 * running turn Hive has heard nothing of for a while, with no sign of its end.
 */
export interface AgentRuntime extends RuntimeFacts {
  /** Its latest turn: running, over, unknown, or none yet. */
  turn: 'running' | 'over' | 'unknown' | 'none'
  /** The CLI's id for that turn, when it names turns. */
  turnId?: string
  /** Its background tasks still running. */
  backgroundTasks: number
  /** Minutes its running turn has been silent, while its state is unknown. */
  silentMinutes?: number
}

/** Before an agent's facts are known (a state from before them): starting, nothing else known. */
const NO_FACTS: RuntimeFacts = { lifecycle: 'starting', maintenance: null, attention: null, composer: 'free' }

/** Minutes since an ISO time, at least 1. */
const minutesSince = (iso: string, now: number): number => Math.max(1, Math.round((now - Date.parse(iso)) / 60_000))

/** The agent's runtime: its stored facts, gathered. */
export function agentRuntime(st: Pick<LiveSessionState, 'runtime' | 'turn' | 'backgroundTasks'>, now = Date.now()): AgentRuntime {
  const turn = st.turn?.state ?? 'none'
  return {
    ...(st.runtime ?? NO_FACTS),
    turn,
    ...(st.turn?.id ? { turnId: st.turn.id } : {}),
    backgroundTasks: st.backgroundTasks ?? 0,
    ...(turn === 'unknown' && st.turn?.silentSince ? { silentMinutes: minutesSince(st.turn.silentSince, now) } : {})
  }
}

/** "Silent 23 min · state unknown" for an agent whose state is unknown (#648); null otherwise. */
export function unknownStateText(st: Pick<LiveSessionState, 'turn'> | null | undefined, now = Date.now()): string | null {
  if (st?.turn?.state !== 'unknown') return null
  return `Silent ${st.turn.silentSince ? minutesSince(st.turn.silentSince, now) : '?'} min · state unknown`
}

/**
 * What an agent is doing, in words, projected from its runtime facts: stopped, starting, signed out, asking, compacting,
 * silent with its state unknown, working; its status message where it has one (what it is asked, what it waits for).
 * Null when its facts say no turn runs: then Hive's policy words apply (watching, finished, ready, its background tasks:
 * ui.statusText).
 */
export function runtimeLabel(st: Pick<LiveSessionState, 'runtime' | 'turn' | 'backgroundTasks' | 'statusMessage' | 'mergeSlot'>, now = Date.now()): string | null {
  const rt = agentRuntime(st, now)
  if (rt.lifecycle === 'stopped') return 'Stopped'
  if (rt.attention === 'waiting') return st.statusMessage || 'Needs your input'
  if (rt.lifecycle === 'starting') return st.statusMessage || 'Starting…'
  if (rt.lifecycle === 'signin') return 'Needs sign-in'
  if (rt.maintenance === 'compacting') return COMPACTING_MESSAGE
  if (rt.turn === 'unknown') return unknownStateText(st, now)
  if (rt.turn === 'running') return st.statusMessage || st.mergeSlot || 'Working…'
  return null
}
