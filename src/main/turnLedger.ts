import type { HookEvent, HookIds } from './providers/types'

/**
 * The turn ledger (#648): which of a launch's CLI turns runs and which are over, by the CLI's own turn ids, so a hook
 * about a turn that is over can't make the agent working again (a PostToolUse that reaches Hive after the turn's Stop:
 * one way #642's Codex agent could have stayed "working"), and so Hive can tell a missing turn end from a busy agent.
 * Pure, so each rule is unit-tested; SessionManager keeps one per launch and puts each hook through `admit` before the
 * status rules (hookStatus).
 *
 * Every turn id the launch has seen is remembered (`seen`), so news of any earlier turn is told apart from a new turn.
 * - A prompt begins a turn, except one in the turn that runs (the same turn id): a prompt the CLI takes mid-turn. One Hive
 *   put there itself (`expectInjected`, a message delivered into the running turn) isn't a new prompt at all. A prompt,
 *   a question or any other news naming a turn that is over is stale.
 * - A tool starting under a turn id never seen starts that turn (a turn the CLI began by itself): the agent works again.
 *   One under the latest turn, after its Stop, carries it on only with positive evidence that it goes on: the CLI's
 *   screen shows it working (`screen`, version-tested). Without it (a delayed hook, a CLI whose screen isn't read) it is
 *   stale. Never an earlier turn: a newer one is never replaced by an older. A sub-agent's tools are news of the running
 *   turn only.
 * - A tool ending in a turn that is over, or one never seen, is late news: stale. Without turn ids (Copilot), a tool end
 *   after the turn's end with no tool start since is too: a call can't end unstarted.
 * - A Stop ends its turn, unless Hive's own reply carried it on (`hiveContinued`: continuations fire no prompt, so only
 *   the Stop Hive answered with nothing ends it), or it is an earlier turn's.
 * - An interrupt, a refused sign-in or the CLI saying it is idle at its prompt ends the turn that runs.
 *
 * A timer never ends a turn: silence (`silentFor`) only makes Hive look for the CLI's own record of the turn's end
 * (`reconciles` by id, `unheardStop` by its Stops' times) or read its screen, and failing those, say the state is unknown.
 */

export type TurnState = 'running' | 'over'

export interface Turn {
  /** The CLI's id for it; null when its hooks name none (Copilot): Hive then knows only the latest turn. */
  id: string | null
  state: TurnState
  /** When Hive took it as begun (ms): records from before it are of earlier turns. */
  startedAt: number
  /** Its tool calls started and not ended: their ids, or a count of those without one. */
  calls: Set<string>
  unnamedCalls: number
  /** Stops of it Hive received (each one Hive answered with a continuation, and the one that ended it). */
  stops: number
  /** Stops of it that Hive answered with a continuation. */
  continued: number
  /** How it ended (for the log): 'stop', 'interrupt', 'idle', 'transcript', 'screen', 'user'… */
  endedBy?: string
}

export interface TurnLedger {
  active: Turn | null
  /** Every turn id the launch has seen, in order (at most MAX_SEEN, far more than a launch has turns). */
  seen: Set<string>
  /** Hooks received for the launch, in order (the receive sequence the log gives each). */
  seq: number
  /** When Hive last heard from the CLI (a hook, the transcript growing, its screen showing it at work), ms. */
  heard: number
  /** Prompts Hive put into the running turn itself and hasn't seen yet (their text, flattened). */
  injected: string[]
}

/** What the CLI's screen shows of its turn, read when a hook needs it (ProviderAdapter.turnScreen): null when not sure. */
export type ScreenReading = 'idle' | 'working' | null

export type Admitted =
  /** The hook goes to the status rules (as `event`, which may say more than the adapter's: resumes, injected). */
  | { verdict: 'apply'; event: HookEvent; note?: string }
  /** Old news of a turn that is over, or of another turn: the status rules don't see it. */
  | { verdict: 'stale'; why: string }
  /** A Stop Hive answered with a continuation: the turn goes on. */
  | { verdict: 'continued' }

/** At most this many turn ids are remembered: a launch with more is far beyond any seen. */
const MAX_SEEN = 10_000
/** At most this many injected prompts are waited for. */
const MAX_INJECTED = 8

