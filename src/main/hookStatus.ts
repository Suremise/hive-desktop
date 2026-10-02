import { COMPACTING_MESSAGE, isCompacting } from '../shared/defaults'
import type { SessionStatus } from '../shared/types'
import type { Ask, HookEvent } from './providers/types'

/**
 * How a provider's hook (normalised by its adapter) changes an agent's status. Pure, so each transition is
 * unit-tested for every provider; SessionManager.handleHookNow carries out the actions it names.
 *
 * An agent needs you (waiting, or a pending question beside its work) only while a person is asked: a CLI's
 * hooks don't always say so (Codex reports a permission request before its own reviewer answers it, and a
 * question it doesn't stop for). So for each launch the rules learn it from one source (`attention`):
 * - 'hooks': an ask is put to the user, except a permission request in a reviewed mode (the CLI's reviewer answers).
 * - 'title': the CLI's terminal title says when a person must act (titleStep); its hooks only say what is asked.
 *   The title is one for everything, so it is matched to the asks still open: each from its hook until it is
 *   resolved (its own call ends, the turn ends, the title goes back). The title coming on is about what is open
 *   (the latest prompt is waited on, the latest question shows), else something its hooks didn't say. A permission request in a
 *   reviewed mode is never open: the reviewer decides it (one it can't decide fails, and one handed to you would
 *   still be told, unsaid), so a finished review can't be taken for a later title.
 * The agent waits on one ask (`waitingOn`), which its own call ending answers. Either way you are told once per
 * need: when the agent starts waiting, or a question appears while it isn't.
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
  /** Where Hive learns that a person must act (see above). */
  attention: 'hooks' | 'title'
  /** The mode's permission requests go to the CLI's own reviewer (ModeOption.reviewed). */
  reviewed: boolean
  /** The CLI's title says a person must act now ('title' attention). */
  titleAsks: boolean
  /** Asks its hooks reported that are still open, oldest first, for the title to be about ('title' attention). */
  open: readonly Ask[]
  /** The ask the agent waits on; null when it doesn't, or the title didn't say what. */
  waitingOn: Ask | null
  /** A question is pending (LiveSessionState.question). */
  question: boolean
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
  /** A question the agent doesn't stop for: tell the user, though it keeps working. */
  | 'notifyQuestion'
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
  /** The pending question: a string sets it, null clears it, undefined leaves it. */
  question?: string | null
  /** The open asks from now on; undefined leaves them. */
  open?: Ask[]
  /** The ask the agent waits on from now on; undefined leaves it. */
  waitingOn?: Ask | null
  actions: HookAction[]
}

/** The status message while the CLI's own reviewer considers a permission request. */
export const REVIEWING = 'Auto-review: '

/** At most this many asks are kept open (an agent rarely has more than two). */
const MAX_OPEN = 8

/** Nothing is open or waited on: the turn is over, or the title says nobody is asked. */
const RESOLVED = { open: [] as Ask[], waitingOn: null }

/**
 * A person is asked (`ask` null: the title didn't say what): a blocking ask waits for them; any other is a pending
 * question beside the agent's work. Told once per need. A question that turns out to be what an unsaid wait was
 * about (the title came before its hook) ends that wait without being told again; it doesn't end a wait for a prompt.
 */
function raise(ask: Ask | null, s: HookStatusInput): HookStep {
  const waiting = s.status === 'waiting'
  if (!ask || ask.blocking) return { next: 'waiting', message: ask?.message || null, waitingOn: ask, actions: waiting ? [] : ['notifyWaiting'] }
  const unsaid = waiting && !s.waitingOn
  return { next: unsaid ? 'working' : null, ...(unsaid ? { message: null } : {}), question: ask.message, actions: waiting || s.question ? [] : ['notifyQuestion'] }
}

/** No longer asked: a wait ends (the agent carries on), the question is answered, nothing is open. */
function lower(s: HookStatusInput): HookStep {
  return { next: s.status === 'waiting' ? 'working' : null, ...(s.status === 'waiting' ? { message: null } : {}), question: null, ...RESOLVED, actions: [] }
}

/** A tool started or ended: the reviewer's decision is in, so its message goes. */
const reviewed = (s: HookStatusInput): Partial<HookStep> => (s.statusMessage?.startsWith(REVIEWING) ? { message: null } : {})

/** The same call (Ask.call), when the CLI names calls. */
const sameCall = (a: Ask, call: string | undefined): boolean => !!call && a.call === call

