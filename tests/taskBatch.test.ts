// A batch card change (hive_update_tasks, #417): one call changes many cards with the same fields. Each card goes through
// the single call's path under the board's lock and its own card lock, so what is refused, recorded and counted is the
// same as for one card. The Hive Assistant's turn for a batch (its limit, its activity list, what it may still do while
// a card waits) is tested through taskBatch.assistantBatch, the same code the Agent API's route runs.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-task-batch-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, for tests: gone.
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p) => rm(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const control = await import('../src/main/assistantControl')
const { ChangeRefused } = control
const { assistantBatch, batchRequest } = await import('../src/main/taskBatch')
const { config } = await import('../src/main/config')
const { withFileLock } = await import('../src/main/fsutil')
const { batchText } = await import('../src/shared/toolReplies')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const alphaAgent = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
const gammaAgent1 = { kind: 'agent', name: 'Agent 1 (gamma)', self: { project: 'gamma', agentId: 'g1' }, scope: 'gamma' } as const

function project(ws: string, name: string, agents: { id: string; name: string }[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.hive'), { recursive: true })
  writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

async function open(path: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(path)
  return w
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Many cards are written, and tests wait on one another: under a full run's load, the default 5 s is too short.
vi.setConfig({ testTimeout: 30_000 })

/** Sets the Assistant's control level for the test, as Settings → Assistant → Control does. */
function setControl(level: 'look' | 'agents' | 'projects'): void {
  config.settings.assistant = { ...config.settings.assistant, control: level } as typeof config.settings.assistant
}

describe('batch card changes (hive_update_tasks)', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  beforeAll(async () => {
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    project(wsPath, 'beta')
    project(wsPath, 'gamma', [
      { id: 'g1', name: 'Agent 1' },
      { id: 'g2', name: 'Agent 2' }
    ])
    project(wsPath, 'batch')
    project(wsPath, 'placing')
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string, proj: string, column: TaskCard['column'] = 'todo', agent?: string) =>
    run(() => tasks.createTask({ title, project: proj, column, ...(agent ? { agent } : {}) }, user))
  const cardOf = (n: number) => run(() => tasks.getTask(n))

  it('changes 27 cards in one call: each applied, with its own history line and its place in the column', async () => {
    const cards = await Promise.all(Array.from({ length: 27 }, (_, i) => make(`Batch ${i + 1}`, 'batch', 'hold')))
    const numbers = cards.map((c) => c.number)
    const items = await run(() => tasks.updateTasks(numbers, { column: 'todo' }, user))
    expect(items.every((i) => i.error === null && i.card?.column === 'todo')).toBe(true)
    for (const i of items) {
      expect(i.said).toEqual(['Moved to Todo'])
      expect((await cardOf(i.number)).history.at(-1)?.what).toBe('Moved to Todo')
    }
  })

  it('refuses a card the caller may not change (missing, or another project), as a missing card is refused, and applies the rest', async () => {
    const mine = await make('Alpha card', 'alpha')
    const theirs = await make('Beta card', 'beta')
    const missing = 987654
    const items = await run(() => tasks.updateTasks([mine.number, theirs.number, missing], { column: 'doing' }, alphaAgent))
    expect(items[0].card?.column).toBe('doing')
    // Another project's card reads the same as one that doesn't exist: the same words, and nothing changed.
    expect(items[1].error).toBe(`Unknown task #${theirs.number}`)
    expect(items[2].error).toBe(`Unknown task #${missing}`)
    expect(items[1].error?.replace(`#${theirs.number}`, '#N')).toBe(items[2].error?.replace(`#${missing}`, '#N'))
    const untouched = await cardOf(theirs.number)
    expect(untouched.column).toBe('todo')
    expect(untouched.history.length).toBe(1)
  })

  it('refuses one card in Doing with another agent and moves the others to Review', async () => {
    const busy = await make('Gamma in progress', 'gamma', 'doing', 'g2')
    const free = await make('Gamma free', 'gamma', 'todo')
    const items = await run(() => tasks.updateTasks([busy.number, free.number], { column: 'review' }, gammaAgent1))
    expect(items[0].error).toMatch(/in Doing with Agent 2, who is working on it/)
    expect(items[0].card).toBeNull()
    expect((await cardOf(busy.number)).column).toBe('doing')
    expect(items[1].card?.column).toBe('review')
  })

  it('a project agent can not park cards On Hold, and nothing in the batch changes', async () => {
    const a = await make('Parked?', 'alpha')
    const b = await make('Parked too?', 'alpha')
    const items = await run(() => tasks.updateTasks([a.number, b.number], { column: 'hold' }, alphaAgent))
    expect(items.every((i) => i.card === null && /Only the user or the Assistant puts cards On Hold/.test(i.error ?? ''))).toBe(true)
    expect((await cardOf(a.number)).column).toBe('todo')
  })

  it("two batches at once don't lose each other's changes: every card keeps both, each with its history line", async () => {
    const cards = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`Race ${i + 1}`, 'batch')))
    const numbers = cards.map((c) => c.number)
    const [blocked, labelled] = await run(() => Promise.all([tasks.updateTasks(numbers, { blocked: 'waiting' }, user), tasks.updateTasks(numbers, { labels: ['bug'] }, user)]))
    expect(blocked.every((i) => i.error === null) && labelled.every((i) => i.error === null)).toBe(true)
    for (const n of numbers) {
      const card = await cardOf(n)
      expect(card.blocked).toBe('waiting')
      expect(card.labels).toEqual(['bug'])
      expect(card.history.map((h) => h.what)).toEqual(expect.arrayContaining(['Blocked: waiting', 'Labels: bug']))
    }
  })

  it('position applies to each card in turn, so the last listed ends at the top', async () => {
    const x = await make('Top one', 'batch', 'passed')
    const y = await make('Top two', 'batch', 'passed')
    const z = await make('Top three', 'batch', 'passed')
    await run(() => tasks.updateTasks([x.number, y.number, z.number], { position: 'top' }, user))
    const list = (await run(() => tasks.listTasks({ column: 'passed', project: 'batch' }))).map((c) => c.number)
    expect(list.slice(0, 3)).toEqual([z.number, y.number, x.number])
  })

  it('takes a list of card numbers only as a whole: at least one, at most the batch limit, each once', () => {
    expect(() => tasks.batchNumbers([])).toThrow(/^cards:/)
    expect(() => tasks.batchNumbers(undefined)).toThrow(/^cards:/)
    expect(() => tasks.batchNumbers([1, 1])).toThrow(/listed twice/)
    expect(() => tasks.batchNumbers(['abc'])).toThrow(/not a card number/)
    expect(() => tasks.batchNumbers([1.5])).toThrow(/not a card number/)
    expect(() => tasks.batchNumbers(Array.from({ length: tasks.MAX_CHANGE_BATCH + 1 }, (_, i) => i + 1))).toThrow(/at most/)
    expect(tasks.batchNumbers(['#12', 3])).toEqual([12, 3])
  })

  describe('the board lock (placement reads every card, so changes that place cards are serialised)', () => {
    it('two changes that place different cards at the top, at once, each get a place of their own', async () => {
      const anchor = await make('Anchor', 'placing', 'todo')
      const a = await make('Placed A', 'placing', 'passed')
      const b = await make('Placed B', 'placing', 'passed')
      await run(() => Promise.all([tasks.updateTasks([a.number], { column: 'todo', position: 'top' }, user), tasks.updateTasks([b.number], { column: 'todo', position: 'top' }, user)]))
      const orders = [(await cardOf(a.number)).order, (await cardOf(b.number)).order, (await cardOf(anchor.number)).order]
      expect(new Set(orders).size).toBe(3)
      const list = (await run(() => tasks.listTasks({ column: 'todo', project: 'placing' }))).map((c) => c.number)
      expect(list.slice(0, 2).sort()).toEqual([a.number, b.number].sort())
      expect(list[2]).toBe(anchor.number)
    })

    it('creations at once each get a place of their own', async () => {
      const cards = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`Created ${i + 1}`, 'placing', 'review')))
      const orders = await Promise.all(cards.map((c) => cardOf(c.number).then((x) => x.order)))
      expect(new Set(orders).size).toBe(10)
    })
  })
})

