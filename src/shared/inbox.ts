import type { AgentBranchStatus, LiveSessionState, ProjectInfo } from './types'

/**
 * The attention inbox: the agents that need you (waiting for input, or finished since you last had their pane on
 * screen), oldest first, and below them worktree agents with work to review (not counted). One list for the status
 * bar's popover, the tray menu, the Projects badge and the project list's counts.
 */
export interface InboxItem {
  projectPath: string
  projectName: string
  agentId: string
  agentName: string
  /** The Hive Assistant's agent: it opens the Assistant's panel. */
  assistant: boolean
  kind: 'waiting' | 'finished' | 'review'
  /** When it got to this state (ISO), '' when not known. */
  since: string
  message?: string
  /** A worktree agent's unmerged work. */
  branch?: AgentBranchStatus
}

export interface Inbox {
  needYou: InboxItem[]
  toReview: InboxItem[]
}

/** Waiting for an answer (seen or not), or finished and not looked at since. */
export function needsYou(live: Pick<LiveSessionState, 'status' | 'unseen'> | null | undefined): boolean {
  return !!live && (live.status === 'waiting' || (live.status === 'finished' && live.unseen))
}

/** Unmerged commits or uncommitted files on a worktree agent's branch. */
export function hasWork(b: AgentBranchStatus | null | undefined): b is AgentBranchStatus {
  return !!b && (b.ahead > 0 || b.dirty > 0)
}

/** Not doing anything (stopped, ready or finished), so its work can be reviewed. */
const idle = (live: LiveSessionState | null): boolean => !live || live.status === 'ready' || live.status === 'finished' || live.status === 'stopped'

/** Oldest first; unknown times last. */
const byAge = (a: InboxItem, b: InboxItem): number => (a.since || '￿').localeCompare(b.since || '￿')

export function inbox(projects: readonly ProjectInfo[], assistant: ProjectInfo | null | undefined, branchOf: (projectPath: string, agentId: string) => AgentBranchStatus | null | undefined): Inbox {
  const needYou: InboxItem[] = []
  const toReview: InboxItem[] = []
  const hosts = assistant ? [...projects, assistant] : projects
  for (const p of hosts) {
    const isAssistant = p === assistant
    for (const a of p.agents) {
      const live = a.live
      const branch = a.worktree ? branchOf(p.path, a.id) : null
      const item = (kind: InboxItem['kind']): InboxItem => ({
        projectPath: p.path,
        projectName: isAssistant ? 'Hive Assistant' : p.name,
        agentId: a.id,
        agentName: a.name,
        assistant: isAssistant,
        kind,
        since: live?.statusSince ?? '',
        ...(live?.statusMessage ? { message: live.statusMessage } : {}),
        ...(hasWork(branch) ? { branch } : {})
      })
      if (needsYou(live)) needYou.push(item(live!.status === 'waiting' ? 'waiting' : 'finished'))
      else if (hasWork(branch) && idle(live)) toReview.push(item('review'))
    }
  }
  return { needYou: needYou.sort(byAge), toReview: toReview.sort(byAge) }
}

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/** "3 files, +120 −40 · 2 commits, 1 uncommitted file" */
export function branchSummary(b: AgentBranchStatus): string {
  const parts: string[] = []
  if (b.diff && b.diff.files) parts.push(`${plural(b.diff.files, 'file')}, +${b.diff.insertions.toLocaleString()} −${b.diff.deletions.toLocaleString()}`)
  const counts: string[] = []
  if (b.ahead) counts.push(plural(b.ahead, 'commit'))
  if (b.dirty) counts.push(`${b.dirty.toLocaleString()} uncommitted ${b.dirty === 1 ? 'file' : 'files'}`)
  if (counts.length) parts.push(counts.join(', '))
  return parts.join(' · ')
}

/** "Needs input: <its question>", "Finished", "To review" */
export function inboxStateText(i: InboxItem): string {
  if (i.kind === 'waiting') return i.message ? `Needs input: ${i.message}` : 'Needs input'
  return i.kind === 'finished' ? 'Finished' : 'To review'
}
