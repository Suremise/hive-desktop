import type { HookEvent, HookIds } from './providers/types'

/**
 * The turn ledger (#648): which of a launch's CLI turns runs and which are over, by the CLI's own turn ids, so a hook
 * about a turn that is over can't make the agent working again (a PostToolUse that reaches Hive after the turn's Stop:
 * one way #642's Codex agent could have stayed "working"), and so Hive can tell a missing turn end from a busy agent.
 * Pure, so each rule is unit-tested; SessionManager keeps one per launch and puts each hook through `admit` before the
 * status rules (hookStatus).
 *
 * The rules (the Assistant's, for #648):
 * 1. **Only a start opens or reopens a turn.** A prompt opens one. After its Stop, a turn reopens only on a start of it:
 *    a tool start with a call id not seen in it before (or none: a CLI whose hooks name no calls), or Hive's own
 *    continuation of a Stop (`hiveContinued`). End news (a tool end, an interrupt, the CLI idle, a refused sign-in, a
 *    Stop) never reopens one. Any hook naming a turn that is neither the open nor the latest one is stale, with no effect
 *    on status, and **an id Hive doesn't remember is stale, never new**: the bound on the ids kept (`seen`) can't make an
 *    old one a new turn. A prompt alone opens a turn under an id never seen (the CLI awaits its hook before the turn, so
 *    a prompt hook is never late). Hooks naming no turn are launch-wide (SessionStart, SessionEnd, compaction) or from a
 *    CLI whose hooks name none (Copilot), and are the latest turn's.
 * 2. **No screen timing decides a continuation**: rule 1 decides it from the ids alone, so a hook reaching Hive before the
 *    CLI redraws changes nothing.
 *    One exception: a CLI that starts a turn by itself when its background tasks end (Claude Code: no prompt hook) does
 *    so only while Hive knows a task of it runs or has just ended (`wake`, from its transcript): the next id Hive hasn't
 *    seen, with no turn running, is that turn.
 * 3. **Times are when a hook reached Hive** (`now`, taken before it waits its turn in the launch's queue), not when it
 *    was handled: the CLI's records are compared with them.
 * - A prompt in the running turn (its id) is one the CLI takes mid-turn; one Hive put there itself (`expectInjected`, a
 *   message delivered into the running turn) isn't a new prompt at all.
 * - A Stop ends its turn, unless Hive's own reply carried it on (continuations fire no prompt, so only the Stop Hive
 *   answered with nothing ends it).
 *
 * A timer never ends a turn: silence (`silentFor`) only makes Hive look for the CLI's own record of the turn's end
 * (`reconciles` by id, `unheardStop` by its Stops' times) or read its screen, and failing those, say the state is unknown.
 */

export type TurnState = 'running' | 'over'

export interface Turn {
  /** The CLI's id for it; null when its hooks name none (Copilot): Hive then knows only the latest turn. */
  id: string | null
  state: TurnState
  /** When its first hook reached Hive (ms, as it arrived, not as it was handled): records from before it are earlier turns'. */
  startedAt: number
  /** Its tool calls started and not ended: their ids, or a count of those without one. */
  calls: Set<string>
  unnamedCalls: number
  /** The ids of every tool call it started: a start of one again after its Stop is no start of the turn. */
  callsSeen: Set<string>
  /** Stops of it Hive received (each one Hive answered with a continuation, and the one that ended it). */
  stops: number
  /** Stops of it that Hive answered with a continuation. */
  continued: number
  /** How it ended (for the log): 'stop', 'interrupt', 'idle', 'transcript', 'screen', 'user'… */
  endedBy?: string
}

export interface TurnLedger {
  active: Turn | null
  /** Turn ids the launch has seen, in order (the latest `maxSeen`): only to say why a hook is stale. */
  seen: Set<string>
  maxSeen: number
  /** Hooks received for the launch, in order (the receive sequence the log gives each). */
  seq: number
  /** When Hive last heard from the CLI (a hook, the transcript growing, its screen showing it at work), ms. */
  heard: number
  /** Prompts Hive put into the running turn itself and hasn't seen yet (their text, flattened). */
  injected: string[]
}

/** What the CLI's screen shows of its turn (ProviderAdapter.turnScreen), read after a silence: null when not sure. */
export type ScreenReading = 'idle' | 'working' | null

export type Admitted =
  /** The hook goes to the status rules (as `event`, which may say more than the adapter's: resumes, injected). */
  | { verdict: 'apply'; event: HookEvent; note?: string }
  /** Old news of a turn that is over, or of another turn: the status rules don't see it. */
  | { verdict: 'stale'; why: string }
  /** A Stop Hive answered with a continuation: the turn goes on. */
  | { verdict: 'continued' }

/** At most this many turn ids are remembered (for the log's reasons; one not remembered is stale either way). */
const MAX_SEEN = 10_000
/** At most this many injected prompts are waited for. */
const MAX_INJECTED = 8

export function newLedger(now = Date.now(), opts: { maxSeen?: number } = {}): TurnLedger {
  return { active: null, seen: new Set(), maxSeen: opts.maxSeen ?? MAX_SEEN, seq: 0, heard: now, injected: [] }
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
    if (ledger.seen.size > ledger.maxSeen) ledger.seen.delete(ledger.seen.values().next().value!)
  }
  ledger.active = { id, state: 'running', startedAt: now, calls: new Set(), unnamedCalls: 0, callsSeen: new Set(), stops: 0, continued: 0 }
  return ledger.active
}

/** The latest turn, over, goes on (a start of it: rule 1). */
function reopen(t: Turn): void {
  t.state = 'running'
  t.endedBy = undefined
}

function addCall(t: Turn, call: string | null): void {
  if (call) {
    t.calls.add(call)
    t.callsSeen.add(call)
  } else t.unnamedCalls++
}

