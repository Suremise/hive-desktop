// Start on a card given to a running, idle agent: the prompt is typed in by sessions.sendPrompt, and the agent may
// start other work, or the user type in its terminal, while it is. Nothing more goes in then, and the card goes back.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'

// What Hive types into agents' terminals, recorded instead (no process runs); onWrite acts as each piece goes in.
const pty = vi.hoisted(() => ({ typed: [] as string[], onWrite: (_data: string): void => undefined }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (_key: string, data: string) => {
    pty.typed.push(data)
    pty.onWrite(data)
  }
}))

const base = mkdtempSync(join(tmpdir(), 'hive-delivery-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { startTask } = await import('../src/main/taskStart')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'deliver')
const s = sessions as unknown as { live: Map<string, unknown>; key: (p: string, a: string) => string }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

/** A running agent, idle, as SessionManager keeps one (no process). */
function idle(agentId: string): { status: string } {
  const state = { provider: 'claude', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: '', status: 'ready', startedAt: '', launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  return state
}
const prompted = (): boolean => pty.typed.join('').includes('Work on task')
const submitted = (): boolean => pty.typed.includes('\r')

describe('a Start typed into a running agent', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: ['d1', 'd2', 'd3', 'd4'].map((id, i) => ({ id, name: `Agent ${i + 1}` })) }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    pty.typed.length = 0
    pty.onWrite = () => undefined
  })

  /** A Review card of the agent's, and what Start did with it. */
  async function startWith(agentId: string, actor: typeof user | typeof assistant) {
    const c = await run(() => tasks.createTask({ title: `Follow-up for ${agentId}`, project: 'deliver', agent: agentId, column: 'review' }, user))
    const result = await run(() => startTask(c.number, { kind: 'agent', agentId }, actor, 'Address the latest review comment.')).then(
      () => null,
      (e: Error) => e.message
    )
    return { error: result, card: await run(() => tasks.getTask(c.number)) }
  }

  it('the agent starts work while the input is being cleared: nothing is typed, the card goes back to Review', async () => {
    const st = idle('d1')
    pty.onWrite = (d) => {
      if (d === '\x15') st.status = 'working'
    }
    const { error, card } = await startWith('d1', user)
    expect(error).toMatch(/is working/)
    expect([prompted(), submitted()]).toEqual([false, false])
    expect([card.column, card.agent]).toEqual(['review', 'd1'])
    expect(card.history.map((h) => h.what).slice(-2)).toEqual(['Moved to Doing', 'Moved to Review'])
  })

  it('the agent starts work while the prompt is typed: it is not sent, and what Hive typed is cleared again', async () => {
    const st = idle('d2')
    pty.onWrite = (d) => {
      if (d.includes('Work on')) st.status = 'working'
    }
    const { error, card } = await startWith('d2', user)
    expect(error).toMatch(/is working/)
    expect(submitted()).toBe(false)
    expect(pty.typed.at(-1)).toBe('\x15')
    expect([card.column, card.agent]).toEqual(['review', 'd2'])
  })

  it("the user types in the agent's terminal before the Assistant's prompt is sent: it isn't, and their input stays", async () => {
    idle('d3')
    // 50 ms after the last piece of the prompt went in (pieces go every 10 ms): in the wait before Enter.
    let timer: ReturnType<typeof setTimeout> | undefined
    pty.onWrite = (d) => {
      if (d === '\x15') return
      clearTimeout(timer)
      timer = setTimeout(() => sessions.noteUserInput(s.key(p, 'd3'), 'x'), 50)
    }
    const { error, card } = await startWith('d3', assistant)
    expect(error).toMatch(/just typed/)
    expect(prompted()).toBe(true)
    expect(submitted()).toBe(false)
    // Nothing cleared after the prompt began: the user's text stays where they typed it.
    expect(pty.typed.lastIndexOf('\x15')).toBe(0)
    expect([card.column, card.agent]).toEqual(['review', 'd3'])
  })

  it('nothing changes meanwhile: the prompt is sent and the card stays in Doing', async () => {
    idle('d4')
    const { error, card } = await startWith('d4', assistant)
    expect(error).toBeNull()
    expect([prompted(), submitted()]).toEqual([true, true])
    expect([card.column, card.agent]).toEqual(['doing', 'd4'])
  })
})
