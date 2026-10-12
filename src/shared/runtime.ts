import { isCompacting } from './defaults'
import type { LiveSessionState } from './types'

/**
 * An agent's runtime as separate facts (#648), rather than one word standing for several: its status is a projection of
 * these, with Hive's policy on top (a watch makes an idle agent "watching"; assigned work is the board's). Unknown is
 * its own value, never idle: a running turn Hive has heard nothing of for a while, with no sign of its end.
 */
export interface AgentRuntime {
  /** The CLI's process: starting, running, stopped by a refused sign-in, or stopped. */
  lifecycle: 'starting' | 'running' | 'signin' | 'stopped'
  /** Its latest turn: running, over, unknown, or none yet. */
  turn: 'running' | 'over' | 'unknown' | 'none'
  /** Work that isn't a turn's: compacting its conversation. */
  maintenance: 'compacting' | null
  /** A person is asked: it waits for them, or a question waits beside its work. */
  attention: 'waiting' | 'question' | null
  /** Its input: holding a line Hive typed that the CLI hasn't taken, or free as far as Hive knows. */
  composer: 'held' | 'free'
  /** Its background tasks still running. */
  backgroundTasks: number
  /** Minutes its running turn has been silent, while its state is unknown. */
  silentMinutes?: number
}

/** Minutes since an ISO time, at least 1. */
const minutesSince = (iso: string, now: number): number => Math.max(1, Math.round((now - Date.parse(iso)) / 60_000))

export function agentRuntime(st: LiveSessionState, now = Date.now()): AgentRuntime {
  const lifecycle = st.status === 'stopped' || st.status === 'error' ? 'stopped' : st.status === 'starting' ? 'starting' : st.status === 'signin' ? 'signin' : 'running'
  const turn = st.turn?.state ?? 'none'
  return {
    lifecycle,
    turn,
    maintenance: isCompacting(st) ? 'compacting' : null,
    attention: st.status === 'waiting' ? 'waiting' : st.question ? 'question' : null,
    composer: st.untakenLine ? 'held' : 'free',
    backgroundTasks: st.backgroundTasks ?? 0,
    ...(turn === 'unknown' && st.turn?.silentSince ? { silentMinutes: minutesSince(st.turn.silentSince, now) } : {})
  }
}

/** "Silent 23 min · state unknown" for an agent whose state is unknown (#648); null otherwise. */
export function unknownStateText(st: Pick<LiveSessionState, 'turn'> | null | undefined, now = Date.now()): string | null {
  if (st?.turn?.state !== 'unknown') return null
  return `Silent ${st.turn.silentSince ? minutesSince(st.turn.silentSince, now) : '?'} min · state unknown`
}
