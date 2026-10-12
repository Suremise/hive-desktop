// Lane watches (#531): the Assistant watches whole lanes, not cards. What counts (shared/laneWatch.ts: a failed review,
// a card blocked or stalled, a lane due to merge, ended or abandoned; passes and moves only when asked), the wake line
// within its size, and the watches themselves (main/watches.ts): "all" follows every running lane, lanes started later
// and cards added too, with no card limit; plain moves stay quiet; a watch after a wake counts what happened in between.
// The sessions are stand-ins here (the e2e lanewatch suite runs fake Claude Code agents).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { LANE_DEFAULT_EVENTS, laneHits, laneWakeLine, readLaneCondition, type LaneMark, type LaneNow } from '../src/shared/laneWatch'
import { WAKE_MAX_BYTES } from '../src/shared/watch'
import { taskWaitText } from '../src/shared/toolReplies'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const card = (over: Partial<LaneMark['cards'][string]> = {}) => ({ c: 'doing' as const, b: false, s: false, f: '', p: '', ...over })

describe('what a lane watch counts (#531)', () => {
  it('the condition: lane ids or "all", and events (default: all but passed and moved)', () => {
    expect(readLaneCondition({ lanes: ['all'] })).toEqual({ ids: 'all', events: LANE_DEFAULT_EVENTS })
    expect(readLaneCondition({ lanes: ['lane-1a2b3c', 'lane-4d5e6f'], events: ['failed', 'passed'] })).toEqual({ ids: ['lane-1a2b3c', 'lane-4d5e6f'], events: ['failed', 'passed'] })
    expect(readLaneCondition({ lanes: [] })).toMatch(/lanes must be/)
    expect(readLaneCondition({ lanes: ['a b'] })).toMatch(/lanes must be/)
    expect(readLaneCondition({ lanes: ['all'], events: ['merged'] })).toMatch(/events must be/)
    expect(LANE_DEFAULT_EVENTS).not.toContain('passed')
    expect(LANE_DEFAULT_EVENTS).not.toContain('moved')
  })

  it("each event since the lane's mark, only those asked for; a lane or card new to the watch starts from now", () => {
    const before: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ c: 'review' }), 2: card(), 3: card({ b: true }) } }
    const now = (mark: LaneMark, extra: Partial<LaneNow['cards'][number]>[] = []): LaneNow => ({ id: 'lane-1', label: 'B1 / R1', mark, cards: Object.keys(mark.cards).map((n, i) => ({ number: Number(n), blocked: null, stalled: null, failedBy: null, passedBy: null, ...extra[i] })) })
    const later: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ c: 'review', f: '2026-10-11T00:00:00.000Z' }), 2: card({ c: 'review', b: true }), 3: card({ b: true, s: true }), 4: card({ b: true }) } }
    const hit = laneHits(before, now(later, [{ failedBy: 'R1 (alpha)' }, { blocked: 'Which icon?' }, { stalled: "B1 isn't running." }]), LANE_DEFAULT_EVENTS)!
    expect(hit.parts.map((p) => p.text)).toEqual(['#1 failed review (R1 (alpha))', '#2 is blocked', '#3 is stalled'])
    expect(hit.parts[1].detail).toBe('Which icon?')
    // #2's move to Review counts only when asked; #4 is new to the lane: from now.
    expect(laneHits(before, now(later), ['moved'])!.parts.map((p) => p.text)).toEqual(['#2 is in Review'])
    expect(laneHits(null, now(later), LANE_DEFAULT_EVENTS)).toBeNull()
    expect(laneHits(before, now(before), LANE_DEFAULT_EVENTS)).toBeNull()
    // The lane: due to merge once every card passed (or done), ended, abandoned.
    const passed: LaneMark = { state: 'active', mergeDue: true, cards: { 1: card({ c: 'passed' }) } }
    expect(laneHits({ ...before, cards: { 1: card() } }, now(passed), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.event)).toEqual(['merge-due'])
    expect(laneHits(passed, now({ ...passed, state: 'ended', mergeDue: false }), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['ended (merged)'])
    expect(laneHits(passed, now({ ...passed, state: 'abandoned' }), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['was abandoned'])
  })

  it("the reply to a lane watch: lean, with the events only when they aren't the default", () => {
    expect(taskWaitText({ watching: 'Waiting on all running lanes', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS] })).toBe('Waiting on all running lanes. End your turn now: Hive types a line into this session on a lane event, or at T if none comes.')
    expect(taskWaitText({ watching: 'Waiting on 2 lanes', limitAt: 'T', events: ['failed', 'passed'], replaced: 'Waiting for #12 → Review' })).toBe('Waiting on 2 lanes (failed, passed). End your turn now: Hive types a line into this session on a lane event, or at T if none comes. It replaces your watch (waiting for #12 → Review).')
  })

  it('the wake line names each lane and card, within the size: details give way, then labels, then each lane is counted', () => {
    const hit = (i: number, detail = 'Which icon should the app use? A bee, a honeycomb or a hive cell.') => ({ id: `lane-${i}`, label: `Builder${i} / Reviewer${i} (lane ${i})`, parts: [{ n: 100 + i, event: 'blocked' as const, text: `#${100 + i} is blocked`, detail }, { n: 200 + i, event: 'failed' as const, text: `#${200 + i} failed review (Reviewer${i} (alpha))` }] })
    expect(laneWakeLine([hit(1)])).toBe(`[Hive] Lane Builder1 / Reviewer1 (lane 1): #101 is blocked: "Which icon should the app use? A bee, a honeycomb or a hive cell."; #201 failed review (Reviewer1 (alpha)). Your lane watch has ended: read the cards named (hive_read_task), act on them, then watch the lanes again (hive_wait_for_tasks with lanes).`)
    for (const n of [3, 7, 20, 60]) {
      const line = laneWakeLine(Array.from({ length: n }, (_, i) => hit(i, '評'.repeat(300))))
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).toMatch(/^\[Hive\] .*Your lane watch has ended/)
      if (n <= 7) for (let i = 0; i < n; i++) expect(line).toContain(`#${100 + i}`)
    }
  })
})

