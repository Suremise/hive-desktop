import { shownText } from './advanced'
import { msg, tr as trNow } from './i18n'
import type { Tr } from './tasks'
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

/**
 * "Silent 23 min · state unknown" for an agent whose state is unknown (#648); null otherwise. In the window's language
 * with tr (#799), else English (the Agent API's).
 */
export function unknownStateText(st: Pick<LiveSessionState, 'turn'> | null | undefined, now = Date.now(), tr?: Tr): string | null {
  if (st?.turn?.state !== 'unknown') return null
  const minutes = st.turn.silentSince ? minutesSince(st.turn.silentSince, now) : null
  if (tr) return tr(msg({ id: 'panes.runtime.silent', defaultMessage: 'Silent {minutes} min · state unknown', description: "An agent's status (its pane, the agents table): Hive has heard nothing of its turn for {minutes} minutes (? when it can't tell) and can't tell what it is doing. Keep it short." }), { minutes: minutes ?? '?' })
  return `Silent ${minutes ?? '?'} min · state unknown` // i18n-ignore: agent-facing (the Agent API's agent state)
}

/**
 * The status of an agent compacting its conversation, as the window shows it (#847); COMPACTING_MESSAGE (defaults.ts) is
 * its English, the status message agents read and isCompacting() compares.
 */
export const COMPACTING_TEXT = msg({ id: 'session.status.compacting', defaultMessage: 'Compacting the conversation…', description: "An agent's status while its CLI summarises the conversation to free up context space." })

/** Hive's own status message in the window's language (`statusText`, #845), else the message as it came (the CLI's words). */
export const shownStatusMessage = (st: Pick<LiveSessionState, 'statusMessage' | 'statusText'>): string | undefined => (st.statusText ? shownText(st.statusText) : st.statusMessage)

/** The agent's place at the merge slot in the window's language (`mergeSlotText`, #845), else its English. */
export const shownMergeSlot = (st: Pick<LiveSessionState, 'mergeSlot' | 'mergeSlotText'>): string | undefined => (st.mergeSlotText ? shownText(st.mergeSlotText) : st.mergeSlot)

/**
 * What an agent is doing, in words, projected from its runtime facts: stopped, starting, signed out, asking, compacting,
 * silent with its state unknown, working; its status message where it has one (what it is asked, what it waits for).
 * Null when its facts say no turn runs: then Hive's policy words apply (watching, finished, ready, its background tasks:
 * ui.statusText).
 */
export function runtimeLabel(st: Pick<LiveSessionState, 'runtime' | 'turn' | 'backgroundTasks' | 'statusMessage' | 'statusText' | 'mergeSlot' | 'mergeSlotText'>, now = Date.now()): string | null {
  const tr = trNow
  const rt = agentRuntime(st, now)
  if (rt.lifecycle === 'stopped') return tr(msg({ id: 'panes.runtime.stopped', defaultMessage: 'Stopped', description: "An agent's status: its session isn't running." }))
  if (rt.attention === 'waiting') return shownStatusMessage(st) || tr(msg({ id: 'panes.runtime.needsInput', defaultMessage: 'Needs your input', description: "An agent's status: its CLI waits for the user's answer." }))
  if (rt.lifecycle === 'starting') return shownStatusMessage(st) || tr(msg({ id: 'panes.runtime.starting', defaultMessage: 'Starting…', description: "An agent's status: its CLI is starting." }))
  if (rt.lifecycle === 'signin') return tr(msg({ id: 'panes.runtime.signin', defaultMessage: 'Needs sign-in', description: "An agent's status: its CLI waits for the user to sign in." }))
  if (rt.maintenance === 'compacting') return tr(COMPACTING_TEXT)
  if (rt.turn === 'unknown') return unknownStateText(st, now, tr)
  if (rt.turn === 'running') return shownStatusMessage(st) || shownMergeSlot(st) || tr(msg({ id: 'panes.runtime.working', defaultMessage: 'Working…', description: "An agent's status: it is working on a turn." }))
  return null
}
