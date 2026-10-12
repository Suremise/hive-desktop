// Deliveries (#647, shared/deliveries.ts and main/deliveries.ts): the states and their moves, coalescing, the typed line
// and the inbox's reply; saved records restored after a restart (offered → uncertain, the Assistant's from a launch that
// has ended refused, and shown), permission worked out again at every step, hive_inbox (received) and ack (acked), cancel,
// expiry and overdue. The sessions are stand-ins here (the e2e deliveries suite runs fake Claude Code agents).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DELIVERY_STATES, ackText, canMove, inboxItems, inboxSummary, inboxText, isOverdue, moved, offerLine, readDelivery, type DeliveryRecord, type DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'

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
    expect(offerLine([rec({ id: 'm4', seq: 4, kind: 'card-event', from: hive, card: 607, body: 'is in Review' }), rec({ id: 'm5', seq: 5, kind: 'card-event', from: hive, card: 607, body: 'has a new comment' })], null)).toBe(
      "[Hive] #607: 2 changes, read the card (Their ids: m4, m5. Once you've acted on them, ack them with hive_inbox.)"
    )
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

  it("after a restart: one offered is uncertain; the Assistant's from a launch that has ended is refused, and in its activity list; Hive's waits and is offered", async () => {
    await make({ body: 'From the old launch.' })
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })
    st.status = 'ready'
    // Offered (typed), then Hive stops before it knows whether it arrived.
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    // The Assistant starts again (a new launch) after Hive restarts.
    now.launch = 'a2'
    const listed = assistant.actions(ws).length
    await restart()
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 uncertain: Hive stopped before it knew whether this reached the agent'])
    expect(assistant.actions(ws).slice(listed).map((a) => `${a.text} | ${a.error}`)).toEqual(["A message for B1 (m1) was refused | the Assistant's session that left it ended"])
    // What is uncertain is offered again once the agent is idle (an event about a card is safe to give twice).
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(["[Hive] #7: is in Review (Its id: m2. Once you've acted on it, ack it with hive_inbox.)"])
    expect((await deliveries.deliveriesOf(alpha, 'b1'))[1]).toMatchObject({ state: 'offered', offers: 2 })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: ['m2'], unknown: [] })
    // Queued and never offered: waits across the restart, and is offered after it.
    await make({ from: hive, kind: 'card-event', card: 8, body: 'is in Passed' })
    await restart()
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(["[Hive] #8: is in Passed (Its id: m3. Once you've acted on it, ack it with hive_inbox.)"])
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
    // Again: nothing new; received and not acked.
    expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1', 'm2', 'm3'] })
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
    await make({ from: hive, kind: 'card-event', card: 8, body: 'is in Done', conversation: null })
    st.sessionId = 's2'
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 expired: not received in time', 'm2 expired: its agent is in another conversation now', 'm3 offered'])
    // Its conversation not known yet (a CLI that reports it later): not held back.
    expect(st.typed).toEqual(["[Hive] #8: is in Done (Its id: m3. Once you've acted on it, ack it with hive_inbox.)"])
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
})
