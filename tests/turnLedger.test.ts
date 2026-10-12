import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { admit, endRunning, expectInjected, heard, newLedger, openCalls, reconciles, silentFor, unheardStop, type ScreenReading, type TurnLedger } from '../src/main/turnLedger'
import { applyStep, hookStep, type HookStatusInput } from '../src/main/hookStatus'
import type { HookEvent, HookIds, ProviderAdapter } from '../src/main/providers/types'
import type { SessionStatus } from '../src/shared/types'

/**
 * The turn ledger (#648): hooks as each CLI sends them, through its adapter, the ledger and the status rules, as
 * SessionManager.handleHookNow does. The sequences recorded from the real CLIs (#645's spike) are in tests/fixtures.
 */

const ids = (turn: string | null, extra: Partial<HookIds> = {}): HookIds => ({ turn, call: null, sub: null, continued: false, ...extra })

interface Agent {
  status: SessionStatus
  statusMessage?: string
  ledger: TurnLedger
  stale: string[]
}

const agent = (status: SessionStatus = 'ready'): Agent => ({ status, ledger: newLedger(0), stale: [] })

const input = (a: Agent): HookStatusInput => ({ status: a.status, statusMessage: a.statusMessage, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false })

/** One hook through the ledger and the status rules; `continued`: Hive answered this Stop with a continuation; `screen`: what the CLI's screen shows. */
function feed(a: Agent, ev: HookEvent, i: HookIds, continued = false, screen: ScreenReading = null): Agent {
  const took = admit(a.ledger, ev, i, { hiveContinued: continued, screen: () => screen, now: a.ledger.seq })
  if (took.verdict === 'apply') applyStep(a, hookStep(took.event, input(a)))
  else a.stale.push(took.verdict === 'stale' ? took.why : 'continued')
  return a
}

/** Hook bodies through a provider's own normaliser. */
function send(adapter: ProviderAdapter, a: Agent, bodies: Record<string, unknown>[], continued: (body: Record<string, unknown>, i: number) => boolean = () => false): Agent {
  bodies.forEach((body, i) => {
    const h = adapter.normalizeHook(body)
    feed(a, h.event, h.ids, h.event.kind === 'stop' && continued(body, i))
  })
  return a
}

const fixture = (name: string): Record<string, unknown>[] => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')).hooks

