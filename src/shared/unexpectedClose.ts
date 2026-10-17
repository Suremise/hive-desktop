/**
 * Hive closing unexpectedly (#984): while Hive runs, its profile holds a marker (running.json) saying when it started,
 * when it was last seen (a heartbeat) and which agents were running. A normal quit, an update, a restart or Windows
 * ending the session removes it; one still there at the next start is a run that ended some other way (killed, a crash,
 * the power). The pure part: the marker's shape and reading it back.
 */
import { formatDate, formatTime } from './dates'
import { fmt, msg, tr } from './i18n'
import type { ProviderId } from './types'

/** An agent running when the marker was last written. */
export interface RunningAgent {
  workspace: string
  projectPath: string
  project: string
  agentId: string
  agentName: string
  provider: ProviderId
  /** The conversation it was in: what Resume would open (empty when its CLI hadn't said yet). */
  sessionId: string
  sessionName?: string
}

export interface RunMarker {
  version: 1
  pid: number
  /** When that Hive started, and when it last wrote the marker (ISO). */
  startedAt: string
  lastSeen: string
  hive: string
  /** The workspaces it had open. */
  workspaces: string[]
  agents: RunningAgent[]
}

/** The marker's file name, in Hive's profile. */
export const RUN_MARKER = 'running.json'

/** How often a running Hive says it is still there. */
export const HEARTBEAT_MS = 60_000

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max

/** A marker's text read back; null when it isn't one (damaged, or written by something else). Bad agent rows are left out. */
export function parseRunMarker(text: string): RunMarker | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.version !== 1 || !str(d.startedAt, 40) || !str(d.lastSeen, 40) || Number.isNaN(Date.parse(d.lastSeen))) return null
  const agents: RunningAgent[] = []
  for (const a of Array.isArray(d.agents) ? d.agents.slice(0, 500) : []) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    if (!str(r.workspace) || !str(r.projectPath) || !r.projectPath || !str(r.project, 300) || !str(r.agentId, 200) || !r.agentId || !str(r.agentName, 300) || !str(r.provider, 40) || !str(r.sessionId, 300)) continue
    agents.push({ workspace: r.workspace, projectPath: r.projectPath, project: r.project, agentId: r.agentId, agentName: r.agentName, provider: r.provider as ProviderId, sessionId: r.sessionId, ...(str(r.sessionName, 300) && r.sessionName ? { sessionName: r.sessionName } : {}) })
  }
  const workspaces = Array.isArray(d.workspaces) ? d.workspaces.filter((w): w is string => str(w) && !!w).slice(0, 50) : []
  return { version: 1, pid: Number(d.pid) || 0, startedAt: d.startedAt, lastSeen: d.lastSeen, hive: str(d.hive, 40) ? d.hive : '', workspaces, agents }
}

/** The projects the agents were running in, by name, each once, in the order first met. */
export function projectsOf(agents: readonly RunningAgent[]): string[] {
  const seen = new Map<string, string>()
  for (const a of agents) if (!seen.has(a.projectPath.toLowerCase())) seen.set(a.projectPath.toLowerCase(), a.project)
  return [...seen.values()]
}

/** A merge an agent held the merge slot for when Hive closed (#984: told in the same notice). */
export interface LeftMerge {
  agentName: string
  branch: string
  cards: number[]
  /** The folder the merge was in: the agent's worktree, or the project's main checkout. */
  folder: string
}

/** What resuming the agents that were running came to: the names resumed, and those that failed with why. */
export interface ResumeReport {
  resumed: string[]
  failed: { name: string; error: string }[]
}

/** The agents that couldn't resume, with why. */
export const resumeFailedLine = (r: ResumeReport): string =>
  tr(msg({ id: 'main.unexpectedClose.failed', defaultMessage: "{n, plural, one {One couldn't resume: {agents}.} other {# couldn't resume: {agents}.}}", description: 'In the notice that Hive closed unexpectedly, or the report of resuming its agents: the agents that failed to resume ({agents}: their names with why).' }), { n: r.failed.length, agents: fmt.list(r.failed.map((f) => `${f.name} (${f.error})`)) })

/** The notice's text: when, what was running, what became of it, a crash dump, merges left half done. */
export function unexpectedCloseText(c: { lastSeen: string; agents: readonly RunningAgent[]; dump: boolean; merges: readonly LeftMerge[] }, r: ResumeReport | null): string {
  const lines = [tr(msg({ id: 'main.unexpectedClose.when', defaultMessage: 'Hive was last seen on {date} at {time}.', description: 'The notice at start that the last run of Hive ended without quitting (its title says so): when that run was last seen running ({date}, {time}).' }), { date: formatDate(c.lastSeen), time: formatTime(c.lastSeen) })]
  lines.push(tr(msg({ id: 'main.unexpectedClose.agents', defaultMessage: '{n, plural, =0 {No agents were running.} one {One agent was running in {projects}.} other {# agents were running in {projects}.}}', description: 'The notice that Hive closed unexpectedly: how many agents were running ({n}) and in which projects ({projects}: their names, listed).' }), { n: c.agents.length, projects: fmt.list(projectsOf(c.agents)) }))
  if (r) {
    lines.push(tr(msg({ id: 'main.unexpectedClose.resumed', defaultMessage: '{n, plural, =0 {None was resumed.} one {One was resumed, as Settings → Sessions says.} other {# were resumed, as Settings → Sessions says.}}', description: 'The notice that Hive closed unexpectedly, with "Resume agents after an unexpected close" on: how many of the agents Hive resumed ({n}).' }), { n: r.resumed.length }))
    if (r.failed.length) lines.push(resumeFailedLine(r))
  } else if (c.agents.length) lines.push(tr(msg({ id: 'main.unexpectedClose.notResumed', defaultMessage: 'Nothing was resumed.', description: 'The notice that Hive closed unexpectedly: Hive did not resume the agents that were running (the user chooses).' })))
  if (c.dump) lines.push(tr(msg({ id: 'main.unexpectedClose.dump', defaultMessage: 'Hive kept a crash dump of it: Help → Copy Diagnostics names it.', description: 'The notice that Hive closed unexpectedly: a crash dump of that run was saved on this PC.' })))
  for (const m of c.merges) {
    const cards = fmt.list(m.cards.map((n) => `#${n}`))
    lines.push(
      m.cards.length
        ? tr(msg({ id: 'main.unexpectedClose.mergeCards', defaultMessage: '{agent} was merging {branch} ({cards}): check {folder} for a merge left half done (git status there) before the next merge.', description: 'The notice that Hive closed unexpectedly: an agent ({agent}) held the merge slot for a branch ({branch}) for cards ({cards}); {folder} is where the merge was (its worktree or the main checkout).' }), { agent: m.agentName, branch: m.branch, cards, folder: m.folder })
        : tr(msg({ id: 'main.unexpectedClose.merge', defaultMessage: '{agent} was merging {branch}: check {folder} for a merge left half done (git status there) before the next merge.', description: 'The notice that Hive closed unexpectedly: an agent ({agent}) held the merge slot for a branch ({branch}); {folder} is where the merge was (its worktree or the main checkout).' }), { agent: m.agentName, branch: m.branch, folder: m.folder })
    )
  }
  return lines.join(' ')
}