describe("the Hive Assistant's batch (through its change boundary)", () => {
  let w: WS
  let wsPath = ''
  let token = ''
  let savedControl: typeof config.settings.assistant | undefined
  let opened = 0
  beforeAll(() => {
    savedControl = config.settings.assistant
  })
  afterAll(() => {
    config.settings.assistant = savedControl as typeof config.settings.assistant
  })
  // Each test has a board of its own (#422): every card created or placed reads every card on the board, so on one
  // shared board the later tests' few dozen cards cost several times what they do alone, and more under load.
  beforeEach(async () => {
    wsPath = join(base, `assistant-ws-${++opened}`)
    project(wsPath, 'batch')
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    w = await open(wsPath)
  })
  afterEach(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string, column: TaskCard['column'] = 'todo') => run(() => tasks.createTask({ title, project: 'batch', column }, user))
  const cardOf = (n: number) => run(() => tasks.getTask(n))
  /** The activity-list lines for one card: exactly the ones the Assistant recorded for it. */
  const linesFor = (n: number) => control.actions(wsPath).filter((a) => a.text.startsWith(`#${n} `) || a.text === `#${n}: change`)
  /** A new message from the user, with the Assistant's control at its most, and a session for its calls. */
  const fresh = async (): Promise<void> => {
    control.newTurn(wsPath)
    setControl('projects')
    await control.newAssistantToken(wsPath)
    token = JSON.parse(readFileSync(control.assistantTokenFile(wsPath), 'utf8')).token
  }

  it('applies a 27-card batch, and counts and lists each card once', async () => {
    await fresh()
    const cards = await Promise.all(Array.from({ length: 27 }, (_, i) => make(`Asst ${i + 1}`, 'hold')))
    const numbers = cards.map((c) => c.number)
    const items = await run(() => assistantBatch(wsPath, token, numbers, { column: 'todo' }, assistant))
    expect(items.every((i) => i.card?.column === 'todo')).toBe(true)
    expect(control.actionsLeft(wsPath)).toBe(3)
    numbers.forEach((n, i) => {
      const lines = linesFor(n)
      expect(lines).toHaveLength(1)
      expect(lines[0].ok).toBe(true)
      expect(lines[0].text).toBe(`#${n} Asst ${i + 1}: Moved to Todo`)
    })
  })

  it('with 3 changes left, a batch of 5 applies none of its cards and says that 3 fit; the 3 that fit still apply', async () => {
    await fresh()
    // 27 of the 30 go on other cards first.
    const used = await Promise.all(Array.from({ length: 27 }, (_, i) => make(`Used ${i + 1}`, 'hold')))
    await run(() => assistantBatch(wsPath, token, used.map((c) => c.number), { column: 'todo' }, assistant))
    expect(control.actionsLeft(wsPath)).toBe(3)
    const five = await Promise.all(Array.from({ length: 5 }, (_, i) => make(`Five ${i + 1}`, 'hold')))
    const refusal = await run(() => assistantBatch(wsPath, token, five.map((c) => c.number), { column: 'todo' }, assistant)).catch((e) => e)
    expect(refusal).toBeInstanceOf(ChangeRefused)
    expect(refusal.status).toBe(429)
    expect(refusal.extra).toEqual({ fits: 3 })
    expect(refusal.message).toMatch(/only 3 fit/)
    for (const c of five) expect((await cardOf(c.number)).column).toBe('hold')
    expect(control.actionsLeft(wsPath)).toBe(3)
    const summary = control.actions(wsPath).filter((a) => a.text === 'Change 5 cards on the board')
    expect(summary).toHaveLength(1)
    expect(summary[0].ok).toBe(false)
    // The three left still fit, and apply.
    const three = five.slice(0, 3).map((c) => c.number)
    const items = await run(() => assistantBatch(wsPath, token, three, { column: 'todo' }, assistant))
    expect(items.every((i) => i.card?.column === 'todo')).toBe(true)
    expect(control.actionsLeft(wsPath)).toBe(0)
  })

  it('a refused card counts once and is listed once, beside the cards that changed', async () => {
    await fresh()
    const done = await run(() => tasks.createTask({ title: 'Already done', project: 'batch', column: 'done' }, user))
    const a = await make('Open one')
    const b = await make('Open two')
    // Putting cards in Done's order is the user's: that card is refused, and the others still change.
    const items = await run(() => assistantBatch(wsPath, token, [a.number, done.number, b.number], { position: 'top' }, assistant))
    expect(items[0].card).not.toBeNull()
    expect(items[1].error).toMatch(/Only the user puts the cards in Done in order/)
    expect(items[2].card).not.toBeNull()
    expect(control.actionsLeft(wsPath)).toBe(control.MAX_ACTIONS_PER_TURN - 3)
    for (const c of [a, done, b]) expect(linesFor(c.number)).toHaveLength(1)
    expect(linesFor(done.number)[0].ok).toBe(false)
  })

  it("batches at once don't exceed the message's limit: exactly the ones that fit apply", async () => {
    await fresh()
    const cards = await Promise.all(Array.from({ length: 36 }, (_, i) => make(`Race ${i + 1}`, 'hold')))
    const groups = [0, 12, 24].map((s) => cards.slice(s, s + 12).map((c) => c.number))
    const settled = await run(() => Promise.allSettled(groups.map((g) => assistantBatch(wsPath, token, g, { column: 'todo' }, assistant))))
    const ok = settled.filter((s) => s.status === 'fulfilled')
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    expect(ok).toHaveLength(2)
    expect(refused).toHaveLength(1)
    expect((refused[0].reason as InstanceType<typeof ChangeRefused>).extra).toEqual({ fits: 6 })
    expect(control.actionsLeft(wsPath)).toBe(6)
  })

  it('a card a batch reaches after the user turns the control level down is left as it was', async () => {
    await fresh()
    const [a, b, c] = [await make('Wait a'), await make('Wait b'), await make('Wait c')]
    // Holds b's card lock, so the batch gets to b and waits there.
    let release: () => void = () => undefined
    const holding = run(() => withFileLock(tasks.cardFile(b.number, w), () => new Promise<void>((r) => (release = r))))
    const pending = run(() => assistantBatch(wsPath, token, [a.number, b.number, c.number], { column: 'review' }, assistant))
    for (let i = 0; i < 1000 && (await cardOf(a.number)).column !== 'review'; i++) await sleep(10)
    expect((await cardOf(a.number)).column).toBe('review')
    setControl('look')
    release()
    await holding
    const items = await pending
    setControl('projects')
    expect(items[0].card?.column).toBe('review')
    expect(items[1].error).toMatch(/turned Settings → Assistant → Control down/)
    expect(items[2].error).toMatch(/turned Settings → Assistant → Control down/)
    expect((await cardOf(b.number)).column).toBe('todo')
    expect((await cardOf(c.number)).column).toBe('todo')
    expect(linesFor(b.number)[0].ok).toBe(false)
    expect(linesFor(c.number)[0].ok).toBe(false)
  })

  it("a card a batch reaches after the Assistant's session is replaced is left as it was", async () => {
    await fresh()
    const [a, b] = [await make('Session a'), await make('Session b')]
    let release: () => void = () => undefined
    const holding = run(() => withFileLock(tasks.cardFile(b.number, w), () => new Promise<void>((r) => (release = r))))
    const pending = run(() => assistantBatch(wsPath, token, [a.number, b.number], { column: 'review' }, assistant))
    for (let i = 0; i < 1000 && (await cardOf(a.number)).column !== 'review'; i++) await sleep(10)
    // The Assistant restarts: its token is replaced, and the one that asked is no longer current.
    await control.newAssistantToken(wsPath)
    release()
    await holding
    const items = await pending
    expect(items[0].card?.column).toBe('review')
    expect(items[1].error).toMatch(/session that asked for this ended/)
    expect((await cardOf(b.number)).column).toBe('todo')
  })

  /**
   * Pauses a write after its checks have passed, in the lookup of the agent it gives the card (its last await before the
   * write): `during` runs then, and the write goes on after it. A write whose authority is lost in that window saves nothing.
   */
  const pausedWrite = async (during: () => void | Promise<void>): Promise<{ item: { card: TaskCard | null; error: string | null }; card: TaskCard }> => {
    const c = await run(() => tasks.createTask({ title: 'Late write', project: 'alpha' }, user))
    let reached: () => void = () => undefined
    const arrived = new Promise<void>((r) => (reached = r))
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const original = w.projectConfig.bind(w)
    const spy = vi.spyOn(w, 'projectConfig').mockImplementationOnce(async (p: string) => {
      reached()
      await gate
      return original(p)
    })
    try {
      const pending = run(() => assistantBatch(wsPath, token, [c.number], { agent: 'a1', labels: ['changed'] }, assistant))
      await Promise.race([arrived, sleep(5000).then(() => Promise.reject(new Error('the lookup was never reached')))])
      await during()
      release()
      const [item] = await pending
      return { item, card: await cardOf(c.number) }
    } finally {
      spy.mockRestore()
    }
  }

  it('a card whose Assistant control is turned down after its last read is not saved (the batch refuses that card, as a whole)', async () => {
    await fresh()
    const { item, card } = await pausedWrite(() => setControl('look'))
    setControl('projects')
    expect(item.card).toBeNull()
    expect(item.error).toMatch(/turned Settings → Assistant → Control down/)
    expect(card.agent).toBeNull()
    expect(card.labels).toEqual([])
    expect(card.history).toHaveLength(1)
  })

  it("a card whose Assistant session is replaced after its last read is not saved", async () => {
    await fresh()
    const { item, card } = await pausedWrite(() => control.newAssistantToken(wsPath))
    expect(item.card).toBeNull()
    expect(item.error).toMatch(/session that asked for this ended/)
    expect(card.agent).toBeNull()
    expect(card.labels).toEqual([])
    expect(card.history).toHaveLength(1)
  })

  it("a single change's write is guarded the same way: a guard that refuses at the write saves nothing", async () => {
    const c = await run(() => tasks.createTask({ title: 'Single guarded', project: 'alpha' }, user))
    await expect(run(() => tasks.updateTask(c.number, { labels: ['x'] }, assistant, { commit: () => { throw new Error('Refused at the write') } }))).rejects.toThrow('Refused at the write')
    expect((await cardOf(c.number)).labels).toEqual([])
  })

  it('a one-card batch refused for the allowance says how many fit (none), and changes nothing', async () => {
    await fresh()
    // The message's allowance is used up on other cards.
    const used = await Promise.all(Array.from({ length: control.MAX_ACTIONS_PER_TURN }, (_, i) => make(`Spent ${i + 1}`, 'hold')))
    await run(() => assistantBatch(wsPath, token, used.map((c) => c.number), { column: 'review' }, assistant))
    expect(control.actionsLeft(wsPath)).toBe(0)
    const one = await make('One card, none left')
    const refusal = await run(() => assistantBatch(wsPath, token, [one.number], { column: 'todo' }, assistant)).catch((e) => e)
    expect(refusal).toBeInstanceOf(ChangeRefused)
    expect(refusal.status).toBe(429)
    expect(refusal.extra).toEqual({ fits: 0 })
    expect((await cardOf(one.number)).column).toBe('todo')
    expect(control.actionsLeft(wsPath)).toBe(0)
  })

  it('at Look and advise, a batch is refused as a whole and changes nothing, counting nothing', async () => {
    await fresh()
    setControl('look')
    const c = await make('Look only')
    const refusal = await run(() => assistantBatch(wsPath, token, [c.number], { column: 'doing' }, assistant)).catch((e) => e)
    setControl('projects')
    expect(refusal).toBeInstanceOf(ChangeRefused)
    expect(refusal.status).toBe(403)
    expect((await cardOf(c.number)).column).toBe('todo')
    expect(control.actionsLeft(wsPath)).toBe(control.MAX_ACTIONS_PER_TURN)
  })
})

