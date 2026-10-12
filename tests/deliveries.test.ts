// Deliveries (#647, shared/deliveries.ts and main/deliveries.ts): the states and their moves, coalescing, the typed line
// and the inbox's reply; saved records restored after a restart (offered → uncertain, the Assistant's from a launch that
// has ended refused, and shown), permission worked out again at every step, hive_inbox (received) and ack (acked), cancel,
// expiry and overdue. The sessions are stand-ins here (the e2e deliveries suite runs fake Claude Code agents).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DELIVERY_BODY_MAX_CHARS, DELIVERY_STATES, ackText, canMove, inboxItems, inboxSummary, inboxText, isOverdue, moved, offerLine, readDelivery, type DeliveryRecord, type DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const at = '2026-10-12T03:00:00.000Z'
const rec = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ id: 'm1', seq: 1, agentId: 'b1', conversation: null, kind: 'rebrief', from: { kind: 'assistant', name: 'the Assistant', workspace: 'C:/ws', launch: 'a1' }, body: 'Rebase first.', state: 'queued', created: at, expires: '2026-10-13T03:00:00.000Z', ...over })

describe('delivery records (#647)', () => {
  it('moves only as the states allow, filling in their times', () => {
    const offered = moved(rec(), 'offered', '2026-10-12T03:01:00.000Z')!
    expect(offered).toMatchObject({ state: 'offered', offered: '2026-10-12T03:01:00.000Z', offers: 1 })
    const received = moved(offered, 'received', '2026-10-12T03:02:00.000Z')!
    expect(moved(received, 'acked', '2026-10-12T03:03:00.000Z')).toMatchObject({ state: 'acked', received: '2026-10-12T03:02:00.000Z', acked: '2026-10-12T03:03:00.000Z' })
    // Acked straight from queued (it was read in a line Hive didn't see taken): received then too.
    expect(moved(rec(), 'acked', '2026-10-12T03:04:00.000Z')).toMatchObject({ received: '2026-10-12T03:04:00.000Z', acked: '2026-10-12T03:04:00.000Z' })
    // Not offered after all: as it was.
    expect(moved(offered, 'queued', at)).toEqual(rec())
    expect(moved(rec(), 'cancelled', at, 'cancelled by the user')).toMatchObject({ state: 'cancelled', ended: at, detail: 'cancelled by the user' })
    // Ended stays ended; received can't be refused or cancelled (the agent has it).
    for (const end of ['acked', 'cancelled', 'refused', 'expired'] as const) for (const to of DELIVERY_STATES) expect(canMove(end, to)).toBe(false)
    expect(canMove('received', 'refused')).toBe(false)
    expect(canMove('received', 'cancelled')).toBe(false)
    expect(canMove('queued', 'uncertain')).toBe(false)
    expect(canMove('offered', 'uncertain')).toBe(true)
    expect(canMove('uncertain', 'offered')).toBe(true)
    expect(moved(rec({ state: 'acked' }), 'queued', at)).toBeNull()
  })

  it('overdue: live and not acked OVERDUE_MINUTES after it was made', () => {
    const t = Date.parse(at)
    expect(isOverdue(rec(), t + 29 * 60_000)).toBe(false)
    expect(isOverdue(rec(), t + 30 * 60_000)).toBe(true)
    expect(isOverdue(rec({ state: 'received' }), t + 31 * 60_000)).toBe(true)
    expect(isOverdue(rec({ state: 'acked' }), t + 31 * 60_000)).toBe(false)
    expect(isOverdue(rec({ state: 'refused' }), t + 31 * 60_000)).toBe(false)
    expect(inboxSummary([rec({ state: 'received' })], t + 31 * 60_000)).toEqual({ unread: [], overdue: 1 })
    expect(inboxSummary([rec({ state: 'acked' })], t)).toBeUndefined()
  })

  it("coalesces a card's events into one item, where its first one was; a message stays its own", () => {
    const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
    const items = inboxItems([
      rec({ id: 'm1', seq: 1, kind: 'card-event', from: hive, card: 607, body: 'is in Review' }),
      rec({ id: 'm2', seq: 2 }),
      rec({ id: 'm3', seq: 3, kind: 'card-event', from: hive, card: 607, body: 'has a new comment' }),
      rec({ id: 'm4', seq: 4, kind: 'card-event', from: hive, card: 608, body: 'is in Passed' }),
      rec({ id: 'm5', seq: 5, kind: 'card-event', from: hive, card: 607, body: 'is in Doing', state: 'received' }),
      rec({ id: 'm6', seq: 6, kind: 'card-event', from: hive, card: 607, body: 'is in Done' })
    ])
    expect(items.map((i) => [i.ids.join(','), i.card ?? null, i.text])).toEqual([
      ['m1,m3,m6', 607, '3 changes, read the card'],
      ['m2', null, 'Rebase first.'],
      ['m4', 608, 'is in Passed']
    ])
    expect(inboxText(items, ['m5'])).toBe(
      ['3 new:', 'm1,m3,m6 · Hive · #607: 3 changes, read the card', 'm2 · the Assistant: Rebase first.', 'm4 · Hive · #608: is in Passed', 'Received before, not acked yet: m5.', 'Ack each with hive_inbox (ack: its ids) once you have acted on it.'].join('\n')
    )
    expect(inboxText([], [])).toBe('Nothing new.')
    expect(inboxText([], ['m5'])).toBe('Nothing new. Received before, not acked yet: m5.')
    expect(ackText(['m1', 'm3'], ['m9'])).toBe('Acked m1, m3. Not in your inbox: m9.')
    // Typed (#649): messages first, with their ids; each other delivery as its producer's own line, with its id to ack for
    // a kind the agent acks (not a card event or a control notice); one that may repeat says so.
    const wake = (id: string, seq: number, body: string, o: Partial<DeliveryRecord> = {}) => rec({ id, seq, kind: 'card-event', from: hive, card: 607, body, ...o })
    expect(offerLine([wake('m4', 4, '[Hive] #607 is in Review.'), wake('m5', 5, '[Hive] #607 has a new comment.')], null)).toBe('[Hive] #607 is in Review. [Hive] #607 has a new comment.')
    expect(offerLine([wake('m6', 6, '[Hive] #607 is in Review.'), rec({ id: 'm2', seq: 2, body: 'Rebase first.' }), rec({ id: 'm7', seq: 7, kind: 'answer', from: { kind: 'user', name: 'the user' }, body: '[Hive] #607 has 1 new decision.' })], null)).toBe(
      "[Hive] Message from the Assistant: Rebase first. (Its id: m2. Once you've acted on it, ack it with hive_inbox.) [Hive] #607 is in Review. [Hive] #607 has 1 new decision. (Its id: m7. Once you've acted on it, ack it with hive_inbox.)"
    )
    expect(offerLine([wake('m8', 8, '[Hive] #607 is in Review.', { again: 'Hive restarted while offering it' })], null)).toBe('[Hive] #607 is in Review. (m8 again: Hive restarted while offering it, so it may repeat.)')
  })

  it('reads back only what checks out (the file can be edited by hand)', () => {
    expect(readDelivery(JSON.parse(JSON.stringify(rec({ card: 12, offered: at, offers: 1, state: 'offered' }))))).toEqual(rec({ card: 12, offered: at, offers: 1, state: 'offered' }))
    for (const bad of [{ id: 'x1' }, { state: 'delivered' }, { kind: 'mail' }, { from: { kind: 'assistant', name: 'A' } }, { created: 'yesterday' }, { card: -1 }, { body: 7 }, { seq: 0 }]) expect(readDelivery({ ...rec(), ...bad })).toBeNull()
    expect(readDelivery(null)).toBeNull()
  })
})

