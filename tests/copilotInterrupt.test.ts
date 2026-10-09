// A Copilot turn that ends on the user refusing a prompt sends no hook (#475): SessionManager reads its end from the
// session's events and ends the wait as an interrupt would. A read the CLI's hooks overtake (its Stop as it carried on,
// or the next prompt, arriving while the read is in flight) is older than they are and doesn't undo them. Copilot's
// hooks as it sends them (handleHook), its events in a file, no process.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-copilot-interrupt-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { copilot } = await import('../src/main/providers/copilot/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; status: string; statusMessage?: string | null }
const s = sessions as unknown as {
  live: Map<string, { state: State }>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  readDetails: (l: unknown, path: string, size: number) => Promise<void>
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const line = (type: string, timestamp: string, data: Record<string, unknown>): string => JSON.stringify({ type, data, timestamp }) + '\n'
// Esc on "Path permission needed" (Copilot CLI 1.0.93): the denial, the tool's failure and the turn's end; no hook.
const REFUSAL =
  line('hook.start', '2026-10-09T10:00:00.000Z', { hookType: 'userPromptSubmitted' }) +
  line('user.message', '2026-10-09T10:00:00.001Z', { content: 'write ../outside.txt' }) +
  line('assistant.turn_start', '2026-10-09T10:00:00.002Z', { turnId: '0' }) +
  line('permission.requested', '2026-10-09T10:00:01.000Z', { toolCallId: 'call_1', permissionRequest: { kind: 'path' } }) +
  line('permission.completed', '2026-10-09T10:00:02.000Z', { toolCallId: 'call_1', result: { kind: 'denied-interactively-by-user' } }) +
  line('tool.execution_complete', '2026-10-09T10:00:02.001Z', { toolCallId: 'call_1', success: false }) +
  line('assistant.turn_end', '2026-10-09T10:00:02.002Z', { turnId: '0' })

/** A Copilot agent waiting on its path prompt, with its events so far in a file of its own. */
function agent(agentId: string): { st: State; l: unknown; events: string } {
  const events = join(base, `${agentId}.jsonl`)
  writeFileSync(events, REFUSAL)
  const st = { provider: 'copilot', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'waiting', statusMessage: 'Path permission needed', startedAt: '2026-10-09T09:00:00.000Z', launchSignature: '', unseen: false }
  const l = { state: st, adapter: copilot, transcriptMtime: '', transcriptPath: events, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st, l, events }
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, ...body }))
/** Until what is queued for the launch (its hooks, and an interrupt read from its events) has run. */
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}

describe('a Copilot turn that ends on a refused prompt', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('ends the wait: the agent is ready', async () => {
    const { st, l, events } = agent('a')
    await run(() => s.readDetails(l, events, statSync(events).size))
    await settled(st)
    expect(st.status).toBe('ready')
  })

  it("doesn't undo the Stop of a turn Copilot carried on with while the read was in flight", async () => {
    const { st, l, events } = agent('b')
    // The read takes the events as they are (ending on the refusal's turn end), then Copilot carries on and its Stop
    // arrives before the read is done.
    const reading = run(() => s.readDetails(l, events, statSync(events).size))
    appendFileSync(events, line('assistant.turn_start', '2026-10-09T10:00:02.003Z', { turnId: '1' }) + line('hook.start', '2026-10-09T10:00:03.000Z', { hookType: 'agentStop' }))
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'I can’t write there.' })
    expect(st.status).toBe('finished')
    await reading
    await settled(st)
    expect(st.status).toBe('finished')
  })

  it("doesn't undo the next prompt that arrived while the read was in flight", async () => {
    const { st, l, events } = agent('c')
    const reading = run(() => s.readDetails(l, events, statSync(events).size))
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again' })
    expect(st.status).toBe('working')
    await reading
    await settled(st)
    expect(st.status).toBe('working')
  })
})
