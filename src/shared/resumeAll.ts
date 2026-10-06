// Resume All: resumes every stopped agent of a project that has a conversation to resume, one at a time, and carries
// on the running ones a refused sign-in stopped (#309).

export interface ResumeAllAgent {
  id: string
  name: string
  /** Running (any status): left alone, unless a refused sign-in stopped its turn (LiveSessionState.signIn). */
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

/**
 * A running agent whose turn a refused sign-in stopped and that hasn't carried on by itself: Resume carries it on.
 * Not while it is busy again (working, asking you).
 */
export function stalledOnSignIn(live: unknown): boolean {
  if (!live || typeof live !== 'object') return false
  const l = live as { signIn?: unknown; status?: unknown }
  return !!l.signIn && (l.status === 'ready' || l.status === 'finished' || l.status === 'signin')
}

/** The agents Resume All resumes: stopped ones with a conversation to resume, and running ones stalled on a sign-in. */
export function agentsToResume<A extends ResumeAllAgent>(agents: readonly A[]): A[] {
  return agents.filter((a) => (!a.live && a.resume) || stalledOnSignIn(a.live))
}

/**
 * Resumes each stopped agent with a conversation in turn (one launch at a time). A failure is recorded
 * with its reason and the rest are still tried; running agents are never restarted (one stalled on a sign-in is
 * carried on: `resumeOne` tells them apart).
 */
export async function resumeAll<A extends ResumeAllAgent>(agents: readonly A[], resumeOne: (agent: A) => Promise<void>): Promise<ResumeAllResult> {
  const result: ResumeAllResult = { resumed: [], running: [], nothing: [], failed: [] }
  for (const a of agents) {
    if (a.live && !stalledOnSignIn(a.live)) {
      result.running.push(a.name)
      continue
    }
    if (!a.live && !a.resume) {
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