function endCall(t: Turn, call: string | null): void {
  if (call && t.calls.delete(call)) return
  if (t.unnamedCalls > 0) t.unnamedCalls--
}

/** A hook's kind, for the log's reasons. */
function what(ev: HookEvent): string {
  return ev.kind === 'toolStart' ? 'a tool start' : ev.kind === 'toolEnd' ? 'a tool end' : ev.kind === 'prompt' ? 'a prompt' : ev.kind === 'ask' ? 'a question' : ev.kind === 'stop' ? 'a Stop' : `${ev.kind} news`
}

/**
 * Takes a hook in: what the status rules should make of it. `hiveContinued`: Hive answered this Stop with a
 * continuation. `wake`: the CLI is due to start a turn by itself (a background task of it runs or just ended). `now`:
 * when the hook reached Hive (before it waited its turn in the launch's queue). Counts it (seq) and that the CLI was heard.
 */
export function admit(ledger: TurnLedger, ev: HookEvent, ids: HookIds, opts: { hiveContinued?: boolean; wake?: boolean; now?: number } = {}): Admitted {
  const now = opts.now ?? Date.now()
  ledger.seq++
  ledger.heard = Math.max(ledger.heard, now)
  const a = ledger.active
  const running = a?.state === 'running'
  const turn = ids.turn
  // Launch-wide hooks name no turn; the CLI's session ending is the launch's.
  if (ev.kind === 'start' || ev.kind === 'end' || ev.kind === 'compactStart' || ev.kind === 'compactEnd' || ev.kind === 'ignore') {
    if (ev.kind === 'end') end(ledger, 'end')
    return { verdict: 'apply', event: ev }
  }
  // A hook naming a turn that is neither the open nor the latest one: an earlier turn's, or one not remembered. Stale
  // (rule 1), but for a prompt under an id never seen, which opens a turn, and the turn a background task's wake began.
  if (turn && a?.id !== turn) {
    const earlier = ledger.seen.has(turn)
    if (ev.kind === 'prompt' && !earlier) {
      begin(ledger, turn, now)
      return { verdict: 'apply', event: ev }
    }
    if (earlier || !opts.wake || running || ids.sub) return { verdict: 'stale', why: `${what(ev)} ${earlier ? 'of an earlier turn' : 'of a turn Hive saw no prompt for'}` }
    begin(ledger, turn, now)
    const r = admit(ledger, ev, ids, { ...opts, now })
    ledger.seq--
    if (r.verdict !== 'apply') return r
    return { verdict: 'apply', event: r.event.kind === 'toolStart' ? { ...r.event, resumes: true } : r.event, note: "a turn the CLI began by itself: its background task's wake" }
  }
  // From here the hook names the latest turn, or none (a CLI whose hooks name none).
  switch (ev.kind) {
    case 'prompt': {
      if (turn && running) {
        const i = ev.text ? ledger.injected.indexOf(flat(ev.text)) : -1
        if (i < 0) return { verdict: 'apply', event: ev, note: 'a prompt in the running turn' }
        ledger.injected.splice(i, 1)
        return { verdict: 'apply', event: { ...ev, injected: true }, note: "Hive's own message in the running turn" }
      }
      if (turn) return { verdict: 'stale', why: 'a prompt of a turn that is over' }
      begin(ledger, null, now)
      return { verdict: 'apply', event: ev }
    }
    case 'toolStart': {
      if (ids.sub) {
        // A sub-agent works inside its parent's turn: news of that turn while it runs; after it, a background agent's.
        if (!running) return { verdict: 'stale', why: "a sub-agent's tool outside the running turn" }
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (running) {
        addCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      // No ids and no turn known yet: nothing to carry on (a tool start alone changes nothing, as before the ledger).
      if (!a) return { verdict: 'apply', event: ev }
      // The latest turn, over: a call it never started is a start of it, and it goes on; one it started is no start.
      if (ids.call && a.callsSeen.has(ids.call)) return { verdict: 'stale', why: 'a tool start of a call its turn started before it ended' }
      reopen(a)
      addCall(a, ids.call)
      return { verdict: 'apply', event: { ...ev, resumes: true }, note: 'a new tool call after its Stop: its turn goes on' }
    }
    case 'toolEnd': {
      if (running) {
        endCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (a) return { verdict: 'stale', why: turn ? 'a tool end of a turn that is over' : 'a tool end after its turn ended, with no tool start since' }
      return { verdict: 'apply', event: ev }
    }
    case 'ask':
      if (turn && !running) return { verdict: 'stale', why: 'a question of a turn that is over' }
      return { verdict: 'apply', event: ev }
    case 'stop': {
      if (ids.sub) return { verdict: 'stale', why: "a sub-agent's Stop" }
      // No ids and no turn known: a turn that ended at once.
      if (!a) begin(ledger, null, now)
      const t = ledger.active!
      t.stops++
      if (opts.hiveContinued) {
        // Hive's own continuation is a start of it (rule 1).
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
      // Of the latest turn, or naming none (launch-wide). An end: it never reopens one.
      end(ledger, ev.kind)
      return { verdict: 'apply', event: ev }
    default:
      return { verdict: 'apply', event: ev }
  }
}

/** The CLI was heard from outside its hooks (its transcript grew, its screen shows it at work). */
export function heard(ledger: TurnLedger, now = Date.now()): void {
  ledger.heard = Math.max(ledger.heard, now)
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
 * name turns (Copilot): more of its Stops answered since the turn's first hook reached Hive (`stopEnds`, ms, as the CLI
 * recorded them) than Stops of the turn Hive got. One answered before the turn began is an earlier turn's; each Stop
 * Hive carried the turn on with is one of those it got, so a missed final one after continuations still counts.
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