describe('the turn ledger', () => {
  it('a final turn with no tool call ends with its Stop', () => {
    const a = feed(feed(agent(), { kind: 'prompt', text: 'hi' }, ids('t1')), { kind: 'stop', lastMessage: 'done' }, ids('t1'))
    expect(a.status).toBe('finished')
    expect(a.ledger.active).toMatchObject({ id: 't1', state: 'over', endedBy: 'stop' })
  })

  it("a tool's late end after its turn's Stop is old news: the agent stays finished (#642)", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(['a tool end of a turn that is over'])
  })

  it("a tool's late start after its turn's Stop is old news too, unless the CLI's screen shows the turn going on", () => {
    for (const screen of [null, 'idle'] as ScreenReading[]) {
      const a = agent()
      feed(a, { kind: 'prompt' }, ids('t1'))
      feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
      feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }), false, screen)
      expect([a.status, a.ledger.active?.state], String(screen)).toEqual(['finished', 'over'])
      expect(a.stale).toEqual(['a tool start after its turn ended, with nothing showing it goes on'])
    }
    // Another Stop hook carried it on (the user's): the screen shows it working, and the turn goes on to its next Stop.
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }), false, 'working')
    expect([a.status, a.ledger.active?.state]).toEqual(['working', 'running'])
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { continued: true }))
    expect(a.status).toBe('finished')
  })

  it('without turn ids (Copilot), a tool end after the turn ended with no tool start since is old news; a start only with the screen working', () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids(null))
    feed(a, { kind: 'toolStart' }, ids(null))
    feed(a, { kind: 'stop', lastMessage: null }, ids(null))
    feed(a, { kind: 'toolEnd' }, ids(null))
    feed(a, { kind: 'toolStart' }, ids(null))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(['a tool end after its turn ended, with no tool start since', 'a tool start after its turn ended, with nothing showing it goes on'])
    // No turn known at all: a tool start alone changes nothing (as before the ledger).
    const fresh = feed(agent('ready'), { kind: 'toolStart' }, ids(null))
    expect([fresh.status, fresh.ledger.active]).toEqual(['ready', null])
  })

  it("an earlier turn's late news while a later turn runs changes nothing, and never makes the earlier one active", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'prompt' }, ids('t2'))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c2' }), false, 'working')
    feed(a, { kind: 'prompt', text: 'late' }, ids('t1'))
    feed(a, { kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'May I?' } }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ id: 't2', state: 'running' })
    expect(a.stale).toEqual(['a tool end of a turn that is over', 'a tool start of an earlier turn', 'a prompt of a turn that is over', 'a question of a turn that is over', "an earlier turn's Stop"])
  })

  it('remembers every turn of the launch: a late hook from many turns ago is still old news', () => {
    const a = agent()
    for (let n = 0; n < 40; n++) {
      feed(a, { kind: 'prompt' }, ids(`t${n}`))
      feed(a, { kind: 'stop', lastMessage: null }, ids(`t${n}`))
    }
    feed(a, { kind: 'toolEnd' }, ids('t0', { call: 'c' }))
    feed(a, { kind: 'toolStart' }, ids('t0', { call: 'c' }), false, 'working')
    expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['finished', 't39', 'over'])
    // A tool end of a turn never seen isn't a new turn either: its start would have said so.
    feed(a, { kind: 'toolEnd' }, ids('t-never', { call: 'c' }))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(['a tool end of a turn that is over', 'a tool start of an earlier turn', 'a tool end of a turn Hive never saw begin'])
  })

  it("a Stop Hive answered with a continuation is not the turn's end: the Stop answered with nothing is", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'), true)
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ state: 'running', continued: 1, stops: 1 })
    // Continuations fire no prompt: the next hooks are the same turn's.
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c2', continued: true }))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { continued: true }))
    expect(a.status).toBe('finished')
  })

  it("a turn the CLI began by itself (a background task's wake: no prompt) is taken from its first tool", () => {
    const a = agent('background')
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t2', { call: 'c1' }))
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ id: 't2', state: 'running' })
  })

  it("a sub-agent's tools are its parent's turn's while it runs, and don't carry on one that is over", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { sub: 'agent-1', call: 's1' }))
    expect(a.stale).toEqual([])
    feed(a, { kind: 'toolEnd' }, ids('t1', { sub: 'agent-1', call: 's1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { sub: 'agent-1', call: 's2' }), false, 'working')
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { sub: 'agent-1' }))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(["a sub-agent's tool outside the running turn", "a sub-agent's Stop"])
  })

  it("a prompt in the running turn isn't a new turn; one Hive put there itself isn't a prompt at all (Messaging 5)", () => {
    const a = agent()
    feed(a, { kind: 'prompt', text: 'go' }, ids('t1'))
    const mid = admit(a.ledger, { kind: 'prompt', text: 'a word from the user' }, ids('t1'))
    expect(mid).toMatchObject({ verdict: 'apply', note: 'a prompt in the running turn' })
    expect(a.ledger.active?.id).toBe('t1')
    expectInjected(a.ledger, 'You have  2 messages:\ncall hive_inbox')
    const own = admit(a.ledger, { kind: 'prompt', text: 'You have 2 messages: call hive_inbox' }, ids('t1'))
    expect(own).toMatchObject({ verdict: 'apply', event: { kind: 'prompt', injected: true } })
    expect(hookStep((own as { event: HookEvent }).event, input(a))).toEqual({ next: null, actions: [] })
    // Only once: the same text again is the CLI's own.
    expect(admit(a.ledger, { kind: 'prompt', text: 'You have 2 messages: call hive_inbox' }, ids('t1'))).not.toMatchObject({ event: { injected: true } })
  })

  it('an interrupt, a refused sign-in and the CLI idle at its prompt end the running turn', () => {
    for (const ev of [{ kind: 'interrupt' }, { kind: 'signIn', message: null }, { kind: 'idle' }] as HookEvent[]) {
      const a = feed(agent(), { kind: 'prompt' }, ids('t1'))
      feed(a, ev, ids(null))
      expect(a.ledger.active?.state, ev.kind).toBe('over')
      feed(a, { kind: 'toolEnd' }, ids('t1'))
      expect(a.stale, ev.kind).toEqual(['a tool end of a turn that is over'])
    }
  })

  it('silence: of a running turn, from when the CLI was last heard, open tool calls or not (their ends can be lost); never an end by itself', () => {
    const l = newLedger(0)
    expect(silentFor(l, 1000)).toBeNull()
    admit(l, { kind: 'prompt' }, ids('t1'), { now: 0 })
    expect(silentFor(l, 60_000)).toBe(60_000)
    admit(l, { kind: 'toolStart' }, ids('t1', { call: 'c' }), { now: 60_000 })
    expect([silentFor(l, 6 * 3600_000), openCalls(l)]).toEqual([6 * 3600_000 - 60_000, 1])
    admit(l, { kind: 'toolEnd' }, ids('t1', { call: 'c' }), { now: 70_000 })
    heard(l, 100_000)
    expect([silentFor(l, 400_000), openCalls(l)]).toEqual([300_000, 0])
    expect(l.active?.state).toBe('running')
  })

  it("the CLI's record of a turn's end by id reconciles only the turn Hive has running under that id", () => {
    const l = newLedger(0)
    admit(l, { kind: 'prompt' }, ids('t2'))
    expect(reconciles(l, 't1')).toBe(false)
    expect(reconciles(l, 't2')).toBe(true)
    endRunning(l, 'transcript')
    expect(reconciles(l, 't2')).toBe(false)
    // A running turn whose prompt hook named none can't be told to be the record's.
    const c = newLedger(0)
    admit(c, { kind: 'prompt' }, ids(null))
    expect(reconciles(c, 't1')).toBe(false)
  })

  it("records naming no turn (Copilot): a Stop answered since the turn began that Hive never got ends it; earlier ones don't", () => {
    // An earlier turn's Stop answered at 900 (in the tail read with the new prompt): not this turn's.
    const c = newLedger(0)
    admit(c, { kind: 'prompt' }, ids(null), { now: 1000 })
    expect(unheardStop(c, [900])).toBe(false)
    // Carried on by Hive once, then its final Stop missed: the second answer is one Hive never got.
    const e = newLedger(0)
    admit(e, { kind: 'prompt' }, ids(null), { now: 1000 })
    admit(e, { kind: 'stop', lastMessage: null }, ids(null), { hiveContinued: true, now: 1100 })
    expect(unheardStop(e, [900, 1101])).toBe(false)
    expect(unheardStop(e, [900, 1101, 1500])).toBe(true)
    // A CLI whose records name turns isn't read this way.
    const f = newLedger(0)
    admit(f, { kind: 'prompt' }, ids('t1'), { now: 1000 })
    expect(unheardStop(f, [1500])).toBe(false)
  })
})