describe('lane watches (main/watches.ts, #531)', async () => {
  const base = tempDir('hive-lanewatch-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  watches.testHooks.settleMs = 0
  // A check reads what Hive did after `await watches.settled()`: deliveries run in the background (#570).
  const lanes = await import('../src/main/lanes')
  const { sessions } = await import('../src/main/sessions')
  let k = 0
  const open = async (builders = 3) => {
    const path = join(base, `ws-${++k}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [...Array.from({ length: builders }, (_, i) => `b${i + 1}`), 'r1', 'r2'].map((id) => ({ id, name: id.toUpperCase() })) }))
    const w = createWorkspaceService()
    await w.open(path)
    mkdirSync(w.assistantHome, { recursive: true })
    return { w, alpha, home: w.assistantHome }
  }
  /** The Assistant (watching, then working once typed into), and every agent of alpha running and working. */
  const fake = (alpha: string, home: string) => {
    const st = { status: 'watching' as string, typed: [] as string[] }
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === home.toLowerCase() && id === 'assistant' ? ({ projectPath: home, agentId: 'assistant', status: st.status, runId: 'a1' } as never) : p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: 'working', runId: id } as never) : null),
      liveStates: () => [],
      userMayBeTyping: () => false,
      lineWaiting: () => false,
      // Each line typed into the Assistant is taken (#649: its wake is received, and its watch ends, then).
      promptsTaken: (p: string, id: string) => (p.toLowerCase() === home.toLowerCase() && id === 'assistant' ? { runId: 'a1', count: st.typed.length } : null),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'working'
      },
      watchChanged: () => undefined
    })
    return st
  }
  const agent = (id: string) => ({ kind: 'agent', name: `${id.toUpperCase()} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
  const user = { kind: 'user' } as const
  const newCards = async (w: Parameters<typeof inWorkspace>[0], agentId: string, n: number) => {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push((await inWorkspace(w, () => tasks.createTask({ title: `Card ${i}`, project: 'alpha', agent: agentId, column: 'doing' }, user))).number)
    return out
  }
  const watchAll = async (w: Parameters<typeof inWorkspace>[0], home: string, st: { status: string }, events?: string[]) => {
    st.status = 'watching'
    return watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: (events ?? [...['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned']]) as never })
  }
  const fail = async (w: Parameters<typeof inWorkspace>[0], n: number, reviewer: string) => {
    await inWorkspace(w, () => tasks.updateTask(n, { review: 'start' }, agent(reviewer)))
    await inWorkspace(w, () => tasks.updateTask(n, { review: 'failed' }, agent(reviewer), { comment: 'Round 1: FAILED' }))
  }

  it('follows every running lane in one watch: a failed review and a block wake it, plain moves stay quiet; a lane due to merge and its end are told', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    const [c] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)', name: 'greetings' })
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
    const r = await watchAll(w, home, st)
    expect(r.watching.label).toBe('Waiting on all running lanes')
    expect(r.watching.lanes).toEqual(['all'])
    // A plain move into Review: nothing.
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // A failed review: told, with its lane and reviewer.
    await fail(w, a, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toMatch(new RegExp(`^\\[Hive\\] Lane B1 / R1 \\(greetings\\): #${a} failed review \\(R1 \\(alpha\\)\\)\\. Your lane watch has ended`))
    // Watched again: a block in the other lane.
    await watchAll(w, home, st)
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Which icon?' }, agent('b2')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] Lane B2 / R2: #${c} is blocked: "Which icon\\?"`))
    // Both of B1's cards pass: its merge is due. Then Done: the lane ends.
    await watchAll(w, home, st)
    for (const n of [a, b]) await inWorkspace(w, () => tasks.updateTask(n, { column: 'passed' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.typed[2]).toMatch(/^\[Hive\] Lane B1 \/ R1 \(greetings\): all its cards passed: its merge is due\./)
    await watchAll(w, home, st)
    for (const n of [a, b]) await inWorkspace(w, () => tasks.updateTask(n, { column: 'done' }, user))
    // Hive ends a lane whose cards are all Done as it follows the board (lanes.refresh).
    await lanes.refresh(w)
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(4), { timeout: HUNG_MS })
    expect(st.typed[3]).toMatch(/^\[Hive\] Lane B1 \/ R1 \(greetings\): ended \(merged\)\./)
    await disposeWorkspaceService(w)
  })

  // 27 cards and three lanes: about 2 s alone, 5 s with four runs at once, and past the 20 s default with twelve suites
  // four at once beside a full e2e set (#570's proofs). Its bound for a hung run fits that work.
  const MANY_CARDS_HUNG_MS = 60_000
  it('"all" takes in a lane started later and cards added to a lane, with no card limit; events narrow what counts', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const many = await newCards(w, 'b1', 25)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: many, by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    // A lane started after the watch: followed from when it is first seen.
    const [x] = await newCards(w, 'b3', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', cards: [x], by: 'B3 (alpha)' })
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(x, { column: 'review' }, agent('b3')))
    await fail(w, x, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toContain(`#${x} failed review`)
    // A lane started after the watch with a card already blocked when first seen: told once.
    await watchAll(w, home, st)
    const [y] = await newCards(w, 'b2', 1)
    await inWorkspace(w, () => tasks.updateTask(y, { blocked: 'Asked before the lane was seen' }, agent('b2')))
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [y], by: 'B2 (alpha)' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.typed[1]).toContain(`#${y} is blocked: "Asked before the lane was seen"`)
    st.typed.splice(1, 1)
    // The 25th card of a lane (more than a card watch's 20).
    await watchAll(w, home, st)
    const last = many[24]
    await inWorkspace(w, () => tasks.updateTask(last, { column: 'review' }, agent('b1')))
    await fail(w, last, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.typed[1]).toContain(`#${last} failed review`)
    // Only passes asked for: a failed review is quiet, a pass wakes it.
    await watchAll(w, home, st, ['passed'])
    await inWorkspace(w, () => tasks.updateTask(many[0], { column: 'review' }, agent('b1')))
    await fail(w, many[0], 'r1')
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    await inWorkspace(w, () => tasks.updateTask(many[1], { column: 'review' }, agent('b1')))
    await inWorkspace(w, () => tasks.updateTask(many[1], { review: 'start' }, agent('r1')))
    await inWorkspace(w, () => tasks.updateTask(many[1], { review: 'passed', column: 'passed' }, agent('r1'), { comment: 'Round 1: PASSED' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.typed[2]).toContain(`#${many[1]} passed review`)
    await disposeWorkspaceService(w)
  }, MANY_CARDS_HUNG_MS)

  it('seven lanes, 28 cards, in one watch: each lane followed, one wake for the lane that changed (#531 card)', async () => {
    const { w, alpha, home } = await open(7)
    const st = fake(alpha, home)
    const lanesCards: number[][] = []
    for (let i = 1; i <= 7; i++) {
      const cs = await newCards(w, `b${i}`, 4)
      lanesCards.push(cs)
      await lanes.startLane(w, { project: 'alpha', builder: `b${i}`, reviewer: 'r1', cards: cs, by: `B${i} (alpha)` })
    }
    await watchAll(w, home, st)
    const n = lanesCards[6][3]
    await inWorkspace(w, () => tasks.updateTask(n, { column: 'review' }, agent('b7')))
    await fail(w, n, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toMatch(new RegExp(`^\\[Hive\\] Lane B7 / R1: #${n} failed review \\(R1 \\(alpha\\)\\)\\. Your lane watch has ended`))
    await disposeWorkspaceService(w)
  })

  it('a card added to a followed lane is followed from an empty start: a block it came with is told (round 1 finding)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    const [b] = await newCards(w, 'b1', 1)
    await inWorkspace(w, () => tasks.updateTask(b, { blocked: 'Blocked before it joined the lane' }, agent('b1')))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toContain(`#${b} is blocked: "Blocked before it joined the lane"`)
    // Told once: the next watch starts from what that wake told.
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  for (const how of ['ended', 'abandoned'] as const) {
    it(`a lane that is ${how} between a wake and the watch after it: the watch after it is told (round 1 finding)`, async () => {
      const { w, alpha, home } = await open()
      const st = fake(alpha, home)
      const [a] = await newCards(w, 'b1', 1)
      const [c] = await newCards(w, 'b2', 1)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
      const other = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })).lane
      await watchAll(w, home, st)
      await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
      // While it handles that wake, the other lane ends (its card Done) or is abandoned.
      if (how === 'ended') {
        await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
        await lanes.refresh(w)
      } else await lanes.endLane(w, other.id, { abandoned: true })
      await watchAll(w, home, st)
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] Lane B2 / R2: ${how === 'ended' ? 'ended \\(merged\\)' : 'was abandoned'}\\.`))
      // Its end told, the lane leaves the watch: nothing more about it.
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toHaveLength(2)
      expect(watches.watchFor(home, 'assistant')?.label).toBe('Waiting on all running lanes')
      await disposeWorkspaceService(w)
    })
  }

  describe('what is new between a wake and the watch after it (round 2 findings)', () => {
    /** B1's lane with one card, watched; its block wakes the Assistant. */
    const woken = async (events?: string[]) => {
      const { w, alpha, home } = await open()
      const st = fake(alpha, home)
      const [a] = await newCards(w, 'b1', 1)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
      await watchAll(w, home, st, events)
      await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
      return { w, home, st, a }
    }

    for (const verdict of ['failed', 'passed'] as const) {
      it(`a card added to a lane and ${verdict} meanwhile is told by the next watch, once`, async () => {
        const { w, home, st, a } = await woken(['failed', 'passed', 'blocked'])
        const [b] = await newCards(w, 'b1', 1)
        await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
        await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, agent('b1')))
        await inWorkspace(w, () => tasks.updateTask(b, { review: 'start' }, agent('r1')))
        await inWorkspace(w, () => tasks.updateTask(b, { review: verdict }, agent('r1'), { comment: `Round 1: ${verdict.toUpperCase()}` }))
        await watchAll(w, home, st, ['failed', 'passed', 'blocked'])
        await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.typed[1]).toContain(`#${b} ${verdict} review (R1 (alpha))`)
        expect(st.typed[1]).not.toContain(`#${a} is blocked`)
        await watchAll(w, home, st, ['failed', 'passed', 'blocked'])
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toHaveLength(2)
        await disposeWorkspaceService(w)
      })
    }

    it('a lane started meanwhile with a blocked card is told by the next watch, once', async () => {
      const { w, home, st } = await woken()
      const [c] = await newCards(w, 'b2', 1)
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Asked as the lane started' }, agent('b2')))
      await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
      await watchAll(w, home, st)
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] Lane B2 / R2: #${c} is blocked: "Asked as the lane started"`))
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toHaveLength(2)
      await disposeWorkspaceService(w)
    })

    for (const how of ['ended', 'abandoned'] as const) {
      it(`a lane started and ${how} meanwhile is told by the next watch, once`, async () => {
        const { w, home, st } = await woken()
        const [c] = await newCards(w, 'b2', 1)
        const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })).lane
        if (how === 'ended') {
          await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
          await lanes.refresh(w)
        } else await lanes.endLane(w, l.id, { abandoned: true })
        await watchAll(w, home, st)
        await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] Lane B2 / R2: ${how === 'ended' ? 'ended \\(merged\\)' : 'was abandoned'}\\.`))
        await watchAll(w, home, st)
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toHaveLength(2)
        await disposeWorkspaceService(w)
      })
    }
  })

  it('events landing while the line waits to be typed are told in the same line (round 1 finding)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [c] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
    await watchAll(w, home, st)
    // The Assistant works (the user asked it something): the first event fires the watch but isn't typed yet.
    st.status = 'working'
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'First question' }, agent('b1')))
    await watches.evaluateWatches(w)
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Second question' }, agent('b2')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toContain(`#${a} is blocked: "First question"`)
    expect(st.typed[0]).toContain(`#${c} is blocked: "Second question"`)
    // Both told: the next watch doesn't tell them again.
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("a card that stalls wakes it with the board's reason (its agent no longer running)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // B1 stops: its Doing card has nobody on it.
    const liveFor = sessions.liveFor.bind(sessions)
    Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'b1' ? null : liveFor(p, id)) })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toContain(`#${a} is stalled: "B1 isn't running."`)
    await disposeWorkspaceService(w)
  })

  it('a lane watch started after a wake counts what happened in between; unknown lanes are refused; kept on disk and read back', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })).lane
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed', 'blocked'] })
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    // Between the wake and the next watch, #b is blocked too: the next watch is woken at once.
    await inWorkspace(w, () => tasks.updateTask(b, { blocked: 'Another question' }, agent('b1')))
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed', 'blocked'] })
    await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.typed[1]).toContain(`#${b} is blocked: "Another question"`)
    expect(st.typed[1]).not.toContain(`#${a} is blocked`)
    await expect(watches.registerLaneWatch(w, home, 'assistant', { ids: ['lane-nosuch'], events: ['failed'] })).rejects.toThrow(/No such lane: lane-nosuch/)
    // Kept: read back after the workspace is forgotten in memory, still a lane watch.
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: ['failed'] })
    watches.forgetWatches(w)
    expect(watches.watchFor(home, 'assistant')).toBeNull()
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(watches.watchFor(home, 'assistant')?.label).toBe('Waiting on all running lanes')
    await disposeWorkspaceService(w)
  })
})