export function newLedger(now = Date.now()): TurnLedger {
  return { active: null, seen: new Set(), seq: 0, heard: now, injected: [] }
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Hive puts `text` into the running turn itself (Messaging 5): its prompt hook isn't a new prompt. */
export function expectInjected(ledger: TurnLedger, text: string): void {
  ledger.injected.push(flat(text))
  if (ledger.injected.length > MAX_INJECTED) ledger.injected.shift()
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

/** A turn begins (`id` never seen before, or none). */
function begin(ledger: TurnLedger, id: string | null, now: number): Turn {
  if (id) {
    ledger.seen.add(id)
    if (ledger.seen.size > MAX_SEEN) ledger.seen.delete(ledger.seen.values().next().value!)
  }
  ledger.active = { id, state: 'running', startedAt: now, calls: new Set(), unnamedCalls: 0, stops: 0, continued: 0 }
  return ledger.active
}

/** The latest turn, over, goes on. */
function reopen(t: Turn): void {
  t.state = 'running'
  t.endedBy = undefined
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
 * continuation. `screen`: reads the CLI's screen, for a tool start after the turn's Stop. Counts it (seq) and that the
 * CLI was heard.
 */
export function admit(ledger: TurnLedger, ev: HookEvent, ids: HookIds, opts: { hiveContinued?: boolean; screen?: () => ScreenReading; now?: number } = {}): Admitted {
  const now = opts.now ?? Date.now()
  ledger.seq++
  ledger.heard = now
  const a = ledger.active
  const running = a?.state === 'running'
  const turn = ids.turn
  // This hook names the turn Hive has as latest, one never seen, or an earlier one (stale whatever it says).
  const latest = !!turn && a?.id === turn
  const earlier = !!turn && !latest && ledger.seen.has(turn)
  /** Positive evidence that the latest turn, over, goes on: the CLI's screen shows it working. */
  const goesOn = (): boolean => opts.screen?.() === 'working'
  switch (ev.kind) {
    case 'prompt': {
      if (latest && running) {
        const i = ev.text ? ledger.injected.indexOf(flat(ev.text)) : -1
        if (i < 0) return { verdict: 'apply', event: ev, note: 'a prompt in the running turn' }
        ledger.injected.splice(i, 1)
        return { verdict: 'apply', event: { ...ev, injected: true }, note: "Hive's own message in the running turn" }
      }
      if (latest || earlier) return { verdict: 'stale', why: 'a prompt of a turn that is over' }
      begin(ledger, turn, now)
      return { verdict: 'apply', event: ev }
    }
    case 'toolStart': {
      if (ids.sub) {
        // A sub-agent works inside its parent's turn: news of that turn while it runs; after it, a background agent's.
        if (!running || (turn && !latest)) return { verdict: 'stale', why: "a sub-agent's tool outside the running turn" }
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (earlier) return { verdict: 'stale', why: 'a tool start of an earlier turn' }
      if (turn && !latest) {
        // A turn id never seen: a turn the CLI began by itself.
        addCall(begin(ledger, turn, now), ids.call)
        return { verdict: 'apply', event: { ...ev, resumes: true }, note: 'a turn Hive saw no prompt for' }
      }
      if (running) {
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      // No ids and no turn known yet: nothing to carry on (a tool start alone changes nothing, as before the ledger).
      if (!a) return { verdict: 'apply', event: ev }
      // The latest turn, over: it goes on only if its screen shows it working (another Stop hook carried it on).
      if (!goesOn()) return { verdict: 'stale', why: 'a tool start after its turn ended, with nothing showing it goes on' }
      reopen(a)
      addCall(a, ids.call)
      return { verdict: 'apply', event: { ...ev, resumes: true }, note: 'its turn goes on after it ended: its screen shows it working' }
    }
    case 'toolEnd': {
      if (turn) {
        if (latest && running) {
          endCall(a, ids.call)
          return { verdict: 'apply', event: ev }
        }
        return { verdict: 'stale', why: latest || earlier ? 'a tool end of a turn that is over' : 'a tool end of a turn Hive never saw begin' }
      }
      if (running) {
        endCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (a) return { verdict: 'stale', why: 'a tool end after its turn ended, with no tool start since' }
      return { verdict: 'apply', event: ev }
    }
    case 'ask':
      if (earlier || (latest && !running)) return { verdict: 'stale', why: 'a question of a turn that is over' }
      return { verdict: 'apply', event: ev }
    case 'stop': {
      if (ids.sub) return { verdict: 'stale', why: "a sub-agent's Stop" }
      if (earlier) return { verdict: 'stale', why: "an earlier turn's Stop" }
      if (turn && !latest && running) return { verdict: 'stale', why: "another turn's Stop while one runs" }
      // A turn never seen that ended at once (begun by the CLI, no tool); or one with no ids and none known.
      if ((turn && !latest) || !a) begin(ledger, turn, now)
      const t = ledger.active!
      t.stops++
      if (opts.hiveContinued) {
        if (t.state === 'over') reopen(t)
        t.continued++
        return { verdict: 'continued' }
      }
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

/** The CLI was heard from outside its hooks (its transcript grew, its screen shows it at work). */
export function heard(ledger: TurnLedger, now = Date.now()): void {
  ledger.heard = now
}

/** How long the running turn has been silent (ms: nothing heard), whether or not a tool call is open; null when none runs. */
export function silentFor(ledger: TurnLedger, now = Date.now()): number | null {
  const a = ledger.active
  return a && a.state === 'running' ? now - ledger.heard : null
}

/** Tool calls of the running turn started and not ended (one may be running long: a test run). */
export function openCalls(ledger: TurnLedger): number {
  const a = ledger.active
  return a && a.state === 'running' ? a.calls.size + a.unnamedCalls : 0
}

/** Whether the CLI's own record that turn `turn` is over (its id as its hooks name turns) is about the turn Hive has running. */
export function reconciles(ledger: TurnLedger, turn: string): boolean {
  const a = ledger.active
  return !!a && a.state === 'running' && a.id === turn
}

/**
 * Whether the CLI's own records show a Stop of the running turn that Hive never received, for CLIs whose records don't
 * name turns (Copilot): more of its Stops answered since the turn began (`stopEnds`, ms, as the CLI recorded them) than
 * Stops of the turn Hive got. One answered before the turn began is an earlier turn's; each Stop Hive carried the turn on
 * with is one of those it got, so a missed final one after continuations still counts.
 */
export function unheardStop(ledger: TurnLedger, stopEnds: readonly number[]): boolean {
  const a = ledger.active
  if (!a || a.state !== 'running' || a.id !== null) return false
  return stopEnds.filter((t) => t >= a.startedAt).length > a.stops
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
