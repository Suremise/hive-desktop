// Waiting on cards (#128): what counts as a change (shared/watch.ts), the reply and wake lines, the watching status's
// hook steps, and the watches themselves (main/watches.ts): a watch is kept in the workspace, fires once when a watched
// card changes or its limit passes, wakes its agent only when it is idle and the user isn't typing (else later), and
// ends on wake or cancel. The sessions are stand-ins here (the e2e cardloop suite runs real ones).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { alreadyThere, changesBetween, decodeSince, encodeSince, limitLine, markOf, movedIntoSince, readCondition, returnRound, WAKE_MAX_BYTES, wakeAbout, wakeLine, watchLabel, cardChange } from '../src/shared/watch'
import { taskWaitText } from '../src/shared/toolReplies'
import { hookStep } from '../src/main/hookStatus'
import type { TaskCard } from '../src/shared/types'

const at = (m: number): string => new Date(Date.UTC(2026, 9, 3, 12, m)).toISOString()
const cardOf = (over: Partial<TaskCard> = {}): TaskCard => ({ number: 7, title: 'T', description: '', project: 'alpha', agent: 'a1', column: 'doing', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at(0), createdBy: 'You', updatedAt: at(0), ...over })

describe('what counts as a change', () => {
  it('column, comment, verdict, agent; only the kinds asked for; a card gone always counts', () => {
    const before = markOf(cardOf())
    const after = markOf(cardOf({ column: 'review', comments: [{ at: at(5), by: 'Codex', text: 'Round 1: FAILED\nmore' }], history: [{ at: at(6), by: 'Codex', what: 'Review failed' }], agent: 'a2' }))
    expect(changesBetween(before, after, { changes: ['column', 'comment', 'verdict', 'agent'] })).toEqual(['column', 'comment', 'verdict', 'agent'])
    expect(changesBetween(before, after, { changes: ['verdict'] })).toEqual(['verdict'])
    expect(changesBetween(before, markOf(cardOf()), { changes: ['column'] })).toEqual([])
    expect(changesBetween(before, markOf(null), { changes: ['comment'] })).toBe('gone')
    expect(changesBetween(before, markOf(cardOf({ archived: true })), { changes: ['comment'] })).toBe('gone')
    // A column to arrive in: a move elsewhere doesn't count.
    expect(changesBetween(before, markOf(cardOf({ column: 'todo' })), { changes: ['column'], column: 'review' })).toEqual([])
    expect(changesBetween(before, markOf(cardOf({ column: 'review' })), { changes: ['column'], column: 'review' })).toEqual(['column'])
  })

  it('in a column (at once if already there) against a move into it (it must leave and come back)', () => {
    const inReview = markOf(cardOf({ column: 'review' }))
    expect(alreadyThere(inReview, { column: 'review' })).toBe(true)
    expect(alreadyThere(inReview, { column: 'review', moveInto: true })).toBe(false)
    // Left and came back between two looks: the marks are the same; the history says it moved.
    const back = cardOf({ column: 'review', history: [{ at: at(10), by: 'B', what: 'Moved to Doing' }, { at: at(11), by: 'B', what: 'Moved to Review' }] })
    expect(movedIntoSince(back, 'review', at(9))).toBe(true)
    expect(movedIntoSince(back, 'review', at(12))).toBe(false)
    expect(movedIntoSince(cardOf({ history: [{ at: at(10), by: 'B', what: 'Moved to the top of Review' }] }), 'review', at(9))).toBe(true)
    expect(movedIntoSince(cardOf({ history: [{ at: at(10), by: 'B', what: 'Moved to Reviewers' }] }), 'review', at(9))).toBe(false)
    const cond = { changes: ['column' as const], column: 'review' as const, moveInto: true as const }
    expect(changesBetween(inReview, markOf(back), cond, false)).toEqual([])
    expect(changesBetween(inReview, markOf(back), cond, true)).toEqual(['column'])
  })

  it('a failed card returned for review comes back into Review; its round and wake line say so (#214)', () => {
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const review = (history: TaskCard['history']) => cardOf({ column: 'review', agentName: 'Claudette', history })
    const failed = [h(1, 'Moved to Review', 'Claudette (hive)'), h(2, 'Started reviewing'), h(3, 'Review failed')]
    // Returnable after a failed review, with nothing since; its round counts the failures since the last pass.
    expect(returnRound(review(failed))).toBe(2)
    expect(returnRound(review([h(0, 'Review failed'), h(0, 'Review passed'), ...failed]))).toBe(2)
    expect(returnRound(review([...failed, h(4, 'Moved to Doing'), h(5, 'Moved to Review'), h(6, 'Review failed')]))).toBe(3)
    // Not after a pass, with none, once returned or reviewed again, under review, or out of Review.
    for (const history of [[h(1, 'Review passed')], [h(1, 'Moved to Review')], [...failed, h(4, 'Returned for review, round 2')], [...failed, h(4, 'Started reviewing')]]) expect(returnRound(review(history))).toBeNull()
    expect(returnRound({ ...review(failed), review: { agent: 'r', agentName: 'R', since: at(4) } })).toBeNull()
    expect(returnRound(cardOf({ column: 'doing', history: failed }))).toBeNull()
    // Returned counts as moving into Review (only Review), and starts a new round: the old failure isn't named.
    const returned = review([...failed, h(4, 'Returned for review, round 2', 'Claudette (hive)')])
    expect(movedIntoSince(returned, 'review', at(3))).toBe(true)
    expect(movedIntoSince(returned, 'review', at(5))).toBe(false)
    expect(movedIntoSince({ ...returned, column: 'doing' }, 'doing', at(3))).toBe(false)
    const line = (card: TaskCard, changes: Parameters<typeof wakeAbout>[1]) => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, 'r1') })
    expect(line(returned, ['column'])).toMatch(/^\[Hive\] #7 \(Claudette's card\) was returned for review \(round 2\)\. Your card watch has ended/)
    // Moved to Doing and back since: an ordinary arrival.
    expect(line(review([...returned.history, h(6, 'Moved to Doing'), h(7, 'Moved to Review')]), ['column'])).toMatch(/^\[Hive\] #7 \(Claudette's card\) is in Review\. /)
    // A comment alone isn't the return.
    expect(line(returned, ['comment'])).toMatch(/is in Review/)
  })

  it('since: marks and time out and back; anything else refused', () => {
    const marks = new Map([
      [3, markOf(cardOf({ number: 3, agent: 'a-1:x', comments: [{ at: at(1), by: 'Y', text: 'hi' }] }))],
      [4, markOf(null)]
    ])
    const back = decodeSince(encodeSince(marks, 1234567))
    expect(back?.at).toBe(1234567)
    expect([...back!.marks]).toEqual([...marks])
    for (const bad of ['', 'nope', '@zz;x:review:0:0::0', '@1;3:sideways:0:0::0', '@1;3:review:0:0::2', 'x'.repeat(5000)]) expect(decodeSince(bad), bad).toBeNull()
  })

  it('a condition from arguments: cards, kinds, column; refused when wrong', () => {
    expect(readCondition({ cards: [3, 4] })).toEqual({ cards: [3, 4], changes: ['column', 'comment', 'verdict', 'agent'] })
    // A column alone: only arriving there counts (a comment while it is still in Doing doesn't).
    expect(readCondition({ cards: [3], column: 'review' })).toEqual({ cards: [3], changes: ['column'], column: 'review' })
    expect(readCondition({ cards: [3], column: 'review', changes: ['column'] })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true })
    // The builder's: a verdict, or a move into Done.
    expect(readCondition({ cards: [3], column: 'done', changes: ['verdict', 'column'] })).toEqual({ cards: [3], changes: ['verdict', 'column'], column: 'done', moveInto: true })
    expect(readCondition({ cards: [3], column: 'review', changes: ['comment'] })).toMatch(/must include "column"/)
    expect(readCondition({ cards: [] })).toMatch(/at least one/)
    expect(readCondition({ cards: [3, 3] })).toMatch(/no repeats/)
    expect(readCondition({ cards: ['x'] })).toMatch(/card numbers/)
    expect(readCondition({ cards: Array.from({ length: 21 }, (_, i) => i + 1) })).toMatch(/at most 20/)
    expect(readCondition({ cards: [1], changes: ['everything'] })).toMatch(/changes must be/)
    expect(readCondition({ cards: [1], column: 'archive' })).toMatch(/column must be/)
  })

  it('the wake line is one short line with the card, its column and the latest comment; the reply is lean', () => {
    const c = cardOf({ column: 'review', comments: [{ at: at(5), by: 'Codex (hive)', text: '\n  Review round 2: FAILED — two findings\n1. …' }] })
    const line = wakeLine(cardChange(7, c, ['column']), 1)
    expect(line).not.toMatch(/\n/)
    expect(line).toMatch(/^\[Hive\] #7 is in Review; latest comment by Codex \(hive\): "Review round 2: FAILED — two findings" \(and 1 more watched card changed\)/)
    expect(wakeLine(cardChange(7, null, 'gone'))).toMatch(/#7 is gone from your board \(archived, deleted or moved to another project\)/)
    expect(limitLine({ cards: [7, 8], changes: [] }, 120)).toMatch(/No change on #7, #8 in 2 h/)
    expect(watchLabel({ cards: [7], column: 'review' })).toBe('Waiting for #7 → Review')
    expect(taskWaitText({ watching: 'Waiting for #7 → Review', limitAt: 'x' })).toMatch(/End your turn now/)
    expect(taskWaitText({ timedOut: true, since: '@1;' })).toBe('No change.\nsince: @1;')
    expect(taskWaitText({ changes: [{ number: 7, column: 'review', changes: ['column'], by: 'B', comment: null }], since: 's' })).toBe('#7 is in Review (column, by B)\nsince: s')
  })

  it("the wake line says whose card it is when it's another agent's, the reviewer's verdict, and that Done isn't merged (#143)", () => {
    const passed = { at: at(6), by: 'Codex (hive)', what: 'Review passed' }
    const comment = [{ at: at(6), by: 'Codex (hive)', text: 'Round 3: PASSED' }]
    const line = (card: TaskCard | null, changes: Parameters<typeof wakeAbout>[1], watcher: string) => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    // Another agent's card (a dependency) moved to Done: whose it is, who passed it, and that Done isn't merged.
    const dep = cardOf({ agent: 'a1', agentName: 'Claude', column: 'done', comments: comment, history: [{ at: at(1), by: 'Claude (hive)', what: 'Moved to Review' }, passed, { ...passed, what: 'Moved to Done' }] })
    expect(line(dep, ['column'], 'a2')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Done: Codex \(hive\) passed it \(Done isn't merged\); latest comment by Codex \(hive\): "Round 3: PASSED"\. Your card watch has ended/)
    // Moved to Done by hand, with no review: no verdict to name, still not merged.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'done' }), ['column'], 'a2')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Done \(Done isn't merged\)\. /)
    // The watcher's own card: short as before, with the verdict when that is what changed.
    expect(line(dep, ['verdict', 'column'], 'a1')).toMatch(/^\[Hive\] #7 is in Done: Codex \(hive\) passed it; latest comment/)
    const failed = cardOf({ agent: 'a1', column: 'review', history: [{ at: at(2), by: 'Codex (hive)', what: 'Review passed' }, { at: at(9), by: 'Codex (hive)', what: 'Review failed' }] })
    expect(line(failed, ['verdict'], 'a1')).toMatch(/^\[Hive\] #7 is in Review: Codex \(hive\) failed it\. /)
    // A move with no verdict among the changes names none; a reviewer waiting for the builder's card hears whose it is.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'review' }), ['column'], 'r1')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Review\. /)
    expect(line(failed, ['column'], 'a1')).toMatch(/^\[Hive\] #7 is in Review\. /)
    // A card without an agent, or gone: nothing about whose it is.
    expect(line(cardOf({ agent: null, column: 'done' }), ['column'], 'a2')).toMatch(/^\[Hive\] #7 is in Done\. /)
    expect(line(null, 'gone', 'a2')).toMatch(/^\[Hive\] #7 is gone from your board/)
    // Still one line, short.
    expect(line(dep, ['column'], 'a2')).not.toMatch(/\n/)
    expect(line(dep, ['column'], 'a2').length).toBeLessThan(260)
  })

  it('a verdict is named only for the round it belongs to: not after the card went back to work, was reviewed again or reassigned', () => {
    const line = (card: TaskCard, changes: Parameters<typeof wakeAbout>[1], watcher = 'a2') => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const dep = (history: TaskCard['history']) => cardOf({ agent: 'a1', agentName: 'Claude', column: 'done', history })
    // Passed, then moved to Done in another call; and passed and moved in one call (same time): the pass is named.
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(3, 'Moved to Done', 'You')]), ['column'])).toMatch(/#7 \(Claude's card\) is in Done: Codex \(hive\) passed it \(Done isn't merged\)/)
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(2, 'Moved to Done')]), ['column'])).toMatch(/is in Done: Codex \(hive\) passed it/)
    // Passed, reopened (back to Doing), more work, then moved to Done by hand with no new review: no verdict is named.
    const reopened = dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed', 'Old reviewer (hive)'), h(3, 'Moved to Done'), h(4, 'Moved to Doing', 'You'), h(5, 'Moved to Done', 'You')])
    expect(line(reopened, ['column'])).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Done \(Done isn't merged\)\. /)
    expect(line(reopened, ['column'])).not.toMatch(/passed it/)
    // Reviewed again since (in Review once more), or given to another agent: the old verdict doesn't carry over.
    expect(line(dep([h(2, 'Review passed'), h(3, 'Moved to the top of Review', 'You'), h(4, 'Moved to Done', 'You')]), ['column'])).not.toMatch(/passed it/)
    expect(line(dep([h(2, 'Review passed'), h(3, 'Given to Claude', 'You'), h(4, 'Moved to Done', 'You')]), ['column'])).not.toMatch(/passed it/)
    // Passed and left in Review; another agent starts a new review (tasks.ts's "Started reviewing"), it stops, and the user
    // moves the card to Done: the old pass isn't named. A verdict from that new review is.
    const second = [h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Started reviewing', 'Old reviewer (hive)'), h(3, 'Review passed', 'Old reviewer (hive)'), h(4, 'Started reviewing', 'New reviewer (hive)'), h(5, 'Review by New reviewer stopped', 'You'), h(5, 'Moved to Done', 'You')]
    expect(line(dep(second), ['column'])).toMatch(/is in Done \(Done isn't merged\)\. /)
    expect(line(dep(second), ['column'])).not.toMatch(/Old reviewer/)
    const secondPassed = [...second.slice(0, 4), h(6, 'Review passed', 'New reviewer (hive)'), h(6, 'Moved to Done', 'New reviewer (hive)')]
    expect(line(dep(secondPassed), ['column'])).toMatch(/is in Done: New reviewer \(hive\) passed it \(Done isn't merged\)/)
    // Failed, then moved to Done by hand: Done names no pass, nor the failure.
    expect(line(dep([h(2, 'Review failed'), h(3, 'Moved to Done', 'You')]), ['column'])).toMatch(/is in Done \(Done isn't merged\)\. /)
    // A verdict that is what changed is always named, on the watcher's own card too.
    expect(line(cardOf({ agent: 'a1', column: 'review', history: [h(2, 'Review failed')] }), ['verdict'], 'a1')).toMatch(/is in Review: Codex \(hive\) failed it/)
  })

  it('long or odd names never push out the card, its state or what to do: each name is cut, the comment gives way', () => {
    const bytes = (s: string) => Buffer.byteLength(JSON.stringify(s))
    const names = ['Builder ' + 'x'.repeat(1100), '建造者'.repeat(400), '🐝'.repeat(500), '  Spaced\n\tout   name  ' + ' '.repeat(50)]
    for (const name of names) {
      const card = cardOf({
        agent: 'a1', agentName: name, column: 'done',
        comments: [{ at: at(6), by: name, text: `"Quoted" ${'評'.repeat(2000)}` }],
        history: [{ at: at(5), by: name, what: 'Review passed' }, { at: at(5), by: name, what: 'Moved to Done' }]
      })
      const line = wakeLine({ ...cardChange(7, card, ['column']), about: wakeAbout(card, ['column'], 'a2') }, 2)
      // Within the saved limit as it is, so nothing is cut from the end.
      expect(bytes(line)).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).not.toMatch(/\n|\t/)
      expect(line).toMatch(/^\[Hive\] #7 \(.{1,40}'s card\) is in Done: .{1,40} passed it \(Done isn't merged\); latest comment by .{1,40}: "/u)
      expect(line).toMatch(/…" \(and 2 more watched cards changed\)\. Your card watch has ended: carry on \(hive_read_task with latestComment for the comment in full\)\.$/)
    }
    // Whitespace in a name becomes single spaces, trimmed.
    const spaced = cardOf({ agent: 'a1', agentName: '  Spaced\n\tout   name  ', column: 'review' })
    expect(wakeLine({ ...cardChange(7, spaced, ['column']), about: wakeAbout(spaced, ['column'], 'a2') })).toMatch(/^\[Hive\] #7 \(Spaced out name's card\) is in Review\. /)
    // A short comment is kept whole.
    const short = cardOf({ comments: [{ at: at(1), by: 'Codex (hive)', text: 'Round 1: PASSED' }] })
    expect(wakeLine(cardChange(7, short, ['comment']))).toContain('latest comment by Codex (hive): "Round 1: PASSED". ')
  })

  it('a watching agent prompted (a wake, or the user) works again; a tool ending while watching is work too', () => {
    const s = { status: 'watching' as const, askedAtStart: false, compacting: null, tasks: 0, attention: 'hooks' as const, reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, backgroundWakes: false }
    expect(hookStep({ kind: 'prompt' } as never, s).next).toBe('working')
    expect(hookStep({ kind: 'toolEnd', call: { tool: 'x' } } as never, s).next).toBe('working')
  })
})

describe('watches (main/watches.ts)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hive-watch-'))
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  const { sessions } = await import('../src/main/sessions')
  const user = { kind: 'user' } as const
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }] }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, alpha }
  }
  /** Stand-in sessions: an agent's status, whether the user is typing, and what Hive typed. */
  const fake = (alpha: string) => {
    const state = { status: 'watching' as string, typing: false, typed: [] as string[] }
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && id === 'a1' ? ({ projectPath: alpha, agentId: 'a1', status: state.status } as never) : null),
      userMayBeTyping: () => state.typing,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        state.typed.push(text)
        state.status = 'working'
      },
      watchChanged: () => undefined
    })
    return state
  }

  it('fires once when a watched card changes, waking an idle agent; a column already reached answers at once', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(r).toMatchObject({ watching: { label: `Waiting for #${c.number}` } })
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    // Something that doesn't count: nothing.
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Round 1: FAILED\nDetails', { kind: 'agent', name: 'Codex (hive)' }))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(new RegExp(`^\\[Hive\\] #${c.number} is in Doing; latest comment by Codex \\(hive\\): "Round 1: FAILED"`))
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // Once: another change wakes nothing.
    await inWorkspace(w, () => tasks.commentTask(c.number, 'again', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    // Already in the column asked for: answered at once, no watch.
    const r2 = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'doing' })
    expect(r2).toMatchObject({ already: { number: c.number, column: 'doing' } })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it("a verdict, move and comment in one call are saved together: the builder's wake names the reviewer's comment (#138)", async () => {
    const { onHiveEvent } = await import('../src/main/events')
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const reviewer = { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' } as const
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1', column: 'review' }, user))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready for review (round 1)', { kind: 'agent', name: 'Builder (alpha)' }))
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict', 'column'], column: 'done' })
    // What anything reading the card sees the moment a change is announced (a watch waking its agent reads it then).
    const seen: { column: string; latest: string | undefined }[] = []
    const off = onHiveEvent((e) => {
      if (e.type !== 'tasks-changed') return
      const card = JSON.parse(readFileSync(join(path, '.hive', 'tasks', `${c.number}.json`), 'utf8')) as TaskCard
      seen.push({ column: card.column, latest: card.comments.at(-1)?.text })
    })
    const said: string[] = []
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'passed', column: 'done' }, reviewer, { said, comment: 'Passed review, round 1.' }))
    off()
    // Before, the move was saved and announced, then the comment: the first announcement showed Done with the builder's comment.
    expect(seen).toEqual([{ column: 'done', latest: 'Passed review, round 1.' }])
    expect(said).toEqual(['Review passed', 'Moved to Done'])
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    // The builder's own card: no owner, but the reviewer's verdict.
    expect(st.typed[0]).toContain(`#${c.number} is in Done: Reviewer (alpha) passed it; latest comment by Reviewer (alpha): "Passed review, round 1."`)
    // A comment that can't be saved stops the whole change: nothing moves without it.
    const d = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', column: 'review' }, user))
    await expect(inWorkspace(w, () => tasks.updateTask(d.number, { column: 'done' }, user, { comment: '   ' }))).rejects.toThrow('The comment is empty.')
    expect((await inWorkspace(w, () => tasks.getTask(d.number))).column).toBe('review')
    await disposeWorkspaceService(w)
  })

  it('not typed while the agent works or the user types: kept, fired, and typed when it can be', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    st.status = 'working'
    await inWorkspace(w, () => tasks.commentTask(c.number, 'x', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    st.status = 'watching'
    st.typing = true
    await watches.tick()
    expect(st.typed).toEqual([])
    st.typing = false
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('its limit with no change wakes it to say so; cancel ends it; it is kept on disk and read back', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    const file = JSON.parse(readFileSync(join(path, '.hive', 'watches.json'), 'utf8'))
    expect(file.watches[0]).toMatchObject({ agentId: 'a1', limitMinutes: 30, cond: { cards: [c.number], changes: ['verdict'] } })
    // Read back after the workspace's watches are forgotten (Hive restarted): the same watch.
    watches.forgetWatches(w)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await new Promise((r) => setTimeout(r, 100))
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    await watches.tick(Date.now() + 29 * 60_000)
    expect(st.typed).toEqual([])
    await watches.tick(Date.now() + 31 * 60_000)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/No change on #\d+ in 30 min/)
    // Cancel.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(false)
    await disposeWorkspaceService(w)
  })

  it('a move into a column fires when the card leaves and comes back, also between two looks', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'review' }, user))
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true })
    expect('watching' in r).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is in Review/)
    await disposeWorkspaceService(w)
  })
  it('a failed card its agent returns for review without leaving Review wakes the reviewer waiting for it to come back (#214)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // a1 reviews here (the stand-in session); a2 did the work.
    const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
    const rev = agent('a1', 'Builder')
    const builder = agent('a2', 'Reviewer')
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, rev))
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'failed' }, rev, { comment: 'Round 1: FAILED' }))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true })
    await new Promise((res) => setTimeout(res, 5))
    // A move in place by anyone else, or a comment: no wake.
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, { kind: 'assistant' }))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Working on it', builder))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, builder, { comment: 'Fixed both findings' }))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(new RegExp(`^\\[Hive\\] #${c.number} \\(Reviewer's card\\) was returned for review \\(round 2\\); latest comment by Reviewer \\(alpha\\): "Fixed both findings"\\. Your card watch has ended`))
    await disposeWorkspaceService(w)
  })

  it('a column alone waits for the card to arrive there: a comment while it is still in Doing wakes nothing', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'doing' }, user))
    const cond = readCondition({ cards: [c.number], column: 'review' })
    if (typeof cond === 'string') throw new Error(cond)
    await watches.registerWatch(w, alpha, 'a1', cond)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Still building', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is in Review/)
    await disposeWorkspaceService(w)
  })

  it('a condition already met ends the earlier watch too', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'review' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const answer = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review' })
    expect(answer).toHaveProperty('already')
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it("a card moved to another project is gone to the agent: nothing of its new project's comments is told", async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    mkdirSync(join(path, 'beta'), { recursive: true })
    await w.refresh()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // A scope written into the file by hand is ignored: the agent's own project decides.
    const file = join(path, '.hive', 'watches.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.watches[0].scope = null
    writeFileSync(file, JSON.stringify(saved))
    watches.forgetWatches(w)
    await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'beta' }, user))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Private beta information', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is gone from your board/)
    expect(st.typed[0]).not.toMatch(/Private|beta/)
    // A card outside the agent's view can't be watched at all.
    await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/Unknown task/)
    await disposeWorkspaceService(w)
  })

  it('a line fired while the card was visible is checked again before it is typed', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    mkdirSync(join(path, 'beta'), { recursive: true })
    await w.refresh()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    st.status = 'working'
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready for you', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'beta' }, user))
    st.status = 'watching'
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is gone from your board/)
    expect(st.typed[0]).not.toMatch(/Ready for you/)
    await disposeWorkspaceService(w)
  })

  /** sendPrompt held after its first check (before Enter) until released; it checks again before Enter. */
  const gated = (st: { typed: string[]; status: string }) => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      entered()
      await gate
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
    return { release: () => release(), ready }
  }

  it('Cancel while the line is being typed stops it before Enter; the agent stays watching until then', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const g = gated(st)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    const waking = watches.evaluateWatches(w)
    await g.ready
    // Still watching while it is typed: no other work can be given to it.
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    g.release()
    await waking
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // Never put back by a later try.
    await watches.tick()
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a new watch while the old one is being typed replaces it: the old line is not typed, the new watch stays', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const g = gated(st)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    const waking = watches.evaluateWatches(w)
    await g.ready
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    g.release()
    await waking
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')?.changes).toEqual(['verdict'])
    await disposeWorkspaceService(w)
  })

  it('a wake refused (the agent got busy) is kept for the next try; cancelled meanwhile, it never comes back', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async () => {
      throw new Error('The agent got busy.')
    }
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await watches.evaluateWatches(w)
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    const st = fake(alpha)
    await watches.tick()
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a change while the watch is being set up is not lost', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'doing' }, user))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    watches.testHooks.afterRead = async () => {
      entered()
      await gate
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true })
      await ready
      // The card was read in Doing; it moves to Review before the watch is in place. The check that move makes waits for it.
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
      const checking = watches.evaluateWatches(w)
      release()
      await registering
      await checking
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(1)
      expect(st.typed[0]).toMatch(/is in Review/)
    } finally {
      release()
      watches.testHooks.afterRead = undefined
      await disposeWorkspaceService(w)
    }
  })

  it("a workspace closed or switched while its watches load never gets another's watch, and the call fails", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const other = join(path, '..', `other-${n}`)
    mkdirSync(other, { recursive: true })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    watches.testHooks.afterLoad = async () => {
      entered()
      await gate
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await ready
      watches.testHooks.afterLoad = undefined
      await w.open(other)
      release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(existsSync(join(other, '.hive', 'watches.json'))).toBe(false)
      expect(existsSync(join(path, '.hive', 'watches.json'))).toBe(false)
    } finally {
      release()
      watches.testHooks.afterLoad = undefined
      await disposeWorkspaceService(w)
    }
  })

  it('a saved watch that is not valid is kept aside and never stops the others; a damaged file is set aside', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const bad = { id: 'bad', projectPath: alpha, agentId: 'a2', cond: { cards: [c.number], changes: ['column'] }, limitAt: new Date(Date.now() + 100000).toISOString() }
    const elsewhere = { ...saved.watches[0], id: 'far', agentId: 'a3', projectPath: join(path, '..', 'not-here', 'alpha') }
    writeFileSync(file, JSON.stringify({ version: 1, watches: [bad, elsewhere, ...saved.watches] }))
    watches.forgetWatches(w)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await expect(watches.evaluateWatches(w)).resolves.toBeUndefined()
    expect(st.typed).toHaveLength(1)
    // The entries that aren't valid are still in the file, as they were.
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.invalid).toEqual([bad, elsewhere])
    expect(after.watches).toEqual([])
    // A file that isn't JSON is renamed, not overwritten.
    writeFileSync(file, '{ not json')
    watches.forgetWatches(w)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(readdirSync(join(path, '.hive')).some((f) => f.startsWith('watches.json.damaged-'))).toBe(true)
    await disposeWorkspaceService(w)
  })

  it("a watch that can't be saved isn't reported as started, nor a cancel that can't be saved as done", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const before = readFileSync(file, 'utf8')
    // A full disk: every save fails, at once (an error that isn't tried again, so the test takes no retry backoff).
    let tries = 0
    watches.testHooks.rename = async (_from, to) => {
      if (to === file) tries++
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    }
    try {
      await expect(watches.cancelWatch(w, alpha, 'a1')).rejects.toThrow(/Could not cancel/)
      expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
      await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })).rejects.toThrow(/Could not save/)
      expect(watches.watchFor(alpha, 'a1')?.changes).toEqual(['comment'])
      // Both were saves of the file that failed, and it is as it was.
      expect(tries).toBe(2)
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      watches.testHooks.rename = undefined
    }
    await disposeWorkspaceService(w)
  })
  /** A gate a hook can wait at: `ready` once something reached it, `release()` lets it go on. */
  const gate = () => {
    let release!: () => void
    let entered!: () => void
    const opened = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    return { release: () => release(), ready, wait: async () => (entered(), await opened) }
  }
  const realRename = (from: string, to: string) => import('fs/promises').then((f) => f.rename(from, to))

  it('a save whose rename is refused while the workspace closes is not tried again there: the watch fails, the file stays as it was', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const other = join(path, '..', `commit-${n}`)
    mkdirSync(other, { recursive: true })
    const g = gate()
    let held = false
    watches.testHooks.rename = async (from, to) => {
      if (to.endsWith('watches.json') && !held) {
        held = true
        await g.wait()
        throw Object.assign(new Error('injected sharing refusal'), { code: 'EPERM' })
      }
      return realRename(from, to)
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await g.ready
      await w.open(other)
      g.release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(existsSync(join(path, '.hive', 'watches.json'))).toBe(false)
      expect(readdirSync(join(path, '.hive')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      g.release()
      watches.testHooks.rename = undefined
      await disposeWorkspaceService(w)
    }
  })

  it('a save whose rename lands after the workspace closed is undone: the file as it was is put back and the watch fails', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    // A first watch saved normally, so the file has something to put back.
    await watches.registerWatch(w, alpha, 'a2', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const before = readFileSync(file, 'utf8')
    const other = join(path, '..', `landed-${n}`)
    mkdirSync(other, { recursive: true })
    const g = gate()
    let held = false
    watches.testHooks.rename = async (from, to) => {
      if (to.endsWith('watches.json') && !held) {
        held = true
        await g.wait()
      }
      return realRename(from, to)
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
      await g.ready
      await w.open(other)
      g.release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      g.release()
      watches.testHooks.rename = undefined
      await disposeWorkspaceService(w)
    }
  })

  it("a damaged file that can't be set aside is left as it is and nothing is saved over it", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const file = join(path, '.hive', 'watches.json')
    writeFileSync(file, '{ damaged original')
    watches.testHooks.rename = async () => {
      throw Object.assign(new Error('file locked'), { code: 'EACCES' })
    }
    try {
      await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/couldn't be set aside/)
      expect(readFileSync(file, 'utf8')).toBe('{ damaged original')
    } finally {
      watches.testHooks.rename = undefined
    }
    // Once it can be set aside, it is, and the watch is kept.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(readdirSync(join(path, '.hive')).some((f) => f.startsWith('watches.json.damaged-'))).toBe(true)
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    await disposeWorkspaceService(w)
    // The locked file is tried 20 times with a growing pause (about 2.2 s): more than the default 5 s on a loaded machine.
  }, 20_000)

  it("a watches file that can't be read is an error, not \"no watches\"; one too big is set aside", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const file = join(path, '.hive', 'watches.json')
    mkdirSync(join(file, 'inside'), { recursive: true })
    await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/Could not read the card watches/)
    expect(existsSync(join(file, 'inside'))).toBe(true)
    rmSync(file, { recursive: true })
    // One byte over the limit: read only up to it, and set aside.
    writeFileSync(file, `{"version":1,"watches":[],"invalid":["${'x'.repeat(1024 * 1024)}"]}`)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(readdirSync(join(path, '.hive')).some((f) => f.startsWith('watches.json.too-big-'))).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).watches).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('the limits hold when a watch is made: at most 500 (replacing one is fine), no file too big to read back; overflow is kept', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const one = JSON.parse(readFileSync(file, 'utf8')).watches[0]
    // 501 saved (a hand edit, or an older build): 500 are used, the 501st is kept aside as it was.
    const many = Array.from({ length: 501 }, (_, i) => ({ ...one, id: `w${i}`, agentId: `a${i + 1}` }))
    writeFileSync(file, JSON.stringify({ version: 1, watches: many }))
    watches.forgetWatches(w)
    await expect(watches.registerWatch(w, alpha, 'new', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/500 card watches/)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.watches).toHaveLength(500)
    expect(saved.invalid).toEqual([many[500]])
    await disposeWorkspaceService(w)
  })

  it('a wake typed once is never typed again, even when saving its end fails (the tick saves it later)', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // Every save after the line is typed fails.
    let failing = false
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      st.typed.push(text)
      st.status = 'working'
      failing = true
    }
    watches.testHooks.write = async (p, t) => {
      if (failing) throw new Error('disk write failed')
      writeFileSync(p, t)
    }
    try {
      await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(1)
      // The file still has the watch, marked as being typed: read back, it counts as delivered.
      const file = join(path, '.hive', 'watches.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).watches[0].fired.sending).toBeTruthy()
      watches.forgetWatches(w)
      st.status = 'watching'
      await watches.evaluateWatches(w)
      await watches.tick()
      expect(st.typed).toHaveLength(1)
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      // Saving works again: the tick writes the file without it.
      failing = false
      await watches.tick()
      expect(JSON.parse(readFileSync(file, 'utf8')).watches).toEqual([])
    } finally {
      watches.testHooks.write = undefined
      await disposeWorkspaceService(w)
    }
  })

  it("a wake isn't typed if Hive can't first save that it is typing it; it is tried again", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    let fail = false
    watches.testHooks.write = async (p, t) => {
      if (fail && t.includes('"sending"')) throw new Error('disk write failed')
      writeFileSync(p, t)
    }
    try {
      st.status = 'working'
      await watches.evaluateWatches(w)
      fail = true
      st.status = 'watching'
      await watches.tick()
      expect(st.typed).toEqual([])
      expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
      fail = false
      await watches.tick()
      expect(st.typed).toHaveLength(1)
    } finally {
      watches.testHooks.write = undefined
      await disposeWorkspaceService(w)
    }
  })
  const keptAside = (path: string) => readdirSync(join(path, '.hive')).filter((f) => f.startsWith('watches.json.kept-aside-'))

  it('a watch taken near the 1 MB limit can still fire, be typed and end: entries kept aside move out to make room', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    // The file 20 bytes under the limit, most of it an entry kept aside (not a watch).
    const seed = JSON.parse(readFileSync(file, 'utf8'))
    seed.invalid = ['']
    const seedBytes = Buffer.byteLength(JSON.stringify(seed, null, 2) + '\n')
    seed.invalid[0] = 'x'.repeat(1024 * 1024 - 20 - seedBytes)
    const seeded = JSON.stringify(seed, null, 2) + '\n'
    writeFileSync(file, seeded)
    watches.forgetWatches(w)
    const answer = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(answer).toHaveProperty('watching')
    // The entry moved, whole, to a file of its own.
    const aside = keptAside(path)
    expect(aside).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(path, '.hive', aside[0]), 'utf8')).invalid).toEqual(seed.invalid)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // And its limit, the same way.
    st.status = 'watching'
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    await watches.tick(Date.now() + 121 * 60_000)
    expect(st.typed).toHaveLength(2)
    expect(st.typed[1]).toMatch(/No change/)
    await disposeWorkspaceService(w)
  })

  it('watches read back too big for each to end: the last ones move to a file of their own; a new one that cannot fit is refused', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const cards: number[] = []
    for (let i = 0; i < 20; i++) cards.push((await inWorkspace(w, () => tasks.createTask({ title: `C${i}`, project: 'alpha' }, user))).number)
    await watches.registerWatch(w, alpha, 'a1', { cards, changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const one = JSON.parse(readFileSync(file, 'utf8')).watches[0]
    // 400 watches on 20 cards each: more than fit at their longest (fired, being typed) in 1 MB.
    const many = Array.from({ length: 400 }, (_, i) => ({ ...one, id: `w${i}`, agentId: `b${String(i).padStart(3, '0')}` }))
    writeFileSync(file, JSON.stringify({ version: 1, watches: many }))
    watches.forgetWatches(w)
    await expect(watches.registerWatch(w, alpha, 'zzzz', { cards, changes: ['comment'] })).rejects.toThrow(/Too many card watches/)
    // The file itself is rewritten without them by the tick.
    await watches.tick()
    const kept = JSON.parse(readFileSync(file, 'utf8')).watches
    const aside = keptAside(path)
    expect(aside).toHaveLength(1)
    const moved = JSON.parse(readFileSync(join(path, '.hive', aside[0]), 'utf8')).watches
    // Nothing lost: every watch is in one file or the other, the last ones moved.
    expect(kept.length + moved.length).toBe(400)
    expect(moved.at(-1).agentId).toBe('b399')
    expect(Buffer.byteLength(readFileSync(file, 'utf8'))).toBeLessThanOrEqual(1024 * 1024)
    // Replacing one of them is still fine.
    await watches.registerWatch(w, alpha, kept[0].agentId, { cards, changes: ['verdict'] })
    await disposeWorkspaceService(w)
    // About 2.5 s of real work (400 large watches written, read and split): more than the default 5 s on a loaded machine.
  }, 20_000)

  it('a save that landed after the workspace closed is undone only while the file is still that save: a newer edit is kept', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const other = join(path, '..', `newer-${n}`)
    mkdirSync(other, { recursive: true })
    const file = join(path, '.hive', 'watches.json')
    const g = gate()
    let held = false
    // The rename itself happens; its result comes back only after the workspace closed and someone edited the file.
    watches.testHooks.rename = async (from, to) => {
      await realRename(from, to)
      if (to === file && !held) {
        held = true
        await g.wait()
      }
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await g.ready
      await w.open(other)
      const newer = JSON.stringify({ version: 1, watches: [], manual: 'newer user data' })
      writeFileSync(file, newer)
      g.release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(readFileSync(file, 'utf8')).toBe(newer)
    } finally {
      g.release()
      watches.testHooks.rename = undefined
      await disposeWorkspaceService(w)
    }
  })
  /**
   * A save that lands after its workspace closed, undone while the restore fails in the ways given: `link` (no links, or
   * `competing` text put at the file's place first) and `backup` (refused for good). Returns the folder's watches files.
   */
  const lateUndo = async (opts: { competing?: string; noLinks?: boolean; refuseBackup?: boolean }) => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a2', { cards: [c.number], changes: ['comment'] })
    const file = join(path, '.hive', 'watches.json')
    const before = readFileSync(file, 'utf8')
    const other = join(path, '..', `undo-${n}`)
    mkdirSync(other, { recursive: true })
    const g = gate()
    let held = false
    const failed: string[] = []
    watches.testHooks.rename = async (from, to) => {
      await realRename(from, to)
      if (to === file && !held) {
        held = true
        await g.wait()
      }
    }
    watches.testHooks.link = async (from, to) => {
      if (opts.competing !== undefined) writeFileSync(to, opts.competing)
      if (opts.noLinks) {
        failed.push('link')
        throw Object.assign(new Error('links unavailable'), { code: 'EPERM' })
      }
      await import('fs/promises').then((f) => f.link(from, to))
    }
    watches.testHooks.backupRename = async (from, to) => {
      if (opts.refuseBackup) {
        failed.push('backup')
        throw Object.assign(new Error('backup rename refused'), { code: 'EACCES' })
      }
      await realRename(from, to)
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
      await g.ready
      await w.open(other)
      g.release()
      await expect(registering).rejects.toThrow(/closed/)
      const files = readdirSync(join(path, '.hive'))
        .filter((f) => f.startsWith('watches.json'))
        .map((f) => ({ name: f, text: readFileSync(join(path, '.hive', f), 'utf8') }))
      return { before, files, failed }
    } finally {
      g.release()
      watches.testHooks.rename = undefined
      watches.testHooks.link = undefined
      watches.testHooks.backupRename = undefined
      await disposeWorkspaceService(w)
    }
  }

  it('undoing a late save where links are unavailable: the earlier watches are kept beside it', async () => {
    const r = await lateUndo({ noLinks: true })
    expect(r.failed).toEqual(['link'])
    expect(r.files.find((f) => f.name.startsWith('watches.json.before-close-'))?.text).toBe(r.before)
    expect(r.files.some((f) => f.name === 'watches.json')).toBe(false)
  })

  it('undoing a late save where links are unavailable and the backup is refused: the staging copy is kept, never removed', async () => {
    const r = await lateUndo({ noLinks: true, refuseBackup: true })
    expect(r.failed.filter((x) => x === 'link')).toHaveLength(1)
    expect(r.failed.filter((x) => x === 'backup').length).toBeGreaterThan(1)
    expect(r.files.find((f) => f.name.endsWith('.tmp'))?.text).toBe(r.before)
  })

  it('undoing a late save where another file took its place: that file stays, the earlier watches are kept beside it', async () => {
    const r = await lateUndo({ competing: 'newer file' })
    expect(r.files.find((f) => f.name === 'watches.json')?.text).toBe('newer file')
    expect(r.files.find((f) => f.name.startsWith('watches.json.before-close-'))?.text).toBe(r.before)
  })

  it('undoing a late save where another file took its place and the backup is refused: both are kept', async () => {
    const r = await lateUndo({ competing: 'newer file', refuseBackup: true })
    expect(r.files.find((f) => f.name === 'watches.json')?.text).toBe('newer file')
    expect(r.files.find((f) => f.name.endsWith('.tmp'))?.text).toBe(r.before)
  })
  it('a watcher keeps "Quit when agents finish" waiting only while another agent works on a card it watches', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    const st = { projectPath: alpha, agentId: 'a1', status: 'watching', watch: watches.watchFor(alpha, 'a1') } as never
    const keeps = async (patch: Parameters<typeof tasks.updateTask>[1]) => {
      await inWorkspace(w, () => tasks.updateTask(c.number, patch, user))
      await watches.evaluateWatches(w)
      return watches.watchKeepsQuitWaiting(st)
    }
    expect(await keeps({ column: 'todo' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: '' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: 'a1' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: 'a2' })).toMatch(/^Waiting for #/)
    expect(await keeps({ column: 'review', agent: 'a2' })).toMatch(/^Waiting for #/)
    expect(await keeps({ column: 'done' })).toBeNull()
    // Not watching: never.
    expect(watches.watchKeepsQuitWaiting({ ...(st as object), status: 'finished' } as never)).toBeNull()
    await disposeWorkspaceService(w)
  })
})
