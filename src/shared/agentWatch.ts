/**
 * Waiting on agents (#416): an agent watch (hive_wait_for_agents with wake) follows agents, not cards, through the same
 * watches as card watches (main/watches.ts). It fires when a watched agent's turn ends, it waits for the user, or it
 * stops; its line names every agent that did. Pure, so the watches, the Agent API and tests share it.
 */
import type { SessionStatus } from './types'
import { WAKE_MAX_BYTES } from './watch'

/** An agent a watch follows: where it is, and its name and project's for the line (as they were when the watch began). */
export interface WatchedAgent {
  projectPath: string
  agentId: string
  name: string
  project: string
}

/** What an agent watch waits for: its agents, and whether background tasks the agent started still count as working. */
export interface AgentWatchCondition {
  agents: WatchedAgent[]
  /** True: the end of its turn is enough, also with background tasks still running (hive_wait_for_agents' ignoreBackground). */
  ignoreBackground: boolean
}

/** At most this many agents in one watch (a project has at most 12; the Assistant can watch several projects'). */
export const AGENT_WATCH_MAX_AGENTS = 20

/** An agent as a watch reads it now (null runId: not running). */
export interface AgentNow {
  status: SessionStatus
  runId: string | null
  /** Prompts its CLI has taken in this launch. */
  prompts: number
  /** Hive typed a prompt into it that its CLI hasn't taken yet (just given a task): it counts as working. */
  pending: boolean
  statusMessage?: string | null
  backgroundTasks?: number
  /** The start of its latest reply (its last turn's end). */
  reply?: string | null
  /** A watching agent's own watch ("Waiting for #12 → Review"). */
  watch?: string | null
}

/**
 * An agent as the watch began: what "it didn't take the prompt" is measured from, and `seq`, the latest of its events
 * (main/watches.ts) the watcher already knows: one after it is news.
 */
export interface AgentMark {
  runId: string | null
  prompts: number
  pending: boolean
  seq: number
}

export const agentMarkOf = (now: AgentNow, seq: number): AgentMark => ({ runId: now.runId, prompts: now.prompts, pending: now.pending, seq })

/** What happened to a watched agent: its turn ended, it waits for the user, it stopped, or it is in error. */
export type AgentEvent = 'finished' | 'untaken' | 'waiting' | 'stopped' | 'error'

/** Whether an agent counts as working: a watch waits on it (as hive_wait_for_agents does without wake). */
export function agentBusy(now: AgentNow, ignoreBackground: boolean): boolean {
  return now.pending || now.status === 'working' || now.status === 'starting' || (now.status === 'background' && !ignoreBackground)
}

/** What an agent no longer working did (null: still working). */
export function agentEvent(now: AgentNow, mark: AgentMark | undefined, ignoreBackground: boolean): AgentEvent | null {
  if (agentBusy(now, ignoreBackground)) return null
  switch (now.status) {
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
    case 'waiting':
    case 'signin':
      return 'waiting'
    default:
      // Idle without having taken the prompt it was typed when the watch began (its CLI dropped it).
      return mark?.pending && mark.runId === now.runId && now.prompts <= mark.prompts ? 'untaken' : 'finished'
  }
}

/** A saved condition, checked (null: not one Hive would have made). */
export function readSavedAgentCondition(v: unknown): AgentWatchCondition | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!Array.isArray(r.agents) || !r.agents.length || r.agents.length > AGENT_WATCH_MAX_AGENTS || typeof r.ignoreBackground !== 'boolean') return null
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max
  const agents: WatchedAgent[] = []
  for (const a of r.agents as Record<string, unknown>[]) {
    if (!a || typeof a !== 'object' || !text(a.projectPath, 1024) || !text(a.agentId, 128) || !text(a.name, 300) || !text(a.project, 300)) return null
    if (agents.some((x) => x.projectPath.toLowerCase() === (a.projectPath as string).toLowerCase() && x.agentId === a.agentId)) return null
    agents.push({ projectPath: a.projectPath, agentId: a.agentId, name: a.name, project: a.project })
  }
  return { agents, ignoreBackground: r.ignoreBackground }
}