describe('the delivery service (#647)', async () => {
  const base = tempDir('hive-deliveries-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const deliveries = await import('../src/main/deliveries')
  const assistant = await import('../src/main/assistantControl')
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  let alpha = ''
  const st = { status: 'working' as string, runId: 'r1', sessionId: 's1', running: true, typed: [] as string[] }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (st.running && p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, sessionId: st.sessionId } as never) : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined,
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  // The Assistant's launch that is running now, and whether Control lets it run agents (as senderRefusal works them out).
  const now = { launch: 'a1', control: true }
  deliveries.setSenderCheckForTests((from) => (from.kind !== 'assistant' ? null : !now.control ? 'the user turned Settings → Assistant → Control down' : from.launch !== now.launch ? "the Assistant's session that left it ended" : null))
  const ws = join(base, 'ws')
  const asst = (launch = 'a1'): DeliverySender => ({ kind: 'assistant', name: 'the Assistant', workspace: ws, launch })
  const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
  const make = (o: Partial<Parameters<typeof deliveries.createDelivery>[1]> = {}) => deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1', conversation: 's1', kind: 'rebrief', from: asst(), body: 'Rebase first.', ...o })
  const states = async (agentId = 'b1') => (await deliveries.deliveriesOf(alpha, agentId)).map((r) => `${r.id} ${r.state}${r.detail ? `: ${r.detail}` : ''}`)
  const file = () => JSON.parse(readFileSync(join(alpha, '.hive', 'deliveries.json'), 'utf8')) as { next: number; deliveries: DeliveryRecord[] }
  /** A restart of Hive: memory forgotten, the file read again. */
  const restart = async () => {
    await deliveries.forgetDeliveriesForTests()
    await deliveries.load(alpha)
    await deliveries.settledForTests()
  }
  beforeEach(() => {
    alpha = join(base, `alpha${++n}`)
    Object.assign(st, { status: 'working', runId: 'r1', sessionId: 's1', running: true, typed: [] })
    Object.assign(now, { launch: 'a1', control: true })
    deliveries.setFileBudgetForTests(4 * 1024 * 1024)
  })

  it('saved as made, with short ids that go on across a restart', async () => {
    expect((await make()).id).toBe('m1')
    expect((await make({ body: 'Then #520.' })).id).toBe('m2')
    expect(file()).toMatchObject({ next: 3, deliveries: [{ id: 'm1', state: 'queued', body: 'Rebase first.', from: { kind: 'assistant', launch: 'a1' }, conversation: 's1' }, { id: 'm2' }] })
    // Nothing that can't be saved: no token, no function.
    expect(JSON.stringify(file())).not.toMatch(/token/i)
    await restart()
    expect((await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })).id).toBe('m3')
  })

  it("after a restart (#649): one offered and not received is uncertain, offered once more saying it may repeat, then left uncertain; the Assistant's from a launch that has ended is refused, and in its activity list; one queued waits and is offered", async () => {
    await make({ body: 'From the old launch.' })
    await make({ from: hive, kind: 'card-event', card: 7, body: '[Hive] #7 is in Review.' })
    st.status = 'ready'
    // Offered (typed), then Hive stops before its CLI took it.
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    // The Assistant starts again (a new launch) after Hive restarts: what was offered isn't received, so its permission
    // counts: refused. Hive's own may not have reached the agent: uncertain.
    now.launch = 'a2'
    const listed = assistant.actions(ws).length
    await restart()
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 uncertain: may not have reached it: Hive stopped while offering it'])
    expect(assistant.actions(ws).slice(listed).map((a) => `${a.text} | ${a.error}`)).toEqual(["A message for B1 (m1) was refused | the Assistant's session that left it ended"])
    // Offered once more when the agent is idle, saying it may repeat.
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(['[Hive] #7 is in Review. (m2 again: Hive restarted while offering it, so it may repeat.)'])
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 offered'])
    // Hive stops again before that one is taken: uncertain, and not typed a third time; the inbox still has it.
    await restart()
    expect((await states())[1]).toBe('m2 uncertain: may not have reached it: Hive stopped while offering it')
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m2 [Hive] #7 is in Review.'])
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 received'])
    // Queued and never offered: waits across the restart, and is offered after it.
    await make({ from: hive, kind: 'card-event', card: 8, body: '[Hive] #8 is in Passed.' })
    await restart()
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(['[Hive] #8 is in Passed.'])
  })

  it('a damaged file is set aside, never overwritten, and Hive starts again with none', async () => {
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'deliveries.json'), '{ not json')
    await deliveries.forgetDeliveriesForTests()
    expect(await deliveries.deliveriesOf(alpha, 'b1')).toEqual([])
    expect(readdirSync(join(alpha, '.hive')).some((f) => f.startsWith('deliveries.json.damaged-'))).toBe(true)
    expect((await make()).id).toBe('m1')
    // Entries that aren't deliveries are left out; the rest are kept.
    const saved = file()
    writeFileSync(join(alpha, '.hive', 'deliveries.json'), JSON.stringify({ version: 1, next: 9, deliveries: [{ id: 'nope' }, ...saved.deliveries] }))
    await restart()
    expect(await states()).toEqual(['m1 queued'])
    expect((await make()).id).toBe('m9')
    // …and kept aside in the file as they were, not lost.
    await deliveries.settledForTests()
    expect((JSON.parse(readFileSync(join(alpha, '.hive', 'deliveries.json'), 'utf8')) as { invalid?: unknown[] }).invalid).toEqual([{ id: 'nope' }])
  })

  it('permission is worked out again at every step: refused at once when its sender may not; refused while it waits once Control is turned down', async () => {
    now.control = false
    await expect(make()).rejects.toThrow(/Not sent: the user turned/)
    now.control = true
    await make()
    now.control = false
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    // Turned up again: what was refused stays refused.
    now.control = true
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
  })

  it('hive_inbox: lists what is unread (now received, not typed after), with what was received before and not acked; ack takes only its own', async () => {
    await make()
    await make({ from: hive, kind: 'card-event', card: 607, body: 'is in Review' })
    await make({ from: hive, kind: 'card-event', card: 607, body: 'has a new comment' })
    await make({ agentId: 'b2', agentName: 'B2', body: 'For B2.' })
    const r = await deliveries.readInbox(alpha, 'b1')
    expect(r.items.map((i) => [i.ids.join(','), i.text])).toEqual([
      ['m1', 'Rebase first.'],
      ['m2,m3', '2 changes, read the card']
    ])
    expect(r.unacked).toEqual([])
    expect(await states()).toEqual(['m1 received', 'm2 received', 'm3 received'])
    expect((await deliveries.deliveriesOf(alpha, 'b1'))[0].receivedVia).toBe('inbox')
    // Received: not typed after, when the agent is idle.
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    // Again: nothing new; received and not acked (a message: a card event is done once received, #649).
    expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
    // Ack: its own; another agent's, or none, is unknown (nothing said of it).
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1', 'm2', 'm4', 'm99'])).toEqual({ acked: ['m1', 'm2'], unknown: ['m4', 'm99'] })
    expect(await states()).toEqual(['m1 acked', 'm2 acked', 'm3 received'])
    expect(await states('b2')).toEqual(['m4 queued'])
    // Acked again: still acked. Cancelled: not for it to act on.
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1'])).toEqual({ acked: ['m1'], unknown: [] })
    await make({ body: 'Cancelled one.' })
    await deliveries.cancelDeliveries(alpha, 'b1', 'the user')
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m5'])).toEqual({ acked: [], unknown: ['m5'] })
    // Survives a restart as it is.
    await restart()
    expect(await states()).toEqual(['m1 acked', 'm2 acked', 'm3 received', 'm5 cancelled: cancelled by the user'])
  })

  it('cancel: only what still waits (a received one is the agent’s); by kind', async () => {
    await make()
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })
    await deliveries.readInbox(alpha, 'b1')
    await make({ body: 'Waiting.' })
    await make({ from: hive, kind: 'card-event', card: 8, body: 'is in Done' })
    expect(await deliveries.cancelDeliveries(alpha, 'b1', 'the Assistant', ['rebrief'])).toBe(1)
    expect(await states()).toEqual(['m1 received', 'm2 received', 'm3 cancelled: cancelled by the Assistant', 'm4 queued'])
  })

  it('expires when not received in time, or once its agent is in another conversation', async () => {
    // Its expiry already past when it is next looked at (no wait for it).
    await make({ expiresMs: -1000 })
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })
    await make({ from: hive, kind: 'card-event', card: 8, body: '[Hive] #8 is in Done.', conversation: null })
    st.sessionId = 's2'
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 expired: not received in time', 'm2 expired: its agent is in another conversation now', 'm3 offered'])
    // Its conversation not known yet (a CLI that reports it later): not held back.
    expect(st.typed).toEqual(['[Hive] #8 is in Done.'])
  })

  it('a task is given now or not at all (#649): typed at once, alone, with its id to ack; not given (cancelled, saying why) to an agent that is busy or watching; one a launch carries is received once that launch takes its first prompt', async () => {
    const task = (body: string) => deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: hive, body, need: 'free' })
    st.status = 'working'
    await expect(task('Fix #3.')).rejects.toThrow(/^it is working$/)
    st.status = 'watching'
    await expect(task('Fix #4.')).rejects.toThrow(/waiting on cards/)
    expect(await states()).toEqual(['m1 cancelled: not given: it is working', 'm2 cancelled: not given: it is waiting on cards, and takes no new work until it is woken'])
    // A message waits too: the task goes alone.
    st.status = 'working'
    await make({ body: 'Rebase first.' })
    st.status = 'ready'
    expect((await task('Fix #5.')).state).toBe('offered')
    expect(st.typed).toEqual(["Fix #5. (Its id: m4. Once you've acted on it, ack it with hive_inbox.)"])
    expect((await states())[2]).toBe('m3 queued')
    // A task its launch carries: offered into that launch (its prompt with its id), received once it takes its first prompt.
    const taken = { n: 0 }
    Object.assign(sessions, { promptsTaken: () => ({ runId: 'r9', count: taken.n }) })
    try {
      st.runId = 'r9'
      let line = ''
      const { record } = await deliveries.launchWith(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Start on #6.' }, async (l) => {
        line = l
        return { runId: 'r9' }
      })
      expect(line).toBe("Start on #6. (Its id: m5. Once you've acted on it, ack it with hive_inbox.)")
      expect(record).toMatchObject({ id: 'm5', state: 'offered', offerRun: 'r9' })
      taken.n = 1
      await deliveries.followAllForTests()
      expect((await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === 'm5')).toMatchObject({ state: 'received', receivedVia: 'typed' })
      // A launch that fails: its task is cancelled, and the error stands.
      await expect(
        deliveries.launchWith(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Never started.' }, async () => {
          throw new Error('It refused to start.')
        })
      ).rejects.toThrow(/refused to start/)
      expect((await states()).at(-1)).toBe('m6 cancelled: not given: It refused to start.')
    } finally {
      Object.assign(sessions, { promptsTaken: () => null })
    }
  })

  it("a launch's task is saved as offered before anything is launched (#649 round 2): not saved, nothing starts; while it starts, never offered by the scheduler; its run's save failing after the launch, it is still followed, and a restart finds it uncertain", async () => {
    const task = (body: string) => ({ agentId: 'b1', agentName: 'B1', kind: 'task' as const, from: hive, body })
    // Not saved: nothing is launched.
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EIO: i/o error')
    })
    let starts = 0
    try {
      await expect(deliveries.launchWith(alpha, task('Never launched.'), async () => (starts++, { runId: 'r9' }))).rejects.toThrow(/couldn't save/)
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    expect(starts).toBe(0)
    expect(await states()).toEqual([])
    // While it starts: saved as offered (not queued), and the scheduler doesn't offer it too.
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let starting = false
    st.status = 'ready'
    const launching = deliveries.launchWith(alpha, task('Start on #7.'), async () => {
      starting = true
      await held
      return { runId: 'r9' }
    })
    await vi.waitFor(() => expect(starting).toBe(true), { timeout: HUNG_MS })
    expect(file().deliveries.map((r) => `${r.id} ${r.state}`)).toEqual(['m1 offered'])
    await deliveries.offerAllForTests()
    await deliveries.followAllForTests()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 offered'])
    // Its run's save fails after the launch: launched all the same, and still offered into that launch (in memory).
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EIO: i/o error')
    })
    release()
    try {
      expect((await launching).record.state).toBe('offered')
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    st.runId = 'r9'
    await deliveries.offerAllForTests()
    await deliveries.followAllForTests()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 offered'])
    // Hive stops before that launch takes it: uncertain after the restart, offered once more saying it may repeat.
    await restart()
    expect(await states()).toEqual(['m1 uncertain: may not have reached it: Hive stopped while offering it'])
    await deliveries.offerAllForTests()
    expect(st.typed).toEqual(["Start on #7. (Its id: m1. Once you've acted on it, ack it with hive_inbox.) (m1 again: Hive restarted while offering it, so it may repeat.)"])
  })

  it('a long task (a card with a long description) is kept as made and restored as it was; one longer than a delivery may be is refused when made, never lost on a restart (#649 round 2)', async () => {
    const long = `Work on task #9 from the Hive task board: Long\n\n${'A long description. '.repeat(1000)}`
    expect(long.length).toBeGreaterThan(9000)
    st.status = 'working'
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'task', from: hive, body: long })
    await make({ from: hive, kind: 'handover', body: `Read the handover "x". ${'More. '.repeat(3000)}` })
    await restart()
    const back = await deliveries.deliveriesOf(alpha, 'b1')
    expect(back.map((r) => `${r.id} ${r.state} ${r.body.length}`)).toEqual([`m1 queued ${long.length}`, `m2 queued ${back[1]?.body.length}`])
    expect(back[0].body).toBe(long)
    expect(file()).not.toHaveProperty('invalid')
    // Over the limit: refused at once, nothing saved.
    await expect(deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'x'.repeat(DELIVERY_BODY_MAX_CHARS + 1) })).rejects.toThrow(/too long to give an agent/)
    expect(await states()).toEqual(['m1 queued', 'm2 queued'])
  })

  it('the Agent API view: unread, overdue, the newest rows with their times', async () => {
    await make()
    await make({ body: 'Second.' })
    await deliveries.readInbox(alpha, 'b1')
    await deliveries.ackDeliveries(alpha, 'b1', ['m1'])
    await make({ body: 'Third, a long one '.repeat(10) })
    const v = await deliveries.deliveryView(alpha, 'b1', 2)
    expect(v).toMatchObject({ unread: 1, overdue: 0, more: 1, deliveries: [{ id: 'm2', state: 'received', receivedVia: 'inbox' }, { id: 'm3', state: 'queued', from: 'the Assistant' }] })
    expect(v.deliveries[1].text.length).toBeLessThanOrEqual(80)
    expect(v.deliveries[0].received).toBeTruthy()
    expect(existsSync(join(alpha, '.hive', 'deliveries.json'))).toBe(true)
  })

  it('ack checks what is unread as an offer would, in the same step: refused, expired or for another conversation is not acked; one received still is', async () => {
    await make({ body: 'Revoked before the ack.' })
    now.control = false
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1'])).toEqual({ acked: [], unknown: ['m1'] })
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    now.control = true
    await make({ body: 'Past its expiry.', expiresMs: -1000 })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: [], unknown: ['m2'] })
    expect((await states()).at(-1)).toBe('m2 expired: not received in time')
    await make({ body: 'For the old conversation.' })
    st.sessionId = 's2'
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m3'])).toEqual({ acked: [], unknown: ['m3'] })
    expect((await states()).at(-1)).toBe('m3 expired: its agent is in another conversation now')
    // Received: the agent has it, so it may still say it acted on it after its sender's permission went.
    await make({ body: 'Received first.', conversation: 's2' })
    await deliveries.readInbox(alpha, 'b1')
    now.control = false
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m4'])).toEqual({ acked: ['m4'], unknown: [] })
  })

  it('within its byte budget: refused when full (history makes room first), and a file it wrote always reads back whole', async () => {
    deliveries.setFileBudgetForTests(40_000)
    // Multibyte text, at the longest a message may be.
    const big = 'é✓'.repeat(2000)
    let made = 0
    for (;;) {
      try {
        await make({ agentId: `a${made}`, body: big })
        made++
      } catch (e) {
        expect((e as Error).message).toMatch(/deliveries are full/)
        break
      }
    }
    expect(made).toBeGreaterThan(1)
    expect(readFileSync(join(alpha, '.hive', 'deliveries.json')).length).toBeLessThanOrEqual(40_000)
    // Ended ones' history makes room: one cancelled lets a new one in.
    await deliveries.cancelDeliveries(alpha, 'a0', 'the user')
    await make({ agentId: 'late', body: big })
    // Read back after a restart: every one of them, nothing set aside, and the ids go on.
    await restart()
    expect(readdirSync(join(alpha, '.hive')).filter((f) => f.startsWith('deliveries.json.'))).toEqual([])
    const all = file().deliveries
    expect(all.filter((r) => r.state === 'queued').length).toBe(made)
    deliveries.setFileBudgetForTests(4 * 1024 * 1024)
    // (The one refused for room was never made: its id is free.)
    expect((await make({ body: 'After.' })).id).toBe(`m${made + 2}`)
  })
})