describe('the real CLIs’ hooks through the ledger (#645 spike recordings)', () => {
  it('Claude Code 2.1.296: three turns, Stops carried on by blocks and context, end finished each time', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const hooks = fixture('turns-claude-2.1.296.json')
    const a = agent()
    // In the recording a hook blocked every Stop but the last of each turn; Hive would have answered them so.
    const last = (i: number) => hooks.slice(i + 1).find((b) => b.hook_event_name === 'Stop' || b.hook_event_name === 'UserPromptSubmit')?.hook_event_name !== 'Stop'
    const statuses: string[] = []
    hooks.forEach((body, i) => {
      const h = claudeCode.normalizeHook(body)
      feed(a, h.event, h.ids, h.event.kind === 'stop' && !last(i))
      statuses.push(`${body.hook_event_name}:${a.status}`)
    })
    expect(statuses.filter((s) => s.startsWith('Stop'))).toEqual(['Stop:working', 'Stop:working', 'Stop:working', 'Stop:finished', 'Stop:working', 'Stop:finished', 'Stop:working', 'Stop:finished'])
    expect(a.stale).toEqual(Array(5).fill('continued'))
    // A late PostToolUse of T1's read, arriving now, is old news.
    const late = claudeCode.normalizeHook(hooks.find((b) => b.hook_event_name === 'PostToolUse')!)
    feed(a, late.event, late.ids)
    expect(a.status).toBe('finished')
  })

  it('Codex 0.162.1: a tool turn carried on once by a block, then a turn with no tool call', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const hooks = fixture('turns-codex-0.162.1.json')
    const a = agent()
    const firstStop = hooks.findIndex((b) => b.hook_event_name === 'Stop')
    send(codex, a, hooks.slice(0, firstStop + 1), (_b, i) => i === firstStop)
    expect(a.status).toBe('working')
    send(codex, a, hooks.slice(firstStop + 1))
    expect(a.status).toBe('finished')
    expect(a.ledger.active?.id).toBe(hooks.at(-1)!.turn_id)
    const post = codex.normalizeHook(hooks.find((b) => b.hook_event_name === 'PostToolUse')!)
    expect(post.ids).toMatchObject({ turn: hooks[1].turn_id, call: expect.stringMatching(/^exec-/) })
    feed(a, post.event, post.ids)
    expect(a.status).toBe('finished')
  })
})

