// Resume All: resumes every stopped agent of a project that has a conversation to resume, one at a time.

export interface ResumeAllAgent {
  id: string
  name: string
  /** Running (any status): left alone. */
  live: unknown
  /** The conversation Resume would open; null when the agent has none. */
  resume: { id: string } | null
}

export interface ResumeAllResult {
  resumed: string[]
  /** Already running. */
  running: string[]
  /** Stopped, with no conversation to resume. */
  nothing: string[]
  failed: { name: string; error: string }[]
}

/** The agents Resume All resumes: stopped ones with a conversation to resume. */
export function agentsToResume<A extends ResumeAllAgent>(agents: readonly A[]): A[] {
  return agents.filter((a) => !a.live && a.resume)
}

/**
 * Resumes each stopped agent with a conversation in turn (one launch at a time). A failure is recorded
 * with its reason and the rest are still tried; running agents are never restarted.
 */
export async function resumeAll<A extends ResumeAllAgent>(agents: readonly A[], resumeOne: (agent: A) => Promise<void>): Promise<ResumeAllResult> {
  const result: ResumeAllResult = { resumed: [], running: [], nothing: [], failed: [] }
  for (const a of agents) {
    if (a.live) {
      result.running.push(a.name)
      continue
    }
    if (!a.resume) {
      result.nothing.push(a.name)
      continue
    }
    try {
      await resumeOne(a)
      result.resumed.push(a.name)
    } catch (e) {
      result.failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
