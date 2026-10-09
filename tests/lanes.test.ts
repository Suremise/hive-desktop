// Lanes (#483): the card loops a workspace runs, as the card-loop skill registers them. How a lane reads against the
// board (its current card, paused while that is blocked, rounds), which are listed, what is kept, and the service:
// start, update, join (either order), end, an agent's removal, and following the board (all Done ends it).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, TaskCard } from '../src/shared/types'
import { allDone, keptLanes, laneLine, laneView, listedLanes, readLane, readLanes, laneCards, laneNumber, laneName, LANE_LINGER_MS, LANE_KEEP_MS, MAX_LANES, type LaneRecord } from '../src/shared/lanes'
import { tempDir } from './tempDir'

const base = tempDir('hive-lanes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { onHiveEvent } = await import('../src/main/events')

vi.setConfig({ testTimeout: 30_000 })

const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({
  id: 'lane-1',
  project: 'alpha',
  name: null,
  builder: { id: 'b1', name: 'B1' },
  reviewer: { id: 'r1', name: 'R1' },
  cards: [1, 2, 3],
  rounds: 10,
  waitMinutes: 360,
  state: 'active',
  startedBy: 'B1 (alpha)',
  startedAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  endedAt: null,
  mergeCommit: null,
  ...over
})

const card = (number: number, column: TaskCard['column'], over: Partial<TaskCard> = {}): TaskCard =>
  ({ number, title: `Card ${number}`, column, project: 'alpha', blocked: null, history: [], comments: [], archived: false, ...over }) as unknown as TaskCard

describe('a lane against the board', () => {
  it('its current card is the first not passed or done; rounds count failed reviews', () => {
    const failed = { at: '', by: 'R1', what: 'Review failed' }
    const v = laneView(rec(), new Map([[1, card(1, 'done')], [2, card(2, 'review', { history: [failed, failed] as TaskCard['history'], review: { agent: 'r1' } as TaskCard['review'] })], [3, card(3, 'todo')]]))
    expect(v.current).toBe(2)
    expect(v.state).toBe('active')
    expect(v.cards.map((c) => [c.number, c.column, c.round, c.reviewing])).toEqual([[1, 'done', 1, false], [2, 'review', 3, true], [3, 'todo', 1, false]])
  })

  it('is paused while its current card is blocked, and only then', () => {
    const paused = laneView(rec(), new Map([[1, card(1, 'passed')], [2, card(2, 'doing', { blocked: 'Asked the user' })], [3, card(3, 'todo')]]))
    expect([paused.state, paused.pausedOn]).toEqual(['paused', 2])
    // A later card blocked (its own reason) doesn't pause the lane.
    const later = laneView(rec(), new Map([[1, card(1, 'doing')], [2, card(2, 'todo')], [3, card(3, 'todo', { blocked: 'Needs #2' })]]))
    expect([later.state, later.pausedOn]).toEqual(['active', null])
    // An ended lane stays ended.
    expect(laneView(rec({ state: 'ended', endedAt: '2026-10-09T11:00:00.000Z' }), new Map([[1, card(1, 'doing', { blocked: 'x' })]])).state).toBe('ended')
  })

  it('a card gone (archived, deleted, another project) reads as gone and is skipped', () => {
    const v = laneView(rec(), new Map([[1, card(1, 'done')], [2, null], [3, card(3, 'todo')]]))
    expect(v.cards[1]).toMatchObject({ number: 2, column: 'gone', title: '' })
    expect(v.current).toBe(3)
  })

  it('names its agents as the project has them now', () => {
    const v = laneView(rec(), new Map(), new Map([['b1', 'Builder One']]))
    expect([v.builder.name, v.reviewer?.name]).toEqual(['Builder One', 'R1'])
  })

  it('all Done (gone cards aside) ends it; Passed is not merged', () => {
    expect(allDone(laneView(rec(), new Map([[1, card(1, 'done')], [2, null], [3, card(3, 'done')]])).cards)).toBe(true)
    expect(allDone(laneView(rec(), new Map([[1, card(1, 'done')], [2, card(2, 'passed')], [3, card(3, 'done')]])).cards)).toBe(false)
    expect(allDone(laneView(rec(), new Map()).cards)).toBe(false)
  })

  it('in a line: its pair, state, cards and id', () => {
    const v = laneView(rec({ name: 'lanes and loops' }), new Map([[1, card(1, 'passed')], [2, card(2, 'review', { history: [{ at: '', by: 'R1', what: 'Review failed' }] as TaskCard['history'] })], [3, card(3, 'todo')]]))
    expect(laneLine(v)).toBe('B1 / R1 (alpha) lanes and loops: active, on #2; #1 Passed, #2 Review r2, #3 Todo; rounds 10, wait 6 h. lane-1')
  })
})

describe('which lanes are listed and kept', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  const ago = (ms: number): string => new Date(now - ms).toISOString()

  it('running ones, and ended ones for an hour unless their builder started another', () => {
    const live = rec({ id: 'a' })
    const recent = rec({ id: 'b', builder: { id: 'b2', name: 'B2' }, state: 'ended', endedAt: ago(10 * 60_000), startedAt: '2026-10-09T08:00:00.000Z' })
    const old = rec({ id: 'c', builder: { id: 'b3', name: 'B3' }, state: 'abandoned', endedAt: ago(LANE_LINGER_MS + 1000) })
    const replaced = rec({ id: 'd', state: 'ended', endedAt: ago(60_000), startedAt: '2026-10-09T09:00:00.000Z' })
    expect(listedLanes([live, recent, old, replaced], now).map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('keeps running lanes and those ended within a day, at most MAX_LANES', () => {
    const list = [rec({ id: 'live' }), rec({ id: 'day', state: 'ended', endedAt: ago(LANE_KEEP_MS + 1) }), rec({ id: 'hour', state: 'ended', endedAt: ago(60_000) })]
    expect(keptLanes(list, now).map((l) => l.id)).toEqual(['live', 'hour'])
    const many = Array.from({ length: MAX_LANES + 5 }, (_, i) => rec({ id: `e${i}`, state: 'ended', endedAt: ago((MAX_LANES + 5 - i) * 1000) }))
    const kept = keptLanes([rec({ id: 'live' }), ...many], now)
    expect(kept.length).toBe(MAX_LANES)
    expect(kept.some((l) => l.id === 'live')).toBe(true)
    expect(kept.some((l) => l.id === 'e0')).toBe(false)
  })

  it('reads back only lanes it would have written', () => {
    expect(readLane(rec())).toEqual(rec())
    expect(readLane({ ...rec(), cards: [] })).toBeNull()
    expect(readLane({ ...rec(), cards: [1, 1] })).toBeNull()
    expect(readLane({ ...rec(), state: 'paused' })).toBeNull()
    expect(readLane({ ...rec(), state: 'ended', endedAt: null })).toBeNull()
    expect(readLane({ ...rec(), rounds: 0 })).toBeNull()
    expect(readLanes({ lanes: [rec(), rec(), 'junk', null] }).length).toBe(1)
    expect(readLanes('nonsense')).toEqual([])
  })

  it('checks what a call gives', () => {
    expect(laneCards([3, 1, 2])).toEqual([3, 1, 2])
    expect(typeof laneCards([])).toBe('string')
    expect(typeof laneCards([1, 1])).toBe('string')
    expect(typeof laneCards([1.5])).toBe('string')
    expect(laneNumber(undefined, 'rounds', 5)).toBe(5)
    expect(laneNumber(360, 'waitMinutes', 120)).toBe(360)
    expect(typeof laneNumber(0, 'rounds', 5)).toBe('string')
    expect(typeof laneNumber(99999, 'waitMinutes', 5)).toBe('string')
    expect(laneName('  lanes\nand   loops ')).toBe('lanes and loops')
    expect(laneName('')).toBeNull()
  })
})

describe('the lanes service', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const events: HiveEvent[] = []
  let off: () => void
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    const p = join(wsPath, 'alpha')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'b2', name: 'B2' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    lanes.startLanes()
    off = onHiveEvent((e) => e.type === 'lanes-changed' && events.push(e))
  })
  afterAll(async () => {
    off()
    await disposeWorkspaceService(w)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string) => run(() => tasks.createTask({ title, project: 'alpha' }, user))
  const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> => {
    const t = Date.now()
    while (!(await fn()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50))
    return fn()
  }

  it('starts a lane, updates it when started again with a card in common, and starts anew with none', async () => {
    const [c1, c2, c3] = [await make('One'), await make('Two'), await make('Three')]
    const a = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], rounds: 10, waitMinutes: 360, name: 'first', by: 'B1 (alpha)' })
    expect(a.did).toBe('started')
    expect(a.lane).toMatchObject({ builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, rounds: 10, waitMinutes: 360, state: 'active', current: c1.number, startedBy: 'B1 (alpha)' })
    // Resumed or changed (a card added): the same lane, its reviewer kept.
    const b = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c1.number, c2.number, c3.number], by: 'B1 (alpha)' })
    expect([b.did, b.lane.id, b.lane.reviewer?.id, b.lane.rounds, b.lane.cards.length]).toEqual(['updated', a.lane.id, 'r1', 10, 3])
    // Other cards altogether: the earlier lane is abandoned (its cards aren't done), a new one starts.
    const c4 = await make('Four')
    const c = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [c4.number], by: 'B1 (alpha)' })
    expect([c.did, c.replaced?.id, c.replaced?.state, c.lane.reviewer]).toEqual(['started', a.lane.id, 'abandoned', null])
    // One running lane per builder.
    const listed = await lanes.listLanes(w)
    expect(listed.filter((l) => l.builder.id === 'b1' && (l.state === 'active' || l.state === 'paused')).map((l) => l.id)).toEqual([c.lane.id])
    // The abandoned one isn't listed: its builder started another.
    expect(listed.some((l) => l.id === a.lane.id)).toBe(false)
    expect((await lanes.listLanes(w, { all: true })).some((l) => l.id === a.lane.id)).toBe(true)
    await lanes.endLane(w, c.lane.id, { abandoned: true })
  })

  it('a reviewer joins its builder’s lane, before or after the builder starts it', async () => {
    const [c1, c2] = [await make('J1'), await make('J2')]
    // Before: no lane for B2 yet, so joining with the cards starts it.
    const early = await lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1.number, c2.number], by: 'R1 (alpha)' })
    expect([early.did, early.lane.builder.id, early.lane.reviewer?.id]).toEqual(['joined', 'b2', 'r1'])
    // The builder's own start then updates it, keeping its reviewer.
    const mine = await lanes.startLane(w, { project: 'alpha', builder: 'b2', cards: [c1.number, c2.number], rounds: 3, by: 'B2 (alpha)' })
    expect([mine.did, mine.lane.id, mine.lane.reviewer?.id, mine.lane.rounds]).toEqual(['updated', early.lane.id, 'r1', 3])
    // Without cards and no lane: refused, saying what to give.
    await lanes.endLane(w, mine.lane.id, {})
    await expect(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', by: 'R1 (alpha)' })).rejects.toThrow(/no lane running yet/)
  })

  it("a builder's next loop, its last lane's cards passed but not merged: that lane ends (not abandoned), whoever registers first", async () => {
    const [p1, p2, n1, n2, m1] = [await make('P1'), await make('P2'), await make('N1'), await make('N2'), await make('M1')]
    const passed = async (...ns: number[]) => {
      for (const n of ns) await run(() => tasks.updateTask(n, { column: 'passed' }, user))
    }
    // The reviewer first: with cards, it joins only a lane that shares one, so the passed lane isn't taken over.
    const l1 = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [p1.number, p2.number], by: 'B1 (alpha)' })).lane
    await passed(p1.number, p2.number)
    const joined = await lanes.joinLane(w, { project: 'alpha', builder: 'b1', reviewer: 'b2', cards: [n1.number, n2.number], by: 'B2 (alpha)' })
    expect([joined.did, joined.lane.id === l1.id, joined.lane.reviewer?.id, joined.lane.cards.map((c) => c.number)]).toEqual(['joined', false, 'b2', [n1.number, n2.number]])
    expect(joined.replaced).toMatchObject({ id: l1.id, state: 'ended', reviewer: { id: 'r1' } })
    // The builder's start then updates that new lane.
    const mine = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [n1.number, n2.number], rounds: 4, by: 'B1 (alpha)' })
    expect([mine.did, mine.lane.id, mine.lane.reviewer?.id]).toEqual(['updated', joined.lane.id, 'b2'])
    // The builder first: its passed lane ends too; one with a card still to do is abandoned.
    await passed(n1.number, n2.number)
    const next = await lanes.startLane(w, { project: 'alpha', builder: 'b1', cards: [m1.number], by: 'B1 (alpha)' })
    expect([next.did, next.replaced?.id, next.replaced?.state]).toEqual(['started', joined.lane.id, 'ended'])
    // Without cards, a reviewer joins the builder's running lane, whatever its cards.
    const plain = await lanes.joinLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', by: 'R1 (alpha)' })
    expect([plain.lane.id, plain.lane.reviewer?.id]).toEqual([next.lane.id, 'r1'])
    await lanes.endLane(w, next.lane.id, { abandoned: true })
  })

  it('only its builder or reviewer ends it, among agents; the user and the Assistant may', async () => {
    const c = await make('E1')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'B1 (alpha)' })).lane
    await expect(lanes.endLane(w, l.id, { project: 'alpha', agent: 'b2' })).rejects.toThrow(/builder or reviewer/)
    const ended = await lanes.endLane(w, l.id, { project: 'alpha', agent: 'b1', mergeCommit: 'abc1234' })
    expect([ended.state, ended.mergeCommit, !!ended.endedAt]).toEqual(['ended', 'abc1234', true])
    await expect(lanes.endLane(w, 'lane-none', {})).rejects.toThrow(/Unknown lane/)
  })

  it('an agent removed abandons its lanes', async () => {
    const c = await make('R1')
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c.number], by: 'B2 (alpha)' })).lane
    await lanes.laneAgentRemoved(w, 'alpha', 'r1')
    expect((await lanes.getLane(w, l.id)).state).toBe('abandoned')
  })

  it('follows the board: paused while blocked, ended once every card is Done, and the window is told', async () => {
    const [c1, c2] = [await make('F1'), await make('F2')]
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], by: 'B1 (alpha)' })).lane
    const told = (fn: (x: Extract<HiveEvent, { type: 'lanes-changed' }>) => boolean) => until(() => events.some((e) => e.type === 'lanes-changed' && fn(e)))
    const mine = (e: Extract<HiveEvent, { type: 'lanes-changed' }>) => e.lanes.find((x) => x.id === l.id)
    expect(await told((e) => mine(e)?.state === 'active')).toBe(true)
    await run(() => tasks.updateTask(c1.number, { column: 'doing', blocked: 'Asked the user' }, user))
    expect(await told((e) => mine(e)?.state === 'paused' && mine(e)?.pausedOn === c1.number)).toBe(true)
    await run(() => tasks.updateTask(c1.number, { blocked: '' }, user))
    expect(await told((e) => mine(e)?.state === 'active' && mine(e)?.current === c1.number)).toBe(true)
    await run(() => tasks.updateTask(c1.number, { column: 'done' }, user))
    await run(() => tasks.updateTask(c2.number, { column: 'done' }, user))
    expect(await told((e) => mine(e)?.state === 'ended')).toBe(true)
    expect((await lanes.getLane(w, l.id)).endedAt).not.toBeNull()
  })
})
