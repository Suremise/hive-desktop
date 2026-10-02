import type { SessionStatus } from '../shared/types'
import type { HookEvent } from './providers/types'

/**
 * How a provider's hook (normalised by its adapter) changes an agent's status. Pure, so each transition is
 * unit-tested for every provider; SessionManager.handleHookNow carries out the actions it names.
 */

/** What Hive knows of the agent when the hook arrives. */
export interface HookStatusInput {
  status: SessionStatus
  statusMessage?: string
  /** The CLI asked something at start (a trust question) that a SessionStart or a prompt answers. */
  askedAtStart: boolean
  /** A Compact Hive asked for: not begun yet, under way, or none. */
  compacting: 'requested' | 'started' | null
  /** The CLI starts a new turn by itself when its background tasks end (capabilities.backgroundWakes). */
  backgroundWakes: boolean
  /** Background tasks still counted (for a stop, after reading the transcript). */
  tasks: number
}

export type HookAction =
  /** The question asked at start is answered. */
  | 'answered'
  /** A prompt (the Assistant counts its changes per prompt). */
  | 'prompted'
  /** Hive's Compact began, or ended. */
  | 'compactBegan'
  | 'compactEnded'
  /** The CLI compacts by itself: say so. */
  | 'autoCompact'
  | 'notifyWaiting'
  | 'notifyFinished'
  /** Release the file locks claimed before the hook arrived, or all of them. */
  | 'releaseLocks'
  | 'releaseAllLocks'
  | 'clearTasks'
  /** A turn ended: record it, back up the transcript, and report the state even if the status stays. */
  | 'turnEnded'

export interface HookStep {
  /** The new status, or null to keep it. */
  next: SessionStatus | null
  /** The status message: a string sets it, null clears it, undefined leaves it (a move to working or ready clears it). */
  message?: string | null
  actions: HookAction[]
}

/** The status a turn's end (or an interruption) leaves: background while tasks will start the agent again. */
export function idleAfter(s: Pick<HookStatusInput, 'backgroundWakes' | 'tasks'>, idle: 'finished' | 'ready'): SessionStatus {
  return s.backgroundWakes && s.tasks > 0 ? 'background' : idle
}

export function hookStep(ev: HookEvent, s: HookStatusInput): HookStep {
  switch (ev.kind) {
    case 'start':
      return { next: s.status === 'starting' || s.askedAtStart ? 'ready' : null, actions: ['answered'] }
    case 'prompt':
      return { next: 'working', actions: ['answered', 'prompted'] }
    case 'toolEnd':
      // A tool ran: the user answered a permission prompt, or the agent carries on after a turn's end.
      return { next: s.status === 'waiting' || s.status === 'ready' || s.status === 'finished' || s.status === 'background' ? 'working' : null, actions: [] }
    case 'needsInput': {
      // The same question again (some CLIs report a prompt twice) doesn't notify twice.
      const again = s.status === 'waiting' && s.statusMessage === ev.message
      return { next: 'waiting', message: ev.message, actions: again ? [] : ['notifyWaiting'] }
    }
    case 'stop': {
      const next = idleAfter(s, 'finished')
      // An agent waiting on background tasks isn't done: it is told when they end and carries on.
      const notify = next === 'finished' && s.status !== 'finished'
      return { next, message: null, actions: ['releaseLocks', ...(notify ? (['notifyFinished'] as const) : []), 'turnEnded'] }
    }
    case 'interrupt':
      // Interrupted turns end without Stop: the agent is idle again, and its claims go.
      return { next: idleAfter(s, 'ready'), message: null, actions: ['releaseLocks'] }
    case 'compactStart': {
      const actions: HookAction[] = s.compacting === 'requested' ? ['compactBegan'] : s.compacting ? [] : ['autoCompact']
      return s.status === 'working' ? { next: null, actions } : { next: 'working', message: 'Compacting the conversation…', actions }
    }
    case 'compactEnd':
      if (s.compacting) return { next: null, actions: ['compactEnded'] }
      // Compaction the CLI did by itself while idle (/compact typed in it): idle again.
      return s.status === 'working' && s.statusMessage?.startsWith('Compacting') ? { next: 'ready', message: null, actions: [] } : { next: null, actions: [] }
    case 'end':
      return { next: 'stopped', actions: ['releaseAllLocks', 'clearTasks'] }
    case 'toolStart':
    case 'ignore':
      return { next: null, actions: [] }
  }
}

/** Applies a step's status and message to an agent's state. True when the status changed. */
export function applyStep(st: { status: SessionStatus; statusMessage?: string; unseen?: boolean }, step: HookStep): boolean {
  if (step.message !== undefined) st.statusMessage = step.message ?? undefined
  if (!step.next || step.next === st.status) return false
  st.status = step.next
  if ((step.next === 'working' || step.next === 'ready') && step.message === undefined) st.statusMessage = undefined
  // Unseen until the window shows its pane (the renderer marks it seen, at once when it is on screen).
  if (step.next === 'finished' || step.next === 'waiting') st.unseen = true
  return true
}

/**
 * Drops background tasks past their own expiry (a Monitor's) or the time limit (`minutes`, Settings → Agents &
 * Worktrees: Hive can't tell a test run from a dev server that never ends). Returns the ids the limit dropped.
 */
export function expireTasks(tasks: Map<string, { at: number; expiresAt?: number }>, now: number, minutes: number): string[] {
  const dropped: string[] = []
  for (const [id, t] of tasks) {
    if (t.expiresAt && t.expiresAt <= now) tasks.delete(id)
    else if (now - t.at >= minutes * 60_000) {
      tasks.delete(id)
      dropped.push(id)
    }
  }
  return dropped
}