describe("the CLIs' own records of a turn's end", () => {
  const line = (type: string, payload: Record<string, unknown>, timestamp = '2026-10-12T00:00:00.000Z') => JSON.stringify({ timestamp, type, payload }) + '\n'

  it("Codex: its latest task_complete, by turn id; a task started after it means a turn runs", async () => {
    const { rolloutDetails } = await import('../src/main/providers/codex/rollout')
    const done = line('event_msg', { type: 'task_started', turn_id: 't1' }) + line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok' }, '2026-10-12T00:00:05.000Z')
    expect(rolloutDetails(done).turnEnded).toEqual({ turn: 't1', at: '2026-10-12T00:00:05.000Z' })
    expect(rolloutDetails(done + line('event_msg', { type: 'task_started', turn_id: 't2' })).turnEnded).toBeNull()
    expect(rolloutDetails(line('event_msg', { type: 'token_count' })).turnEnded).toBeUndefined()
  })

  it('Copilot: when each of its Stop hooks was answered (agentStop hook.end), whatever follows', async () => {
    const { eventsDetails } = await import('../src/main/providers/copilot/events')
    const ev = (type: string, data: Record<string, unknown>, timestamp = '2026-10-12T00:00:00.000Z') => JSON.stringify({ type, data, timestamp }) + '\n'
    const ended = ev('user.message', { content: 'go' }) + ev('assistant.turn_start', { turnId: '0' }) + ev('assistant.turn_end', { turnId: '0' }) + ev('hook.start', { hookType: 'agentStop' }) + ev('hook.end', { hookType: 'agentStop' }, '2026-10-12T00:00:09.000Z')
    expect(eventsDetails(ended).stopsAnswered).toEqual(['2026-10-12T00:00:09.000Z'])
    // The next prompt's hook in the same lines (#648 round 1: a tail read with it): the answer is still the earlier one's.
    const next = ended + ev('hook.start', { hookType: 'userPromptSubmitted' }, '2026-10-12T00:00:20.000Z')
    expect(eventsDetails(next).stopsAnswered).toEqual(['2026-10-12T00:00:09.000Z'])
    expect(eventsDetails(ev('user.message', { content: 'go' })).stopsAnswered).toBeUndefined()
    expect(eventsDetails(ended).turnEnded).toBeUndefined()
    // The real 1.0.93 session's events: three Stops answered (tests/fixtures/copilot).
    const real = readFileSync(join(__dirname, 'fixtures', 'copilot', 'session-state', '5cb5a219-ee72-49a3-b871-cc0c05d27269', 'events.jsonl'), 'utf8')
    expect(eventsDetails(real).stopsAnswered).toHaveLength(3)
  })
})

