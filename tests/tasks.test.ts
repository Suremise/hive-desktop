// The task board (.hive/tasks) and removing projects: who may change what, card numbers and order, and what Hide,
// Remove from Hive and Delete do with a project's cards, handovers and folder (and what restoring brings back).
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'

const base = mkdtempSync(join(tmpdir(), 'hive-tasks-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, for tests: gone.
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p) => rm(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { newSinceStart, restoreOrders, workStartedAt } = await import('../src/shared/tasks')
const { decisionNotice, noteCardRead } = await import('../src/main/decisionNotices')
const removal = await import('../src/main/projectRemoval')
const { sessions } = await import('../src/main/sessions')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const agent = { kind: 'agent', name: 'Agent 1 (alpha)' } as const
const assistant = { kind: 'assistant' } as const

function project(ws: string, name: string, agents: { id: string; name: string }[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.hive'), { recursive: true })
  writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

function handover(ws: string, file: string, projectName: string): void {
  writeFileSync(join(ws, '.hive', 'shared', 'handovers', file), `# Title\n\n- **Project:** ${projectName}\n\nBody\n`)
}

async function open(path: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(path)
  return w
}

describe('task board', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  beforeAll(async () => {
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    project(wsPath, 'beta')
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  it('numbers cards and never reuses a number', async () => {
    const a = await run(() => tasks.createTask({ title: 'First', project: 'alpha' }, user))
    const b = await run(() => tasks.createTask({ title: 'Second', project: 'ALPHA' }, agent))
    expect([a.number, b.number]).toEqual([1, 2])
    expect(b.project).toBe('alpha')
    expect(b.createdBy).toBe('Agent 1 (alpha)')
    await run(() => tasks.deleteTask(2))
    const c = await run(() => tasks.createTask({ title: 'Third' }, user))
    expect(c.number).toBe(3)
    expect(c.project).toBe('')
  })

  it('checks projects, agents and card references', async () => {
    await expect(run(() => tasks.createTask({ title: 'x', project: 'nope' }, user))).rejects.toThrow(/Unknown project/)
    await expect(run(() => tasks.createTask({ title: 'x', project: 'beta', agent: 'Agent 1' }, user))).rejects.toThrow(/Unknown agent/)
    await expect(run(() => tasks.createTask({ title: ' ' }, user))).rejects.toThrow(/title/)
    await expect(run(() => tasks.updateTask(1, { blockedBy: [1] }, user))).rejects.toThrow(/itself/)
    await expect(run(() => tasks.updateTask(1, { blockedBy: [99] }, user))).rejects.toThrow(/no card #99/)
    const given = await run(() => tasks.updateTask(1, { agent: 'agent 1' }, user))
    expect(given.agent).toBe('a1')
    expect(given.agentName).toBe('Agent 1')
    // Another project: its agent doesn't come along.
    const moved = await run(() => tasks.updateTask(1, { project: 'beta' }, user))
    expect(moved.agent).toBeNull()
    await run(() => tasks.updateTask(1, { project: 'alpha' }, user))
  })

  it("anyone moves cards into and out of Done; archived cards stay the user's", async () => {
    const c = await run(() => tasks.createTask({ title: 'Done-ish', project: 'alpha' }, agent))
    // A new card starts in Done only from the user.
    await expect(run(() => tasks.createTask({ title: 'x', column: 'done' }, agent))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    await run(() => tasks.updateTask(c.number, { column: 'review' }, agent))
    expect((await run(() => tasks.updateTask(c.number, { column: 'done' }, agent))).column).toBe('done')
    // Back out of Done, by an agent, the Assistant or the user, with no special step.
    expect((await run(() => tasks.updateTask(c.number, { column: 'review' }, agent))).column).toBe('review')
    expect((await run(() => tasks.updateTask(c.number, { column: 'done' }, assistant))).column).toBe('done')
    const back = await run(() => tasks.updateTask(c.number, { column: 'doing' }, user))
    expect(back.column).toBe('doing')
    const moves = back.history.filter((h) => h.what.startsWith('Moved to')).map((h) => `${h.by}: ${h.what}`)
    expect(moves).toEqual(['Agent 1 (alpha): Moved to Review', 'Agent 1 (alpha): Moved to Done', 'Agent 1 (alpha): Moved to Review', 'Assistant: Moved to Done', 'You: Moved to Doing'])
    await run(() => tasks.archiveTask(c.number, true))
    await expect(run(() => tasks.commentTask(c.number, 'hi', agent))).rejects.toThrow(/archived/)
    await expect(run(() => tasks.updateTask(c.number, { title: 'x' }, agent))).rejects.toThrow(/archived/)
    const restored = await run(() => tasks.archiveTask(c.number, false))
    expect(restored.archived).toBe(false)
    expect(restored.history.map((h) => h.what)).toEqual(expect.arrayContaining(['Moved to Review', 'Moved to Done', 'Archived', 'Brought back from the archive']))
    expect(restored.history.find((h) => h.what === 'Moved to Review')?.by).toBe('Agent 1 (alpha)')
  })

  it('orders cards in a column and moves them before another', async () => {
    const a = await run(() => tasks.createTask({ title: 'A', column: 'todo' }, user))
    const b = await run(() => tasks.createTask({ title: 'B', column: 'todo' }, user))
    const c = await run(() => tasks.createTask({ title: 'C', column: 'todo' }, user))
    await run(() => tasks.updateTask(c.number, { before: a.number }, user))
    const todo = (await run(() => tasks.listTasks({ column: 'todo' }))).filter((t) => [a.number, b.number, c.number].includes(t.number))
    expect(todo.map((t) => t.title)).toEqual(['C', 'A', 'B'])
    await run(() => tasks.updateTask(a.number, { column: 'review', before: null }, user))
    expect((await run(() => tasks.getTask(a.number))).column).toBe('review')
  })

  describe('agents putting cards in order', () => {
    const titles = async (column: 'todo' | 'review', only: number[]): Promise<string[]> =>
      (await run(() => tasks.listTasks({ column }))).filter((t) => only.includes(t.number)).map((t) => t.title)
    const make = async (names: string[]) => {
      const out = []
      for (const title of names) out.push(await run(() => tasks.createTask({ title }, user)))
      return out
    }
    const last = async (n: number): Promise<string> => (await run(() => tasks.getTask(n))).history.at(-1)!.what

    it('puts a card at the top, the bottom or before another, and says so in its history', async () => {
      const [p, q, r] = await make(['P', 'Q', 'R'])
      const ns = [p.number, q.number, r.number]
      await run(() => tasks.updateTask(r.number, { position: 'top' }, agent))
      expect(await titles('todo', ns)).toEqual(['R', 'P', 'Q'])
      expect(await last(r.number)).toBe('Moved to the top of Todo')
      expect((await run(() => tasks.listTasks({ column: 'todo' })))[0].number).toBe(r.number)
      await run(() => tasks.updateTask(r.number, { position: 'bottom' }, assistant))
      expect(await titles('todo', ns)).toEqual(['P', 'Q', 'R'])
      expect(await last(r.number)).toBe('Moved to the bottom of Todo')
      await run(() => tasks.updateTask(q.number, { before: p.number }, agent))
      expect(await titles('todo', ns)).toEqual(['Q', 'P', 'R'])
      expect(await last(q.number)).toBe(`Moved before #${p.number} in Todo`)
      // Already there: no line.
      const lines = (await run(() => tasks.getTask(q.number))).history.length
      await run(() => tasks.updateTask(q.number, { before: p.number }, agent))
      expect((await run(() => tasks.getTask(q.number))).history.length).toBe(lines)
      // With a column change, one line says both.
      await run(() => tasks.updateTask(p.number, { column: 'review', position: 'top' }, agent))
      expect((await run(() => tasks.listTasks({ column: 'review' })))[0].number).toBe(p.number)
      expect(await last(p.number)).toBe('Moved to the top of Review')
      await run(() => tasks.updateTask(r.number, { column: 'review', before: p.number }, agent))
      expect(await titles('review', [p.number, r.number])).toEqual(['R', 'P'])
      expect(await last(r.number)).toBe(`Moved to Review, before #${p.number}`)
      // The user's drags stay out of the history.
      const userLines = (await run(() => tasks.getTask(r.number))).history.length
      await run(() => tasks.updateTask(r.number, { position: 'bottom' }, user))
      expect((await run(() => tasks.getTask(r.number))).history.length).toBe(userLines)
      for (const n of ns) await run(() => tasks.deleteTask(n))
    })

    it('refuses a place it can not honour', async () => {
      const a = await run(() => tasks.createTask({ title: 'A' }, user))
      const b = await run(() => tasks.createTask({ title: 'B', column: 'review' }, user))
      const d = await run(() => tasks.createTask({ title: 'D', column: 'done' }, user))
      await expect(run(() => tasks.updateTask(a.number, { before: b.number }, agent))).rejects.toThrow(`#${b.number} is in Review, not in Todo`)
      await expect(run(() => tasks.updateTask(a.number, { before: 99_999 }, agent))).rejects.toThrow('There is no card #99999')
      await expect(run(() => tasks.updateTask(a.number, { before: a.number }, agent))).rejects.toThrow("can't go before itself")
      await expect(run(() => tasks.updateTask(a.number, { before: b.number, position: 'top' }, agent))).rejects.toThrow('not both')
      await expect(run(() => tasks.updateTask(a.number, { position: 'middle' as never }, agent))).rejects.toThrow('Unknown position')
      await expect(run(() => tasks.updateTask(d.number, { position: 'top' }, agent))).rejects.toThrow(tasks.TaskPermissionError)
      // The Assistant, even when the user agreed to the move into Done, doesn't choose its place there.
      await expect(run(() => tasks.updateTask(b.number, { column: 'done', position: 'top' }, assistant))).rejects.toThrow('Only the user puts the cards in Done in order')
      // The user may (a drop whose card moved meanwhile goes to the end).
      await run(() => tasks.updateTask(d.number, { position: 'top' }, user))
      await run(() => tasks.updateTask(a.number, { before: b.number }, user))
      for (const n of [a.number, b.number, d.number]) await run(() => tasks.deleteTask(n))
    })

    it('puts a list of cards at the top of a column in one call, the rest keeping their order', async () => {
      const cards = await make(['1', '2', '3', '4', '5'])
      const ns = cards.map((c) => c.number)
      const [c1, c2, c3, c4, c5] = ns
      const list = await run(() => tasks.reorderTasks('todo', [c4, `#${c2}`, c1], agent))
      expect(list.filter((c) => ns.includes(c.number)).map((c) => c.title)).toEqual(['4', '2', '1', '3', '5'])
      expect(list[0].number).toBe(c4)
      expect(await last(c4)).toBe('Moved to the top of Todo')
      expect(await last(c2)).toBe('Placed 2nd in Todo')
      expect(await last(c1)).toBe('Placed 3rd in Todo')
      // Not moved: no line.
      expect(await last(c3)).toBe('Created in Todo')
      const b = await run(() => tasks.createTask({ title: 'B', column: 'review' }, user))
      await expect(run(() => tasks.reorderTasks('todo', [c5, b.number], agent))).rejects.toThrow(`#${b.number} is in Review, not in Todo`)
      await expect(run(() => tasks.reorderTasks('todo', [c5, c5], agent))).rejects.toThrow('listed twice')
      await expect(run(() => tasks.reorderTasks('todo', [], agent))).rejects.toThrow('cards:')
      await expect(run(() => tasks.reorderTasks('done', [c5], assistant))).rejects.toThrow(tasks.TaskPermissionError)
      // A failed list changes nothing.
      expect(await titles('todo', ns)).toEqual(['4', '2', '1', '3', '5'])
      for (const n of [...ns, b.number]) await run(() => tasks.deleteTask(n))
    })
  })

  it('says what a change did, for the hive tools to confirm it', async () => {
    const a = await run(() => tasks.createTask({ title: 'Said', project: 'alpha' }, agent))
    const b = await run(() => tasks.createTask({ title: 'Other', project: 'alpha' }, agent))
    const said: string[] = []
    await run(() => tasks.updateTask(a.number, { column: 'review', labels: ['bug'], blocked: 'needs a key' }, agent, { said }))
    expect(said).toEqual(['Moved to Review', 'Labels: bug', 'Blocked: needs a key'])
    // Nothing to do: nothing said.
    const none: string[] = []
    await run(() => tasks.updateTask(a.number, { column: 'review', blocked: 'needs a key' }, agent, { said: none }))
    expect(none).toEqual([])
    const placed: string[] = []
    await run(() => tasks.updateTask(b.number, { column: 'review', position: 'top' }, agent, { said: placed }))
    expect(placed).toEqual(['Moved to the top of Review'])
    for (const n of [a.number, b.number]) await run(() => tasks.deleteTask(n))
  })

  it("refuses a project agent moving another agent's card in Doing on to Review or Done; its own, and everyone else, may", async () => {
    const projectJson = join(wsPath, 'alpha', '.hive', 'project.json')
    const saved = readFileSync(projectJson, 'utf8')
    writeFileSync(projectJson, JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }, { id: 'a2', name: 'Agent 2' }] }))
    const a1 = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    const a2 = { kind: 'agent', name: 'Agent 2 (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' } as const
    const doing = () => run(() => tasks.createTask({ title: 'In progress', project: 'alpha', column: 'doing', agent: 'a1' }, user))
    const refused = async (n: number, patch: Parameters<typeof tasks.updateTask>[1]) => {
      const before = await run(() => tasks.getTask(n))
      const e = await run(() => tasks.updateTask(n, patch, a2)).then(() => null, (x: Error) => x)
      const after = await run(() => tasks.getTask(n))
      expect([after.column, after.agent, after.history.length]).toEqual([before.column, before.agent, before.history.length])
      return e
    }
    try {
      const c = await doing()
      for (const column of ['done', 'review'] as const) {
        const e = await refused(c.number, { column })
        expect(e).toBeInstanceOf(tasks.TaskConflictError)
        expect(e?.message).toMatch(/is in Doing with Agent 1, who is working on it: newer work is in progress/)
      }
      // Taking it and finishing it in one change: still refused (checked on the card as it was).
      expect(await refused(c.number, { agent: 'a2', column: 'done' })).toBeInstanceOf(tasks.TaskConflictError)
      expect(await refused(c.number, { column: 'done', comment: 'Looks good.' } as never)).toBeInstanceOf(tasks.TaskConflictError)
      // Other changes to it, and moving it back to Todo, aren't finishing it.
      expect((await run(() => tasks.updateTask(c.number, { labels: ['x'] }, a2))).labels).toEqual(['x'])

      // Its own agent, the user, the Assistant and a script with the workspace token (no own token) may.
      expect((await run(() => tasks.updateTask(c.number, { column: 'review' }, a1))).column).toBe('review')
      for (const who of [user, assistant, agent]) {
        const d = await doing()
        expect((await run(() => tasks.updateTask(d.number, { column: 'done' }, who))).column).toBe('done')
      }
      // A card in Doing with no agent isn't anyone's work in progress.
      const loose = await run(() => tasks.createTask({ title: 'Nobody', project: 'alpha', column: 'doing', agent: '' }, user))
      expect((await run(() => tasks.updateTask(loose.number, { column: 'done' }, a2))).column).toBe('done')

      // The stale review: a2 reviews, a1 takes the card back for more work (ending the review), and a2's verdict and a
      // plain move to Done are both refused. In Review, a2 may move it to Done (when the user said so).
      const r = await run(() => tasks.createTask({ title: 'Reviewed', project: 'alpha', column: 'review', agent: 'a1' }, user))
      await run(() => tasks.updateTask(r.number, { review: 'start' }, a2))
      await run(() => tasks.updateTask(r.number, { column: 'doing' }, a1))
      await expect(run(() => tasks.updateTask(r.number, { review: 'passed', comment: 'Fine.' } as never, a2))).rejects.toThrow(/aren't reviewing/)
      expect(await refused(r.number, { column: 'done' })).toBeInstanceOf(tasks.TaskConflictError)
      await run(() => tasks.updateTask(r.number, { column: 'review' }, a1))
      expect((await run(() => tasks.updateTask(r.number, { column: 'done' }, a2))).column).toBe('done')

      // At the same time: a1 takes a card in Review back to Doing while a2 moves it to Done. Whichever goes first, the
      // card ends in Doing with a1: a2's move either came first (then a1's) or is refused.
      for (let i = 0; i < 5; i++) {
        const t = await run(() => tasks.createTask({ title: `Race ${i}`, project: 'alpha', column: 'review', agent: 'a1' }, user))
        const [, second] = await Promise.allSettled([run(() => tasks.updateTask(t.number, { column: 'doing' }, a1)), run(() => tasks.updateTask(t.number, { column: 'done' }, a2))])
        const end = await run(() => tasks.getTask(t.number))
        if (second.status === 'rejected') {
          expect(second.reason).toBeInstanceOf(tasks.TaskConflictError)
          expect([end.column, end.agent]).toEqual(['doing', 'a1'])
        } else expect(end.history.map((h) => h.what)).toContain('Moved to Done')
        expect(end.column).toBe('doing')
      }
    } finally {
      writeFileSync(projectJson, saved)
    }
  })

  it('gives a card an agent moves into Doing to that agent, when no agent is named', async () => {
    const me = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' } } as const
    const fresh = () => run(() => tasks.createTask({ title: 'Take me', project: 'alpha' }, user))

    const said: string[] = []
    const taken = await run(async () => tasks.updateTask((await fresh()).number, { column: 'doing' }, me, { said }))
    expect([taken.agent, taken.agentName, taken.column]).toEqual(['a1', 'Agent 1', 'doing'])
    expect(said).toEqual(['Given to Agent 1', 'Moved to Doing'])

    // Another agent's card, out of Doing (so nobody was working on it): taken, from each column, and said so.
    const projectJson = join(wsPath, 'alpha', '.hive', 'project.json')
    const saved = readFileSync(projectJson, 'utf8')
    writeFileSync(projectJson, JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }, { id: 'a2', name: 'Agent 2' }] }))
    try {
      const other = { kind: 'agent', name: 'Agent 2 (alpha)', self: { project: 'alpha', agentId: 'a2' } } as const
      for (const column of ['todo', 'review', 'done'] as const) {
        const held = await run(async () => tasks.updateTask((await fresh()).number, { agent: 'a1', column }, user))
        const moved: string[] = []
        const now = await run(() => tasks.updateTask(held.number, { column: 'doing' }, other, { said: moved }))
        expect([column, now.agent, now.column, moved]).toEqual([column, 'a2', 'doing', ['Given to Agent 2', 'Moved to Doing']])
        expect(now.history.slice(-2).map((h) => [h.by, h.what])).toEqual([
          ['Agent 2 (alpha)', 'Given to Agent 2'],
          ['Agent 2 (alpha)', 'Moved to Doing']
        ])
      }
      // Its own card: nothing to give.
      const mine = await run(async () => tasks.updateTask((await fresh()).number, { agent: 'a2', column: 'review' }, user))
      const back: string[] = []
      await run(() => tasks.updateTask(mine.number, { column: 'doing' }, other, { said: back }))
      expect(back).toEqual(['Moved to Doing'])
      // In Doing already, someone else's: a move or reorder within Doing leaves it theirs.
      const busy = await run(async () => tasks.updateTask((await fresh()).number, { agent: 'a1', column: 'doing' }, user))
      expect((await run(() => tasks.updateTask(busy.number, { column: 'doing', position: 'top' }, other))).agent).toBe('a1')
    } finally {
      writeFileSync(projectJson, saved)
    }
    // An agent named (or none, with empty) wins.
    const named = await run(async () => tasks.updateTask((await fresh()).number, { column: 'doing', agent: '' }, me))
    expect(named.agent).toBeNull()
    // The Assistant, the user, a plain Agent API caller and an agent of another project give it to nobody.
    for (const who of [assistant, user, agent, { kind: 'agent', name: 'B (beta)', self: { project: 'beta', agentId: 'b1' } } as const]) {
      expect((await run(async () => tasks.updateTask((await fresh()).number, { column: 'doing' }, who))).agent).toBeNull()
    }
    // Already in Doing: a move within it isn't taking it.
    expect((await run(() => tasks.updateTask(named.number, { position: 'top' }, me))).agent).toBeNull()

    // Created straight into Doing: the same.
    expect((await run(() => tasks.createTask({ title: 'Mine', project: 'alpha', column: 'doing' }, me))).agent).toBe('a1')
    expect((await run(() => tasks.createTask({ title: 'Todo', project: 'alpha' }, me))).agent).toBeNull()
    expect((await run(() => tasks.createTask({ title: 'Nobody', project: 'alpha', column: 'doing', agent: '' }, me))).agent).toBeNull()
    expect((await run(() => tasks.createTask({ title: 'Theirs', project: 'alpha', column: 'doing' }, assistant))).agent).toBeNull()

    for (const c of await run(() => tasks.allTasks())) if (['Take me', 'Mine', 'Todo', 'Nobody', 'Theirs'].includes(c.title)) await run(() => tasks.deleteTask(c.number))
  })

  it('drops references to a deleted card', async () => {
    const a = await run(() => tasks.createTask({ title: 'Base' }, user))
    const b = await run(() => tasks.createTask({ title: 'Depends', blockedBy: [a.number], links: [a.number] }, user))
    await run(() => tasks.deleteTask(a.number))
    const after = await run(() => tasks.getTask(b.number))
    expect(after.blockedBy).toEqual([])
    expect(after.links).toEqual([])
  })

  it('reads damaged card files safely', async () => {
    writeFileSync(join(wsPath, '.hive', 'tasks', '500.json'), JSON.stringify({ title: 7, column: 'sideways', labels: 'x', blockedBy: ['a', 3] }))
    writeFileSync(join(wsPath, '.hive', 'tasks', '501.json'), '{ not json')
    const c = await run(() => tasks.getTask(500))
    expect(c.column).toBe('todo')
    expect(c.title).toBe('Task 500')
    expect(c.labels).toEqual([])
    expect(c.blockedBy).toEqual([3])
    await expect(run(() => tasks.getTask(501))).rejects.toThrow(/Unknown task/)
    // Cards added by hand (or board.json lost): new cards get numbers past them, damaged ones too.
    expect((await run(() => tasks.createTask({ title: 'After' }, user))).number).toBe(502)
    rmSync(join(wsPath, '.hive', 'tasks', '500.json'))
    rmSync(join(wsPath, '.hive', 'tasks', '501.json'))
  })
  it('leaves out a reference to a card deleted as it was linked, and drops it from the file on the next save', async () => {
    const keep = await run(() => tasks.createTask({ title: 'Kept' }, user))
    const c = await run(() => tasks.createTask({ title: 'Linked' }, user))
    // As if the link was written just after #998 was deleted.
    const file = join(wsPath, '.hive', 'tasks', `${c.number}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), blockedBy: [998], links: [keep.number, 998] }))
    const read = await run(() => tasks.getTask(c.number))
    expect([read.blockedBy, read.links]).toEqual([[], [keep.number]])
    const listed = (await run(() => tasks.allTasks())).find((x) => x.number === c.number)!
    expect([listed.blockedBy, listed.links]).toEqual([[], [keep.number]])
    await run(() => tasks.commentTask(c.number, 'saved', agent))
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect([saved.blockedBy, saved.links]).toEqual([[], [keep.number]])
  })

  it('says which Doing cards nobody is working on', async () => {
    const { stalledReason } = await import('../src/shared/tasks')
    const card = { column: 'doing' as const, archived: false, agent: 'a2', agentName: 'Agent 2' }
    expect(stalledReason(card, { name: 'Agent 2', running: true })).toBeNull()
    expect(stalledReason(card, { name: 'Agent 2', running: false })).toBe("Agent 2 isn't running.")
    expect(stalledReason(card, null)).toBe('Agent 2 was removed.')
    expect(stalledReason({ ...card, agent: null }, null)).toMatch(/no agent/)
    expect(stalledReason({ ...card, column: 'review' }, null)).toBeNull()
    expect(stalledReason({ ...card, archived: true }, null)).toBeNull()
  })

  it("takes a removed agent's open cards back, and leaves its done ones", async () => {
    const { removeAgent } = await import('../src/main/projectAgents')
    const p = join(wsPath, 'alpha')
    await run(() => w.mutateProjectConfig(p, (now) => ({ agents: [...now.agents, { id: 'gone', name: 'Agent 9' }] })))
    const doing = await run(() => tasks.createTask({ title: 'Half done', project: 'alpha', agent: 'gone', column: 'doing' }, user))
    const review = await run(() => tasks.createTask({ title: 'To check', project: 'alpha', agent: 'gone', column: 'review' }, user))
    const done = await run(() => tasks.createTask({ title: 'Finished', project: 'alpha', agent: 'gone', column: 'done' }, user))
    const other = await run(() => tasks.createTask({ title: 'Not theirs', project: 'alpha', agent: 'a1', column: 'doing' }, user))
    expect((await run(() => tasks.agentCards('alpha', 'gone'))).map((c) => c.number)).toEqual([doing.number, review.number])
    await run(() => removeAgent(p, 'gone', { deleteWorktree: false, releaseCards: true }))
    const get = (n: number) => run(() => tasks.getTask(n))
    expect([(await get(doing.number)).column, (await get(doing.number)).agent]).toEqual(['todo', null])
    expect([(await get(review.number)).column, (await get(review.number)).agent]).toEqual(['review', null])
    expect((await get(done.number)).agent).toBe('gone')
    expect((await get(other.number)).agent).toBe('a1')
    expect((await get(doing.number)).history.map((h) => h.what)).toContain('Taken from Agent 9')
  })

  it('archives cards some days after they went into Done', async () => {
    const { config } = await import('../src/main/config')
    const day = 86_400_000
    const now = Date.now()
    const at = (daysAgo: number): string => new Date(now - daysAgo * day).toISOString()
    const make = async (title: string, history: { at: string; what: string }[], column = 'done'): Promise<number> => {
      const c = await run(() => tasks.createTask({ title }, user))
      const file = join(wsPath, '.hive', 'tasks', `${c.number}.json`)
      writeFileSync(file, JSON.stringify({ ...c, column, history: history.map((h) => ({ ...h, by: 'You' })), updatedAt: at(0) }))
      return c.number
    }
    const old = await make('Done long ago', [{ at: at(30), what: 'Created in Todo' }, { at: at(20), what: 'Moved to Done' }])
    const recent = await make('Done lately', [{ at: at(30), what: 'Moved to Done' }, { at: at(30), what: 'Moved to Review' }, { at: at(3), what: 'Moved to Done' }])
    const back = await make('Brought back', [{ at: at(40), what: 'Moved to Done' }, { at: at(1), what: 'Brought back from the archive' }])
    const review = await make('In Review', [{ at: at(40), what: 'Moved to Review' }], 'review')
    // Edited lately, but in Done for long: its edits don't count.
    const edited = await make('Edited', [{ at: at(15), what: 'Moved to Done' }, { at: at(0), what: 'Changed the description' }])

    config.settings.board.archiveDoneDays = 0
    expect(await tasks.archiveOldDone(w, now)).toEqual([])
    config.settings.board.archiveDoneDays = 14
    expect((await tasks.archiveOldDone(w, now)).sort((a, b) => a - b)).toEqual([old, edited])
    const card = await run(() => tasks.getTask(old))
    expect([card.archived, card.archivedFor, card.history.at(-1)?.what]).toEqual([true, 'done', 'Archived after 14 days in Done'])
    for (const n of [recent, back, review]) expect((await run(() => tasks.getTask(n))).archived).toBe(false)
    // Already archived: left as it is.
    expect(await tasks.archiveOldDone(w, now)).toEqual([])
  })
})

// Bulk archiving (#351): Archive All in a column and Archive All Cards, as batches that come back where they were.
describe('archiving in batches', () => {
  let w: WS
  const wsPath = join(base, 'ws-batch')
  beforeAll(async () => {
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    project(wsPath, 'beta')
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = async (title: string, column: 'todo' | 'done' | 'review' = 'todo'): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', column }, user))).number
  const column = async (col: 'todo' | 'done'): Promise<string[]> => (await run(() => tasks.listTasks({ column: col }))).map((c) => c.title)
  // What the board asked for: the whole board by default, nobody's cards included.
  const req = (label: string, more: Partial<Parameters<typeof tasks.archiveBatch>[1]> = {}): Parameters<typeof tasks.archiveBatch>[1] => ({ label, column: null, project: null, query: '', includeBusy: false, ...more })
  const cardFile = (n: number): string => join(wsPath, '.hive', 'tasks', `${n}.json`)

  it("is the user's alone: agents, scripts and the Assistant are refused", async () => {
    const n = await make('Mine')
    const own = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    for (const who of [agent, assistant, own]) {
      await expect(run(() => tasks.archiveBatch([n], req('All in Todo'), who))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    }
    await expect(run(() => tasks.unarchiveBatch('b1', agent))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    expect((await run(() => tasks.getTask(n))).archived).toBe(false)
    await expect(run(() => tasks.archiveBatch([], req('x'), user))).rejects.toThrow(/list the cards/)
    await expect(run(() => tasks.archiveBatch(['x'], req('x'), user))).rejects.toThrow(/card numbers/)
    await run(() => tasks.archiveTask(n, true))
  })

  it("records the batch, its columns as they were, and a line in each card's history", async () => {
    const [a, b, c, d] = [await make('A', 'done'), await make('B', 'done'), await make('C', 'done'), await make('D')]
    const already = await make('Already', 'done')
    await run(() => tasks.archiveTask(already, true))
    const { batch, archived, skipped } = await run(() => tasks.archiveBatch([a, c, d, already, 999], req('All Cards'), user))
    // In board order: Todo before Done.
    expect([archived, skipped]).toEqual([[d, a, c], []])
    expect(batch).toMatchObject({ by: 'You', label: 'All Cards', cards: [d, a, c], columns: { done: [a, b, c], todo: [d] } })
    const card = await run(() => tasks.getTask(c))
    expect([card.archived, card.archivedFor, card.archivedBatch, card.history.at(-1)?.what]).toEqual([true, 'user', batch!.id, 'Archived in a batch of 3 (All Cards)'])
    expect((await run(() => tasks.getTask(already))).archivedBatch).toBeUndefined()
    expect((await run(() => tasks.archiveBatches())).map((x) => x.id)).toContain(batch!.id)
    // Nothing left to archive: no batch.
    expect(await run(() => tasks.archiveBatch([a, already], req('All Cards'), user))).toEqual({ batch: null, archived: [], skipped: [] })
  })

  it('checks each card again as it archives it: still in the column, project and search shown, and nobody on it', async () => {
    const [plan, login, other, taken] = [await make('Plan'), await make('Login page'), await make('Other'), await make('Taken')]
    await run(() => tasks.updateTask(other, { project: 'beta' }, user))
    // Who is on a card, as main sees it now: here, any card in Doing with an agent.
    const busy = (c: { column: string; agent: string | null }): string | null => (c.column === 'doing' && c.agent ? 'Agent 1 is working on it' : null)
    await run(() => tasks.updateTask(taken, { column: 'doing', agent: 'a1' }, user))
    const r = await run(() => tasks.archiveBatch([plan, login, other], req('2 shown in Todo', { column: 'todo', project: 'alpha', query: 'login' }), user, { busy }))
    expect(r.archived).toEqual([login])
    expect(r.skipped).toEqual([
      { number: plan, why: 'no longer matches the search' },
      { number: other, why: 'moved to another project' }
    ])
    expect(r.batch!.cards).toEqual([login])
    // A card an agent is on stays unless the user includes it.
    const kept = await run(() => tasks.archiveBatch([taken], req('All Cards'), user, { busy }))
    expect([kept.batch, kept.archived, kept.skipped]).toEqual([null, [], [{ number: taken, why: 'Agent 1 is working on it' }]])
    expect((await run(() => tasks.getTask(taken))).archived).toBe(false)
    const included = await run(() => tasks.archiveBatch([taken], req('All Cards', { includeBusy: true }), user, { busy }))
    expect(included.archived).toEqual([taken])
  })

  it('a card an agent takes while the archive waits is left on the board (race)', async () => {
    const [idle, alsoIdle] = [await make('Idle'), await make('Also idle')]
    const busy = (c: { column: string; agent: string | null }): string | null => (c.column === 'doing' && c.agent ? 'Agent 1 is working on it' : null)
    // The agent takes the card (under its lock) just as the archive, sent for it as idle, reaches it.
    const [, inTodo] = await Promise.all([run(() => tasks.updateTask(idle, { column: 'doing', agent: 'a1' }, user)), run(() => tasks.archiveBatch([idle], req('All in Todo', { column: 'todo' }), user, { busy }))])
    expect([inTodo.archived, inTodo.skipped]).toEqual([[], [{ number: idle, why: 'moved to Doing' }]])
    const [, board] = await Promise.all([run(() => tasks.updateTask(alsoIdle, { column: 'doing', agent: 'a1' }, user)), run(() => tasks.archiveBatch([alsoIdle], req('All Cards'), user, { busy }))])
    expect([board.archived, board.skipped]).toEqual([[], [{ number: alsoIdle, why: 'Agent 1 is working on it' }]])
    for (const n of [idle, alsoIdle]) expect((await run(() => tasks.getTask(n))).archived).toBe(false)
  })

  it('brings a batch back to its columns and order; a card brought back on its own leaves it', async () => {
    const x = [await make('X1', 'done'), await make('X2', 'done'), await make('X3', 'done')]
    const keep = await make('Keep', 'done')
    const solo = await make('Solo', 'review')
    const shape = await column('done')
    const { batch } = await run(() => tasks.archiveBatch([x[0], x[2], solo], req('All Cards'), user))
    expect(await column('done')).toEqual(shape.filter((t) => t !== 'X1' && t !== 'X3'))
    // Moved on meanwhile: Keep goes to the top of Done; Solo comes back by itself.
    await run(() => tasks.updateTask(keep, { position: 'top' }, user))
    await run(() => tasks.archiveTask(solo, false))
    expect((await run(() => tasks.getTask(solo))).archivedBatch).toBeUndefined()
    const back = await run(() => tasks.unarchiveBatch(batch!.id, user))
    expect([back.restored.sort((p, q) => p - q), back.failed]).toEqual([[x[0], x[2]], []])
    // X1 after the card that was above it, X3 after X2: where they were among the cards still there.
    expect(await column('done')).toEqual(['Keep', ...shape.filter((t) => t !== 'Keep')])
    const card = await run(() => tasks.getTask(x[0]))
    expect([card.archived, card.archivedFor, card.archivedBatch, card.history.at(-1)?.what]).toEqual([false, undefined, undefined, 'Brought back with its batch (All Cards)'])
    // A batch is brought back once, then forgotten.
    expect((await run(() => tasks.archiveBatches())).map((b) => b.id)).not.toContain(batch!.id)
    await expect(run(() => tasks.unarchiveBatch(batch!.id, user))).rejects.toThrow(/no longer kept/)
  })

  it("keeps the batch while a card can't come back, and brings the rest; another try brings that one", async () => {
    const [ok, stuck] = [await make('Comes back', 'done'), await make('Stuck', 'done')]
    const { batch } = await run(() => tasks.archiveBatch([ok, stuck], req('All in Done', { column: 'done' }), user))
    // Its file can be read but not replaced (open in another program, read-only).
    chmodSync(cardFile(stuck), 0o444)
    try {
      const first = await run(() => tasks.unarchiveBatch(batch!.id, user))
      expect([first.restored, first.failed]).toEqual([[ok], [stuck]])
      expect((await run(() => tasks.getTask(stuck))).archived).toBe(true)
      expect((await run(() => tasks.archiveBatches())).map((b) => b.id)).toContain(batch!.id)
    } finally {
      chmodSync(cardFile(stuck), 0o666)
    }
    const again = await run(() => tasks.unarchiveBatch(batch!.id, user))
    expect([again.restored, again.failed]).toEqual([[stuck], []])
    expect(await column('done')).toEqual(expect.arrayContaining(['Comes back', 'Stuck']))
    expect((await run(() => tasks.archiveBatches())).map((b) => b.id)).not.toContain(batch!.id)
  }, 20_000)

  it('a card whose neighbours are gone comes back at the top; two batches at once each keep their cards', async () => {
    const [p, q, r] = [await make('P'), await make('Q'), await make('R')]
    const { batch } = await run(() => tasks.archiveBatch([q], req('1 shown in Todo'), user))
    // Every card that was around it goes (p and r among them); a new one comes.
    for (const c of await run(() => tasks.listTasks({ column: 'todo' }))) await run(() => tasks.archiveTask(c.number, true))
    expect([(await run(() => tasks.getTask(p))).archived, (await run(() => tasks.getTask(r))).archived]).toEqual([true, true])
    await make('New')
    await run(() => tasks.unarchiveBatch(batch!.id, user))
    expect(await column('todo')).toEqual(['Q', 'New'])
    // Two at once (two windows): one after the other under the board's lock, both recorded, nothing lost.
    const [m, n] = [await make('M'), await make('N')]
    const [one, two] = await Promise.all([run(() => tasks.archiveBatch([m], req('one'), user)), run(() => tasks.archiveBatch([n], req('two'), user))])
    expect((await run(() => tasks.archiveBatches())).map((b) => b.id)).toEqual(expect.arrayContaining([one.batch!.id, two.batch!.id]))
    expect([(await run(() => tasks.getTask(m))).archivedBatch, (await run(() => tasks.getTask(n))).archivedBatch]).toEqual([one.batch!.id, two.batch!.id])
  })
})

// A card's decisions (#357): recorded by anyone for the user, changed or removed by the user only, kept under the
// card's lock and in its history; the flag an agent's reply gets when one is new to it.
describe('card decisions', () => {
  let w: WS
  const wsPath = join(base, 'ws-decisions')
  const alpha = join(wsPath, 'alpha')
  const coder = { kind: 'agent', name: 'Coder (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
  const reviewer = { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'r1' }, scope: 'alpha' } as const
  const betaAgent = { kind: 'agent', name: 'B (beta)', self: { project: 'beta', agentId: 'b1' }, scope: 'beta' } as const
  beforeAll(async () => {
    project(wsPath, 'alpha', [
      { id: 'a1', name: 'Coder' },
      { id: 'r1', name: 'Reviewer' }
    ])
    project(wsPath, 'beta', [{ id: 'b1', name: 'B' }])
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha' }, user))).number

  it('the user, the Assistant and agents record decisions, each decided by the user; history says who recorded what', async () => {
    const n = await make('Login page')
    await run(() => tasks.updateTask(n, { decision: '  Keep the old URL.  ' }, user))
    await run(() => tasks.updateTask(n, { decision: 'Option B for the layout.' }, assistant))
    const said: string[] = []
    const c = await run(() => tasks.updateTask(n, { decision: 'No new dependency.' }, coder, { said }))
    expect(said).toEqual(['Recorded a decision: "No new dependency."'])
    expect(c.decisions!.map((d) => [d.text, d.decidedBy, d.recordedBy])).toEqual([
      ['Keep the old URL.', 'user', 'You'],
      ['Option B for the layout.', 'user', 'Assistant'],
      ['No new dependency.', 'user', 'Coder (alpha)']
    ])
    expect(new Set(c.decisions!.map((d) => d.id)).size).toBe(3)
    expect(c.history.slice(-3).map((h) => [h.by, h.what])).toEqual([
      ['You', 'Recorded a decision: "Keep the old URL."'],
      ['Assistant', 'Recorded a decision: "Option B for the layout."'],
      ['Coder (alpha)', 'Recorded a decision: "No new dependency."']
    ])
    await expect(run(() => tasks.updateTask(n, { decision: '   ' }, coder))).rejects.toThrow(/decision is empty/)
    await expect(run(() => tasks.updateTask(n, { decision: 'x'.repeat(4001) }, coder))).rejects.toThrow(/too long/)
    // Another project's agent can't reach the card; an archived card is the user's.
    await expect(run(() => tasks.updateTask(n, { decision: 'Mine' }, betaAgent))).rejects.toThrow(`Unknown task #${n}`)
    const archived = await make('Archived')
    await run(() => tasks.archiveTask(archived, true))
    await expect(run(() => tasks.updateTask(archived, { decision: 'Late' }, coder))).rejects.toThrow(/archived/)
  })

  it('only the user changes or removes one, and the history keeps what it said', async () => {
    const n = await make('Wording')
    const [d] = (await run(() => tasks.updateTask(n, { decision: 'Say "workspace", not "folder".' }, coder))).decisions!
    for (const who of [coder, assistant, { kind: 'agent', name: 'Agent API' } as const]) {
      await expect(run(() => tasks.editDecision(n, d.id, 'Changed', who))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
      await expect(run(() => tasks.editDecision(n, d.id, null, who))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    }
    const changed = await run(() => tasks.editDecision(n, d.id, 'Say "workspace".', user))
    expect([changed.decisions![0].text, changed.decisions![0].recordedBy, !!changed.decisions![0].editedAt]).toEqual(['Say "workspace".', 'Coder (alpha)', true])
    expect(changed.history.at(-1)?.what).toBe('Changed a decision to "Say "workspace"." (was "Say "workspace", not "folder".")')
    await expect(run(() => tasks.editDecision(n, d.id, ' ', user))).rejects.toThrow(/remove it instead/)
    const removed = await run(() => tasks.editDecision(n, d.id, null, user))
    expect(removed.decisions).toBeUndefined()
    expect(removed.history.at(-1)?.what).toBe('Removed a decision: "Say "workspace"."')
    await expect(run(() => tasks.editDecision(n, d.id, null, user))).rejects.toThrow(/no longer on/)
  })

  it('two recorded at once are both kept (the card lock); damaged entries in the file are left out', async () => {
    const n = await make('Busy')
    await Promise.all([run(() => tasks.updateTask(n, { decision: 'One' }, coder)), run(() => tasks.updateTask(n, { decision: 'Two' }, assistant)), run(() => tasks.updateTask(n, { decision: 'Three' }, user))])
    expect((await run(() => tasks.getTask(n))).decisions!.map((d) => d.text).sort()).toEqual(['One', 'Three', 'Two'])
    const file = join(wsPath, '.hive', 'tasks', `${n}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...raw, decisions: [...raw.decisions, null, { text: 5 }, { text: 'By hand' }] }))
    const c = await run(() => tasks.getTask(n))
    expect(c.decisions!.map((d) => d.text)).toEqual([...raw.decisions.map((d: { text: string }) => d.text), 'By hand'])
    expect(c.decisions!.at(-1)).toMatchObject({ decidedBy: 'user', recordedBy: '' })
  })

  it("flags a decision new to the agent working on the card or reviewing it, until it reads the card", async () => {
    const me = { projectPath: alpha, agentId: 'a1' }
    const n = (await run(() => tasks.createTask({ title: 'Flagged', project: 'alpha', column: 'doing', agent: 'a1' }, user))).number
    const notice = (who = me, self = 'Coder (alpha)'): Promise<string | null> => decisionNotice(w, who, self)
    await new Promise((r) => setTimeout(r, 5))
    expect(await notice()).toBeNull()
    await run(() => tasks.updateTask(n, { decision: 'Use the old API.' }, user))
    expect(await notice()).toBe(`[Hive] #${n} has 1 new decision since you last read it: read the card (hive_read_task) at your next checkpoint.`)
    // Read in full: not new any more. Its own records never are.
    noteCardRead(me, n)
    expect(await notice()).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.updateTask(n, { decision: 'Recorded by me' }, coder))
    expect(await notice()).toBeNull()
    // Changed by the user since it read the card: new again. Another project's agent, or one not on the card, hears nothing.
    const mine = (await run(() => tasks.getTask(n))).decisions![0]
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.editDecision(n, mine.id, 'Use the old API, v2.', user))
    expect(await notice()).toMatch(new RegExp(`^\\[Hive\\] #${n} has 1 new decision`))
    expect(await notice({ projectPath: alpha, agentId: 'r1' }, 'Reviewer (alpha)')).toBeNull()
    // In Review with a reviewer: the reviewer hears of one recorded after its review began; the builder, out of Doing, doesn't.
    await run(() => tasks.updateTask(n, { column: 'review' }, coder))
    await run(() => tasks.updateTask(n, { review: 'start' }, reviewer))
    await new Promise((r) => setTimeout(r, 5))
    expect(await notice({ projectPath: alpha, agentId: 'r1' }, 'Reviewer (alpha)')).toBeNull()
    await run(() => tasks.updateTask(n, { decision: 'Mobile first.' }, assistant))
    expect(await notice({ projectPath: alpha, agentId: 'r1' }, 'Reviewer (alpha)')).toMatch(new RegExp(`#${n} has 1 new decision`))
    expect(await notice()).toBeNull()
  })

  it("flags the user's change to a decision the agent recorded itself", async () => {
    const me = { projectPath: alpha, agentId: 'a1' }
    const n = (await run(() => tasks.createTask({ title: 'Colour', project: 'alpha', column: 'doing', agent: 'a1' }, user))).number
    const [d] = (await run(() => tasks.updateTask(n, { decision: 'User chose blue.' }, coder))).decisions!
    noteCardRead(me, n)
    expect(await decisionNotice(w, me, 'Coder (alpha)')).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.editDecision(n, d.id, 'User now chooses green.', user))
    expect(await decisionNotice(w, me, 'Coder (alpha)')).toMatch(new RegExp(`#${n} has 1 new decision`))
    // Recorded by the agent before its work began and corrected by the user after: new too.
    await run(() => tasks.updateTask(n, { column: 'todo' }, user))
    const m = (await run(() => tasks.createTask({ title: 'Early', project: 'alpha' }, user))).number
    const [e] = (await run(() => tasks.updateTask(m, { decision: 'User chose tabs.' }, coder))).decisions!
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.updateTask(m, { column: 'doing', agent: 'a1' }, user))
    expect(await decisionNotice(w, me, 'Coder (alpha)')).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.editDecision(m, e.id, 'User now chooses spaces.', user))
    expect(await decisionNotice(w, me, 'Coder (alpha)')).toMatch(new RegExp(`#${m} has 1 new decision`))
    await run(() => tasks.updateTask(m, { column: 'todo' }, user))
  })

  it("a reviewer's next round: a decision recorded since its last read is flagged on the card back in Review, also after it starts the review", async () => {
    const rev = { projectPath: alpha, agentId: 'r1' }
    const n = (await run(() => tasks.createTask({ title: 'Round two', project: 'alpha', column: 'doing', agent: 'a1' }, user))).number
    // This card's part of the flag (cards of the tests before may have their own).
    const notice = async (): Promise<string | null> => ((await decisionNotice(w, rev, 'Reviewer (alpha)')) ?? '').match(new RegExp(`#${n} has \\d+ new decisions?`))?.[0] ?? null
    await run(() => tasks.updateTask(n, { decision: 'Keep it short.' }, user))
    await run(() => tasks.updateTask(n, { column: 'review' }, coder))
    // Round 1: the reviewer reads the card, reviews it and fails it.
    await run(() => tasks.updateTask(n, { review: 'start' }, reviewer))
    noteCardRead(rev, n)
    await run(() => tasks.updateTask(n, { review: 'failed' }, reviewer, { comment: 'Too long.' }))
    expect(await notice()).toBeNull()
    // Fixes, and a decision recorded meanwhile; back in Review for round 2, nobody reviewing yet.
    await run(() => tasks.updateTask(n, { column: 'doing' }, coder))
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.updateTask(n, { decision: 'Mobile first.' }, assistant))
    await run(() => tasks.updateTask(n, { column: 'review' }, coder))
    expect(await notice()).toMatch(new RegExp(`#${n} has 1 new decision`))
    // Starting round 2 doesn't make it read.
    await new Promise((r) => setTimeout(r, 5))
    await run(() => tasks.updateTask(n, { review: 'start' }, reviewer))
    expect(await notice()).toMatch(new RegExp(`#${n} has 1 new decision`))
    noteCardRead(rev, n)
    expect(await notice()).toBeNull()
    // Another agent that never reviewed it hears nothing.
    expect(await decisionNotice(w, { projectPath: alpha, agentId: 'zz' }, 'Other (alpha)')).toBeNull()
  })

  it('marks a decision recorded after work on the card started as new since start', () => {
    const card = { history: [{ at: '2026-10-07T10:00:00.000Z', by: 'You', what: 'Created in Todo' }] }
    expect(newSinceStart(card, { at: '2026-10-07T11:00:00.000Z' })).toBe(false)
    const started = { history: [...card.history, { at: '2026-10-07T10:30:00.000Z', by: 'B5 (hive)', what: 'Moved to Doing' }] }
    expect(workStartedAt(started)).toBe(Date.parse('2026-10-07T10:30:00.000Z'))
    expect(newSinceStart(started, { at: '2026-10-07T10:20:00.000Z' })).toBe(false)
    expect(newSinceStart(started, { at: '2026-10-07T11:00:00.000Z' })).toBe(true)
    expect(workStartedAt({ history: [{ at: '2026-10-07T09:00:00.000Z', by: 'You', what: 'Moved to the top of Doing' }] })).toBeGreaterThan(0)
  })
})

