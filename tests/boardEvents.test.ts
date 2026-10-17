// A batch of card changes under load ran main out of memory (#988, #1011): each tasks-changed is a read of the whole
// board for its listeners, the board folder's watcher told one for each card written (a temporary file and a rename),
// and recording the running agents' cards read the board once per agent per event, never one run at a time. Now a batch
// tells the board once, after it; the watcher tells a burst once; the readers run one at a time, with one more run for
// the changes told meanwhile.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-board-events-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

// Every read of the whole board that recording the running agents' cards makes, counted (the reads themselves unchanged).
const boardReads = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/main/tasks', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/main/tasks')>()
  return {
    ...orig,
    allTasks: (...a: Parameters<typeof orig.allTasks>) => {
      boardReads.n++
      return orig.allTasks(...a)
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { onHiveEvent } = await import('../src/main/events')
const { coalesced, coalescing } = await import('../src/main/coalesce')
const { recordLiveCardsSoon } = await import('../src/main/cardSessions')

/** Bounds a hung run; the tests wait for what they expect, never for a time. */
const HUNG_MS = 15_000
const user = { kind: 'user' } as const

describe('coalesced (#1011)', () => {
  it('runs one at a time: asked meanwhile, however often, it runs once more after, and each ask resolves after a run that started after it', async () => {
    let running = 0
    let most = 0
    let runs = 0
    const gates: (() => void)[] = []
    const fn = async (): Promise<void> => {
      runs++
      running++
      most = Math.max(most, running)
      await new Promise<void>((r) => gates.push(r))
      running--
    }
    const first = coalesced('t1', fn)
    const later = Array.from({ length: 20 }, () => coalesced('t1', fn))
    expect(runs).toBe(1)
    gates.shift()!()
    // The one more run, for all 20 asks.
    await vi.waitFor(() => expect(runs).toBe(2), { timeout: HUNG_MS })
    // The asks made during the first run wait for the second, the first's included (it ran on): none has settled yet.
    let settled = false
    void Promise.all([first, ...later]).then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    gates.shift()!()
    await Promise.all([first, ...later])
    expect(runs).toBe(2)
    expect(most).toBe(1)
    expect(coalescing('t1')).toBe(false)
  })

  it("a run that fails doesn't stop the one after it, and other keys run beside it", async () => {
    let runs = 0
    const failing = coalesced('t2', async () => {
      runs++
      throw new Error('no')
    })
    const again = coalesced('t2', async () => void runs++)
    const other = coalesced('t3', async () => void runs++)
    await Promise.all([failing, again, other])
    expect(runs).toBe(3)
  })
})

describe('board events (#1011)', () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  let w: ReturnType<typeof createWorkspaceService>
  const seen: number[] = []
  let off: () => void
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  beforeAll(async () => {
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    off = onHiveEvent((e: HiveEvent) => {
      if (e.type === 'tasks-changed' && e.workspacePath === wsPath) seen.push(Date.now())
    })
  })
  afterAll(async () => {
    off()
    await disposeWorkspaceService(w)
  })
  afterEach(() => void (seen.length = 0))

  /** Cards in Done, and the board told of them before the test looks. */
  async function doneCards(n: number): Promise<number[]> {
    const made: number[] = []
    for (let i = 0; i < n; i++) made.push((await run(() => tasks.createTask({ title: `Card ${i}`, project: 'alpha', column: 'done' }, user))).number)
    const told = seen.length
    // A hand edit after them: once it is told, what the watcher saw of the cards has been told too.
    writeFileSync(join(wsPath, '.hive', 'tasks', 'marker.json'), JSON.stringify({ at: Date.now() }))
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(told), { timeout: HUNG_MS })
    await vi.waitFor(() => expect((w as unknown as { tasksTimer: unknown }).tasksTimer).toBeNull(), { timeout: HUNG_MS })
    seen.length = 0
    return made
  }

  /** What `batch` told the board: nothing while it ran, and once (or twice, a write the watcher told late) after it. */
  async function toldOnceAfter(batch: () => Promise<unknown>): Promise<void> {
    await batch()
    expect(seen).toHaveLength(0)
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: HUNG_MS })
    await vi.waitFor(() => expect((w as unknown as { tasksTimer: unknown }).tasksTimer).toBeNull(), { timeout: HUNG_MS })
    expect(seen.length).toBeLessThanOrEqual(2)
  }

  it('Archive All of 40 cards tells the board once, after it (its 40 writes were 80 events)', async () => {
    const cards = await doneCards(40)
    await toldOnceAfter(async () => {
      const r = await run(() => tasks.archiveBatch(cards, { label: 'Archive All', column: 'done', project: null, query: '', includeBusy: true }, user))
      expect(r.archived).toHaveLength(40)
    })
  })

  it('a batch update of 30 cards tells the board once, after it (it told one for each card)', async () => {
    const cards = await doneCards(30)
    await toldOnceAfter(async () => {
      const items = await run(() => tasks.updateTasks(cards, { labels: ['x'] }, user))
      expect(items.every((i) => i.error === null)).toBe(true)
    })
  })

  it('a card changed by hand still shows at once, and a burst of them is told once, not once a file', async () => {
    const t = Date.now()
    writeFileSync(join(wsPath, '.hive', 'tasks', '9001.json'), JSON.stringify({ number: 9001, title: 'By hand', project: 'alpha' }))
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: HUNG_MS })
    // Told within the quiet time, not held back (a bound for a slow machine, not how long it takes).
    expect(seen[0] - t).toBeLessThan(HUNG_MS)
    await vi.waitFor(() => expect((w as unknown as { tasksTimer: unknown }).tasksTimer).toBeNull(), { timeout: HUNG_MS })
    seen.length = 0
    for (let i = 0; i < 30; i++) writeFileSync(join(wsPath, '.hive', 'tasks', `${9100 + i}.json`), JSON.stringify({ number: 9100 + i, title: 'By hand', project: 'alpha' }))
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: HUNG_MS })
    await vi.waitFor(() => expect((w as unknown as { tasksTimer: unknown }).tasksTimer).toBeNull(), { timeout: HUNG_MS })
    // 30 files, each a create and a change: told once a burst (at least every 0.5 s while it goes on), never once a file.
    expect(seen.length).toBeLessThan(10)
  })

  describe('a batch and a change already waiting to be told (#1011 round 2)', () => {
    type Held = { tasksChangedSoon: () => void; holdTaskEvents: <T>(fn: () => Promise<T>) => Promise<T>; tasksTimer: unknown }
    const gate = (): { open: () => void; wait: Promise<void> } => {
      let open = (): void => undefined
      const wait = new Promise<void>((r) => (open = r))
      return { open, wait }
    }
    // The quiet times, run on a fake clock: what is told while a batch is held is checked at a time after them, not slept for.
    const later = (): void => void vi.advanceTimersByTime(5_000)

    beforeEach(async () => {
      await vi.waitFor(() => expect((w as unknown as Held).tasksTimer).toBeNull(), { timeout: HUNG_MS })
      seen.length = 0
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    afterEach(() => void vi.useRealTimers())

    it('a change waiting to be told as a batch starts is told after it, once, not part way through it', async () => {
      const ws = w as unknown as Held
      ws.tasksChangedSoon()
      const g = gate()
      const batch = ws.holdTaskEvents(() => g.wait)
      later()
      expect(seen).toHaveLength(0)
      // And what changes during it.
      ws.tasksChangedSoon()
      later()
      expect(seen).toHaveLength(0)
      g.open()
      await batch
      later()
      expect(seen).toHaveLength(1)
    })

    it('batches that overlap are told once, after the last of them', async () => {
      const ws = w as unknown as Held
      const a = gate()
      const b = gate()
      const first = ws.holdTaskEvents(() => a.wait)
      const second = ws.holdTaskEvents(() => b.wait)
      ws.tasksChangedSoon()
      a.open()
      await first
      later()
      expect(seen).toHaveLength(0)
      b.open()
      await second
      later()
      expect(seen).toHaveLength(1)
    })

    it('a batch with nothing to tell tells nothing', async () => {
      const g = gate()
      const batch = (w as unknown as Held).holdTaskEvents(() => g.wait)
      g.open()
      await batch
      later()
      expect(seen).toHaveLength(0)
    })
  })

  it("recording the running agents' cards reads the board once a run, one run at a time, with one more for the changes told meanwhile", async () => {
    const live = Array.from({ length: 12 }, (_, i) => ({ projectPath: alpha, agentId: `a${i}`, sessionId: `s${i}`, settingUp: false }) as unknown as LiveSessionState)
    boardReads.n = 0
    // 50 board changes told while the first run reads: 12 agents each, they were 600 reads.
    const all = Array.from({ length: 50 }, () => recordLiveCardsSoon(wsPath, () => live))
    await Promise.all(all)
    expect(boardReads.n).toBe(2)
  })
})