export function readSavedAgentMark(v: unknown): AgentMark | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0
  if (!(m.runId === null || (typeof m.runId === 'string' && m.runId.length <= 128)) || !count(m.prompts) || typeof m.pending !== 'boolean' || !count(m.seq)) return null
  return { runId: m.runId, prompts: m.prompts, pending: m.pending, seq: m.seq }
}

const names = (agents: Pick<WatchedAgent, 'name'>[]): string => agents.map((a) => a.name).join(', ')

/** What a watching agent shows: "Waiting for B6 to finish". */
export const agentWatchLabel = (cond: AgentWatchCondition): string => `Waiting for ${names(cond.agents)} to finish`

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clipChars = (text: string, max: number): string => {
  const chars = [...oneLine(text)]
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : chars.join('')
}
const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length

/**
 * One agent and what it did, its latest reply (or what it asks) cut to `max` characters (0: left out). `already`: its
 * state now, for an answer at once; `again`: it did so, and is working again since.
 */
export function agentPart(a: Pick<WatchedAgent, 'name' | 'project'>, ev: AgentEvent, now: AgentNow, max = 200, already = false, again = false): string {
  return again ? `${partOf(a, ev, now, max, already)} (working again now)` : partOf(a, ev, now, max, already)
}

function partOf(a: Pick<WatchedAgent, 'name' | 'project'>, ev: AgentEvent, now: AgentNow, max: number, already: boolean): string {
  const who = `${a.name} (${a.project})`
  const quote = (t: string | null | undefined): string => (t && max > 0 ? `: "${clipChars(t, max)}"` : '')
  switch (ev) {
    case 'stopped':
      return `${who} ${already ? 'is stopped' : 'stopped'}`
    case 'error':
      return `${who} is in error${quote(now.statusMessage)}`
    case 'waiting':
      return now.status === 'signin' ? `${who} is waiting for the user to sign in to its CLI again` : `${who} is waiting for the user${quote(now.statusMessage)}`
    case 'untaken':
      return `${who} is idle: its CLI hasn't taken the prompt it was typed`
    case 'finished': {
      const n = now.backgroundTasks ?? 0
      const also = now.watch ? ` (${now.watch.replace(/^Waiting/, 'now waiting')})` : n ? ` (${n} background task${n === 1 ? '' : 's'} still running)` : ''
      return `${who} ${already ? 'is idle' : 'finished'}${also}${quote(now.reply)}`
    }
  }
}

/**
 * The one line Hive types to wake a watcher (#416): each agent that changed and what it did, with the start of its
 * latest reply, then what to do. One line within WAKE_MAX_BYTES: replies give way first, then they are left out.
 */
export function agentWakeLine(changes: { agent: WatchedAgent; event: AgentEvent; now: AgentNow; again?: boolean }[]): string {
  const tail = '. Your agent watch has ended: carry on (hive_agent_activity for more).'
  const full = (max: number): string => `[Hive] ${changes.map((c) => agentPart(c.agent, c.event, c.now, max, false, c.again)).join('; ')}${tail}`
  for (const max of [300, 160, 80, 40, 0]) if (jsonBytes(full(max)) <= WAKE_MAX_BYTES) return full(max)
  const short = `[Hive] ${names(changes.map((c) => c.agent))} changed${tail}`
  return jsonBytes(short) <= WAKE_MAX_BYTES ? short : `[Hive] ${changes.length} watched agents changed${tail}`
}

/** The line Hive types when an agent watch's limit passes with every agent still working. */
export function agentLimitLine(cond: AgentWatchCondition, minutes: number): string {
  const one = cond.agents.length === 1
  const dur = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`
  return `[Hive] ${names(cond.agents)} ${one ? 'is' : 'are'} still working after ${dur}: your agent watch has ended. Check on ${one ? 'it' : 'them'} (hive_agent_activity) and watch again, or tell the user (hive_notify) if ${one ? 'it seems' : 'one seems'} stuck.`
}