describe('where a batch comes back (restoreOrders)', () => {
  const live = (...xs: [number, number][]): { number: number; order: number }[] => xs.map(([number, order]) => ({ number, order }))
  const sorted = (l: { number: number; order: number }[], m: Map<number, number>): number[] =>
    [...l, ...[...m].map(([number, order]) => ({ number, order }))].sort((a, b) => a.order - b.order).map((c) => c.number)

  it('puts each card after the one above it, else before the one below it, else at the top', () => {
    const l = live([2, 2], [4, 4])
    expect(sorted(l, restoreOrders(l, [1, 2, 3, 4, 5], [1, 3, 5]))).toEqual([1, 2, 3, 4, 5])
    // The ones above gone: before the next one still there.
    const l2 = live([9, 1], [4, 5])
    expect(sorted(l2, restoreOrders(l2, [1, 2, 3, 4], [2, 3]))).toEqual([9, 2, 3, 4])
    // Every old neighbour gone: at the top, in their old order.
    const l3 = live([7, 1], [8, 2])
    expect(sorted(l3, restoreOrders(l3, [1, 2, 3], [1, 3]))).toEqual([1, 3, 7, 8])
    // An empty column.
    expect(sorted([], restoreOrders([], [5, 6], [6, 5]))).toEqual([5, 6])
  })
})