describe('batch requests', () => {
  it('sets only the fields a batch takes: a card-only or user-only field is refused as a whole', () => {
    for (const k of ['title', 'comment', 'decision', 'archived', 'links', 'blockedBy', 'project', 'before', 'review']) {
      expect(() => batchRequest({ numbers: [1], column: 'todo', [k]: 'x' })).toThrow(ChangeRefused)
    }
  })

  it('checks the values it takes', () => {
    expect(() => batchRequest({ numbers: [1] })).toThrow(/Give what to change/)
    expect(() => batchRequest({ numbers: [1], column: 'nope' })).toThrow(/Unknown column/)
    expect(() => batchRequest({ numbers: [1], position: 'middle' })).toThrow(/Unknown position/)
    expect(() => batchRequest({ numbers: [1], labels: 'bug' })).toThrow(/labels is a list/)
    expect(() => batchRequest({ numbers: [1], blocked: 3 })).toThrow(/blocked is the reason/)
    expect(() => batchRequest({ numbers: [], column: 'todo' })).toThrow(/^cards:/)
  })

  it('reads the card numbers with or without #, and an empty agent takes the agent away', () => {
    expect(batchRequest({ numbers: ['#2', 3], blocked: '' })).toEqual({ numbers: [2, 3], patch: { blocked: '' } })
    expect(batchRequest({ numbers: [4], agent: '' }).patch).toEqual({ agent: null })
  })
})

describe('the batch reply', () => {
  it('lists each card changed and each refused, with why', () => {
    const changed = { number: 4, title: 'Fix it', column: 'todo' as const, position: 2, of: 5, project: 'alpha', agent: null, changes: ['Moved to Todo'] }
    const text = batchText({ changed: [changed], refused: [{ number: 9, error: 'Unknown task #9' }] })
    expect(text).toContain('1 card changed:')
    expect(text).toContain('#4 Fix it: Moved to Todo. Now in Todo (2nd of 5), alpha.')
    expect(text).toContain('Refused, left as they were: #9 (Unknown task #9).')
  })

  it('says so when nothing changed', () => {
    expect(batchText({ changed: [], refused: [{ number: 9, error: 'Unknown task #9' }] })).toMatch(/^No card changed\./)
  })
})
