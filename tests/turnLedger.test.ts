import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { admit, endRunning, expectInjected, heard, newLedger, reconciles, silentFor, type TurnLedger } from '../src/main/turnLedger'
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

/** One hook through the ledger and the status rules; `continued`: Hive answered this Stop with a continuation. */
function feed(a: Agent, ev: HookEvent, i: HookIds, continued = false): Agent {
  const took = admit(a.ledger, ev, i, { hiveContinued: continued, now: 0 })
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

  it('without turn ids (Copilot), a tool end after the turn ended with no tool start since is old news too', () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids(null))
    feed(a, { kind: 'toolStart' }, ids(null))
    feed(a, { kind: 'stop', lastMessage: null }, ids(null))
    feed(a, { kind: 'toolEnd' }, ids(null))
    expect(a.status).toBe('finished')
    // A tool that starts after the Stop carries the turn on (another Stop hook made the CLI go on), and its end counts.
    feed(a, { kind: 'toolStart' }, ids(null))
    expect(a.status).toBe('working')
    feed(a, { kind: 'toolEnd' }, ids(null))
    feed(a, { kind: 'stop', lastMessage: null }, ids(null))
    expect(a.status).toBe('finished')
  })

  it("an earlier turn's late hook while a later turn runs changes nothing", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'prompt' }, ids('t2'))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ id: 't2', state: 'running' })
    expect(a.stale).toEqual(['a tool end of a turn that is over', "an earlier turn's Stop while a later one runs"])
  })

  it('a Stop Hive answered with a continuation is not the turn\'s end: the Stop answered with nothing is', () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'), true)
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ state: 'running', continued: 1 })
    // Continuations fire no prompt: the next hooks are the same turn's.
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c2', continued: true }))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { continued: true }))
    expect(a.status).toBe('finished')
  })

  it('a turn another Stop hook carried on (not Hive) works again at its next tool, and ends at its next Stop', () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    expect(a.status).toBe('finished')
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    expect(a.status).toBe('working')
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
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
    feed(a, { kind: 'toolStart' }, ids('t1', { sub: 'agent-1', call: 's2' }))
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

  it('silence: only a running turn with no tool under way, from when the CLI was last heard; never an end by itself', () => {
    const l = newLedger(0)
    expect(silentFor(l, 1000)).toBeNull()
    admit(l, { kind: 'prompt' }, ids('t1'), { now: 0 })
    expect(silentFor(l, 60_000)).toBe(60_000)
    admit(l, { kind: 'toolStart' }, ids('t1', { call: 'c' }), { now: 60_000 })
    expect(silentFor(l, 10 * 60_000)).toBeNull()
    admit(l, { kind: 'toolEnd' }, ids('t1', { call: 'c' }), { now: 70_000 })
    heard(l, 100_000)
    expect(silentFor(l, 400_000)).toBe(300_000)
    expect(l.active?.state).toBe('running')
  })

  it("the CLI's record of a turn's end reconciles only the turn it names; one naming none, only if Hive didn't carry it on", () => {
    const l = newLedger(0)
    admit(l, { kind: 'prompt' }, ids('t2'))
    expect(reconciles(l, 't1', true)).toBe(false)
    expect(reconciles(l, 't2', false)).toBe(true)
    endRunning(l, 'transcript')
    expect(reconciles(l, 't2', true)).toBe(false)
    const c = newLedger(0)
    admit(c, { kind: 'prompt' }, ids(null))
    expect(reconciles(c, null, true)).toBe(true)
    // A hook since the read (the next prompt): the record may be of the turn before.
    expect(reconciles(c, null, false)).toBe(false)
    // A record naming a turn, while the running one has no id (a prompt hook without one): only with no hook since.
    expect(reconciles(c, 't1', false)).toBe(false)
    expect(reconciles(c, 't1', true)).toBe(true)
    admit(c, { kind: 'stop', lastMessage: null }, ids(null), { hiveContinued: true })
    expect(reconciles(c, null, true)).toBe(false)
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

  it("Copilot: its agentStop hook answered (hook.end), until a turn or prompt follows", async () => {
    const { eventsDetails } = await import('../src/main/providers/copilot/events')
    const ev = (type: string, data: Record<string, unknown>, timestamp = '2026-10-12T00:00:00.000Z') => JSON.stringify({ type, data, timestamp }) + '\n'
    const ended = ev('user.message', { content: 'go' }) + ev('assistant.turn_start', { turnId: '0' }) + ev('assistant.turn_end', { turnId: '0' }) + ev('hook.start', { hookType: 'agentStop' }) + ev('hook.end', { hookType: 'agentStop' }, '2026-10-12T00:00:09.000Z')
    expect(eventsDetails(ended).turnEnded).toEqual({ turn: null, at: '2026-10-12T00:00:09.000Z' })
    // Its Stop hook asked to carry on: another model call follows.
    expect(eventsDetails(ended + ev('assistant.turn_start', { turnId: '1' })).turnEnded).toBeNull()
    expect(eventsDetails(ev('user.message', { content: 'go' })).turnEnded).toBeNull()
    // The real 1.0.93 session's events end on a turn whose Stop was answered (tests/fixtures/copilot).
    const real = readFileSync(join(__dirname, 'fixtures', 'copilot', 'session-state', '5cb5a219-ee72-49a3-b871-cc0c05d27269', 'events.jsonl'), 'utf8')
    expect(eventsDetails(real).turnEnded).toMatchObject({ turn: null })
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
