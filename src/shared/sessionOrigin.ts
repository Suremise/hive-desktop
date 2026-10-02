import type { SessionListItem } from './types'

/**
 * Where a session ran and whose it was, for the Sessions tab: "Coder · Project folder", "Reviewer · Worktree ·
 * hive/reviewer". From what the session recorded (its agent's id and name, its folder and branch), never from which
 * agent has that name or folder now: an agent added later with the same name or worktree isn't the one that ran it.
 * Which agent resumes it now is separate (resumeTarget).
 */
export interface SessionOrigin {
  /** The agent: its current name; "Coder (removed)" or "Removed agent" once gone; null when none was recorded. */
  agent: string | null
  /** "Project folder", or "Worktree · <branch>". */
  location: string
  /** The badge: agent and location. */
  label: string
  /** For a tooltip: the full folder, and the agent's id. */
  detail: string
}

type Recorded = Pick<SessionListItem, 'source' | 'agentId' | 'agentName' | 'cwd' | 'branch'>

/** Null for sessions started outside Hive. (The Assistant's conversations aren't labelled: it has one place to run.) */
export function sessionOrigin(projectPath: string, agents: readonly { id: string; name: string }[], s: Recorded): SessionOrigin | null {
  if (s.source !== 'hive') return null
  const folder = s.cwd || projectPath
  const inWorktree = folder.toLowerCase() !== projectPath.toLowerCase()
  const location = inWorktree ? `Worktree · ${s.branch || folder.split(/[\\/]/).filter(Boolean).pop() || folder}` : 'Project folder'
  const now = s.agentId ? agents.find((a) => a.id === s.agentId) : undefined
  const agent = !s.agentId ? null : now ? now.name : s.agentName ? `${s.agentName} (removed)` : 'Removed agent'
  const who = !s.agentId
    ? 'No agent recorded (adopted, or from before Hive recorded agents).'
    : now
      ? `Agent ${now.name} (${s.agentId}).`
      : `Its agent (${s.agentId}) has since been removed.`
  return { agent, location, label: agent ? `${agent} · ${location}` : location, detail: `Ran in ${folder}\n${who}` }
}
