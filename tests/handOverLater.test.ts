// A hand-over at a good moment (#1057): which agents a long transcript's notice offers Hand Over to… (idle, on no running
// lane) and which a hand-over after this card, and when a queued one is done: never while merging; in a lane once its
// card is through review and the lane is on another; outside a lane once the turn is over with nothing waiting.
import { describe, expect, it } from 'vitest'
import { handOverDecision, handOverMoment, handOverWaits, handOverWhen } from '../src/shared/handOver'
import type { DeliveryNeed } from '../src/shared/deliveries'
import type { LaneCard, LaneInfo, LaneState, LiveSessionState, SessionStatus, TaskColumn } from '../src/shared/types'

type Live = Parameters<typeof handOverMoment>[0]

const live = (status: SessionStatus, more: Partial<LiveSessionState> = {}): NonNullable<Live> => ({ status, provider: 'claude', ...more })

const card = (number: number, column: TaskColumn | 'gone'): LaneCard => ({ number, title: `#${number}`, column, blocked: null }) as LaneCard

const lane = (state: LaneState, cards: LaneCard[]): LaneInfo =>
  ({
    id: 'lane-1',
    project: 'hive',
    name: null,
    builder: { id: 'b1', name: 'B1' },
    reviewer: { id: 'r1', name: 'R1' },
    cards,
    current: cards.find((x) => x.column !== 'passed' && x.column !== 'done' && x.column !== 'gone')?.number ?? null,
    state,
    pausedOn: null,
    rounds: 10,
    waitMinutes: 360,
    startedBy: 'Assistant',
    startedAt: '',
    updatedAt: '',
    endedAt: null,
    mergeCommit: null
  }) as LaneInfo

const queued = (n: number | null, laneId: string | null = 'lane-1'): LiveSessionState['handOverAfter'] => ({ card: n, lane: laneId, since: '2026-10-18T00:00:00.000Z' })

/** A readiness check that answers `idle` for a watching agent and `free` only when its turn is over with no watch. */
const readiness =
  (st: NonNullable<Live>) =>
  (need: DeliveryNeed): boolean =>
    st.status === 'ready' || st.status === 'finished' || (need === 'idle' && st.status === 'watching')

describe('handOverWaits', () => {
  it('lets an idle agent on no running lane hand over at once', () => {
    expect(handOverWaits(live('ready'), false)).toBe(false)
    expect(handOverWaits(live('finished'), false)).toBe(false)
  })

  it('waits for a working, asking, watching or merging agent, or one on a running lane', () => {
    for (const s of ['working', 'waiting', 'watching', 'background', 'starting'] as SessionStatus[]) expect(handOverWaits(live(s), false)).toBe(true)
    expect(handOverWaits(live('ready', { mergeSlot: 'Merging into main' }), false)).toBe(true)
    expect(handOverWaits(live('ready'), true)).toBe(true)
  })

  it('waits for background tasks that will wake the agent', () => {
    expect(handOverWaits(live('finished', { backgroundTasks: 2 }), false)).toBe(true)
  })

  it('never waits for an agent that is not running (Hand Over to… ends no conversation then)', () => {
    expect(handOverWaits(null, true)).toBe(false)
    expect(handOverWaits(live('stopped'), true)).toBe(false)
  })
})

