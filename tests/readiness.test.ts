// When an agent can take a line of Hive's (#649, main/readiness.ts): read from the turn ledger's facts (#648), with a
// watch as Hive's policy on top; a state from before the facts reads its status word.
import { describe, expect, it } from 'vitest'
import { readyFor } from '../src/main/readiness'
import type { LiveSessionState, RuntimeFacts } from '../src/shared/types'

const st = (o: Partial<LiveSessionState> & { facts?: Partial<RuntimeFacts> } = {}): LiveSessionState => {
  const { facts, ...rest } = o
  return { provider: 'claude-code', runId: 'r1', projectPath: 'C:/p', agentId: 'a1', cwd: 'C:/p', sessionId: 's1', status: 'finished', startedAt: '', launchSignature: '', unseen: false, runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free', ...facts }, turn: { state: 'over' }, ...rest } as LiveSessionState
}
const watch = { cards: [1], changes: ['column' as const], label: 'Waiting for #1', since: '', limitAt: '' }

describe('readyFor (#649)', () => {
  it('takes an agent whose turn is over, or that has run none yet, while its CLI runs and nobody is asked', () => {
    expect(readyFor(st())).toBe(true)
    expect(readyFor(st({ turn: undefined }))).toBe(true)
    expect(readyFor(st(), 'free')).toBe(true)
  })

  it('not while a turn runs, or one has gone silent with no sign of its end (unknown is never idle)', () => {
    expect(readyFor(st({ turn: { state: 'running' } }))).toBe(false)
    expect(readyFor(st({ turn: { state: 'unknown', silentSince: '' } }))).toBe(false)
  })

  it('not while it compacts, is asked something, or is starting or stopped; background tasks that will wake it hold it too', () => {
    expect(readyFor(st({ facts: { maintenance: 'compacting' } }))).toBe(false)
    expect(readyFor(st({ facts: { attention: 'waiting' } }))).toBe(false)
    expect(readyFor(st({ facts: { attention: 'question' } }))).toBe(false)
    expect(readyFor(st({ facts: { lifecycle: 'starting' } }))).toBe(false)
    expect(readyFor(st({ facts: { lifecycle: 'stopped' } }))).toBe(false)
    expect(readyFor(st({ backgroundTasks: 1 }))).toBe(false)
    // A CLI its background tasks don't wake (Codex) is idle all the same.
    expect(readyFor(st({ provider: 'codex', backgroundTasks: 1 }))).toBe(true)
  })

  it("a watch is Hive's policy: a watching agent takes a message or a wake (idle), not new work (free)", () => {
    expect(readyFor(st({ status: 'watching', watch }))).toBe(true)
    expect(readyFor(st({ status: 'watching', watch }), 'free')).toBe(false)
  })

  it('stopped by a refused sign-in: only the carry-on (stalled) is offered', () => {
    expect(readyFor(st({ facts: { lifecycle: 'signin' } }))).toBe(false)
    expect(readyFor(st({ facts: { lifecycle: 'signin' } }), 'stalled')).toBe(true)
  })

  it("who holds the composer is the writer's to check, not readiness's (it holds it itself while it types)", () => {
    expect(readyFor(st({ facts: { composer: 'held' } }))).toBe(true)
  })

  it('a state from before the facts reads its status word', () => {
    const old = (status: LiveSessionState['status']) => ({ ...st({ status }), runtime: undefined, turn: undefined }) as LiveSessionState
    expect(readyFor(old('ready'))).toBe(true)
    expect(readyFor(old('working'))).toBe(false)
    expect(readyFor(old('watching'))).toBe(true)
    expect(readyFor(old('watching'), 'free')).toBe(false)
    expect(readyFor(old('signin'), 'stalled')).toBe(true)
    expect(readyFor(null)).toBe(false)
  })
})
