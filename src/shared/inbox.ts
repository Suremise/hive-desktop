import type { AgentBranchStatus, LiveSessionState, ProjectInfo } from './types'
import type { StartFailure } from './startFailure'

/**
 * The attention inbox: the agents that need you (waiting for input, with a question pending, finished since you
 * last had their pane on screen, or failed to start), oldest first, and below them worktree agents with work to review (not counted). One list for the status
 * bar's popover, the tray menu, the Projects badge and the project list's counts.
 */
export interface InboxItem {
  projectPath: string
  projectName: string
  agentId: string
  agentName: string
  /** The Hive Assistant's agent: it opens the Assistant's panel. */
  assistant: boolean
  kind: 'waiting' | 'question' | 'finished' | 'failed' | 'review'
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

/**
 * A person is asked something: the agent waits for an answer, or has a question pending beside its work. What the
 * header, inbox, taskbar flash, chime and notifications all go by.
 */
export function asksYou(live: Pick<LiveSessionState, 'status' | 'question'> | null | undefined): boolean {
  return !!live && (live.status === 'waiting' || !!live.question)
}

/** Asked something (seen or not), or finished and not looked at since. */
export function needsYou(live: Pick<LiveSessionState, 'status' | 'unseen' | 'question'> | null | undefined): boolean {
  return asksYou(live) || (!!live && live.status === 'finished' && live.unseen)
}

/** Unmerged commits or uncommitted files on a worktree agent's branch. */
export function hasWork(b: AgentBranchStatus | null | undefined): b is AgentBranchStatus {
  return !!b && (b.ahead > 0 || b.dirty > 0)
}

/** Not doing anything (stopped, ready or finished), so its work can be reviewed. */
const idle = (live: LiveSessionState | null): boolean => !live || live.status === 'ready' || live.status === 'finished' || live.status === 'stopped'

/** Oldest first; unknown times last. */
const byAge = (a: InboxItem, b: InboxItem): number => (a.since || '￿').localeCompare(b.since || '￿')

/** `failureOf`: why an agent's last launch failed to start, where the caller knows (the window does; the tray doesn't). */
export function inbox(
  projects: readonly ProjectInfo[],
  assistant: ProjectInfo | null | undefined,
  branchOf: (projectPath: string, agentId: string) => AgentBranchStatus | null | undefined,
  failureOf?: (projectPath: string, agentId: string) => Pick<StartFailure, 'reason' | 'at'> | undefined
): Inbox {
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
      const failure = live ? undefined : failureOf?.(p.path, a.id)
      if (failure) needYou.push({ ...item('failed'), since: failure.at, message: failure.reason.split('\n')[0] })
      else if (live?.status === 'waiting') needYou.push(item('waiting'))
      else if (live?.question) needYou.push({ ...item('question'), since: live.question.since, ...(live.question.text ? { message: live.question.text } : {}) })
      else if (needsYou(live)) needYou.push(item('finished'))
      else if (hasWork(branch) && idle(live)) toReview.push(item('review'))
    }
  }
  return { needYou: needYou.sort(byAge), toReview: toReview.sort(byAge) }
}

/**
 * Several inboxes' items (one inbox per window) as one list, oldest first across them all, each kept with its owner
 * (the window to show it in), and cut to `limit`: the tray menu. Equal times keep the windows' order.
 */
export function firstAcross<O>(parts: readonly { owner: O; items: readonly InboxItem[] }[], limit: number): { shown: { owner: O; item: InboxItem }[]; total: number } {
  const all = parts.flatMap(({ owner, items }) => items.map((item) => ({ owner, item }))).sort((x, y) => byAge(x.item, y.item))
  return { shown: all.slice(0, limit), total: all.length }
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

/** "Needs input: <its question>", "Asks: <its question>", "Couldn't start: <why>", "Finished", "To review" */
export function inboxStateText(i: InboxItem): string {
  if (i.kind === 'waiting') return i.message ? `Needs input: ${i.message}` : 'Needs input'
  if (i.kind === 'question') return i.message ? `Asks: ${i.message}` : 'Asks you something'
  if (i.kind === 'failed') return i.message ? `Couldn't start: ${i.message}` : "Couldn't start"
  return i.kind === 'finished' ? 'Finished' : 'To review'
}
