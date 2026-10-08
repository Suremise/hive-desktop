// Waiting on agents (#416): what counts as an agent no longer working (shared/agentWatch.ts), its wake and limit lines,
// and agent watches in main/watches.ts: one fires once when a watched agent finishes its turn, waits for the user or
// stops, wakes its watcher only when it is idle and the user isn't typing (else later), and ends on wake or cancel. The
// sessions are stand-ins here (the e2e agentwatch suite runs real ones).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { agentBusy, agentEvent, agentLimitLine, agentPart, agentWakeLine, agentWatchLabel, readSavedAgentCondition, type AgentNow } from '../src/shared/agentWatch'
import { WAKE_MAX_BYTES } from '../src/shared/watch'
import { agentWatchText } from '../src/shared/toolReplies'

const nowOf = (over: Partial<AgentNow> = {}): AgentNow => ({ status: 'working', runId: 'r1', prompts: 1, pending: false, ...over })
const b6 = { projectPath: 'C:\\ws\\hive', agentId: 'b6', name: 'B6', project: 'hive' }

describe('what an agent watch counts', () => {
  it('working, starting, a typed prompt not yet taken, and background tasks (unless ignored) are working', () => {
    expect(agentBusy(nowOf(), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'starting' }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'ready', pending: true }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'background' }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'background' }), true)).toBe(false)
    for (const status of ['ready', 'finished', 'watching', 'waiting', 'signin', 'stopped', 'error'] as const) expect(agentBusy(nowOf({ status }), false)).toBe(false)
  })

  it('what it did: finished, waits for the user, stopped, in error, or never took the prompt it was typed', () => {
    expect(agentEvent(nowOf(), undefined, false)).toBeNull()
    expect(agentEvent(nowOf({ status: 'finished' }), undefined, false)).toBe('finished')
    expect(agentEvent(nowOf({ status: 'watching' }), undefined, false)).toBe('finished')
    expect(agentEvent(nowOf({ status: 'waiting' }), undefined, false)).toBe('waiting')
    expect(agentEvent(nowOf({ status: 'signin' }), undefined, false)).toBe('waiting')
    expect(agentEvent(nowOf({ status: 'stopped', runId: null }), undefined, false)).toBe('stopped')
    expect(agentEvent(nowOf({ status: 'error' }), undefined, false)).toBe('error')
    const typed = { runId: 'r1', prompts: 1, pending: true, seq: 0 }
    expect(agentEvent(nowOf({ status: 'ready', prompts: 1 }), typed, false)).toBe('untaken')
    expect(agentEvent(nowOf({ status: 'finished', prompts: 2 }), typed, false)).toBe('finished')
  })

  it('the wake line names each agent with the start of its reply, within the size; the limit line says to check on it', () => {
    expect(agentWakeLine([{ agent: b6, event: 'finished', now: nowOf({ status: 'finished', reply: 'The installer for Reinstall 12 is built.\nMore.' }) }])).toBe(
      '[Hive] B6 (hive) finished: "The installer for Reinstall 12 is built. More.". Your agent watch has ended: carry on (hive_agent_activity for more).'
    )
    const two = agentWakeLine([
      { agent: b6, event: 'waiting', now: nowOf({ status: 'waiting', statusMessage: 'Allow Bash: npm run dist?' }) },
      { agent: { ...b6, agentId: 'b7', name: 'B7' }, event: 'stopped', now: nowOf({ status: 'stopped' }) }
    ])
    expect(two).toBe('[Hive] B6 (hive) is waiting for the user: "Allow Bash: npm run dist?"; B7 (hive) stopped. Your agent watch has ended: carry on (hive_agent_activity for more).')
    // Long replies from many agents: cut, never past the line's limit, one line.
    const many = agentWakeLine(Array.from({ length: 20 }, (_, i) => ({ agent: { ...b6, agentId: `a${i}`, name: `Agent ${i}` }, event: 'finished' as const, now: nowOf({ status: 'finished', reply: '評'.repeat(500) }) })))
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(many).not.toMatch(/\n/)
    expect(many).toContain('Agent 19')
    expect(agentPart(b6, 'finished', nowOf({ status: 'watching', watch: 'Waiting for #12 → Review' }))).toBe('B6 (hive) finished (now waiting for #12 → Review)')
    expect(agentPart(b6, 'finished', nowOf({ status: 'ready', backgroundTasks: 2 }), 200, true)).toBe('B6 (hive) is idle (2 background tasks still running)')
    expect(agentPart(b6, 'untaken', nowOf({ status: 'ready' }))).toBe("B6 (hive) is idle: its CLI hasn't taken the prompt it was typed")
    expect(agentLimitLine({ agents: [b6], ignoreBackground: false }, 120)).toMatch(/^\[Hive\] B6 is still working after 2 h: your agent watch has ended\. Check on it \(hive_agent_activity\)/)
    expect(agentWatchLabel({ agents: [b6, { ...b6, agentId: 'b7', name: 'B7' }], ignoreBackground: false })).toBe('Waiting for B6, B7 to finish')
  })

  it('a saved condition is checked in full', () => {
    expect(readSavedAgentCondition({ agents: [b6], ignoreBackground: false })).toEqual({ agents: [b6], ignoreBackground: false })
    expect(readSavedAgentCondition({ agents: [], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [b6, b6], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [{ ...b6, name: '' }], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [b6] })).toBeNull()
  })

  it('the tool reply: a watch begun (and the card watch it replaced), already, cancelled', () => {
    expect(agentWatchText({ watching: 'Waiting for B6 to finish', limitAt: '2026-10-08T14:00:00.000Z' })).toBe(
      'Waiting for B6 to finish. End your turn now: Hive types a line into this session when one finishes, waits for the user or stops, or at 2026-10-08T14:00:00.000Z if none does. Nothing runs meanwhile.'
    )
    expect(agentWatchText({ watching: 'Waiting for B6 to finish', limitAt: 'x', replaced: 'Waiting for #12 → Review' })).toMatch(/It replaces your card watch \(waiting for #12 → Review\)\.$/)
    expect(agentWatchText({ already: ['B6 (hive) is idle: "Done."'] })).toBe('Already: B6 (hive) is idle: "Done.".')
    expect(agentWatchText({ done: 'Cancelled your agent watch.' })).toBe('Cancelled your agent watch.')
  })
})

