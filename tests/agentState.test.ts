import { describe, expect, it } from 'vitest'
import { AGENT_STATE_LABEL, AGENT_STATES, agentState, boardExtras, mostUrgent, projectAgentStates, stateCounts, stateSummary, type AgentState } from '../src/shared/agentState'
import { tr } from '../src/shared/i18n'
import type { AgentInfo, LiveSessionState, SessionStatus, TaskCard } from '../src/shared/types'

const live = (status: SessionStatus, extra: Partial<LiveSessionState> = {}): LiveSessionState =>
  ({ provider: 'claude-code', runId: 'r', projectPath: '', agentId: '', cwd: '', sessionId: '', status, unseen: false, startedAt: '', launchSignature: '', ...extra }) as LiveSessionState

describe('agent state marks (#973)', () => {
  it('maps every session status to one of the four states', () => {
    const expected: Record<SessionStatus, AgentState> = {
      waiting: 'waiting',
      signin: 'waiting',
      error: 'stalled',
      working: 'working',
      starting: 'working',
      background: 'working',
      ready: 'idle',
      finished: 'idle',
      watching: 'idle',
      stopped: 'idle'
    }
    for (const [status, state] of Object.entries(expected)) expect(agentState(live(status as SessionStatus)), status).toBe(state)
  })

  it('no session is idle', () => {
    expect(agentState(null)).toBe('idle')
    expect(agentState(undefined)).toBe('idle')
  })

  it('a question beside its work is waiting for you, though it works on', () => {
    expect(agentState(live('working', { question: { text: 'Which colour?', since: 't' } }))).toBe('waiting')
  })

  it("stalled: a turn silent with its state unknown, or cards it loops on left unwatched", () => {
    expect(agentState(live('working', { turn: { state: 'unknown', silentSince: 't' } }))).toBe('stalled')
    expect(agentState(live('finished', { notWatching: [12] }))).toBe('stalled')
    expect(agentState(live('finished', { notWatching: [] }))).toBe('idle')
    expect(agentState(live('working', { turn: { state: 'running' } }))).toBe('working')
  })

  it("the board's facts: a card blocked on you is waiting, a stalled card stalled, with or without a session", () => {
    expect(agentState(live('working'), { blocked: true })).toBe('waiting')
    expect(agentState(null, { blocked: true })).toBe('waiting')
    expect(agentState(live('working'), { stalled: true })).toBe('stalled')
    expect(agentState(null, { stalled: true })).toBe('stalled')
    // Waiting for you comes first: what it needs now.
    expect(agentState(live('waiting'), { stalled: true })).toBe('waiting')
  })

  it('most urgent first: waiting, stalled, working, idle; counts and the summary mark', () => {
    expect(AGENT_STATES).toEqual(['waiting', 'stalled', 'working', 'idle'])
    expect(stateCounts(['working', 'idle', 'working', 'waiting'])).toEqual({ waiting: 1, stalled: 0, working: 2, idle: 1 })
    expect(mostUrgent(['idle', 'working', 'stalled'])).toBe('stalled')
    expect(mostUrgent(['idle', 'working', 'waiting'])).toBe('waiting')
    expect(mostUrgent([])).toBe('idle')
  })

  it('one label per state', () => {
    expect(AGENT_STATES.map((s) => tr(AGENT_STATE_LABEL[s]))).toEqual(['Waiting for you', 'Stalled', 'Working', 'Idle'])
  })

  const card = (agent: string | null, column: TaskCard['column'], extra: Partial<TaskCard> = {}) => ({ project: 'Alpha', agent, column, blocked: null, archived: false, ...extra })
  const agent = (id: string, l: LiveSessionState | null) => ({ id, name: id, live: l }) as AgentInfo

  it("the board's facts of an agent: a card blocked on you in Doing or Review; a Doing card while it isn't running", () => {
    expect(boardExtras('alpha', agent('a1', live('working')), [card('a1', 'review', { blocked: 'Which name?' })])).toEqual({ blocked: true, stalled: false })
    expect(boardExtras('alpha', agent('a1', null), [card('a1', 'doing')])).toEqual({ blocked: false, stalled: true })
    expect(boardExtras('alpha', agent('a1', live('ready')), [card('a1', 'doing')])).toEqual({ blocked: false, stalled: false })
    // Not its card, another project's, archived, or in a column nobody works in.
    const none = [card('a2', 'doing', { blocked: 'x' }), card('a1', 'doing', { project: 'beta', blocked: 'x' }), card('a1', 'doing', { archived: true, blocked: 'x' }), card('a1', 'todo', { blocked: 'x' }), card('a1', 'passed', { blocked: 'x' })]
    expect(boardExtras('alpha', agent('a1', null), none)).toEqual({ blocked: false, stalled: false })
  })

  it("a project's agents' states, in its order, with the board's facts", () => {
    const p = { name: 'alpha', agents: [agent('a1', live('working')), agent('a2', null), agent('a3', live('finished'))] }
    expect(projectAgentStates(p, [card('a2', 'doing'), card('a3', 'review', { blocked: 'Which?' })])).toEqual(['working', 'stalled', 'waiting'])
  })

  it('the summary line: most urgent first, idle only when all are idle (or asked for)', () => {
    expect(stateSummary(['idle', 'working', 'waiting', 'working', 'idle'])).toBe('1 waiting · 2 working')
    expect(stateSummary(['idle', 'working', 'waiting', 'working', 'idle'], true)).toBe('1 waiting · 2 working · 2 idle')
    expect(stateSummary(['idle', 'idle'])).toBe('2 idle')
    expect(stateSummary(['stalled', 'working'])).toBe('1 stalled · 1 working')
    expect(stateSummary([])).toBe('')
  })
})