// A project agent (known by its own token) is confined to its project's cards; the user, the Assistant and scripts
// see the whole board.
describe("a project agent's board", () => {
  let w: WS
  const wsPath = join(base, 'ws-scope')
  const alphaAgent = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
  const script = { kind: 'agent', name: 'Agent API' } as const
  const n: Record<string, number> = {}
  beforeAll(async () => {
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    project(wsPath, 'beta', [{ id: 'b1', name: 'Agent B' }])
    w = await open(wsPath)
    // Todo, top to bottom: A1, B1, A2, B2, A3; and a workspace card and an archived beta card.
    for (const [k, proj] of [['A1', 'alpha'], ['B1', 'beta'], ['A2', 'alpha'], ['B2', 'beta'], ['A3', 'alpha'], ['W', ''], ['Bx', 'beta']]) {
      n[k] = (await inWorkspace(w, () => tasks.createTask({ title: k, project: proj }, user))).number
    }
    await inWorkspace(w, () => tasks.archiveTask(n.Bx, true))
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const titles = (cards: { title: string }[]): string[] => cards.map((c) => c.title)
  const betaOrders = async (): Promise<number[]> => (await run(() => tasks.listTasks({ project: 'beta' }))).map((c) => c.order)

  it('lists only its project, and refuses another project', async () => {
    expect(titles(await run(() => tasks.listTasks({ column: 'todo' })))).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'W'])
    expect(titles(await run(() => tasks.listTasks({ scope: 'alpha' })))).toEqual(['A1', 'A2', 'A3'])
    expect(titles(await run(() => tasks.listTasks({ project: 'alpha', scope: 'alpha' })))).toEqual(['A1', 'A2', 'A3'])
    await expect(run(() => tasks.listTasks({ project: 'beta', scope: 'alpha' }))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    expect(await run(() => tasks.listTasks({ archived: true, scope: 'alpha' }))).toEqual([])
  })

  it("another project's card, or the workspace's, is unknown to it: read, change, comment, move", async () => {
    expect((await run(() => tasks.readTask(n.A1, alphaAgent))).title).toBe('A1')
    for (const x of [n.B1, n.W, n.Bx]) {
      await expect(run(() => tasks.readTask(x, alphaAgent))).rejects.toThrow(`Unknown task #${x}`)
      await expect(run(() => tasks.updateTask(x, { column: 'review' }, alphaAgent))).rejects.toThrow(`Unknown task #${x}`)
      await expect(run(() => tasks.updateTask(x, { agent: null }, alphaAgent))).rejects.toThrow(`Unknown task #${x}`)
      await expect(run(() => tasks.commentTask(x, 'hi', alphaAgent))).rejects.toThrow(`Unknown task #${x}`)
    }
    // The same answer as for a card that doesn't exist (the archived one doesn't say "archived").
    await expect(run(() => tasks.readTask(999, alphaAgent))).rejects.toThrow('Unknown task #999')
    expect((await run(() => tasks.getTask(n.B1))).comments).toEqual([])
    // The Assistant and scripts reach every card.
    expect((await run(() => tasks.commentTask(n.B1, 'from the Assistant', assistant))).comments).toHaveLength(1)
    expect((await run(() => tasks.readTask(n.W, script))).title).toBe('W')
  })

  it('creates cards only in its project, which is the default', async () => {
    const c = await run(() => tasks.createTask({ title: 'Mine' }, alphaAgent))
    expect(c.project).toBe('alpha')
    await expect(run(() => tasks.createTask({ title: 'x', project: 'beta' }, alphaAgent))).rejects.toThrow(/only to your project \(alpha\)/)
    await expect(run(() => tasks.createTask({ title: 'x', project: '' }, alphaAgent))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    await expect(run(() => tasks.createTask({ title: 'x', blockedBy: [n.B1] }, alphaAgent))).rejects.toThrow(`there is no card #${n.B1}`)
    await run(() => tasks.deleteTask(c.number))
  })

  it("can't move a card out of its project", async () => {
    await expect(run(() => tasks.updateTask(n.A1, { project: 'beta' }, alphaAgent))).rejects.toThrow(/stay in your project \(alpha\)/)
    await expect(run(() => tasks.updateTask(n.A1, { project: '' }, alphaAgent))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    expect((await run(() => tasks.getTask(n.A1))).project).toBe('alpha')
  })

  it("sees other projects' linked cards as numbers, and keeps them when it changes the links", async () => {
    await run(() => tasks.updateTask(n.A2, { links: [n.B1], blockedBy: [n.B2] }, user))
    expect(await run(() => tasks.refsOutside([n.B1, n.A1], 'alpha'))).toEqual([n.B1])
    expect(await run(() => tasks.refsOutside([n.B1], null))).toEqual([])
    await expect(run(() => tasks.updateTask(n.A2, { links: [n.B2] }, alphaAgent))).rejects.toThrow(`there is no card #${n.B2}`)
    const c = await run(() => tasks.updateTask(n.A2, { links: [n.A1], blockedBy: [] }, alphaAgent))
    expect(c.links).toEqual([n.A1, n.B1])
    expect(c.blockedBy).toEqual([n.B2])
    await run(() => tasks.updateTask(n.A2, { links: [], blockedBy: [] }, user))
  })

  it("places and orders its cards among its project's, leaving other projects' cards as they are", async () => {
    const before = await betaOrders()
    await expect(run(() => tasks.updateTask(n.A1, { before: n.B2 }, alphaAgent))).rejects.toThrow(`There is no card #${n.B2}`)
    await run(() => tasks.updateTask(n.A3, { position: 'top' }, alphaAgent))
    expect(titles(await run(() => tasks.listTasks({ scope: 'alpha' })))).toEqual(['A3', 'A1', 'A2'])
    await run(() => tasks.updateTask(n.A3, { position: 'bottom' }, alphaAgent))
    expect(titles(await run(() => tasks.listTasks({ scope: 'alpha' })))).toEqual(['A1', 'A2', 'A3'])
    await expect(run(() => tasks.reorderTasks('todo', [n.A2, n.B1], alphaAgent))).rejects.toThrow(`There is no card #${n.B1}`)
    const listed = await run(() => tasks.reorderTasks('todo', [n.A3, n.A2], alphaAgent))
    expect(titles(listed)).toEqual(['A3', 'A2', 'A1'])
    expect(await betaOrders()).toEqual(before)
    // Still in the column where the project's cards were: below nothing it couldn't see before.
    expect(titles(await run(() => tasks.listTasks({ column: 'todo' })))[0]).toBe('A3')
  })

  it('a project change clears the agent, says so, and takes no agent with it', async () => {
    const t = await run(() => tasks.createTask({ title: 'Transfer', project: 'alpha', agent: 'a1' }, user))
    const moved = await run(() => tasks.updateTask(t.number, { project: 'beta' }, user))
    expect(moved.agent).toBeNull()
    expect(moved.agentName).toBeUndefined()
    expect(moved.history.slice(-2).map((h) => h.what)).toEqual(['Moved to beta', 'Taken from Agent 1 of alpha'])
    // An agent named in the same change doesn't come along (nor does it get round the rule).
    await expect(run(() => tasks.updateTask(t.number, { project: 'alpha', agent: 'a1' }, user))).rejects.toThrow(/project first, then give it/)
    await expect(run(() => tasks.updateTask(t.number, { project: 'alpha', agent: 'a1' }, assistant))).rejects.toThrow(/project first/)
    expect((await run(() => tasks.getTask(t.number))).project).toBe('beta')
    // Back, then given to an agent as a change of its own.
    await run(() => tasks.updateTask(t.number, { project: 'alpha' }, assistant))
    expect((await run(() => tasks.updateTask(t.number, { agent: 'a1' }, assistant))).agent).toBe('a1')
    // A project agent can't move it at all.
    await expect(run(() => tasks.updateTask(t.number, { project: 'beta' }, alphaAgent))).rejects.toBeInstanceOf(tasks.TaskPermissionError)
    await run(() => tasks.deleteTask(t.number))
  })

  it('authorises every write on the card as it is under its lock (a project change while a write waits)', async () => {
    const { withFileLock } = await import('../src/main/fsutil')
    const file = (x: number): string => join(wsPath, '.hive', 'tasks', `${x}.json`)
    // Someone (the user, the Assistant) moves the card to beta while the agent's write waits for the card.
    const toBeta = (x: number): void => {
      const c = JSON.parse(readFileSync(file(x), 'utf8'))
      writeFileSync(file(x), JSON.stringify({ ...c, project: 'beta', agent: null }))
    }
    const c1 = (await run(() => tasks.createTask({ title: 'C1', project: 'alpha' }, user))).number
    const c2 = (await run(() => tasks.createTask({ title: 'C2', project: 'alpha' }, user))).number
    const before2 = await run(() => tasks.getTask(c2))
    // A later card in a reorder: the first is written, the moved one is refused and left as it was.
    let reorder!: Promise<unknown>
    await withFileLock(file(c2), async () => {
      reorder = run(() => tasks.reorderTasks('todo', [c1, c2], alphaAgent))
      await new Promise((r) => setTimeout(r, 150))
      toBeta(c2)
    })
    await expect(reorder).rejects.toThrow(`Unknown task #${c2}`)
    const after2 = await run(() => tasks.getTask(c2))
    expect(after2.order).toBe(before2.order)
    expect(after2.history).toEqual(before2.history)
    // The first card in a reorder, an update and a comment, likewise.
    const before1 = await run(() => tasks.getTask(c1))
    // Each outcome is caught as it happens: they are refused together, once the card is free.
    let pending: Promise<unknown>[] = []
    await withFileLock(file(c1), async () => {
      pending = [
        run(() => tasks.reorderTasks('todo', [c1], alphaAgent)),
        run(() => tasks.updateTask(c1, { column: 'review', blocked: 'mine' }, alphaAgent)),
        run(() => tasks.commentTask(c1, 'mine', alphaAgent))
      ].map((p) => p.then(() => 'written', (e: Error) => e.message))
      await new Promise((r) => setTimeout(r, 150))
      toBeta(c1)
    })
    expect(await Promise.all(pending)).toEqual(Array(3).fill(`Unknown task #${c1}`))
    const after1 = await run(() => tasks.getTask(c1))
    expect([after1.column, after1.blocked, after1.comments.length, after1.order]).toEqual(['todo', null, 0, before1.order])
    expect(after1.history).toEqual(before1.history)
    for (const x of [c1, c2]) await run(() => tasks.deleteTask(x))
  })

  it('reads only the latest comment, as far as it may read the card', async () => {
    const l = (await run(() => tasks.createTask({ title: 'Long', description: 'x'.repeat(5000), project: 'alpha' }, user))).number
    expect(await run(() => tasks.latestComment(l, alphaAgent))).toEqual({ number: l, comment: null })
    await run(() => tasks.commentTask(l, 'first', user))
    await run(() => tasks.commentTask(l, 'second', assistant))
    await run(() => tasks.commentTask(l, 'third, '.repeat(400), alphaAgent))
    const got = await run(() => tasks.latestComment(l, alphaAgent))
    expect(Object.keys(got)).toEqual(['number', 'comment'])
    expect(got.comment?.by).toBe('Agent 1 (alpha)')
    expect(got.comment?.text).toBe('third, '.repeat(400).trim())
    expect(JSON.stringify(got)).not.toMatch(/first|second|xxxx/)
    // Equal times: the last added is the latest.
    const f = join(wsPath, '.hive', 'tasks', `${l}.json`)
    const c = JSON.parse(readFileSync(f, 'utf8'))
    writeFileSync(f, JSON.stringify({ ...c, comments: c.comments.map((x: { text: string }) => ({ ...x, at: '2026-10-02T10:00:00.000Z' })) }))
    expect((await run(() => tasks.latestComment(l, alphaAgent))).comment?.by).toBe('Agent 1 (alpha)')
    // Another project's card, the workspace's or a missing one: unknown to the agent, readable for the others.
    for (const x of [n.B1, n.W, 999]) await expect(run(() => tasks.latestComment(x, alphaAgent))).rejects.toThrow(`Unknown task #${x}`)
    expect((await run(() => tasks.latestComment(n.B1, assistant))).comment?.text).toBe('from the Assistant')
    expect(await run(() => tasks.latestComment(n.W, script))).toEqual({ number: n.W, comment: null })
    await run(() => tasks.deleteTask(l))
  })
})

describe('removing projects', () => {
  let w: WS
  const wsPath = join(base, 'ws2')
  beforeAll(async () => {
    project(wsPath, 'keep')
    project(wsPath, 'hide-me')
    project(wsPath, 'remove-me')
    project(wsPath, 'remove-me-too')
    project(wsPath, 'delete-me')
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const names = async (): Promise<string[]> => (await w.listProjectPaths()).map((p) => p.split(/[\\/]/).pop()!)

  it('hides a project and brings it back with its cards', async () => {
    const c = await run(() => tasks.createTask({ title: 'Hidden work', project: 'hide-me' }, user))
    const done = await run(() => tasks.createTask({ title: 'Already archived', project: 'hide-me' }, user))
    await run(() => tasks.archiveTask(done.number, true))
    await run(() => removal.removeProject(join(wsPath, 'hide-me'), 'hide'))
    expect(await names()).not.toContain('hide-me')
    expect(w.isProjectPath(join(wsPath, 'hide-me'))).toBe(false)
    expect(existsSync(join(wsPath, 'hide-me'))).toBe(true)
    expect((await run(() => tasks.getTask(c.number))).archivedFor).toBe('project-hidden')
    expect(w.hiddenProjects()).toEqual([expect.objectContaining({ name: 'hide-me', mode: 'hidden', present: true })])
    // New cards can't be given to it meanwhile.
    await expect(run(() => tasks.createTask({ title: 'x', project: 'hide-me' }, user))).rejects.toThrow(/Unknown project/)
    await run(() => removal.restoreProject('hide-me'))
    expect(await names()).toContain('hide-me')
    expect((await run(() => tasks.getTask(c.number))).archived).toBe(false)
    // The one the user had archived stays archived.
    expect((await run(() => tasks.getTask(done.number))).archived).toBe(true)
  })

  it('removes a project from Hive, packing its handovers and cards into its folder, and restores them', async () => {
    handover(wsPath, '2026-10-01-remove-me-plan.md', 'remove-me')
    handover(wsPath, '2026-10-01-remove-me-too-other.md', 'remove-me-too')
    handover(wsPath, '2026-10-01-keep-notes.md', 'keep')
    const c = await run(() => tasks.createTask({ title: 'Packed', project: 'remove-me' }, user))
    const info = await run(() => removal.removalInfo(join(wsPath, 'remove-me')))
    // "remove-me-too" starts with "remove-me": its handover isn't this project's.
    expect(info.handovers).toEqual(['handovers/2026-10-01-remove-me-plan.md'])
    await run(() => removal.removeProject(join(wsPath, 'remove-me'), 'remove'))
    const packed = join(wsPath, 'remove-me', '.hive', 'removed')
    expect(readdirSync(join(packed, 'handovers'))).toEqual(['2026-10-01-remove-me-plan.md'])
    expect(existsSync(join(packed, 'cards.json'))).toBe(true)
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-remove-me-plan.md'))).toBe(false)
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-remove-me-too-other.md'))).toBe(true)
    expect((await run(() => tasks.getTask(c.number))).archivedFor).toBe('project-removed')
    expect(w.hiddenProjects().find((h) => h.name === 'remove-me')?.mode).toBe('removed')

    const r = await run(() => removal.restoreProject('remove-me'))
    expect(r).toEqual({ handovers: 1, cards: 1 })
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-remove-me-plan.md'))).toBe(true)
    expect(existsSync(packed)).toBe(false)
    // The same card back, not a copy.
    expect((await run(() => tasks.getTask(c.number))).archived).toBe(false)
    expect((await run(() => tasks.listTasks({ project: 'remove-me' }))).length).toBe(1)
  })

  it('takes a removed project into another workspace, with new card numbers', async () => {
    const a = await run(() => tasks.createTask({ title: 'First', project: 'remove-me-too' }, user))
    await run(() => tasks.createTask({ title: 'Second', project: 'remove-me-too', blockedBy: [a.number] }, user))
    await run(() => removal.removeProject(join(wsPath, 'remove-me-too'), 'remove'))
    // The folder moves to another workspace, whose board already has cards.
    const other = join(base, 'ws3')
    mkdirSync(other, { recursive: true })
    execFileSync(process.platform === 'win32' ? 'cmd' : 'mv', process.platform === 'win32' ? ['/c', 'move', join(wsPath, 'remove-me-too'), other] : [join(wsPath, 'remove-me-too'), other])
    expect(w.hiddenProjects().find((h) => h.name === 'remove-me-too')?.present).toBe(false)
    await run(() => removal.forgetHidden('remove-me-too'))
    expect(w.hiddenProjects().some((h) => h.name === 'remove-me-too')).toBe(false)

    const w3 = await open(other)
    try {
      await inWorkspace(w3, () => tasks.createTask({ title: 'Already here' }, user))
      const info = await w3.projectInfo(join(other, 'remove-me-too'))
      expect(info.removedData).toEqual(expect.objectContaining({ handovers: 1, cards: 2 }))
      const r = await inWorkspace(w3, () => removal.takeRemovedData(join(other, 'remove-me-too'), true))
      expect(r).toEqual({ handovers: 1, cards: 2 })
      const cards = await inWorkspace(w3, () => tasks.listTasks({ project: 'remove-me-too' }))
      expect(cards.map((x) => x.number).sort()).toEqual([2, 3])
      const second = cards.find((x) => x.title === 'Second')!
      expect(second.blockedBy).toEqual([cards.find((x) => x.title === 'First')!.number])
      expect(existsSync(join(other, '.hive', 'shared', 'handovers', '2026-10-01-remove-me-too-other.md'))).toBe(true)
    } finally {
      await disposeWorkspaceService(w3)
    }
  })

  it('deletes a project with its cards and handovers', async () => {
    handover(wsPath, '2026-10-01-delete-me-x.md', 'delete-me')
    const c = await run(() => tasks.createTask({ title: 'Gone', project: 'delete-me' }, user))
    const keep = await run(() => tasks.createTask({ title: 'Stays', project: 'keep', links: [c.number] }, user))
    await run(() => removal.removeProject(join(wsPath, 'delete-me'), 'delete'))
    expect(existsSync(join(wsPath, 'delete-me'))).toBe(false)
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-delete-me-x.md'))).toBe(false)
    await expect(run(() => tasks.getTask(c.number))).rejects.toThrow(/Unknown task/)
    expect((await run(() => tasks.getTask(keep.number))).links).toEqual([])
    expect(await names()).not.toContain('delete-me')
  })

  it("won't remove a project whose worktree has work that isn't merged", async () => {
    const p = project(wsPath, 'gitproj')
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
    git(p, 'init', '-q', '-b', 'main')
    writeFileSync(join(p, 'a.txt'), 'a')
    git(p, 'add', 'a.txt')
    git(p, 'commit', '-q', '-m', 'a')
    const tree = join(base, 'ws2.worktrees', 'gitproj', 'agent-2')
    git(p, 'worktree', 'add', '-q', '-b', 'hive/agent-2', tree, 'main')
    writeFileSync(join(tree, 'b.txt'), 'b')
    git(tree, 'add', 'b.txt')
    git(tree, 'commit', '-q', '-m', 'b')
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a2', name: 'Agent 2', worktree: { path: tree, branch: 'hive/agent-2', base: 'main' } }] }))
    await w.refresh()
    const info = await run(() => removal.removalInfo(p))
    expect(info.worktrees).toEqual([expect.objectContaining({ agent: 'Agent 2', ahead: 1 })])
    await expect(run(() => removal.removeProject(p, 'remove'))).rejects.toThrow(/Merge or discard the work in Agent 2's worktree/)
    expect(await names()).toContain('gitproj')
    // Merged: then the worktree and its branch go, and the project leaves.
    git(p, 'merge', '-q', 'hive/agent-2')
    await run(() => removal.removeProject(p, 'remove'))
    expect(existsSync(tree)).toBe(false)
    expect(git(p, 'branch', '--list', 'hive/agent-2').trim()).toBe('')
    expect(await names()).not.toContain('gitproj')
  })
})

// Faults the code review found: each test sets up the fault and checks nothing is lost.
describe('removal and board under faults', () => {
  let w: WS
  const wsPath = join(base, 'ws-faults')
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  /** A git project with one worktree agent (Agent 2), committed and merged: nothing to lose yet. */
  function withWorktree(name: string): { p: string; tree: string } {
    const p = project(wsPath, name)
    git(p, 'init', '-q', '-b', 'main')
    writeFileSync(join(p, 'a.txt'), 'a')
    git(p, 'add', 'a.txt')
    git(p, 'commit', '-q', '-m', 'a')
    const tree = join(base, 'ws-faults.worktrees', name, 'agent-2')
    git(p, 'worktree', 'add', '-q', '-b', 'hive/agent-2', tree, 'main')
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a2', name: 'Agent 2', worktree: { path: tree, branch: 'hive/agent-2', base: 'main' } }] }))
    return { p, tree }
  }
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive', 'shared', 'handovers'), { recursive: true })
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const names = async (): Promise<string[]> => (await w.listProjectPaths()).map((p) => p.split(/[\\/]/).pop()!)

  it("treats a worktree git can't check as holding work", async () => {
    const { p, tree } = withWorktree('corrupt')
    writeFileSync(join(tree, 'unsaved.txt'), 'work in progress')
    // A damaged index: git status fails in the worktree.
    const gitDir = readFileSync(join(tree, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim()
    writeFileSync(join(gitDir, 'index'), 'not an index')
    await w.refresh()
    const info = await run(() => removal.removalInfo(p))
    expect(info.worktrees[0].error).toMatch(/couldn't check/)
    await expect(run(() => removal.removeProject(p, 'remove'))).rejects.toThrow(/Merge or discard/)
    expect(readFileSync(join(tree, 'unsaved.txt'), 'utf8')).toBe('work in progress')
    expect(await names()).toContain('corrupt')
  })

  it('looks at the worktrees again once the agents have stopped, and lets no agent start meanwhile', async () => {
    const { p, tree } = withWorktree('late-write')
    await w.refresh()
    const s = sessions as unknown as { stopWhereAndWait: (...a: unknown[]) => Promise<void> }
    const original = s.stopWhereAndWait
    let refused = ''
    s.stopWhereAndWait = async (...a: unknown[]) => {
      // A stopping agent writes one last file; and something tries to start an agent.
      writeFileSync(join(tree, 'last.txt'), 'written while stopping')
      await sessions.start(p, { agentId: 'a2' }).catch((e: Error) => (refused = e.message))
      return original.apply(sessions, a)
    }
    try {
      await expect(run(() => removal.removeProject(p, 'remove'))).rejects.toThrow(/1 uncommitted file/)
    } finally {
      s.stopWhereAndWait = original
    }
    expect(refused).toMatch(/being removed/)
    expect(readFileSync(join(tree, 'last.txt'), 'utf8')).toBe('written while stopping')
    expect(await names()).toContain('late-write')
  })

  it("never deletes a folder project.json calls a worktree when git says it isn't one", async () => {
    const p = project(wsPath, 'bogus')
    const unrelated = join(base, 'unrelated-folder')
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(unrelated, 'keep.txt'), 'not yours')
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a9', name: 'Odd', worktree: { path: unrelated, branch: 'x', base: 'main' } }] }))
    await w.refresh()
    const r = await run(() => removal.removeProject(p, 'delete'))
    expect(existsSync(p)).toBe(false)
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('not yours')
    expect(r.warnings.join(' ')).toMatch(/Left alone: Odd's worktree/)
  })

  it("touches nothing else when the project folder itself can't be deleted", async () => {
    const p = project(wsPath, 'locked')
    handover(wsPath, '2026-10-01-locked-notes.md', 'locked')
    const c = await run(() => tasks.createTask({ title: 'Stays', project: 'locked' }, user))
    await w.refresh()
    const shell = electron.shell as unknown as { trashItem: (p: string) => Promise<void> }
    const trash = shell.trashItem
    shell.trashItem = async (x: string) => {
      if (x.toLowerCase() === p.toLowerCase()) throw new Error('The process cannot access the file because it is being used by another process.')
      return trash(x)
    }
    try {
      await expect(run(() => removal.removeProject(p, 'delete'))).rejects.toThrow(/Nothing was deleted/)
    } finally {
      shell.trashItem = trash
    }
    expect(existsSync(p)).toBe(true)
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-locked-notes.md'))).toBe(true)
    expect((await run(() => tasks.getTask(c.number))).title).toBe('Stays')
    expect(await names()).toContain('locked')
  })

  it('tells apart projects whose names make the same slug', async () => {
    project(wsPath, 'foo_bar')
    project(wsPath, 'foo-bar')
    handover(wsPath, '2026-10-01-foo-bar-theirs.md', 'foo-bar')
    handover(wsPath, '2026-10-01-foo-bar-mine.md', 'foo_bar')
    await w.refresh()
    const info = await run(() => removal.removalInfo(join(wsPath, 'foo_bar')))
    expect(info.handovers).toEqual(['handovers/2026-10-01-foo-bar-mine.md'])
    const theirs = await run(() => removal.removalInfo(join(wsPath, 'foo-bar')))
    expect(theirs.handovers).toEqual(['handovers/2026-10-01-foo-bar-theirs.md'])
  })

  it("leaves a gone project's handovers alone when its slug matches", async () => {
    // "baz-qux" has left the workspace; its handover stays. "baz_qux" makes the same slug.
    const p = project(wsPath, 'baz_qux')
    handover(wsPath, '2026-10-01-baz-qux-old-plan.md', 'baz-qux')
    await w.refresh()
    expect((await run(() => removal.removalInfo(p))).handovers).toEqual([])
    await run(() => removal.removeProject(p, 'delete'))
    expect(existsSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-baz-qux-old-plan.md'))).toBe(true)
  })

  it('restores a packed handover beside a different note that took its name', async () => {
    const p = project(wsPath, 'clash')
    handover(wsPath, '2026-10-01-clash-plan.md', 'clash')
    await w.refresh()
    await run(() => removal.removeProject(p, 'remove'))
    // Meanwhile another note gets the same name.
    writeFileSync(join(wsPath, '.hive', 'shared', 'handovers', '2026-10-01-clash-plan.md'), '# A different plan\n\n- **Project:** clash\n')
    const r = await run(() => removal.restoreProject('clash'))
    expect(r.handovers).toBe(1)
    const dirNow = join(wsPath, '.hive', 'shared', 'handovers')
    expect(readFileSync(join(dirNow, '2026-10-01-clash-plan.md'), 'utf8')).toMatch(/A different plan/)
    expect(readFileSync(join(dirNow, '2026-10-01-clash-plan-restored.md'), 'utf8')).toMatch(/Body/)
  })

  it("doesn't bring back a card deleted while a change waited", async () => {
    const c = await run(() => tasks.createTask({ title: 'Doomed' }, user))
    const deleting = run(() => tasks.deleteTask(c.number))
    // Its rejection is handled at once: it can come before the deletion's await returns.
    const changing = expect(run(() => tasks.commentTask(c.number, 'late', agent))).rejects.toThrow(/Unknown task/)
    await deleting
    await changing
    await expect(run(() => tasks.getTask(c.number))).rejects.toThrow(/Unknown task/)
  })

  it('starts a card once, and puts it back (removing the new agent) when the agent fails to start', async () => {
    project(wsPath, 'starter')
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const c = await run(() => tasks.createTask({ title: 'Try me', project: 'starter' }, user))
    const s = sessions as unknown as { start: (...a: unknown[]) => Promise<unknown> }
    const original = s.start
    let launches = 0
    s.start = async () => {
      launches++
      await new Promise((r) => setTimeout(r, 50))
      throw new Error('Claude Code is required to run Agent 1.')
    }
    try {
      const first = run(() => startTask(c.number, { kind: 'new-agent', worktree: false }, user))
      await expect(run(() => startTask(c.number, { kind: 'new-agent', worktree: false }, user))).rejects.toThrow(/already being started/)
      await expect(first).rejects.toThrow(/required/)
    } finally {
      s.start = original
    }
    expect(launches).toBe(1)
    const after = await run(() => tasks.getTask(c.number))
    expect([after.column, after.agent]).toEqual(['todo', null])
    expect((await w.projectInfo(join(wsPath, 'starter'))).agents).toEqual([])
  })

  it("keeps a decision made while a failed Start was launching", async () => {
    project(wsPath, 'decider', [{ id: 'd1', name: 'Agent 1' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as { start: (...a: unknown[]) => Promise<unknown> }
    const original = s.start
    for (const decision of ['done', 'review'] as const) {
      const c = await run(() => tasks.createTask({ title: `Decide ${decision}`, project: 'decider' }, user))
      let release: () => void = () => undefined
      s.start = () => new Promise((_, reject) => (release = () => reject(new Error('launch failed'))))
      try {
        const starting = run(() => startTask(c.number, { kind: 'agent', agentId: 'd1' }, user))
        const handled = expect(starting).rejects.toThrow(/launch failed/)
        // Taken (Doing, the agent's) before the launch; the user decides meanwhile; then the launch fails.
        for (let i = 0; i < 50 && (await run(() => tasks.getTask(c.number))).column !== 'doing'; i++) await new Promise((r) => setTimeout(r, 20))
        await run(() => tasks.updateTask(c.number, { column: decision }, user))
        release()
        await handled
      } finally {
        s.start = original
      }
      expect((await run(() => tasks.getTask(c.number))).column).toBe(decision)
    }
  })

  it('starts more work on a card in Review or Done: Doing, then Review when its agent is done', async () => {
    project(wsPath, 'resumer', [{ id: 'r1', name: 'Agent 1' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as { start: (p: string, o: { agentId: string; prompt: string }) => Promise<unknown> }
    const original = s.start
    const prompts: string[] = []
    s.start = async (_p, o) => void prompts.push(o.prompt)
    const r1 = { kind: 'agent', name: 'Agent 1 (resumer)', self: { project: 'resumer', agentId: 'r1' }, scope: 'resumer' } as const
    try {
      for (const from of ['review', 'done'] as const) {
        const c = await run(() => tasks.createTask({ title: `Back from ${from}`, project: 'resumer', agent: 'r1', column: from }, user))
        const started = await run(() => startTask(c.number, { kind: 'agent', agentId: 'r1' }, assistant, '  Address the latest review comment.  '))
        expect([started.card.column, started.card.agent]).toEqual(['doing', 'r1'])
        expect(started.card.history.at(-1)).toMatchObject({ by: 'Assistant', what: 'Moved to Doing' })
        expect(prompts.at(-1)).toBe(
          `Work on task #${c.number} from the Hive task board: Back from ${from}\n\nIt was in ${from === 'review' ? 'Review' : 'Done'} and is back in Doing for more work.\n\nAddress the latest review comment.`
        )
        // Its agent finishes: Review, whatever it came from.
        const finished = await run(() => tasks.updateTask(c.number, { column: 'review' }, r1))
        expect(finished.column).toBe('review')
        expect(finished.history.filter((h) => h.what.startsWith('Moved to')).map((h) => h.what).slice(-2)).toEqual(['Moved to Doing', 'Moved to Review'])
      }
      // Started again while in Doing with the same agent: no second move or hand-over in its history.
      const c = await run(() => tasks.createTask({ title: 'Again', project: 'resumer' }, user))
      await run(() => startTask(c.number, { kind: 'agent', agentId: 'r1' }, user))
      const once = (await run(() => tasks.getTask(c.number))).history.length
      await run(() => startTask(c.number, { kind: 'agent', agentId: 'r1' }, user))
      const again = await run(() => tasks.getTask(c.number))
      expect([again.column, again.agent, again.history.length]).toEqual(['doing', 'r1', once])
      expect(prompts.at(-1)).not.toMatch(/back in Doing/)
      // A note longer than a prompt should be is refused before anything changes.
      await expect(run(() => startTask(c.number, { kind: 'agent', agentId: 'r1' }, assistant, 'x'.repeat(4001)))).rejects.toThrow(/too long/)
    } finally {
      s.start = original
    }
  })

  it('refuses a Start whose card was moved to Done meanwhile, and leaves it there', async () => {
    project(wsPath, 'racer', [{ id: 'x1', name: 'Agent 1' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as { start: (...a: unknown[]) => Promise<unknown> }
    const original = s.start
    const ww = w as unknown as { projectConfig: (p: string) => Promise<unknown> }
    const config = ww.projectConfig
    let launches = 0
    s.start = async () => void launches++
    for (const from of ['todo', 'review'] as const) {
      const c = await run(() => tasks.createTask({ title: `Race from ${from}`, project: 'racer', column: from }, user))
      // The Start has read the card and is looking up the agent when the user puts the card in Done.
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => (release = r))
      let reached: () => void = () => undefined
      const atGate = new Promise<void>((r) => (reached = r))
      ww.projectConfig = async (p) => {
        ww.projectConfig = config
        reached()
        await gate
        return config.call(w, p)
      }
      try {
        const starting = run(() => startTask(c.number, { kind: 'agent', agentId: 'x1' }, user))
        const handled = expect(starting).rejects.toThrow(/moved to Done meanwhile/)
        await atGate
        await run(() => tasks.updateTask(c.number, { column: 'done' }, user))
        release()
        await handled
      } finally {
        ww.projectConfig = config
      }
      const now = await run(() => tasks.getTask(c.number))
      expect([now.column, now.agent]).toEqual(['done', null])
    }
    s.start = original
    expect(launches).toBe(0)
  })

  /** Pauses the next Start where it looks up the project's agents (after it read the card), until released. */
  function pauseAgentLookup(): { reached: Promise<void>; release: () => void; restore: () => void } {
    const ww = w as unknown as { projectConfig: (p: string) => Promise<unknown> }
    const config = ww.projectConfig
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let reached: () => void = () => undefined
    const atGate = new Promise<void>((r) => (reached = r))
    ww.projectConfig = async (p) => {
      ww.projectConfig = config
      reached()
      await gate
      return config.call(w, p)
    }
    return { reached: atGate, release, restore: () => (ww.projectConfig = config) }
  }

  it("refuses a Start whose card was reassigned or moved meanwhile, and keeps that decision", async () => {
    project(wsPath, 'reassign', [{ id: 'x1', name: 'Agent 1' }, { id: 'x2', name: 'Agent 2' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as { start: (...a: unknown[]) => Promise<unknown> }
    const original = s.start
    let launches = 0
    s.start = async () => void launches++
    const decisions = [
      { from: 'review', change: { agent: 'x2' }, error: /given to another agent meanwhile/, after: ['review', 'x2'] },
      { from: 'review', change: { agent: null }, error: /given to nobody meanwhile/, after: ['review', null] },
      { from: 'todo', change: { column: 'review' }, error: /moved to Review meanwhile/, after: ['review', 'x1'] },
      { from: 'done', change: { column: 'todo' }, error: /moved to Todo meanwhile/, after: ['todo', 'x1'] }
    ] as const
    try {
      for (const d of decisions) {
        const c = await run(() => tasks.createTask({ title: `Decided ${JSON.stringify(d.change)}`, project: 'reassign', agent: 'x1', column: d.from }, user))
        const pause = pauseAgentLookup()
        try {
          const starting = run(() => startTask(c.number, { kind: 'agent', agentId: 'x1' }, user))
          const handled = expect(starting).rejects.toThrow(d.error)
          await pause.reached
          await run(() => tasks.updateTask(c.number, d.change, user))
          pause.release()
          await handled
        } finally {
          pause.restore()
        }
        const now = await run(() => tasks.getTask(c.number))
        expect([now.column, now.agent]).toEqual(d.after)
        expect(now.history.filter((h) => h.by === 'You').length).toBe(now.history.length)
      }
      // Nothing changed meanwhile: a card in Done is still started, as asked.
      const done = await run(() => tasks.createTask({ title: 'Done, more to do', project: 'reassign', agent: 'x1', column: 'done' }, user))
      expect((await run(() => startTask(done.number, { kind: 'agent', agentId: 'x1' }, user))).card.column).toBe('doing')
    } finally {
      s.start = original
    }
    expect(launches).toBe(1)
  })

  it('checks the agent again just before the prompt goes in, and puts the card back if it is busy now', async () => {
    project(wsPath, 'recheck', [{ id: 'k1', name: 'Agent 1' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as {
      liveFor: (...a: unknown[]) => unknown
      userMayBeTyping: (...a: unknown[]) => boolean
      sendPrompt: (...a: unknown[]) => Promise<void>
      start: (...a: unknown[]) => Promise<unknown>
    }
    const saved = { liveFor: s.liveFor, userMayBeTyping: s.userMayBeTyping, sendPrompt: s.sendPrompt, start: s.start }
    let typed = 0
    let launched = 0
    s.sendPrompt = async () => void typed++
    s.start = async () => void launched++
    try {
      // Idle when the Start looks, working by the time the prompt would go in (it was taking the card).
      const cases = [
        { what: 'started working', actor: user, live: ['ready', 'working'], typing: [false, false], error: /is working/ },
        { what: 'the user typed', actor: assistant, live: ['ready', 'ready'], typing: [false, true], error: /just typed/ }
      ]
      for (const k of cases) {
        const c = await run(() => tasks.createTask({ title: k.what, project: 'recheck', agent: 'k1', column: 'review' }, user))
        let looks = 0
        let typingLooks = 0
        s.liveFor = () => ({ status: k.live[Math.min(looks++, 1)] })
        s.userMayBeTyping = () => k.typing[Math.min(typingLooks++, 1)]
        await expect(run(() => startTask(c.number, { kind: 'agent', agentId: 'k1' }, k.actor))).rejects.toThrow(k.error)
        const now = await run(() => tasks.getTask(c.number))
        // It was taken (Doing), then put back where it was when the agent turned out to be busy.
        expect([now.column, now.agent]).toEqual(['review', 'k1'])
        expect(now.history.map((h) => h.what).slice(-2)).toEqual(['Moved to Doing', 'Moved to Review'])
      }
      expect(typed + launched).toBe(0)
      // Stopped meanwhile: it is started with the card instead of typed into.
      const c = await run(() => tasks.createTask({ title: 'Stopped meanwhile', project: 'recheck', agent: 'k1' }, user))
      let looks = 0
      s.liveFor = () => (looks++ === 0 ? { status: 'ready' } : null)
      s.userMayBeTyping = () => false
      await run(() => startTask(c.number, { kind: 'agent', agentId: 'k1' }, user))
      expect([typed, launched]).toEqual([0, 1])
    } finally {
      Object.assign(s, saved)
    }
  })

  it('gives an agent one card at a time: a Start of another card for it meanwhile is refused', async () => {
    project(wsPath, 'oneatatime', [{ id: 'o1', name: 'Agent 1' }])
    await w.refresh()
    const { startTask } = await import('../src/main/taskStart')
    const s = sessions as unknown as { liveFor: (...a: unknown[]) => unknown; sendPrompt: (...a: unknown[]) => Promise<void> }
    const saved = { liveFor: s.liveFor, sendPrompt: s.sendPrompt }
    const prompts: string[] = []
    let release: () => void = () => undefined
    const typing = new Promise<void>((r) => (release = r))
    s.liveFor = () => ({ status: 'ready' })
    s.sendPrompt = async (...a: unknown[]) => {
      prompts.push(String(a[2]))
      await typing
    }
    try {
      const a = await run(() => tasks.createTask({ title: 'First card', project: 'oneatatime' }, user))
      const b = await run(() => tasks.createTask({ title: 'Second card', project: 'oneatatime' }, user))
      const first = run(() => startTask(a.number, { kind: 'agent', agentId: 'o1' }, user))
      for (let i = 0; i < 50 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 20))
      await expect(run(() => startTask(b.number, { kind: 'agent', agentId: 'o1' }, user))).rejects.toThrow(/being given another card/)
      release()
      await first
      // Its prompt has just gone in; the agent's hook hasn't said it's working yet: still refused.
      await expect(run(() => startTask(b.number, { kind: 'agent', agentId: 'o1' }, user))).rejects.toThrow(/being given another card/)
      expect(prompts.length).toBe(1)
      expect(prompts[0]).toMatch(/First card/)
      const second = await run(() => tasks.getTask(b.number))
      expect([second.column, second.agent, second.history.length]).toEqual(['todo', null, 1])
    } finally {
      Object.assign(s, saved)
    }
  })
})

describe('task prompt', () => {
  const card = { number: 7, title: 'Fix it', description: 'The details.', blockedBy: [], comments: [] } as unknown as import('../src/shared/types').TaskCard
  it('says when a card is back for more work, and puts the note before the card', async () => {
    const { taskPrompt } = await import('../src/shared/tasks')
    expect(taskPrompt(card, false)).toBe('Work on task #7 from the Hive task board: Fix it\n\nThe details.')
    expect(taskPrompt(card, false, { from: 'todo', note: ' ' })).toBe('Work on task #7 from the Hive task board: Fix it\n\nThe details.')
    expect(taskPrompt(card, false, { from: 'done', note: 'Only the tests.' })).toBe(
      'Work on task #7 from the Hive task board: Fix it\n\nIt was in Done and is back in Doing for more work.\n\nOnly the tests.\n\nThe details.'
    )
    // With Hive's tools: the work-on-card skill says how to carry it through, and the comments are a read away.
    expect(taskPrompt(card, true)).toBe('Work on task #7 from the Hive task board: Fix it\n\nThe details.\n\nUse the work-on-card skill.')
    const commented = { ...card, comments: [{ at: '2026-10-01T10:00:00Z', by: 'You', text: 'First thoughts.' }, { at: '2026-10-02T10:00:00Z', by: 'Reviewer (alpha)', text: 'Failed: the redirect loops.' }] }
    expect(taskPrompt(commented, true)).toMatch(/The card has 2 comments: read them with hive_read_task\.$/)
    expect(taskPrompt(commented, true)).not.toContain('redirect loops')
  })

  it('brings the feedback a card came back with: its latest comment, after the note and the card', async () => {
    const { taskPrompt } = await import('../src/shared/tasks')
    const back = { ...card, comments: [{ at: '2026-10-01T10:00:00Z', by: 'You', text: 'First thoughts.' }, { at: '2026-10-02T10:00:00Z', by: 'Reviewer (alpha)', text: 'Failed: the redirect loops.' }] }
    const text = taskPrompt(back, true, { from: 'review', note: 'Fix what the review found.' })
    expect(text.indexOf('Fix what the review found.')).toBeLessThan(text.indexOf('The details.'))
    expect(text).toContain('Its latest comment (Reviewer (alpha), 2026-10-02):\n\nFailed: the redirect loops.')
    expect(text).not.toContain('First thoughts.')
    expect(text).toMatch(/read the rest with hive_read_task/)
    // Without tools it still has the card and the feedback; a long comment is cut, saying so.
    const long = { ...back, comments: [{ at: '2026-10-02T10:00:00Z', by: 'You', text: 'x'.repeat(5000) }] }
    expect(taskPrompt(long, false, { from: 'done' })).toMatch(/x{4000}… \(cut short: hive_read_task has it all\)$/)
  })
})

describe('column colours', () => {
  it('uses a saved #rrggbb colour, and the default for anything else', async () => {
    const { columnColor, DEFAULT_COLUMN_COLORS } = await import('../src/shared/tasks')
    expect(columnColor({ doing: '#123ABC' }, 'doing')).toBe('#123ABC')
    expect(columnColor({ doing: 'red; background: url(x)' }, 'doing')).toBe(DEFAULT_COLUMN_COLORS.doing)
    expect(columnColor({ doing: '#fff' }, 'doing')).toBe(DEFAULT_COLUMN_COLORS.doing)
    expect(columnColor(undefined, 'done')).toBe(DEFAULT_COLUMN_COLORS.done)
    expect(new Set(Object.values(DEFAULT_COLUMN_COLORS)).size).toBe(6)
  })
})

describe("an agent's cards on its session", () => {
  let w: WS
  const wsPath = join(base, 'ws-cards')
  let alpha = ''
  beforeAll(async () => {
    alpha = project(wsPath, 'alpha', [
      { id: 'a1', name: 'Agent 1' },
      { id: 'a2', name: 'Agent 2' }
    ])
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  it('shows only the Doing cards given to the agent, in board order', async () => {
    const { agentDoingCards } = await import('../src/shared/tasks')
    const a = await run(() => tasks.createTask({ title: 'Inbox', project: 'alpha', agent: 'a1', column: 'doing' }, user))
    const b = await run(() => tasks.createTask({ title: 'Snippets', project: 'alpha', agent: 'a1', column: 'doing' }, user))
    await run(() => tasks.createTask({ title: 'Later', project: 'alpha', agent: 'a1', column: 'todo' }, user))
    await run(() => tasks.createTask({ title: 'Theirs', project: 'alpha', agent: 'a2', column: 'doing' }, user))
    const all = await run(() => tasks.allTasks(w))
    expect(agentDoingCards(all, 'ALPHA', 'a1').map((c) => c.number)).toEqual([a.number, b.number])
    await run(() => tasks.updateTask(a.number, { column: 'review' }, user))
    expect(agentDoingCards(await run(() => tasks.allTasks(w)), 'alpha', 'a1').map((c) => c.number)).toEqual([b.number])
    // Back in Doing, it goes to the end.
    await run(() => tasks.updateTask(a.number, { column: 'doing' }, user))
  })

  it("records each Doing card on the agent's running session once, in order, with its title then", async () => {
    const { recordCards, recordLiveCards } = await import('../src/main/cardSessions')
    await w.upsertSession(alpha, { id: 's1', agentId: 'a1' })
    await recordCards(w, alpha, 'a1', 's1')
    const rec = async () => (await w.sessionsFile(alpha)).sessions.find((s) => s.id === 's1')
    expect((await rec())?.cards?.map((c) => c.title)).toEqual(['Snippets', 'Inbox'])
    // A card given to it later is added; moving one out of Doing or renaming it keeps the record.
    const c = await run(() => tasks.createTask({ title: 'Third', project: 'alpha', agent: 'a1', column: 'doing' }, user))
    await run(() => tasks.updateTask(1, { column: 'review', title: 'Inbox, renamed' }, user))
    await recordLiveCards(wsPath, [{ projectPath: alpha, agentId: 'a1', sessionId: 's1' } as never])
    expect((await rec())?.cards).toEqual([
      { number: 2, title: 'Snippets' },
      { number: 1, title: 'Inbox' },
      { number: c.number, title: 'Third' }
    ])
    // A session Hive hasn't recorded isn't created.
    await recordCards(w, alpha, 'a1', 'unknown')
    expect((await w.sessionsFile(alpha)).sessions.some((s) => s.id === 'unknown')).toBe(false)
  })
})