describe('handOverMoment', () => {
  it('waits with nothing queued', () => {
    const st = live('ready')
    expect(handOverMoment(st, null, readiness(st))).toBe('wait')
  })

  it('outside a lane: once the turn is over with no watch', () => {
    const working = live('working', { handOverAfter: queued(null, null) })
    expect(handOverMoment(working, null, readiness(working))).toBe('wait')
    const watching = live('watching', { handOverAfter: queued(null, null) })
    expect(handOverMoment(watching, null, readiness(watching))).toBe('wait')
    const idle = live('finished', { handOverAfter: queued(null, null) })
    expect(handOverMoment(idle, null, readiness(idle))).toBe('now')
  })

  it('never while the agent holds the merge slot or waits for it', () => {
    const st = live('finished', { handOverAfter: queued(null, null), mergeSlot: 'Merging into feature/090-session' })
    expect(handOverMoment(st, null, readiness(st))).toBe('wait')
    const inLane = live('watching', { handOverAfter: queued(7), mergeSlot: 'Waiting for the merge slot' })
    expect(handOverMoment(inLane, lane('active', [card(7, 'passed'), card(8, 'doing')]), readiness(inLane))).toBe('wait')
  })

  it('in a lane: not while its card is in Doing or Review', () => {
    const st = live('watching', { handOverAfter: queued(7) })
    expect(handOverMoment(st, lane('active', [card(7, 'doing'), card(8, 'todo')]), readiness(st))).toBe('wait')
    expect(handOverMoment(st, lane('active', [card(7, 'review'), card(8, 'todo')]), readiness(st))).toBe('wait')
    // Blocked on that card (the lane paused): still its card.
    expect(handOverMoment(st, lane('paused', [card(7, 'review'), card(8, 'todo')]), readiness(st))).toBe('wait')
  })

  it('in a lane: between its steps once the card is through and the lane is on another, its turn over', () => {
    const st = live('watching', { handOverAfter: queued(7) })
    expect(handOverMoment(st, lane('active', [card(7, 'passed'), card(8, 'todo')]), readiness(st))).toBe('between')
    expect(handOverMoment(st, lane('active', [card(7, 'gone'), card(8, 'doing')]), readiness(st))).toBe('between')
    const working = live('working', { handOverAfter: queued(7) })
    expect(handOverMoment(working, lane('active', [card(7, 'passed'), card(8, 'doing')]), readiness(working))).toBe('wait')
  })

  it("in a lane with every card passed (its merge due): once the lane has ended", () => {
    const st = live('watching', { handOverAfter: queued(8) })
    expect(handOverMoment(st, lane('active', [card(7, 'passed'), card(8, 'passed')]), readiness(st))).toBe('wait')
    const queuedInMerge = live('finished', { handOverAfter: queued(null) })
    expect(handOverMoment(queuedInMerge, lane('active', [card(7, 'passed')]), readiness(queuedInMerge))).toBe('wait')
    expect(handOverMoment(queuedInMerge, lane('ended', [card(7, 'done')]), readiness(queuedInMerge))).toBe('now')
  })

  it('a lane ended, abandoned or gone: as outside a lane', () => {
    const watching = live('watching', { handOverAfter: queued(7) })
    expect(handOverMoment(watching, lane('abandoned', [card(7, 'doing')]), readiness(watching))).toBe('wait')
    const idle = live('ready', { handOverAfter: queued(7) })
    expect(handOverMoment(idle, lane('abandoned', [card(7, 'doing')]), readiness(idle))).toBe('now')
    expect(handOverMoment(idle, null, readiness(idle))).toBe('now')
  })
})

describe('handOverDecision', () => {
  it('says why it waits: merging, its card, the lane to end, or the turn', () => {
    const merging = live('finished', { handOverAfter: queued(7), mergeSlot: 'Merging into main' })
    expect(handOverDecision(merging, lane('active', [card(7, 'passed'), card(8, 'todo')]), readiness(merging))).toEqual({ wait: 'merging' })
    const watching = live('watching', { handOverAfter: queued(7) })
    expect(handOverDecision(watching, lane('active', [card(7, 'review'), card(8, 'todo')]), readiness(watching))).toEqual({ wait: 'card' })
    expect(handOverDecision(watching, lane('active', [card(7, 'passed')]), readiness(watching))).toEqual({ wait: 'lane-end' })
    const working = live('working', { handOverAfter: queued(null, null) })
    expect(handOverDecision(working, null, readiness(working))).toEqual({ wait: 'turn' })
    expect(handOverDecision(live('ready'), null, readiness(live('ready')))).toEqual({ wait: 'none' })
  })
})

describe('handOverWhen', () => {
  it('names the card, the lane, the Assistant or the turn', () => {
    expect(handOverWhen(queued(7)!, false)).toEqual({ when: 'card', card: '7' })
    expect(handOverWhen(queued(null)!, false)).toEqual({ when: 'lane', card: '' })
    expect(handOverWhen(queued(null, null)!, false)).toEqual({ when: 'other', card: '' })
    expect(handOverWhen(queued(null, null)!, true)).toEqual({ when: 'assistant', card: '' })
  })
})
