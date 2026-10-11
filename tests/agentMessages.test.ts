// Messages left for an agent that can't take a prompt now (#530, main/agentMessages.ts): typed at once when it is idle or
// watching (its watch carries on, and the line says so), else queued and typed with its next line: first in a wake (a
// watch's line, a loop wake) when one comes first, else a line of its own once it is idle; several in one line; bounded;
// each kept to its sender's permission (refused, never typed, once it is gone); cancelled by the user or the Assistant;
// dropped when its launch ends; the reply says what became of it. The sessions are stand-ins here (the e2e
// agentmessage suite runs fake Claude Code agents).
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

describe('messages left for agents (#530)', async () => {
  const base = tempDir('hive-messages-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const messages = await import('../src/main/agentMessages')
  const watches = await import('../src/main/watches')
  messages.useRiderForTests()
  const { sessions } = await import('../src/main/sessions')
  const alpha = join(base, 'alpha')
  /**
   * Stand-in agents of alpha (b1, and any other id while `running`): b1's status, launch and watch, the queue shown,
   * whether the user types there, what was typed, and `during`: run while a line is being typed (before its last check).
   */
  const st = { status: 'working' as string, runId: 'r1', watch: null as null | { label: string }, typing: false, shown: null as unknown[] | null, typed: [] as string[], running: true, during: null as null | (() => void) }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (st.running && p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, ...(st.watch ? { watch: st.watch } : {}) } as never) : null),
    userMayBeTyping: () => st.typing,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setQueuedMessages: (_p: string, id: string, items: unknown[] | null) => {
      if (id === 'b1') st.shown = items
    },
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      st.during?.()
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  const leave = (text: string, allowed?: () => string | null) => messages.leaveMessage(alpha, 'b1', 'HR2', 'the Assistant', text, allowed)
  beforeEach(() => {
    messages.clearMessages()
    Object.assign(st, { status: 'working', runId: 'r1', watch: null, typing: false, shown: null, typed: [], running: true, during: null })
  })

  it('the line: one message, several in order, and a watch that carries on', () => {
    expect(messages.messageLine([{ from: 'the Assistant', text: 'Darren answered #506: resume in the recorded provider.' }], null)).toBe('[Hive] Message from the Assistant: Darren answered #506: resume in the recorded provider.')
    expect(messages.messageLine([{ from: 'the Assistant', text: 'One.' }, { from: 'the Assistant', text: 'Two.' }], 'Waiting for #506, #509 → Review')).toBe(
      '[Hive] 2 messages from the Assistant: (1) One. (2) Two. (Your watch is still on, waiting for #506, #509 → Review: do what this asks, then end your turn, and Hive wakes you when it changes.)'
    )
  })

  it('a watching agent is typed into at once, and told its watch carries on', async () => {
    Object.assign(st, { status: 'watching', watch: { label: 'Waiting for #506 → Review' } })
    expect(await leave('Review #506 when it returns, then #509.')).toEqual({ fate: 'delivered', queued: 0 })
    expect(st.typed).toEqual(['[Hive] Message from the Assistant: Review #506 when it returns, then #509. (Your watch is still on, waiting for #506 → Review: do what this asks, then end your turn, and Hive wakes you when it changes.)'])
    expect(st.shown).toBeNull()
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'delivered', count: 1 } })
  })

  it('a working agent gets it as its next line once it is idle; several waiting go in one line', async () => {
    expect(await leave('Add #520 to your lane after #519.')).toEqual({ fate: 'queued', queued: 1 })
    expect(await leave('And #522.')).toEqual({ fate: 'queued', queued: 2 })
    await messages.tryMessages()
    expect(st.typed).toEqual([])
    expect((st.shown as { text: string }[]).map((m) => m.text)).toEqual(['Add #520 to your lane after #519.', 'And #522.'])
    // Waiting for the user, on background tasks, starting: still queued. The user typing there: still queued.
    for (const s of ['waiting', 'background', 'starting']) {
      st.status = s
      await messages.tryMessages()
    }
    Object.assign(st, { status: 'finished', typing: true })
    await messages.tryMessages()
    expect(st.typed).toEqual([])
    st.typing = false
    await messages.tryMessages()
    expect(st.typed).toEqual(['[Hive] 2 messages from the Assistant: (1) Add #520 to your lane after #519. (2) And #522.'])
    expect(st.shown).toBeNull()
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'delivered', count: 2 } })
    // Delivered once.
    st.status = 'ready'
    await messages.tryMessages()
    expect(st.typed).toHaveLength(1)
  })

  it("queued messages ride the agent's next wake, first, once; a change while it is typed stops it, and the next try takes the queue as it is (round 1 finding)", async () => {
    await leave('Use the revised review scope.')
    // The agent's turn ends and a wake (a loop wake, typed through typeLine) is due before the queue is tried.
    st.status = 'finished'
    expect(await watches.typeLine(alpha, 'b1', '[Hive] #2 (B1\'s card) is in Review. You review this card in its loop: carry on with it.', () => true)).toBe(true)
    expect(st.typed).toEqual(["[Hive] Message from the Assistant: Use the revised review scope. [Hive] #2 (B1's card) is in Review. You review this card in its loop: carry on with it."])
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'delivered', count: 1 } })
    st.status = 'finished'
    await messages.tryMessages()
    expect(st.typed).toHaveLength(1)
    // Cancelled while the wake is typed: the wake isn't typed with it; tried again, it goes alone.
    st.status = 'working'
    await leave('Never mind.')
    st.status = 'finished'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await watches.typeLine(alpha, 'b1', '[Hive] #3 is in Review.', () => true)).toBe(false)
    st.during = null
    expect(await watches.typeLine(alpha, 'b1', '[Hive] #3 is in Review.', () => true)).toBe(true)
    expect(st.typed.at(-1)).toBe('[Hive] #3 is in Review.')
    // A line of a message's own takes no rider.
    st.status = 'working'
    await leave('Alone.')
    st.status = 'finished'
    expect(await watches.typeLine(alpha, 'b1', '[Hive] Something else.', () => true, { rider: false })).toBe(true)
    expect(st.typed.at(-1)).toBe('[Hive] Something else.')
    expect(messages.messagesOf(alpha, 'b1').queued).toHaveLength(1)
  })

  it("cancelled while it is being typed: never typed, and the reply says so, not that it was typed (round 1 finding)", async () => {
    st.status = 'ready'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await leave('Stop that.')).toEqual({ fate: 'cancelled', queued: 0, detail: 'the user' })
    expect(st.typed).toEqual([])
  })

  it("kept to its sender's permission: refused, never typed, once it is gone, while queued or while it is typed (round 1 finding)", async () => {
    let why: string | null = null
    const allowed = () => why
    await leave('This delivery requires Control agents.', allowed)
    why = 'the user turned Settings → Assistant → Control down'
    st.status = 'finished'
    await messages.tryMessages()
    expect(st.typed).toEqual([])
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'refused', count: 1, detail: 'the user turned Settings → Assistant → Control down' } })
    // Nor does it ride a wake.
    why = null
    st.status = 'working'
    await leave('Also gone.', allowed)
    why = "the Assistant's session that left it ended"
    st.status = 'finished'
    expect(await watches.typeLine(alpha, 'b1', '[Hive] #4 is in Review.', () => true)).toBe(true)
    expect(st.typed).toEqual(['[Hive] #4 is in Review.'])
    expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'refused', detail: "the Assistant's session that left it ended" })
    // Revoked while it is being typed at once: stopped before Enter, and refused.
    why = null
    st.status = 'ready'
    st.during = () => {
      why = 'the user turned Settings → Assistant → Control down'
    }
    expect(await leave('Typed now?', allowed)).toEqual({ fate: 'refused', queued: 0, detail: 'the user turned Settings → Assistant → Control down' })
    expect(st.typed).toEqual(['[Hive] #4 is in Review.'])
  })

  it("its CLI drops the first Enter and its permission goes before the Enter again: never submitted; the line is cleared and a wake it rode typed alone (round 2 finding)", async () => {
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
    watches.testHooks.takeMs = 100
    try {
      let why: string | null = null
      const allowed = () => why
      // Its own line: typed, not taken; revoked before the Enter again.
      st.status = 'ready'
      expect(await leave('Revoked before the retry.', allowed)).toEqual({ fate: 'delivered', queued: 0 })
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(() => expect(cli.clears).toBe(1), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
      expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'refused', detail: 'the user turned Settings → Assistant → Control down' })
      // Riding a wake: the same, and the wake is typed again alone, and taken.
      why = null
      st.status = 'working'
      await leave('Riding, revoked before the retry.', allowed)
      st.status = 'finished'
      expect(await watches.typeLine(alpha, 'b1', '[Hive] #5 is in Review.', () => true)).toBe(true)
      expect(st.typed.at(-1)).toBe('[Hive] Message from the Assistant: Riding, revoked before the retry. [Hive] #5 is in Review.')
      why = "the Assistant's session that left it ended"
      await vi.waitFor(() => expect(cli.clears).toBe(2), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(st.typed.at(-1)).toBe('[Hive] #5 is in Review.'), { timeout: 5000 })
      expect(st.typed.filter((t) => t.includes('Riding, revoked'))).toHaveLength(1)
      expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'refused', detail: "the Assistant's session that left it ended" })
      // The wake typed again is taken by the Enter again (nothing rides it now): one Enter, for it.
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      // Still allowed: the Enter again submits it, as before.
      why = null
      st.status = 'ready'
      await leave('Still allowed.', allowed)
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: HUNG_MS })
      expect(cli.clears).toBe(2)

      // The user typed into the line since (round 3 finding): their draft. No Enter, no clear, not offered for Enter.
      const marks: string[] = []
      Object.assign(sessions, { userTypedOverLine: () => true, lineNotTaken: (_p: string, _id: string, _r: string, text: string) => void marks.push(text) })
      st.status = 'ready'
      await leave('Drafted over, revoked.', allowed)
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(() => expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'refused' }), { timeout: HUNG_MS })
      expect([cli.enters, cli.clears, marks]).toEqual([2, 2, []])
      // Riding a wake, drafted over: the wake isn't typed over the draft; it comes once the user's prompt is submitted.
      why = null
      st.status = 'working'
      await leave('Riding, drafted over.', allowed)
      st.status = 'finished'
      expect(await watches.typeLine(alpha, 'b1', '[Hive] #6 is in Review.', () => true)).toBe(true)
      const typed = st.typed.length
      why = "the Assistant's session that left it ended"
      await vi.waitFor(() => expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'refused', detail: "the Assistant's session that left it ended" }), { timeout: HUNG_MS })
      st.status = 'finished'
      await new Promise((r) => setTimeout(r, 1500)) // A fixed wait on purpose: this checks that the wake is NOT typed over the draft.
      expect([st.typed.length, cli.enters, cli.clears, marks]).toEqual([typed, 2, 2, []])
      cli.count++ // the user submits their prompt
      Object.assign(sessions, { userTypedOverLine: () => false })
      await vi.waitFor(() => expect(st.typed.at(-1)).toBe('[Hive] #6 is in Review.'), { timeout: 5000 })
    } finally {
      watches.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain', 'clearTyped', 'userTypedOverLine']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
    }
  })

  it('bounded: at most 5 waiting, 4000 characters each, and the latest outcomes of at most 200 agents; refused for an agent not running', async () => {
    for (let i = 0; i < messages.MAX_QUEUED; i++) await leave(`Note ${i}`)
    await expect(leave('One too many')).rejects.toThrow(/already has 5 messages waiting/)
    await expect(leave('x'.repeat(messages.MESSAGE_MAX_CHARS + 1))).rejects.toThrow(/at most 4000 characters/)
    for (let i = 0; i < messages.MAX_OUTCOMES + 20; i++) {
      await messages.leaveMessage(alpha, `a${i}`, `A${i}`, 'the Assistant', 'Hello')
      messages.cancelMessages(alpha, `a${i}`, 'the user')
    }
    expect(messages.outcomeCount()).toBe(messages.MAX_OUTCOMES)
    expect(messages.messagesOf(alpha, 'a0').last).toBeNull()
    expect(messages.messagesOf(alpha, `a${messages.MAX_OUTCOMES + 19}`).last).toMatchObject({ outcome: 'cancelled' })
    st.running = false
    await expect(leave('Hello')).rejects.toThrow(/isn't running/)
  })

  it('cancelled (the user, the Assistant), or dropped when its launch ends: never typed', async () => {
    await leave('Hold on.')
    expect(messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
    expect(st.shown).toBeNull()
    expect(messages.messagesOf(alpha, 'b1').last).toMatchObject({ outcome: 'cancelled', count: 1, detail: 'the user' })
    expect(messages.cancelMessages(alpha, 'b1', 'the user')).toBe(0)
    st.status = 'ready'
    await messages.tryMessages()
    expect(st.typed).toEqual([])
    // A new launch: what waited for the old one is dropped.
    st.status = 'working'
    await leave('For the old launch.')
    Object.assign(st, { runId: 'r2', status: 'ready' })
    await messages.tryMessages()
    expect(st.typed).toEqual([])
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'dropped', detail: 'its session was started again' } })
    // Stopped.
    st.status = 'working'
    await leave('Too late.')
    st.running = false
    await messages.tryMessages()
    expect(messages.messagesOf(alpha, 'b1')).toMatchObject({ queued: [], last: { outcome: 'dropped', detail: 'it stopped' } })
  })
})
