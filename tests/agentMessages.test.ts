// Messages left for an agent (#530, main/agentMessages.ts), as deliveries (#647, main/deliveries.ts): its doorbell typed at
// once when it is idle or watching (its watch carries on, and the line says so), else queued and named in its next line:
// with a wake (#649: a card event, as a watch or a loop wake hands it over) when one comes first, else a line of its own
// once it is idle; several in one line, by their ids (#650: never their text); received once the agent reads it;
// bounded; each kept to its sender's permission (refused, never typed, once it is gone); cancelled by the user or the
// Assistant; kept across the agent's stops; the reply says what became of it. The sessions are stand-ins here (the e2e
// agentmessage and deliveries suites run fake Claude Code agents).
import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

describe('messages left for agents (#530, #647)', async () => {
  const base = tempDir('hive-messages-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const messages = await import('../src/main/agentMessages')
  const deliveries = await import('../src/main/deliveries')
  const writer = await import('../src/main/lineWriter')
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  let alpha = ''
  /**
   * Stand-in agents of alpha (b1, and any other id while `running`): b1's status, launch and watch, the inbox shown,
   * whether the user types there, what was typed, and `during`: run while a line is being typed (before its last check).
   */
  const st = { status: 'working' as string, runId: 'r1', sessionId: 's1', watch: null as null | { label: string }, typing: false, shown: undefined as undefined | { unread: { id: string; state: string; text: string }[]; overdue: number }, typed: [] as string[], running: true, during: null as null | (() => unknown) }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (st.running && p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, sessionId: st.sessionId, ...(st.watch ? { watch: st.watch } : {}) } as never) : null),
    userMayBeTyping: () => st.typing,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: (_p: string, id: string, inbox: typeof st.shown) => {
      if (id === 'b1') st.shown = inbox
    },
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      await st.during?.()
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  /** Whether the Assistant may still send what it left (null: it may), as Control and its launch would say. */
  let why: string | null = null
  deliveries.setSenderCheckForTests((from) => (from.kind === 'assistant' ? why : null))
  const asst: DeliverySender = { kind: 'assistant', name: 'the Assistant', workspace: 'C:/ws', launch: 'a1' }
  const leave = (text: string) => messages.leaveMessage(alpha, 'b1', 'HR2', asst, text)
  const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
  /** A wake for b1 (#649: a card event, as a watch or a loop wake hands it over), offered now: whether a line was typed. */
  const wake = async (body: string): Promise<boolean> => {
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body })
    return deliveries.offerNow(alpha, 'b1')
  }
  const states = async (agentId = 'b1') => (await deliveries.deliveriesOf(alpha, agentId)).map((r) => `${r.id} ${r.state}${r.detail ? `: ${r.detail}` : ''}`)
  const tryAll = () => deliveries.offerAllForTests()
  /** The doorbell (#650) naming these deliveries: Hive's fixed words with counts and ids. */
  const bell = (what: string, ids: string, tail = '') => `[Hive] New in your inbox: ${what} (${ids}). Call hive_inbox to read ${ids.includes(',') ? 'them' : 'it'}.${tail}`
  beforeEach(async () => {
    // Each test its own project, so ids start at m1.
    alpha = join(base, `alpha${++n}`)
    why = null
    Object.assign(st, { status: 'working', runId: 'r1', sessionId: 's1', watch: null, typing: false, shown: undefined, typed: [], running: true, during: null })
  })

  it('a watching agent is typed into at once, with its id, and told its watch carries on', async () => {
    Object.assign(st, { status: 'watching', watch: { label: 'Waiting for #506 → Review' } })
    expect(await leave('Review #506 when it returns, then #509.')).toEqual({ id: 'm1', fate: 'typed', queued: 0 })
    expect(st.typed).toEqual([bell('1 message', 'm1', ' (Your watch is still on, waiting for #506 → Review: do what this asks, then end your turn, and Hive wakes you when it changes.)')])
    expect(await states()).toEqual(['m1 offered'])
    // Offered, not received: the pane still shows it until the agent fetches or acks it.
    expect(st.shown?.unread.map((m) => `${m.id} ${m.state}`)).toEqual(['m1 offered'])
  })

  it('a working agent gets it as its next line once it is idle; several waiting go in one line', async () => {
    expect(await leave('Add #520 to your lane after #519.')).toEqual({ id: 'm1', fate: 'queued', queued: 1 })
    expect(await leave('And #522.')).toEqual({ id: 'm2', fate: 'queued', queued: 2 })
    await tryAll()
    expect(st.typed).toEqual([])
    expect(st.shown?.unread.map((m) => m.text)).toEqual(['Add #520 to your lane after #519.', 'And #522.'])
    // Waiting for the user, on background tasks, starting: still queued. The user typing there: still queued.
    for (const s of ['waiting', 'background', 'starting']) {
      st.status = s
      await tryAll()
    }
    Object.assign(st, { status: 'finished', typing: true })
    await tryAll()
    expect(st.typed).toEqual([])
    st.typing = false
    await tryAll()
    expect(st.typed).toEqual([bell('2 messages', 'm1, m2')])
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    // Offered once.
    st.status = 'ready'
    await tryAll()
    expect(st.typed).toHaveLength(1)
  })

  it('received only once the agent reads it (#650), never because its doorbell was typed or its CLI took it; acked through hive_inbox once read, never from its id alone', async () => {
    const cli = { count: 0 }
    Object.assign(sessions, { promptsTaken: () => ({ runId: 'r1', count: cli.count }), holdForConfirm: () => () => undefined })
    writer.testHooks.takeMs = 5000
    try {
      st.status = 'ready'
      expect((await leave('Rebase first.')).fate).toBe('typed')
      // Typed, not taken yet: offered.
      expect(await states()).toEqual(['m1 offered'])
      expect(st.shown?.unread.map((m) => `${m.id} ${m.state}`)).toEqual(['m1 offered'])
      // The CLI takes the doorbell (its prompt count goes up after the line's Enter, its turn under way): still offered.
      cli.count++
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      await deliveries.followAllForTests()
      expect(await states()).toEqual(['m1 offered'])
      // The agent reads it: received, through the inbox, and no longer unread in its pane.
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m1 Rebase first.'])
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[0]).toMatchObject({ state: 'received', receivedVia: 'inbox' })
      expect(st.shown).toBeUndefined()
      // Still the agent's to ack.
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
      // Not acked from its id alone (#650: its doorbell named it, so it is read first): read, then acked.
      st.status = 'ready'
      expect((await leave('And #521.')).fate).toBe('typed')
      expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: [], unknown: [], unread: ['m2'] })
      expect((await states()).at(-1)).toBe('m2 offered')
      await deliveries.readInbox(alpha, 'b1')
      expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: ['m2'], unknown: [], unread: [] })
      expect((await states()).at(-1)).toBe('m2 acked')
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['holdForConfirm']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('offered only once saved: a save that fails types nothing, and a wake waits for the save of what rides it', async () => {
    // A save that fails: the message isn't made (nothing claims it is saved).
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      st.status = 'working'
      await expect(leave('Never saved.')).rejects.toThrow(/couldn't save the deliveries \(EACCES/)
      // Not made: nothing published, nor on disk (and its id is free again).
      expect(await states()).toEqual([])
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    // Saved while queued; offering it can't be saved: nothing is typed, and it still waits.
    await leave('Saved, then not offered.')
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      st.status = 'ready'
      await tryAll()
      expect(st.typed).toEqual([])
      expect(await states()).toEqual(['m1 queued'])
      // Nor can a wake be made while nothing can be saved: nothing is typed, and the message still waits.
      await expect(wake('[Hive] #3 is in Review.')).rejects.toThrow(/couldn't save the deliveries/)
      expect(st.typed).toEqual([])
      expect(await states()).toEqual(['m1 queued'])
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    // A save that is slow: the line's first key waits for it (the wake's own, then the offer's).
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let saving = false
    deliveries.setBeforeSaveForTests(async () => {
      saving = true
      await held
    })
    try {
      st.status = 'finished'
      const typing = wake('[Hive] #4 is in Review.')
      await vi.waitFor(() => expect(saving).toBe(true), { timeout: HUNG_MS })
      expect(st.typed).toEqual([])
      release()
      expect(await typing).toBe(true)
      expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it("waiting messages go in the line with the agent's next wake, once; a change while it is typed stops it, and the next try takes what waits then", async () => {
    await leave('Use the revised review scope.')
    // The agent's turn ends and a wake (a loop wake's card event) is due before the queue is tried: one line, the message first.
    st.status = 'finished'
    expect(await wake("[Hive] #2 (B1's card) is in Review. You review this card in its loop: carry on with it.")).toBe(true)
    expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    st.status = 'finished'
    await tryAll()
    expect(st.typed).toHaveLength(1)
    // Cancelled while the line is typed: the wake isn't typed with it; tried again, it goes alone.
    st.status = 'working'
    await leave('Never mind.')
    st.status = 'finished'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await wake('[Hive] #3 is in Review.')).toBe(false)
    st.during = null
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 card event', 'm4')), { timeout: HUNG_MS })
    expect((await states()).slice(2)).toEqual(['m3 cancelled: cancelled by the user', 'm4 offered'])
    // A line that isn't typed after all (the agent got busy): both wait again, and go together in the next line.
    st.status = 'working'
    await leave('Again later.')
    st.status = 'finished'
    st.during = () => {
      st.status = 'working'
    }
    expect(await wake('[Hive] #4 is in Review.')).toBe(false)
    st.during = null
    await vi.waitFor(async () => expect((await states()).slice(4)).toEqual(['m5 queued', 'm6 queued']), { timeout: HUNG_MS })
    st.status = 'finished'
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 message and 1 card event', 'm5, m6')), { timeout: HUNG_MS })
  })

  it('cancelled while it is being typed: never typed, and the reply says so, not that it was typed', async () => {
    st.status = 'ready'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await leave('Stop that.')).toEqual({ id: 'm1', fate: 'cancelled', queued: 0, detail: 'cancelled by the user' })
    expect(st.typed).toEqual([])
  })

  it("kept to its sender's permission: refused, never typed, once it is gone, while queued or while it is typed", async () => {
    await leave('This delivery requires Control agents.')
    why = 'the user turned Settings → Assistant → Control down'
    st.status = 'finished'
    await tryAll()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    // Nor can it be sent while its sender may not.
    await expect(leave('Refused at once.')).rejects.toThrow(/Not sent: the user turned/)
    // Nor does it go in a line with a wake: the wake is typed alone.
    why = null
    st.status = 'working'
    await leave('Also gone.')
    why = "the Assistant's session that left it ended"
    st.status = 'finished'
    expect(await wake('[Hive] #4 is in Review.')).toBe(true)
    expect(st.typed).toEqual([bell('1 card event', 'm3')])
    await vi.waitFor(async () => expect((await states())[1]).toBe("m2 refused: the Assistant's session that left it ended"), { timeout: HUNG_MS })
    // Revoked while it is being typed at once: stopped before Enter, and refused.
    why = null
    st.status = 'ready'
    st.during = () => {
      why = 'the user turned Settings → Assistant → Control down'
    }
    expect(await leave('Typed now?')).toEqual({ id: 'm4', fate: 'refused', queued: 0, detail: 'the user turned Settings → Assistant → Control down' })
    expect(st.typed).toEqual([bell('1 card event', 'm3')])
  })

  it('its CLI drops the first Enter and its permission goes before the Enter again: never submitted; the line is cleared and a wake that was in it typed again alone', async () => {
    // A CLI that takes nothing typed (as Codex dropped an Enter on 7 Oct), until Hive presses Enter again.
    const cli = { count: 0, enters: 0, clears: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: 'r1', count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      clearTyped: () => {
        cli.clears++
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 100
    try {
      // Its own line: typed, not taken; revoked before the Enter again.
      st.status = 'ready'
      expect(await leave('Revoked before the retry.')).toEqual({ id: 'm1', fate: 'typed', queued: 0 })
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(() => expect(cli.clears).toBe(1), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      // Its refusal is saved after the line is cleared.
      await vi.waitFor(async () => expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down']), { timeout: HUNG_MS })
      // In a line with a wake: the same, and the wake is typed again alone (it still holds), and taken.
      why = null
      st.status = 'working'
      await leave('Riding, revoked before the retry.')
      st.status = 'finished'
      expect(await wake('[Hive] #5 is in Review.')).toBe(true)
      expect(st.typed.at(-1)).toBe(bell('1 message and 1 card event', 'm2, m3'))
      why = "the Assistant's session that left it ended"
      await vi.waitFor(() => expect(cli.clears).toBe(2), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 card event', 'm3')), { timeout: 5000 })
      expect(st.typed.filter((t) => t.includes('m2'))).toHaveLength(1)
      await vi.waitFor(async () => expect((await states())[1]).toBe("m2 refused: the Assistant's session that left it ended"), { timeout: HUNG_MS })
      // The wake typed again is taken by the Enter again (nothing else is in its line now): one Enter, for it; received
      // once the agent reads it (#650).
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m3'])
      expect((await states()).at(-1)).toBe('m3 received')
      // Still allowed: the Enter again submits it, as before.
      why = null
      st.status = 'ready'
      await leave('Still allowed.')
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: HUNG_MS })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m4'])
      expect(cli.clears).toBe(2)
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain', 'clearTyped']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('a transaction is saved before anyone sees it: a read waits for a create whose save fails, and gets nothing of it', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let saves = 0
    deliveries.setBeforeSaveForTests(async () => {
      if (++saves === 1) {
        await held
        throw new Error('EACCES: permission denied')
      }
    })
    try {
      st.status = 'working'
      const made = leave('Never saved, never seen.')
      await vi.waitFor(() => expect(saves).toBe(1), { timeout: HUNG_MS })
      const read = deliveries.readInbox(alpha, 'b1')
      release()
      await expect(made).rejects.toThrow(/couldn't save the deliveries/)
      expect(await read).toEqual({ items: [], unacked: [] })
      expect(await states()).toEqual([])
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it('an operation takes effect at its save: a change while it is saved applies to the next one; a line is checked again before its first key', async () => {
    let release = (): void => undefined
    let holding = false
    const hold = (): void => {
      holding = false
      const held = new Promise<void>((r) => (release = r))
      let first = true
      deliveries.setBeforeSaveForTests(async () => {
        if (!first) return
        first = false
        holding = true
        await held
      })
    }
    try {
      // The inbox: its sender's launch ends while the save of "received" is held: the fetch was decided before, so it
      // is given out and received.
      st.status = 'working'
      await leave('Fetched, then revoked.')
      hold()
      const read = deliveries.readInbox(alpha, 'b1')
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      why = "the Assistant's session that left it ended"
      release()
      expect((await read).items.map((x) => x.ids)).toEqual([['m1']])
      expect(await states()).toEqual(['m1 received'])
      why = null
      // An ack: the agent moves to another conversation while it is saved: acked; the next operation (its inbox) finds
      // the one left for the old conversation expired.
      await leave('Acked from the old conversation.')
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids)).toEqual([['m2']])
      await leave('Left for the old conversation.')
      hold()
      const ack = deliveries.ackDeliveries(alpha, 'b1', ['m2'])
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      st.sessionId = 's2'
      release()
      expect(await ack).toEqual({ acked: ['m2'], unknown: [], unread: [] })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
      expect((await states()).slice(1)).toEqual(['m2 acked', 'm3 expired: its agent is in another conversation now'])
      // An offer: its sender's permission goes while "offered" is saved: the writer's check before the first key stops
      // it: nothing typed, refused.
      await leave('Offered while revoked.')
      hold()
      st.status = 'ready'
      const offering = tryAll()
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      why = 'the user turned Settings → Assistant → Control down'
      release()
      await offering
      expect(st.typed).toEqual([])
      expect((await states()).at(-1)).toBe('m4 refused: the user turned Settings → Assistant → Control down')
      why = null
      // An offer: the agent moves to another conversation while "offered" is saved: nothing typed into it, expired.
      st.status = 'working'
      await leave('For this conversation only.')
      hold()
      st.status = 'ready'
      const offering2 = tryAll()
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      st.sessionId = 's3'
      release()
      await offering2
      expect(st.typed).toEqual([])
      expect((await states()).at(-1)).toBe('m5 expired: its agent is in another conversation now')
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it('a save that fails changes nothing, on disk or in memory, and a restart restores what was saved (inbox and ack; its write or its rename failing)', async () => {
    for (const how of ['inbox', 'ack'] as const) {
      for (const at of ['write', 'rename'] as const) {
        alpha = join(base, `alpha-failed-${how}-${at}`)
        st.status = 'working'
        await leave('Never received.')
        // An ack is of what was read (#650): read first.
        if (how === 'ack') await deliveries.readInbox(alpha, 'b1')
        const was = how === 'ack' ? 'm1 received' : 'm1 queued'
        const fail = (): never => {
          throw new Error('EIO: i/o error')
        }
        if (at === 'write') deliveries.setBeforeSaveForTests(fail)
        else deliveries.setBeforeRenameForTests(fail)
        try {
          const call = how === 'inbox' ? deliveries.readInbox(alpha, 'b1') : deliveries.ackDeliveries(alpha, 'b1', ['m1'])
          await expect(call).rejects.toThrow(/couldn't save the deliveries \(EIO.*nothing changed/)
        } finally {
          deliveries.setBeforeSaveForTests(null)
          deliveries.setBeforeRenameForTests(null)
        }
        expect(await states()).toEqual([was])
        const dir = join(alpha, '.hive')
        expect(JSON.parse(readFileSync(join(dir, 'deliveries.json'), 'utf8')).deliveries.map((r: { id: string; state: string }) => `${r.id} ${r.state}`)).toEqual([was])
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
        await deliveries.forgetDeliveriesForTests()
        expect(await states()).toEqual([was])
      }
    }
  })

  it("the confirmation's Enter again checks what the first keys did: expired (also once a check has published it), another conversation, cancelled, another launch (uncertain then, #649): no Enter, ended honestly", async () => {
    const cli = { count: 0, enters: 0, clears: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      clearTyped: () => {
        cli.clears++
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    let t = Date.now()
    deliveries.setClockForTests(() => t)
    writer.testHooks.takeMs = 100
    try {
      // Typed, its first Enter lost; then past its expiry: no Enter again; the line is cleared; expired.
      st.status = 'ready'
      expect((await messages.leaveMessage(alpha, 'b1', 'HR2', asst, 'Expires before the retry.')).fate).toBe('typed')
      t += 25 * 60 * 60_000
      await vi.waitFor(() => expect(cli.clears).toBe(1), { timeout: HUNG_MS })
      await vi.waitFor(async () => expect(await states()).toEqual(['m1 expired: not received in time']), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // The same once a check (the agent's inbox) has published it expired first.
      t = Date.now()
      st.status = 'ready'
      expect((await leave('Expired by a check first.')).fate).toBe('typed')
      t += 25 * 60 * 60_000
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect((await states()).at(-1)).toBe('m2 expired: not received in time')
      await vi.waitFor(() => expect(cli.clears).toBe(2), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // The agent in another conversation before the retry: no Enter again; expired.
      t = Date.now()
      st.status = 'ready'
      expect((await leave('For this conversation.')).fate).toBe('typed')
      st.sessionId = 's2'
      await vi.waitFor(() => expect(cli.clears).toBe(3), { timeout: HUNG_MS })
      await vi.waitFor(async () => expect((await states()).at(-1)).toBe('m3 expired: its agent is in another conversation now'), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // Cancelled while its CLI hasn't taken the line: no Enter again; Hive's line is cleared; cancelled.
      st.status = 'ready'
      expect((await leave('Cancelled before the retry.')).fate).toBe('typed')
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
      await vi.waitFor(() => expect(cli.clears).toBe(4), { timeout: HUNG_MS })
      expect((await states()).at(-1)).toBe('m4 cancelled: cancelled by the user')
      expect(cli.enters).toBe(0)
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // The agent started again before the retry: no Enter (nor a clear) in the new launch; it may not have reached the
      // agent, so it is uncertain (#649), waiting to be offered once more, and the user can still cancel it.
      st.status = 'working'
      expect((await leave('Typed into the old launch.')).fate).toBe('queued')
      st.status = 'ready'
      await tryAll()
      expect((await states()).at(-1)).toBe('m5 offered')
      st.runId = 'r2'
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      expect(cli.clears).toBe(4)
      await vi.waitFor(async () => expect((await states()).at(-1)).toBe('m5 uncertain: may not have reached it: its session ended or restarted before it was read'), { timeout: HUNG_MS })
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
    } finally {
      deliveries.setClockForTests(null)
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain', 'clearTyped']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it("a line with a wake whose offer is saved slowly while a prompt of the user's is taken: its confirmation waits for this line, a cancel still ends the message, no Enter again, and the wake is typed again alone", async () => {
    const cli = { count: 0, enters: 0, clears: 0, entersAtClear: -1 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      clearTyped: () => {
        cli.clears++
        cli.entersAtClear = cli.enters
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    // Long enough for the cancel to land before the Enter again would come.
    writer.testHooks.takeMs = 2000
    let release = (): void => undefined
    try {
      st.status = 'working'
      await leave('Rides a slow save.')
      await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[Hive] #6 is in Review.' })
      // The offer's save of "offered" is held; meanwhile the user's own prompt is taken and its turn ends.
      const held = new Promise<void>((r) => (release = r))
      let holding = false
      deliveries.setBeforeSaveForTests(async () => {
        if (holding) return
        holding = true
        await held
      })
      st.status = 'finished'
      const typing = deliveries.offerNow(alpha, 'b1')
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      cli.count++
      release()
      deliveries.setBeforeSaveForTests(null)
      expect(await typing).toBe(true)
      expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
      // Its Enter was lost (the count is still the user's prompt's): not taken, so still the user's to cancel.
      expect(writer.confirmsInFlight()).toBe(1)
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
      await vi.waitFor(() => expect(cli.clears).toBe(1), { timeout: HUNG_MS })
      expect(cli.entersAtClear).toBe(0)
      await vi.waitFor(async () => expect(await states()).toEqual(['m1 cancelled: cancelled by the user', 'm2 queued']), { timeout: HUNG_MS })
      // The wake that was in it is typed again alone.
      await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 card event', 'm2')), { timeout: HUNG_MS })
      expect(st.typed.filter((t) => t.includes('m1'))).toHaveLength(1)
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain', 'clearTyped']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('a line Hive leaves in the prompt (the user typed over it): nothing more is typed into the agent until that prompt is submitted, so their draft is never typed over (#530, #649)', async () => {
    const cli = { count: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      userTypedOverLine: () => true,
      submitAgain: () => true,
      clearTyped: () => true,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 50
    try {
      st.status = 'working'
      await leave('Revoked with a draft over it.')
      st.status = 'finished'
      expect(await wake('[Hive] #7 is in Review.')).toBe(true)
      expect(st.typed).toHaveLength(1)
      // Its sender's permission goes before the Enter again, and the user has typed over the line: left as it is.
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(async () => expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down', 'm2 queued']), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      why = null
      // The wake still holds, but nothing is typed over the user's draft while that prompt stands.
      st.status = 'ready'
      await tryAll()
      expect(st.typed).toHaveLength(1)
      // Submitted (its CLI's count goes up): the wake goes in, alone.
      cli.count++
      await tryAll()
      expect(st.typed.at(-1)).toBe(bell('1 card event', 'm2'))
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'userTypedOverLine', 'submitAgain', 'clearTyped']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('bounded: at most 5 waiting, 4000 characters each; refused for an agent not running', async () => {
    for (let i = 0; i < messages.MAX_QUEUED; i++) await leave(`Note ${i}`)
    await expect(leave('One too many')).rejects.toThrow(/already has 5 messages waiting/)
    await expect(leave('x'.repeat(messages.MESSAGE_MAX_CHARS + 1))).rejects.toThrow(/at most 4000 characters/)
    // Another agent's count is its own.
    expect((await messages.leaveMessage(alpha, 'b2', 'B2', asst, 'Hello')).fate).toBe('queued')
    st.running = false
    await expect(leave('Hello')).rejects.toThrow(/isn't running/)
  })

  it('cancelled by the user or the Assistant: never typed; kept across a stop and offered to its next launch of that conversation, not another', async () => {
    await leave('Hold on.')
    expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
    expect(st.shown).toBeUndefined()
    expect(await states()).toEqual(['m1 cancelled: cancelled by the user'])
    expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(0)
    st.status = 'ready'
    await tryAll()
    expect(st.typed).toEqual([])
    // Stopped and started again in the same conversation: it waited, and goes in.
    st.status = 'working'
    await leave('For after the restart.')
    st.running = false
    await tryAll()
    expect((await states()).at(-1)).toBe('m2 queued')
    Object.assign(st, { running: true, runId: 'r2', status: 'ready' })
    await tryAll()
    expect(st.typed.at(-1)).toBe(bell('1 message', 'm2'))
    // Its agent in another conversation now: not for it.
    st.status = 'working'
    await leave('For the old conversation.')
    Object.assign(st, { sessionId: 's2', status: 'ready' })
    await tryAll()
    expect(st.typed.filter((t) => t.includes('m3'))).toEqual([])
    expect((await states()).at(-1)).toBe('m3 expired: its agent is in another conversation now')
  })
})