/** How the CLI's title saying a person must act (or no longer) changes the status ('title' attention). */
export function titleStep(asks: boolean, s: HookStatusInput): HookStep {
  if (asks === s.titleAsks) return { next: null, actions: [] }
  if (!asks) return lower(s)
  // About everything open: the latest prompt is waited on, the latest question shows beside it (told with the wait).
  const prompt = s.open.findLast((a) => a.blocking)
  const question = s.open.findLast((a) => !a.blocking)
  const step = raise(prompt ?? question ?? null, s)
  return { ...step, ...(prompt && question ? { question: question.message } : {}), open: s.open.filter((a) => a !== prompt && a !== question) }
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
      // A question's answer comes as a prompt ('title' attention: the title says when it is answered).
      return { next: 'working', ...reviewed(s), ...(s.attention === 'hooks' && s.question ? { question: null } : {}), actions: ['answered', 'prompted'] }
    case 'toolStart':
      return { next: null, ...reviewed(s), actions: [] }
    case 'toolEnd': {
      // A tool ran: the user answered a permission prompt, or the agent carries on after a turn's end. The title is
      // one for everything: while it still asks (a question pending, or the prompt is for another call running
      // beside this one), only the end of the call the wait is about answers it. A call ending resolves its ask,
      // asked or not; a question's call ends at once (it returns before it is answered), so it stays open.
      const answered = s.status === 'waiting' && (s.attention === 'hooks' || !s.titleAsks || (!!s.waitingOn && sameCall(s.waitingOn, ev.call)))
      const open = s.open.filter((a) => !a.blocking || !sameCall(a, ev.call))
      // Another prompt still up (calls side by side, the title still on): the wait moves on to it, already told.
      const still = answered && s.attention === 'title' && s.titleAsks ? open.findLast((a) => a.blocking) : undefined
      if (still) return { next: null, message: still.message || null, waitingOn: still, open: open.filter((a) => a !== still), ...reviewed(s), actions: [] }
      const next = answered || s.status === 'ready' || s.status === 'finished' || s.status === 'background' ? 'working' : null
      return { next, ...(open.length !== s.open.length ? { open } : {}), ...(answered ? { waitingOn: null } : {}), ...reviewed(s), actions: [] }
    }
    case 'ask': {
      // In a reviewed mode a permission request is the CLI's reviewer's: never open, never a person asked.
      if (ev.ask.kind === 'permission' && s.reviewed) return { next: null, ...(s.status === 'waiting' ? {} : { message: `${REVIEWING}${ev.ask.message}` }), actions: [] }
      // Anything else is put to a person: once the title says so, or at once (the hooks say so, or the title
      // already asks, so this is a new need).
      if (s.attention === 'title' && !s.titleAsks) return { next: null, open: [...s.open.filter((a) => !sameCall(a, ev.ask.call)), ev.ask].slice(-MAX_OPEN), actions: [] }
      // A second prompt while one waits: the wait is on the newer one, and the first stays open (its call ending
      // doesn't answer this one). The same prompt reported again changes nothing.
      const first = ev.ask.blocking && s.waitingOn && !sameCall(s.waitingOn, ev.ask.call) ? s.waitingOn : null
      return { ...raise(ev.ask, s), ...(first ? { open: [...s.open, first].slice(-MAX_OPEN) } : {}) }
    }
    case 'stop': {
      const next = idleAfter(s, 'finished')
      // An agent waiting on background tasks isn't done: it is told when they end and carries on.
      const notify = next === 'finished' && s.status !== 'finished'
      return { next, message: null, ...RESOLVED, actions: ['releaseLocks', ...(notify ? (['notifyFinished'] as const) : []), 'turnEnded'] }
    }
    case 'interrupt':
      // Interrupted turns end without Stop: the agent is idle again, and its claims go.
      return { next: idleAfter(s, 'ready'), message: null, ...RESOLVED, actions: ['releaseLocks'] }
    case 'compactStart': {
      const actions: HookAction[] = s.compacting === 'requested' ? ['compactBegan'] : s.compacting ? [] : ['autoCompact']
      return s.status === 'working' ? { next: null, actions } : { next: 'working', message: COMPACTING_MESSAGE, actions }
    }
    case 'compactEnd':
      if (s.compacting) return { next: null, actions: ['compactEnded'] }
      // Compaction the CLI did by itself while idle (/compact typed in it): idle again.
      return isCompacting(s) ? { next: 'ready', message: null, actions: [] } : { next: null, actions: [] }
    case 'end':
      return { next: 'stopped', question: null, ...RESOLVED, actions: ['releaseAllLocks', 'clearTasks'] }
    case 'ignore':
      return { next: null, actions: [] }
  }
}

/** Applies a step's status, message and question to an agent's state. True when any of them changed (the state needs sending). */
export function applyStep(st: { status: SessionStatus; statusMessage?: string; unseen?: boolean; question?: { text: string; since: string } }, step: HookStep, now = new Date().toISOString()): boolean {
  let changed = false
  if (step.message !== undefined && (step.message ?? undefined) !== st.statusMessage) {
    st.statusMessage = step.message ?? undefined
    changed = true
  }
  if (step.question !== undefined && step.question !== (st.question?.text ?? null)) {
    st.question = step.question === null ? undefined : { text: step.question, since: now }
    changed = true
  }
  if (!step.next || step.next === st.status) return changed
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