describe("the adapters' turn ids, Stop replies and idle screens", () => {
  const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

  it('read the ids each CLI sends, and nothing that is not an id', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    expect(claudeCode.normalizeHook({ hook_event_name: 'PreToolUse', prompt_id: 'p-1', tool_use_id: 'toolu_1', agent_id: 'a1', tool_input: {} }).ids).toEqual({ turn: 'p-1', call: 'toolu_1', sub: 'a1', continued: false })
    expect(claudeCode.normalizeHook({ hook_event_name: 'Stop', prompt_id: 'p-1', stop_hook_active: true }).ids).toEqual({ turn: 'p-1', call: null, sub: null, continued: true })
    expect(codex.normalizeHook({ hook_event_name: 'PostToolUse', turn_id: 't-1', tool_use_id: 'exec-1', tool_input: {} }).ids).toEqual({ turn: 't-1', call: 'exec-1', sub: null, continued: false })
    expect(copilot.normalizeHook({ hook_event_name: 'Stop' }).ids).toEqual({ turn: null, call: null, sub: null, continued: false })
    expect(claudeCode.normalizeHook({ hook_event_name: 'Stop', prompt_id: 'not an id: user text' }).ids.turn).toBeNull()
  })

  it('know which Stop replies carry the turn on', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    for (const ad of [claudeCode, codex, copilot]) {
      expect(ad.stopContinues({}), ad.id).toBe(false)
      expect(ad.stopContinues({ decision: 'block', reason: 'Fetch your inbox' }), ad.id).toBe(true)
    }
    expect(claudeCode.stopContinues({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'You have mail' } })).toBe(true)
    expect(codex.stopContinues({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'You have mail' } })).toBe(false)
  })

  it("Claude Code 2.1.296's screens, recorded alone and in Hive: idle at its prompt, or working; older versions aren't read", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const turn = claudeCode.turnScreen('2.1.296')!
    const recorded = screen('screen-claude-2.1.296-idle.txt')
    expect(turn(recorded)).toBe('idle')
    // The same screen with the spinner of a turn under way above its input.
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)'))).toBe('working')
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✶ Pondering…'))).toBe('working')
    // A spinner line left above in the history (an earlier moment of the turn) isn't its state now.
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✻ Brewing… (esc to interrupt)\n● plain answer\n✻ Worked for 3s · done 2:20'))).toBe('idle')
    // A dialog, or no status line: not sure.
    expect(turn('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBeNull()
    expect(turn('※ recap: the work is merged\n❯ ')).toBeNull()
    // As Hive's own terminal renders it (#648's real check: its input marked ">", its spinner with no "esc to interrupt"):
    // a reply held for seconds ("✢ Embellishing…"), and once done.
    expect(turn(screen('screen-claude-2.1.296-hive-working.txt'))).toBe('working')
    expect(turn(screen('screen-claude-2.1.296-hive-idle.txt'))).toBe('idle')
    expect(claudeCode.turnScreen('2.1.291')).toBeNull()
    expect(claudeCode.turnScreen(null)).toBeNull()
  })

  it("Codex 0.162.1's screens, recorded: idle at its prompt, working; a draft or a queued message isn't sure", async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const turn = codex.turnScreen('0.162.1')!
    const recorded = screen('screen-codex-0.162.1-idle.txt')
    expect(turn(recorded)).toBe('idle')
    // Recorded while a command ran (#645's live rerun): its Working line, a draft in its input, a message it would queue.
    expect(turn(screen('screen-codex-0.162.1-working.txt'))).toBe('working')
    expect(turn(recorded.replace('› Ask Codex to do anything', '› fix the tests'))).toBeNull()
    expect(turn(`${recorded}\ntab to queue message`)).toBeNull()
    expect(codex.turnScreen('0.160.0')).toBeNull()
  })
})
