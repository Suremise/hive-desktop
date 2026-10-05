// Start New (All) and Archive and Start New (All) (#216): every agent of a project gets a fresh session after one
// confirmation, running ones stopped first; the second archives each agent's session first. Pure parts here (which
// agents, which sessions, what the confirmation says about each, running them one at a time), so they are tested.
import type { SessionStatus } from './types'

export interface BatchAgent {
  id: string
  name: string
  live: { sessionId: string; status: SessionStatus } | null
  /** The session it last ran (stopped agents). */
  lastSessionId?: string
  /** The session Resume would open. */
  resume: { id: string } | null
}

export interface BatchSession {
  id: string
  archived?: boolean
}

/** What stopping a running agent costs it, as the quit dialog says it (null: nothing in progress). */
export function busyNote(status: SessionStatus): string | null {
  return status === 'working'
    ? 'will be interrupted'
    : status === 'background'
      ? 'background tasks will stop'
      : status === 'waiting'
        ? 'waiting for you'
        : status === 'watching'
          ? 'its card loop pauses until it is resumed'
          : null
}

/**
 * The session Archive and Start New (All) archives for each agent, as Archive Session and Start New… does for one: a
 * running agent's current session, else the last one it ran (or would resume) if that isn't archived yet. Agents with
 * none are left out (they have nothing to archive and keep what they have).
 */
export function sessionsToArchive<A extends BatchAgent>(agents: readonly A[], sessions: readonly BatchSession[]): { agent: A; sessionId: string }[] {
  return agents.flatMap((agent) => {
    const id = agent.live?.sessionId ?? agent.lastSessionId ?? agent.resume?.id
    const s = id ? sessions.find((x) => x.id === id) : undefined
    return s && (agent.live || !s.archived) ? [{ agent, sessionId: s.id }] : []
  })
}

/** The confirmation's line for an agent: what it is doing, and what stopping it costs when that is something. */
export function batchLine(agent: BatchAgent, statusText: (live: NonNullable<BatchAgent['live']>) => string): string {
  if (!agent.live) return `• ${agent.name} — not running`
  const note = busyNote(agent.live.status)
  return `• ${agent.name} — ${statusText(agent.live)}${note ? ` (${note})` : ''}`
}

export interface BatchResult {
  done: string[]
  failed: { name: string; error: string }[]
}

/** Runs `step` for each agent in turn (one launch at a time): a failure is kept with its reason and the rest go on. */
export async function eachAgent<A extends { name: string }>(agents: readonly A[], step: (agent: A) => Promise<void>): Promise<BatchResult> {
  const result: BatchResult = { done: [], failed: [] }
  for (const a of agents) {
    try {
      await step(a)
      result.done.push(a.name)
    } catch (e) {
      result.failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
