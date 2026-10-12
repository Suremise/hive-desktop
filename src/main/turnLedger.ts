import type { HookEvent, HookIds } from './providers/types'

/**
 * The turn ledger (#648): which of a launch's CLI turns runs and which are over, by the CLI's own turn ids, so a hook
 * about a turn that is over can't make the agent working again (a PostToolUse that reaches Hive after the turn's Stop:
 * one way #642's Codex agent could have stayed "working"), and so Hive can tell a missing turn end from a busy agent.
 * Pure, so each rule is unit-tested; SessionManager keeps one per launch and puts each hook through `admit` before the
 * status rules (hookStatus).
 *
 * - A prompt begins a turn, except one in the turn that runs (the same turn id): a prompt the CLI takes mid-turn. One Hive
 *   put there itself (`expectInjected`, a message delivered into the running turn) isn't a new prompt at all.
 * - A tool starting in a turn that is over carries that turn on (another Stop hook of the user's made the CLI go on), and
 *   one in a turn Hive never saw begin starts it (a turn the CLI began by itself): the agent works again. A sub-agent's
 *   tools don't carry its parent's finished turn on (a background agent working on).
 * - A tool ending in a turn that is over is late news of that turn: it changes nothing (stale). Without turn ids
 *   (Copilot), the same holds for a tool end after the turn's end with no tool start since: a call can't end unstarted.
 * - A Stop ends its turn, unless Hive's own reply carried it on (`hiveContinued`: continuations fire no prompt, so only
 *   the Stop Hive answered with nothing ends it), or it is an earlier turn's while a later one runs.
 * - An interrupt, a refused sign-in or the CLI saying it is idle at its prompt ends the turn that runs.
 *
 * A timer never ends a turn: silence (`silentFor`) only makes Hive look for the CLI's own record of the turn's end
 * (`reconciles`) or its idle prompt on screen, and failing those, say the state is unknown.
 */

export type TurnState = 'running' | 'over'

export interface Turn {
  /** The CLI's id for it; null when its hooks name none (Copilot): Hive then knows only the latest turn. */
  id: string | null
  state: TurnState
  /** Its tool calls started and not ended: their ids, or a count of those without one. */
  calls: Set<string>
  unnamedCalls: number
  /** Stops of it that Hive answered with a continuation. */
  continued: number
  /** How it ended (for the log): 'stop', 'interrupt', 'idle', 'transcript', 'screen', 'user'… */
  endedBy?: string
}

export interface TurnLedger {
  active: Turn | null
  /** Ids of turns that are over, newest last (at most MAX_OVER), besides the active one. */
  over: string[]
  /** Hooks received for the launch, in order (the receive sequence the log gives each). */
  seq: number
  /** When Hive last heard from the CLI (a hook, the transcript growing), ms. */
  heard: number
  /** Prompts Hive put into the running turn itself and hasn't seen yet (their text, flattened). */
  injected: string[]
}

export type Admitted =
  /** The hook goes to the status rules (as `event`, which may say more than the adapter's: resumes, injected). */
  | { verdict: 'apply'; event: HookEvent; note?: string }
  /** Old news of a turn that is over, or of another turn: the status rules don't see it. */
  | { verdict: 'stale'; why: string }
  /** A Stop Hive answered with a continuation: the turn goes on. */
  | { verdict: 'continued' }

/** At most this many ended turns are remembered (a late hook comes seconds after its turn, not dozens of turns). */
const MAX_OVER = 32
/** At most this many injected prompts are waited for. */
const MAX_INJECTED = 8

