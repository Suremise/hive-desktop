// The turn ledger in SessionManager (#648): Codex's hooks as it sends them (handleHook, with the reply Hive gave), its
// rollout in a file, no process. A late tool end after Stop leaves the agent finished; a Stop Hive carried on isn't an
// end; a Stop that never came is made up for by Codex's own record of the turn's end; silence with no sign of an end
// leaves the state unknown (never idle) until the CLI is heard, its idle prompt shows, or the user marks it idle.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-turn-ledger-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { codex, codexTurnScreen } = await import('../src/main/providers/codex/adapter')
const { newLedger } = await import('../src/main/turnLedger')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; status: string; turn?: { state: string; silentSince?: string } }
type Launch = { state: State; ledger: { heard: number }; screen?: { text: () => string }; turnScreen?: (s: string) => 'idle' | 'working' | null }
const s = sessions as unknown as {
  live: Map<string, Launch>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  readDetails: (l: unknown, path: string, size: number) => Promise<void>
  checkSilence: (projectPath: string, agentId: string) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const event = (payload: Record<string, unknown>): string => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n'

/** A working Codex agent with an empty rollout of its own. */
function agent(agentId: string): { st: State; l: Launch; rollout: string } {
  const rollout = join(base, `${agentId}.jsonl`)
  writeFileSync(rollout, '')
  const st = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
  const l = { state: st, adapter: codex, transcriptMtime: '', transcriptPath: rollout, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger() }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st, l: l as never, rollout }
}
/** A hook as Codex sends it, answered as the hook server answers it (sessions.hookReply). */
const hook = (st: State, body: Record<string, unknown>) =>
  run(() => {
    const full = { session_id: st.sessionId, cwd: p, ...body }
    return sessions.handleHook(st.runId, full, sessions.hookReply(st.runId, full))
  })
/** Until what is queued for the launch (its hooks, what its rollout or screen said) has run. */
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}
const pre = (turn: string, call: string) => ({ hook_event_name: 'PreToolUse', turn_id: turn, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: call })
const post = (turn: string, call: string) => ({ hook_event_name: 'PostToolUse', turn_id: turn, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: call })

describe('the turn ledger in a session', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
  })
  afterEach(() => {
    sessions.stopReplier = null
    delete process.env.HIVE_TEST_SILENT_MS
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it("stays finished when a tool's end reaches Hive after its turn's Stop (#642)", async () => {
    const { st } = agent('late')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, pre('t1', 'exec-1'))
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done' })
    expect(st.status).toBe('finished')
    await hook(st, post('t1', 'exec-1'))
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it("isn't over at a Stop Hive answered with a continuation, only at the one it answered with nothing", async () => {
    const { st } = agent('cont')
    let drains = 1
    sessions.stopReplier = () => (drains-- > 0 ? { decision: 'block', reason: 'You have mail: call hive_inbox' } : null)
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done' })
    expect(st.status).toBe('working')
    expect(st.turn).toEqual({ state: 'running', id: 't1' })
    await hook(st, pre('t1', 'exec-2'))
    await hook(st, post('t1', 'exec-2'))
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: true, last_assistant_message: 'Read my inbox' })
    expect(st.status).toBe('finished')
  })

  it("ends the turn a Stop never came for from Codex's own record of it (task_complete), and only that turn", async () => {
    const { st, l, rollout } = agent('lost')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    // An older turn's record changes nothing.
    appendFileSync(rollout, event({ type: 'task_complete', turn_id: 't0' }))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect(st.status).toBe('working')
    await hook(st, pre('t1', 'exec-3'))
    await hook(st, post('t1', 'exec-3'))
    // The final reply, then no Stop: Codex records the turn's end.
    appendFileSync(rollout, event({ type: 'task_complete', turn_id: 't1', last_agent_message: 'Watching for the revised document.' }))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it("after silence with no sign of the turn's end, the state is unknown, not idle, until the user marks it idle", async () => {
    const { st, l } = agent('silent')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 5000
    l.turnScreen = codexTurnScreen
    // Its screen visibly at work (a long reply): heard, so not silent.
    l.screen = { text: () => '• Working (40s • esc to interrupt)\n\n› Ask Codex to do anything' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    expect(Date.now() - l.ledger.heard).toBeLessThan(5000)
    // A screen that shows neither (a draft in its input): unknown.
    l.ledger.heard = Date.now() - 5000
    l.screen = { text: () => '• Done.\n\n› half a sentence the user typed' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.status).toBe('working')
    expect(st.turn).toMatchObject({ state: 'unknown', id: 't1', silentSince: expect.any(String) })
    // Any hook says more: the turn runs again, as far as Hive knows.
    await hook(st, { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'exec-4' })
    await hook(st, post('t1', 'exec-4'))
    expect(st.turn).toEqual({ state: 'running', id: 't1' })
    l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('unknown')
    await run(() => sessions.markIdle(p, st.agentId))
    expect(st.status).toBe('ready')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it('after silence, a CLI idle at its prompt on screen has ended its turn', async () => {
    const { st, l } = agent('screen')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 5000
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '• Done.\n\n  Worked for 5s • 02:29\n\n› Ask Codex to do anything\n\n  ? for shortcuts' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it("never ends a turn on silence alone: a tool under way, or a short silence, is left as it is", async () => {
    const { st, l } = agent('busy')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, pre('t1', 'exec-5'))
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 60_000
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '› Ask Codex to do anything' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    await hook(st, post('t1', 'exec-5'))
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
  })
})
