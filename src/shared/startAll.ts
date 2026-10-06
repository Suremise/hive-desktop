// Start New (All) and Archive and Start New (All) (#216): every agent of a project gets a fresh session after one
// confirmation, running ones stopped first; the second archives each agent's session first. Pure parts here (which
// agents, which sessions, what the confirmation says about each, running them one at a time), so they are tested.
import { agentsToResume } from './resumeAll'
import type { SessionStatus, WorktreeCheck } from './types'

export interface BatchAgent {
  id: string
  name: string
  live: { sessionId: string; status: SessionStatus } | null
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
 * The session Archive and Start New (All) archives for an agent: a running agent's current one, else the one its Resume
 * would open (its last one, if that isn't archived yet; worked out in main as `AgentInfo.resume`). Null: it has none.
 * The header counts the agents with one, so the button's count and the confirmation's list are the same agents (#275).
 */
export function archiveTarget(agent: Pick<BatchAgent, 'live' | 'resume'>): string | null {
  return agent.live?.sessionId ?? agent.resume?.id ?? null
}

/**
 * Each agent's session to archive (`archiveTarget`), as Hive keeps it: agents with none, or whose stopped session is
 * gone or archived meanwhile, are left out (they have nothing to archive and keep what they have).
 */
export function sessionsToArchive<A extends BatchAgent>(agents: readonly A[], sessions: readonly BatchSession[]): { agent: A; sessionId: string }[] {
  return agents.flatMap((agent) => {
    const id = archiveTarget(agent)
    const s = id ? sessions.find((x) => x.id === id) : undefined
    return s && (agent.live || !s.archived) ? [{ agent, sessionId: s.id }] : []
  })
}

/** How many agents each batch action in the project header would act on, as its confirmation lists them (#275). */
export interface BatchCounts {
  /** Stop: the running agents. */
  stop: number
  /** Resume: the stopped agents with a conversation to resume. */
  resume: number
  /** Start New: every agent. */
  startNew: number
  /** Archive and Start New: the agents with a session to archive. */
  archive: number
}

export function batchCounts(agents: readonly BatchAgent[]): BatchCounts {
  return {
    stop: agents.filter((a) => a.live).length,
    resume: agentsToResume(agents).length,
    startNew: agents.length,
    archive: agents.filter((a) => archiveTarget(a)).length
  }
}

/** The confirmation's line for an agent: what it is doing, and what stopping it costs when that is something. */
export function batchLine(agent: BatchAgent, statusText: (live: NonNullable<BatchAgent['live']>) => string): string {
  if (!agent.live) return `• ${agent.name} — not running`
  const note = busyNote(agent.live.status)
  return `• ${agent.name} — ${statusText(agent.live)}${note ? ` (${note})` : ''}`
}

/** A worktree agent's worktree, with whether it could be deleted without losing work (`agents:worktreeChecks`). */
export interface BatchWorktree {
  branch: string
  check?: Pick<WorktreeCheck, 'removable' | 'reason'>
}

/**
 * Remove All's line for an agent (#291): what it is doing, as `batchLine`, and for a worktree agent what can happen to
 * its worktree: deleted only if the box is ticked and it is merged and clean, else always kept (and why).
 */
export function removeLine(agent: BatchAgent, statusText: (live: NonNullable<BatchAgent['live']>) => string, worktree?: BatchWorktree): string {
  const line = batchLine(agent, statusText)
  if (!worktree) return line
  const check = worktree.check
  return `${line} · worktree ${worktree.branch}: ${check?.removable ? 'merged and clean' : `always kept (${check?.reason ?? "couldn't be checked"})`}`
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
