// The task board (.hive/tasks) and removing projects: who may change what, card numbers and order, and what Hide,
// Remove from Hive and Delete do with a project's cards, handovers and folder (and what restoring brings back).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

  it('gives a card an agent moves into Doing to that agent, when nobody has it and no agent is named', async () => {
    const me = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' } } as const
    // Another agent of alpha, not in project.json: giving it a card would fail, so a test that passes never did.
    const other = { kind: 'agent', name: 'Other (alpha)', self: { project: 'alpha', agentId: 'zz' } } as const
    const fresh = () => run(() => tasks.createTask({ title: 'Take me', project: 'alpha' }, user))

    const said: string[] = []
    const taken = await run(async () => tasks.updateTask((await fresh()).number, { column: 'doing' }, me, { said }))
    expect([taken.agent, taken.agentName, taken.column]).toEqual(['a1', 'Agent 1', 'doing'])
    expect(said).toEqual(['Given to Agent 1', 'Moved to Doing'])

    // A card someone has keeps them.
    const held = await run(async () => tasks.updateTask((await fresh()).number, { agent: 'a1' }, user))
    expect((await run(() => tasks.updateTask(held.number, { column: 'doing' }, other))).agent).toBe('a1')
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
})

describe('column colours', () => {
  it('uses a saved #rrggbb colour, and the default for anything else', async () => {
    const { columnColor, DEFAULT_COLUMN_COLORS } = await import('../src/shared/tasks')
    expect(columnColor({ doing: '#123ABC' }, 'doing')).toBe('#123ABC')
    expect(columnColor({ doing: 'red; background: url(x)' }, 'doing')).toBe(DEFAULT_COLUMN_COLORS.doing)
    expect(columnColor({ doing: '#fff' }, 'doing')).toBe(DEFAULT_COLUMN_COLORS.doing)
    expect(columnColor(undefined, 'done')).toBe(DEFAULT_COLUMN_COLORS.done)
    expect(new Set(Object.values(DEFAULT_COLUMN_COLORS)).size).toBe(4)
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