describe('agent watches (main/watches.ts)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hive-agentwatch-'))
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  watches.testHooks.settleMs = 0
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    const beta = join(path, 'beta')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    mkdirSync(join(beta, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Second' }] }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Other' }] }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, alpha, beta }
  }
  /** Stand-in sessions: the watcher a1 (its status, the user typing, what Hive typed) and the agents it watches. */
  const fake = (alpha: string) => {
    const state = { status: 'watching' as string, typing: false, typed: [] as string[], agents: new Map<string, AgentNow | null>() }
    const is = (p: string, id: string, want: string) => p.toLowerCase() === alpha.toLowerCase() && id === want
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (is(p, id, 'a1') ? ({ projectPath: alpha, agentId: 'a1', status: state.status } as never) : null),
      agentNow: (p: string, id: string) => {
        const a = p.toLowerCase() === alpha.toLowerCase() ? state.agents.get(id) : undefined
        return a ? { statusMessage: null, backgroundTasks: 0, reply: null, ...a } : null
      },
      userMayBeTyping: () => state.typing,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        state.typed.push(text)
        state.status = 'working'
      },
      watchChanged: () => undefined
    })
    return state
  }
  const reviewer = (alpha: string) => ({ projectPath: alpha, agentId: 'a2', name: 'Reviewer', project: 'alpha' })
  const second = (alpha: string) => ({ projectPath: alpha, agentId: 'a3', name: 'Second', project: 'alpha' })
  /** An agent's new state, told to the watches as its status event is in Hive (noteAgentStatus). */
  const move = (st: ReturnType<typeof fake>, alpha: string, id: string, now: AgentNow) => {
    st.agents.set(id, now)
    watches.noteAgentStatus({ projectPath: alpha, agentId: id, status: now.status, runId: now.runId ?? '', statusMessage: now.statusMessage ?? undefined } as never)
  }

  it('an agent that finished and is working again by the time the line is typed is still in it, with the one that finished since', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    move(st, alpha, 'a3', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    // The watcher works (the user gave it something): the line waits.
    st.status = 'working'
    move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'First done.' }))
    await watches.evaluateAgentWatches(w)
    move(st, alpha, 'a2', nowOf({ prompts: 2 }))
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Second done.' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual([])
    st.status = 'watching'
    await watches.tick()
    expect(st.typed).toEqual(['[Hive] Reviewer (alpha) finished: "First done." (working again now); Second (alpha) finished: "Second done.". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    await disposeWorkspaceService(w)
  })

  it('a restarted agent becoming ready is no finished turn: a watch after it is given a task waits for that task (round 2 finding)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    st.agents.set('a2', null)
    watches.noteAgentStatus({ projectPath: alpha, agentId: 'a2', status: 'stopped', runId: '' } as never)
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/^\[Hive\] Reviewer \(alpha\) stopped\. /)
    // Restarted (starting, then ready), then given its next task (typed, not taken yet), then watched again.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'starting', runId: 'r2', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 0, pending: true }))
    expect('watching' in (await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false }))).toBe(true)
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    // It takes the task and finishes it: one line, now.
    move(st, alpha, 'a2', nowOf({ runId: 'r2', prompts: 1 }))
    move(st, alpha, 'a2', nowOf({ status: 'finished', runId: 'r2', prompts: 1, reply: 'Task done.' }))
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2))
    expect(st.typed[1]).toBe('[Hive] Reviewer (alpha) finished: "Task done.". Your agent watch has ended: carry on (hive_agent_activity for more).')
    // A card watch it starts while idle (finished, then watching, with no turn) isn't a finished turn either.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ runId: 'r2', prompts: 2 }))
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 2, pending: true }))
    expect(st.typed).toHaveLength(2)
    await disposeWorkspaceService(w)
  })

  it('a startup question or sign-in before any turn is no finished turn; a turn interrupted while it asks still is (round 3 finding)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const watch = () => watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    // Starting, it asks to trust its folder: the watcher is told that (it waits for the user).
    move(st, alpha, 'a2', nowOf({ status: 'starting', runId: 'r1', prompts: 0 }))
    await watch()
    move(st, alpha, 'a2', nowOf({ status: 'waiting', runId: 'r1', prompts: 0, statusMessage: 'Trust this folder?' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is waiting for the user: "Trust this folder\?"/)
    // The user answers it (ready, no turn ran), and Hive gives it a task: watched again, nothing is told yet.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0, pending: true }))
    expect('watching' in (await watch())).toBe(true)
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    // A sign-in refused before any turn, then signed in again (ready): still nothing.
    move(st, alpha, 'a2', nowOf({ status: 'signin', runId: 'r1', prompts: 0 }))
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2))
    expect(st.typed[1]).toMatch(/waiting for the user to sign in/)
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0, pending: true }))
    await watch()
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(2)
    // The task runs while the watcher works; it asks for a permission and is interrupted there (ready): that turn's end
    // is what the line tells once the watcher is idle.
    st.status = 'working'
    move(st, alpha, 'a2', nowOf({ runId: 'r1', prompts: 1 }))
    move(st, alpha, 'a2', nowOf({ status: 'waiting', runId: 'r1', prompts: 1, statusMessage: 'Allow Bash?' }))
    await watches.evaluateAgentWatches(w)
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 1, reply: 'Interrupted.' }))
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.typed).toHaveLength(3))
    expect(st.typed[2]).toMatch(/^\[Hive\] Reviewer \(alpha\) finished: "Interrupted\."/)
    await disposeWorkspaceService(w)
  })

  it("a wake's next watch counts what happened in between: an agent that finished and took new work meanwhile fires it at once", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    move(st, alpha, 'a3', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'First done.' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/^\[Hive\] Reviewer \(alpha\) finished: "First done."\. /)
    // While the watcher reads that wake (working), Second finishes and is given new work; Reviewer too.
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Second done.' }))
    move(st, alpha, 'a3', nowOf({ prompts: 2 }))
    move(st, alpha, 'a2', nowOf({ prompts: 2 }))
    st.status = 'watching'
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    expect('watching' in r).toBe(true)
    // Second's finish is told (the watch's own check, as it starts, may be typing it); Reviewer's, already told, isn't.
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2))
    expect(st.typed[1]).toBe('[Hive] Second (alpha) finished: "Second done." (working again now). Your agent watch has ended: carry on (hive_agent_activity for more).')
    // Nothing new since that wake: the next watch waits.
    st.status = 'watching'
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(2)
    expect(watches.watchFor(alpha, 'a1')?.label).toBe('Waiting for Reviewer, Second to finish')
    await disposeWorkspaceService(w)
  })

  it('fires once when the agent finishes, with its reply; the watch ends; agents not working are the answer at once', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(r).toMatchObject({ watching: { label: 'Waiting for Reviewer to finish', agents: ['Reviewer'], cards: [] } })
    expect(watches.watchFor(alpha, 'a1')?.agents).toEqual(['Reviewer'])
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual([])
    st.agents.set('a2', nowOf({ status: 'finished', reply: 'All checks pass.' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual(['[Hive] Reviewer (alpha) finished: "All checks pass.". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    st.status = 'watching'
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    // Idle now: the answer at once, and no watch.
    const again = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(again).toEqual({ already: ['Reviewer (alpha) is idle: "All checks pass."'] })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it('nothing is typed while the watcher works or the user types there; it is typed once both are done', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    st.status = 'working'
    st.agents.set('a2', nowOf({ status: 'waiting', statusMessage: 'Allow Bash?' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual([])
    st.status = 'watching'
    st.typing = true
    await watches.tick()
    expect(st.typed).toEqual([])
    st.typing = false
    await watches.tick()
    expect(st.typed).toEqual(['[Hive] Reviewer (alpha) is waiting for the user: "Allow Bash?". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    await disposeWorkspaceService(w)
  })

  it('a stop, a prompt typed but not taken, background tasks, the limit and cancel', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const watch = (ignoreBackground = false, limit?: number) => watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground }, limit)
    // Stopped.
    st.agents.set('a2', nowOf())
    await watch()
    st.agents.set('a2', null)
    await watches.evaluateAgentWatches(w)
    expect(st.typed.pop()).toMatch(/^\[Hive\] Reviewer \(alpha\) stopped\. /)
    // Just given a task, its CLI hasn't taken it yet: working, not already idle; never taken, told so.
    st.status = 'watching'
    st.agents.set('a2', nowOf({ status: 'ready', pending: true }))
    expect('watching' in (await watch())).toBe(true)
    st.agents.set('a2', nowOf({ status: 'ready', pending: false }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed.pop()).toMatch(/Reviewer \(alpha\) is idle: its CLI hasn't taken the prompt it was typed/)
    // Background tasks count as working, unless ignored.
    st.status = 'watching'
    st.agents.set('a2', nowOf())
    await watch()
    st.agents.set('a2', nowOf({ status: 'background', backgroundTasks: 1 }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual([])
    await watch(true)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // The limit, with nothing done.
    st.agents.set('a2', nowOf())
    await watch(false, 30)
    await watches.tick(Date.now() + 29 * 60_000)
    expect(st.typed).toEqual([])
    await watches.tick(Date.now() + 31 * 60_000)
    expect(st.typed.pop()).toMatch(/^\[Hive\] Reviewer is still working after 30 min: your agent watch has ended/)
    // Cancel.
    st.status = 'watching'
    await watch()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    st.agents.set('a2', nowOf({ status: 'finished' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('kept in the workspace across a reload; replaces a card watch and is replaced by one; only its own project, never itself', async () => {
    const { w, alpha, beta } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, { kind: 'user' }))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(r).toMatchObject({ replaced: `Waiting for #${c.number}` })
    // Read back from the file.
    watches.forgetWatches(w)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await new Promise((res) => setTimeout(res, 50))
    expect(watches.watchFor(alpha, 'a1')?.label).toBe('Waiting for Reviewer to finish')
    st.agents.set('a2', nowOf({ status: 'finished' }))
    await watches.evaluateAgentWatches(w)
    expect(st.typed).toHaveLength(1)
    // A card watch replaces it.
    st.status = 'watching'
    st.agents.set('a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    // Itself: refused. Another project's agent: watched (its status is open), but what it said isn't told to a
    // project agent (its conversation holds that project's cards).
    await expect(watches.registerAgentWatch(w, alpha, 'a1', { agents: [{ projectPath: alpha, agentId: 'a1', name: 'Builder', project: 'alpha' }], ignoreBackground: false })).rejects.toThrow(/yourself/)
    const other = { projectPath: beta, agentId: 'b1', name: 'Other', project: 'beta' }
    const agentNow = sessions.agentNow
    sessions.agentNow = (p: string, id: string) => (id === 'b1' ? { status: 'finished', runId: 'r2', prompts: 1, pending: false, statusMessage: null, backgroundTasks: 0, reply: 'Card #9 is done.' } : agentNow(p, id))
    try {
      expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [other], ignoreBackground: false })).toEqual({ already: ['Other (beta) is idle'] })
    } finally {
      sessions.agentNow = agentNow
    }
    await disposeWorkspaceService(w)
  })
})