export function newLedger(now = Date.now()): TurnLedger {
  return { active: null, over: [], seq: 0, heard: now, injected: [] }
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Hive puts `text` into the running turn itself (Messaging 5): its prompt hook isn't a new prompt. */
export function expectInjected(ledger: TurnLedger, text: string): void {
  ledger.injected.push(flat(text))
  if (ledger.injected.length > MAX_INJECTED) ledger.injected.shift()
}

/** Whether turn `id` is over: the active one ended, or an earlier one. */
function isOver(ledger: TurnLedger, id: string): boolean {
  return (ledger.active?.id === id && ledger.active.state === 'over') || ledger.over.includes(id)
}

/** The active turn is over now (`by`: how, for the log). */
function end(ledger: TurnLedger, by: string): void {
  const a = ledger.active
  if (!a || a.state === 'over') return
  a.state = 'over'
  a.endedBy = by
  a.calls.clear()
  a.unnamedCalls = 0
}

/** A turn begins: the one before is remembered as over. */
function begin(ledger: TurnLedger, id: string | null): Turn {
  const a = ledger.active
  if (a?.id) {
    ledger.over = ledger.over.filter((x) => x !== a.id)
    ledger.over.push(a.id)
    if (ledger.over.length > MAX_OVER) ledger.over.shift()
  }
  if (id) ledger.over = ledger.over.filter((x) => x !== id)
  ledger.active = { id, state: 'running', calls: new Set(), unnamedCalls: 0, continued: 0 }
  return ledger.active
}

/** A turn that was over goes on (its id taken off the list of ended ones). */
function reopen(ledger: TurnLedger, id: string | null): void {
  if (ledger.active && ledger.active.id === id) {
    ledger.active.state = 'running'
    ledger.active.endedBy = undefined
  } else begin(ledger, id)
}

function addCall(t: Turn, call: string | null): void {
  if (call) t.calls.add(call)
  else t.unnamedCalls++
}

function endCall(t: Turn, call: string | null): void {
  if (call && t.calls.delete(call)) return
  if (t.unnamedCalls > 0) t.unnamedCalls--
}

/**
 * Takes a hook in: what the status rules should make of it. `hiveContinued`: Hive answered this Stop with a
 * continuation. Counts it (seq) and that the CLI was heard.
 */
export function admit(ledger: TurnLedger, ev: HookEvent, ids: HookIds, opts: { hiveContinued?: boolean; now?: number } = {}): Admitted {
  ledger.seq++
  ledger.heard = opts.now ?? Date.now()
  const a = ledger.active
  const running = a?.state === 'running'
  const turn = ids.turn
  switch (ev.kind) {
    case 'prompt': {
      if (turn && running && a.id === turn) {
        const i = ev.text ? ledger.injected.indexOf(flat(ev.text)) : -1
        if (i < 0) return { verdict: 'apply', event: ev, note: 'a prompt in the running turn' }
        ledger.injected.splice(i, 1)
        return { verdict: 'apply', event: { ...ev, injected: true }, note: "Hive's own message in the running turn" }
      }
      begin(ledger, turn)
      return { verdict: 'apply', event: ev }
    }
    case 'toolStart': {
      if (ids.sub) {
        // A sub-agent works inside its parent's turn: news of that turn while it runs; after it, a background agent's.
        if (!running || (turn && a.id !== turn)) return { verdict: 'stale', why: "a sub-agent's tool outside the running turn" }
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (turn) {
        if (running && a.id === turn) {
          addCall(a, ids.call)
          return { verdict: 'apply', event: ev }
        }
        const resumed = isOver(ledger, turn)
        reopen(ledger, turn)
        addCall(ledger.active!, ids.call)
        return { verdict: 'apply', event: { ...ev, resumes: true }, note: resumed ? 'its turn goes on after it ended' : 'a turn Hive saw no prompt for' }
      }
      if (running) {
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      // No ids and no turn known yet: nothing to carry on, so as before the ledger (a tool start alone changes nothing).
      if (!a) return { verdict: 'apply', event: ev }
      reopen(ledger, a.id)
      addCall(ledger.active!, ids.call)
      return { verdict: 'apply', event: { ...ev, resumes: true }, note: 'its turn goes on after it ended' }
    }
    case 'toolEnd': {
      if (turn) {
        if (running && a.id === turn) {
          endCall(a, ids.call)
          return { verdict: 'apply', event: ev }
        }
        if (isOver(ledger, turn)) return { verdict: 'stale', why: 'a tool end of a turn that is over' }
        if (ids.sub) return { verdict: 'stale', why: "a sub-agent's tool end outside the running turn" }
        // A turn Hive saw nothing of until now (the CLI began it by itself, its tool start lost).
        begin(ledger, turn)
        return { verdict: 'apply', event: ev, note: 'a turn Hive saw no prompt for' }
      }
      if (running) {
        endCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (a) return { verdict: 'stale', why: 'a tool end after its turn ended, with no tool start since' }
      return { verdict: 'apply', event: ev }
    }
    case 'stop': {
      if (ids.sub) return { verdict: 'stale', why: "a sub-agent's Stop" }
      if (turn && running && a.id && a.id !== turn) return { verdict: 'stale', why: "an earlier turn's Stop while a later one runs" }
      if (opts.hiveContinued) {
        if (!running || (turn && a.id !== turn)) reopen(ledger, turn ?? a?.id ?? null)
        ledger.active!.continued++
        return { verdict: 'continued' }
      }
      if (turn && a?.id !== turn) begin(ledger, turn)
      else if (!a) begin(ledger, null)
      end(ledger, 'stop')
      return { verdict: 'apply', event: ev }
    }
    case 'interrupt':
    case 'signIn':
    case 'idle':
      end(ledger, ev.kind)
      return { verdict: 'apply', event: ev }
    case 'end':
      end(ledger, 'end')
      return { verdict: 'apply', event: ev }
    default:
      return { verdict: 'apply', event: ev }
  }
}

/** The CLI was heard from outside its hooks (its transcript grew). */
export function heard(ledger: TurnLedger, now = Date.now()): void {
  ledger.heard = now
}

/** How long the running turn has been silent (ms): no hook, no transcript growth and no tool call under way; null when none runs or a tool does. */
export function silentFor(ledger: TurnLedger, now = Date.now()): number | null {
  const a = ledger.active
  if (!a || a.state !== 'running' || a.calls.size || a.unnamedCalls) return null
  return now - ledger.heard
}

/**
 * Whether the CLI's own record that turn `turn` is over (null: its records don't name turns as its hooks do) is about
 * the turn Hive has running. With both ids, by the id. Otherwise it can't be told which turn the record means: only when
 * no hook has come since it was read (`noHookSince`: a newer turn's prompt would have), and not once Hive has carried the
 * running turn on itself (the record may be of the Stop it answered).
 */
export function reconciles(ledger: TurnLedger, turn: string | null, noHookSince: boolean): boolean {
  const a = ledger.active
  if (!a || a.state !== 'running') return false
  if (turn !== null && a.id !== null) return a.id === turn
  return noHookSince && a.continued === 0
}

/** Ends the running turn on other evidence than a hook (`by`: the CLI's records, its screen, the user). */
export function endRunning(ledger: TurnLedger, by: string): void {
  end(ledger, by)
}

/** The running turn's id and calls, for the log. */
export function describe(ledger: TurnLedger): string {
  const a = ledger.active
  if (!a) return 'no turn'
  const calls = a.calls.size + a.unnamedCalls
  return `turn ${a.id ?? '?'} ${a.state === 'running' ? 'running' : `over (${a.endedBy ?? '?'})`}${calls ? `, ${calls} call${calls === 1 ? '' : 's'} open` : ''}`
}
