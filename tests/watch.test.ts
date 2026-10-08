// Waiting on cards (#128): what counts as a change (shared/watch.ts), the reply and wake lines, the watching status's
// hook steps, and the watches themselves (main/watches.ts): a watch is kept in the workspace, fires once when a watched
// card changes or its limit passes, wakes its agent only when it is idle and the user isn't typing (else later), and
// ends on wake or cancel. The sessions are stand-ins here (the e2e cardloop suite runs real ones).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { alreadyThere, changesBetween, decodeSince, encodeSince, limitLine, markOf, movedIntoSince, readCondition, returnRound, WAKE_MAX_BYTES, wakeAbout, wakeLine, wakeLines, carriedOver, changesSince, seenOf, watchLabel, cardChange } from '../src/shared/watch'
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

  it('in a column, or a move into it: at once if already there (#434); a fresh move into it must leave and come back', () => {
    const inReview = markOf(cardOf({ column: 'review' }))
    expect(alreadyThere(inReview, { column: 'review' })).toBe(true)
    expect(alreadyThere(inReview, { column: 'review', moveInto: true })).toBe(true)
    expect(alreadyThere(inReview, { column: 'review', moveInto: true, fresh: true })).toBe(false)
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

  it('several changes in one line: each card with its verdict; comments, then cards, give way to the size (#224)', () => {
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const change = (n: number, v: 'passed' | 'failed', comment = `Round 1: ${v.toUpperCase()}`) => {
      const card = cardOf({ number: n, agent: 'a1', agentName: 'Claudette', column: 'review', history: [h(1, 'Moved to Review', 'Claudette (hive)'), h(2, `Review ${v}`)], comments: [{ at: at(2), by: 'Codex (hive)', text: comment }] })
      return { ...cardChange(n, card, ['verdict' as const]), about: wakeAbout(card, ['verdict'], 'a2') }
    }
    expect(wakeLines([change(217, 'passed'), change(119, 'failed')])).toBe(
      `[Hive] #217 (Claudette's card) is in Review: Codex (hive) passed it (latest comment by Codex (hive): "Round 1: PASSED"); #119 (Claudette's card) is in Review: Codex (hive) failed it (latest comment by Codex (hive): "Round 1: FAILED"). Your card watch has ended: carry on (hive_read_task with latestComment on each card for its comment in full).`
    )
    // One change: the single line as before.
    expect(wakeLines([change(217, 'passed')])).toBe(wakeLine(change(217, 'passed')))
    // Long comments are cut; many cards: as many as fit, the rest counted. Always within the line's limit, one line.
    const long = Array.from({ length: 5 }, (_, i) => change(100 + i, 'failed', '評'.repeat(400)))
    const five = wakeLines(long)
    expect(Buffer.byteLength(JSON.stringify(five))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(five).toMatch(/#100 .*#101 .*#102 .*#103 .*#104 /)
    // Twenty (the most a watch has): every card is still named, in a few words, and the agent is told to read them (#226).
    const many = wakeLines(Array.from({ length: 20 }, (_, i) => change(100 + i, i % 2 ? 'passed' : 'failed')))
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    for (let n = 100; n < 120; n++) expect(many).toContain(`#${n} in Review, ${n % 2 ? 'passed' : 'failed'}`)
    expect(many).toMatch(/Details were left out to fit: read each card \(hive_read_task\) before you carry on\.$/)
    expect(many).not.toMatch(/\n|more watched card/)
  })

  it('too many changes to tell in full: every card is named, briefly or by number, within the size; gone ones say nothing more (#226)', () => {
    const long = (s: string) => s.repeat(300)
    // Twenty cards with long Unicode owners, reviewers and comments; some returned, some gone, one moved by hand.
    const card = (n: number) =>
      cardOf({ number: n, agent: 'a1', agentName: long('建造者'), column: n % 5 === 0 ? 'done' : 'review', history: [{ at: at(1), by: long('🐝'), what: n % 3 ? 'Review failed' : 'Review passed' }, ...(n % 7 === 0 ? [{ at: at(2), by: 'You', what: 'Returned for review, round 3' }] : [])], comments: [{ at: at(2), by: long('評'), text: long('Ünïcødé ') }] })
    const changes = Array.from({ length: 20 }, (_, i) => {
      const n = 300 + i
      if (n % 4 === 0) return cardChange(n, null, 'gone')
      const c = card(n)
      return { ...cardChange(n, c, ['verdict', 'column']), about: wakeAbout(c, ['verdict', 'column'], 'a2') }
    })
    const line = wakeLines(changes)
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(line).not.toMatch(/\n/)
    for (const c of changes) expect(line).toMatch(new RegExp(`#${c.number}\\b`))
    // A gone card: its number only, nothing of its state (it may be another project's now).
    expect(line).toContain('#300 gone')
    expect(line).not.toMatch(/#300 (in|returned)/)
    // No names or comments in the short form.
    expect(line).not.toMatch(/建造者|🐝|評|Ünïcødé/)
    expect(line).toMatch(/Details were left out to fit/)
    // Numbers alone when even the short form can't fit (huge numbers); past what a watch can hold, counted.
    const huge = Array.from({ length: 20 }, (_, i) => cardChange(10 ** 15 + i, null, ['comment']))
    const byNumber = wakeLines(huge)
    expect(Buffer.byteLength(JSON.stringify(byNumber))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    for (const c of huge) expect(byNumber).toContain(`#${c.number}`)
    const beyond = wakeLines(Array.from({ length: 200 }, (_, i) => cardChange(10 ** 15 + i, null, ['comment'])))
    expect(Buffer.byteLength(JSON.stringify(beyond))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(beyond).toMatch(/ and \d+ more watched cards changed\. /)
  })

  it('a watch counts what came after where its view of a card ended, not by time: an entry sharing the millisecond counts (#224)', () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const before = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)'), h(2, 'Started reviewing', 'R (alpha)')], comments: [{ at: at(2), by: 'R (alpha)', text: 'looking' }] })
    const base = { mark: markOf(before), seen: seenOf(before), since: at(2) }
    const cond = { changes: ['verdict' as const, 'comment' as const, 'column' as const, 'agent' as const] }
    expect(changesSince(before, base, cond)).toEqual([])
    // The verdict and its comment land in the same millisecond as what was seen: still news.
    const same = { ...before, history: [...before.history, h(2, 'Review failed', 'R (alpha)')], comments: [...before.comments, { at: at(2), by: 'R (alpha)', text: 'Round 1: FAILED' }] }
    expect(changesSince(same, base, cond)).toEqual(['comment', 'verdict'])
    // Given to another agent, archived: against the starting mark.
    expect(changesSince({ ...before, agent: 'a2', history: [...before.history, h(2, 'Given to X', 'You')] }, base, cond)).toEqual(['agent'])
    expect(changesSince({ ...before, archived: true }, base, cond)).toBe('gone')
    // Out and back into Review: a move into it, seen by the entries after.
    const back = { ...before, history: [...before.history, h(3, 'Moved to Doing', 'B (alpha)'), h(3, 'Moved to Review', 'B (alpha)')] }
    expect(changesSince(back, base, { changes: ['column'], column: 'review', moveInto: true })).toEqual(['column'])
    // A history capped past the entry seen: what is newer than its time counts.
    expect(changesSince({ ...back, history: back.history.slice(-1) }, base, { changes: ['column'], column: 'review', moveInto: true })).toEqual(['column'])
  })

  it('an entry exactly like the one seen (time, author, words) is still a new one; the one seen is never counted again (#224)', () => {
    const e = (what: string, id?: string) => ({ at: at(2), by: 'R (alpha)', what, ...(id ? { id } : {}) })
    const cond = { changes: ['verdict' as const, 'comment' as const] }
    // With ids (every entry written since #224).
    const seenCard = cardOf({ column: 'review', history: [e('Started reviewing', 'aaaa01'), e('Review failed', 'aaaa02')], comments: [{ at: at(2), by: 'R (alpha)', text: 'no', id: 'cccc01' }] })
    const base = { mark: markOf(seenCard), seen: seenOf(seenCard), since: at(2) }
    expect(changesSince(seenCard, base, cond)).toEqual([])
    const again = { ...seenCard, history: [...seenCard.history, e('Started reviewing', 'aaaa03'), e('Review failed', 'aaaa04')], comments: [...seenCard.comments, { at: at(2), by: 'R (alpha)', text: 'no', id: 'cccc02' }] }
    expect(changesSince(again, base, cond)).toEqual(['comment', 'verdict'])
    // The entry seen dropped from the front of a capped history: everything kept came after it.
    expect(changesSince({ ...again, history: again.history.slice(-1), comments: again.comments.slice(-1) }, base, cond)).toEqual(['comment', 'verdict'])
    // Entries from before ids: by their place.
    const old = cardOf({ column: 'review', history: [e('Started reviewing'), e('Review failed')], comments: [{ at: at(2), by: 'R (alpha)', text: 'no' }] })
    const oldBase = { mark: markOf(old), seen: seenOf(old), since: at(2) }
    expect(changesSince(old, oldBase, cond)).toEqual([])
    expect(changesSince({ ...old, history: [...old.history, e('Started reviewing'), e('Review failed')], comments: [...old.comments, { at: at(2), by: 'R (alpha)', text: 'no' }] }, oldBase, cond)).toEqual(['comment', 'verdict'])
  })

  it('after a wake, a card starts from what the wake told, past only what the agent did itself since (#224)', () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const card = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)')], comments: [] })
    const told = { mark: markOf(card), seen: seenOf(card) }
    const cond = { changes: ['verdict' as const, 'comment' as const, 'column' as const, 'agent' as const] }
    const since = at(9)
    const from = (now: TaskCard, self = 'B (alpha)') => ({ mark: carriedOver(now, told, self), seen: told.seen, since, self })
    // The agent's own work since the wake (a comment, a move to Doing): not news.
    const own = { ...card, column: 'doing' as const, history: [...card.history, h(5, 'Moved to Doing', 'B (alpha)')], comments: [{ at: at(5), by: 'B (alpha)', text: 'fixing' }] }
    expect(changesSince(own, from(own), cond)).toEqual([])
    // Someone else's verdict, comment, reassignment or archiving since: news, whatever their times.
    const theirs = { ...card, agent: 'a2', history: [...card.history, h(1, 'Review failed', 'R (alpha)'), h(1, 'Given to Other', 'You')], comments: [{ at: at(1), by: 'R (alpha)', text: 'no' }] }
    expect(changesSince(theirs, from(theirs), cond)).toEqual(['comment', 'verdict', 'agent'])
    expect(changesSince({ ...card, archived: true }, from({ ...card, archived: true }), cond)).toBe('gone')
    // Mixed: another's comment and the agent's own after it: the comment kind is still news.
    const mixed = { ...card, comments: [{ at: at(3), by: 'R (alpha)', text: 'q' }, { at: at(4), by: 'B (alpha)', text: 'a' }] }
    expect(changesSince(mixed, from(mixed), cond)).toEqual(['comment'])
    // The agent's own changes after the watch began count, as they always have.
    const later = { ...card, comments: [{ at: at(10), by: 'B (alpha)', text: 'later' }] }
    expect(changesSince(later, from(later), cond)).toEqual(['comment'])
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
    // Fresh (#434): only the next move into the column; it needs one.
    expect(readCondition({ cards: [3], column: 'review', fresh: true })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true, fresh: true })
    expect(readCondition({ cards: [3], column: 'review', changes: ['column'], fresh: false })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true })
    expect(readCondition({ cards: [3], fresh: true })).toMatch(/fresh needs a column/)
    expect(readCondition({ cards: [3], column: 'review', fresh: 'yes' })).toMatch(/fresh must be true or false/)
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
    // Archived (one card, or a batch, #351): said so, and that only the user brings it back.
    expect(wakeLine(cardChange(7, cardOf({ archived: true }), 'gone'))).toMatch(/^\[Hive\] #7 was archived \(off the board: only the user brings it back\)\. Your card watch has ended/)
    expect(taskWaitText({ changes: [{ number: 7, column: 'gone', changes: 'gone', by: null, comment: null, archived: true }] })).toBe('#7 was archived')
    expect(limitLine({ cards: [7, 8], changes: [] }, 120)).toMatch(/No change on #7, #8 in 2 h/)
    expect(watchLabel({ cards: [7], column: 'review' })).toBe('Waiting for #7 → Review')
    expect(taskWaitText({ watching: 'Waiting for #7 → Review', limitAt: 'x' })).toMatch(/End your turn now/)
    expect(taskWaitText({ timedOut: true, since: '@1;' })).toBe('No change.\nsince: @1;')
    expect(taskWaitText({ changes: [{ number: 7, column: 'review', changes: ['column'], by: 'B', comment: null }], since: 's' })).toBe('#7 is in Review (column, by B)\nsince: s')
  })

  it("the wake line says whose card it is when it's another agent's, the reviewer's verdict, and that Passed isn't merged (#143; Passed since #170)", () => {
    const passed = { at: at(6), by: 'Codex (hive)', what: 'Review passed' }
    const comment = [{ at: at(6), by: 'Codex (hive)', text: 'Round 3: PASSED' }]
    const line = (card: TaskCard | null, changes: Parameters<typeof wakeAbout>[1], watcher: string) => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    // Another agent's card (a dependency) moved to Passed: whose it is, who passed it, and that Passed isn't merged (Done is).
    const dep = cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed', comments: comment, history: [{ at: at(1), by: 'Claude (hive)', what: 'Moved to Review' }, passed, { ...passed, what: 'Moved to Passed' }] })
    expect(line(dep, ['column'], 'a2')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Passed: Codex \(hive\) passed it \(Passed isn't merged\); latest comment by Codex \(hive\): "Round 3: PASSED"\. Your card watch has ended/)
    // Moved to Passed by hand, with no review: no verdict to name, still not merged.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed' }), ['column'], 'a2')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Passed \(Passed isn't merged\)\. /)
    // The watcher's own card: short as before, with the verdict when that is what changed.
    expect(line(dep, ['verdict', 'column'], 'a1')).toMatch(/^\[Hive\] #7 is in Passed: Codex \(hive\) passed it; latest comment/)
    const failed = cardOf({ agent: 'a1', column: 'review', history: [{ at: at(2), by: 'Codex (hive)', what: 'Review passed' }, { at: at(9), by: 'Codex (hive)', what: 'Review failed' }] })
    expect(line(failed, ['verdict'], 'a1')).toMatch(/^\[Hive\] #7 is in Review: Codex \(hive\) failed it\. /)
    // A move with no verdict among the changes names none; a reviewer waiting for the builder's card hears whose it is.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'review' }), ['column'], 'r1')).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Review\. /)
    expect(line(failed, ['column'], 'a1')).toMatch(/^\[Hive\] #7 is in Review\. /)
    // A card without an agent, or gone: nothing about whose it is.
    expect(line(cardOf({ agent: null, column: 'passed' }), ['column'], 'a2')).toMatch(/^\[Hive\] #7 is in Passed\. /)
    expect(line(null, 'gone', 'a2')).toMatch(/^\[Hive\] #7 is gone from your board/)
    // Still one line, short.
    expect(line(dep, ['column'], 'a2')).not.toMatch(/\n/)
    expect(line(dep, ['column'], 'a2').length).toBeLessThan(260)
  })

  it('a verdict is named only for the round it belongs to: not after the card went back to work, was reviewed again or reassigned', () => {
    const line = (card: TaskCard, changes: Parameters<typeof wakeAbout>[1], watcher = 'a2') => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const dep = (history: TaskCard['history']) => cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed', history })
    // Passed, then moved to Passed in another call; and passed and moved in one call (same time): the pass is named.
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(3, 'Moved to Passed', 'You')]), ['column'])).toMatch(/#7 \(Claude's card\) is in Passed: Codex \(hive\) passed it \(Passed isn't merged\)/)
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(2, 'Moved to Passed')]), ['column'])).toMatch(/is in Passed: Codex \(hive\) passed it/)
    // Passed, reopened (back to Doing), more work, then moved to Passed by hand with no new review: no verdict is named.
    const reopened = dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed', 'Old reviewer (hive)'), h(3, 'Moved to Passed'), h(4, 'Moved to Doing', 'You'), h(5, 'Moved to Passed', 'You')])
    expect(line(reopened, ['column'])).toMatch(/^\[Hive\] #7 \(Claude's card\) is in Passed \(Passed isn't merged\)\. /)
    expect(line(reopened, ['column'])).not.toMatch(/passed it/)
    // Reviewed again since (in Review once more), or given to another agent: the old verdict doesn't carry over.
    expect(line(dep([h(2, 'Review passed'), h(3, 'Moved to the top of Review', 'You'), h(4, 'Moved to Passed', 'You')]), ['column'])).not.toMatch(/passed it/)
    expect(line(dep([h(2, 'Review passed'), h(3, 'Given to Claude', 'You'), h(4, 'Moved to Passed', 'You')]), ['column'])).not.toMatch(/passed it/)
    // Passed and left in Review; another agent starts a new review (tasks.ts's "Started reviewing"), it stops, and the user
    // moves the card to Done: the old pass isn't named. A verdict from that new review is.
    const second = [h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Started reviewing', 'Old reviewer (hive)'), h(3, 'Review passed', 'Old reviewer (hive)'), h(4, 'Started reviewing', 'New reviewer (hive)'), h(5, 'Review by New reviewer stopped', 'You'), h(5, 'Moved to Passed', 'You')]
    expect(line(dep(second), ['column'])).toMatch(/is in Passed \(Passed isn't merged\)\. /)
    expect(line(dep(second), ['column'])).not.toMatch(/Old reviewer/)
    const secondPassed = [...second.slice(0, 4), h(6, 'Review passed', 'New reviewer (hive)'), h(6, 'Moved to Passed', 'New reviewer (hive)')]
    expect(line(dep(secondPassed), ['column'])).toMatch(/is in Passed: New reviewer \(hive\) passed it \(Passed isn't merged\)/)
    // Failed, then moved to Passed by hand: Passed names no pass, nor the failure.
    expect(line(dep([h(2, 'Review failed'), h(3, 'Moved to Passed', 'You')]), ['column'])).toMatch(/is in Passed \(Passed isn't merged\)\. /)
    // A verdict that is what changed is always named, on the watcher's own card too.
    expect(line(cardOf({ agent: 'a1', column: 'review', history: [h(2, 'Review failed')] }), ['verdict'], 'a1')).toMatch(/is in Review: Codex \(hive\) failed it/)
  })

  it('long or odd names never push out the card, its state or what to do: each name is cut, the comment gives way', () => {
    const bytes = (s: string) => Buffer.byteLength(JSON.stringify(s))
    const names = ['Builder ' + 'x'.repeat(1100), '建造者'.repeat(400), '🐝'.repeat(500), '  Spaced\n\tout   name  ' + ' '.repeat(50)]
    for (const name of names) {
      const card = cardOf({
        agent: 'a1', agentName: name, column: 'passed',
        comments: [{ at: at(6), by: name, text: `"Quoted" ${'評'.repeat(2000)}` }],
        history: [{ at: at(5), by: name, what: 'Review passed' }, { at: at(5), by: name, what: 'Moved to Passed' }]
      })
      const line = wakeLine({ ...cardChange(7, card, ['column']), about: wakeAbout(card, ['column'], 'a2') }, 2)
      // Within the saved limit as it is, so nothing is cut from the end.
      expect(bytes(line)).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).not.toMatch(/\n|\t/)
      expect(line).toMatch(/^\[Hive\] #7 \(.{1,40}'s card\) is in Passed: .{1,40} passed it \(Passed isn't merged\); latest comment by .{1,40}: "/u)
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
  // Typed at once here; the settle (changes landing together told together, #224) has tests of its own.
  watches.testHooks.settleMs = 0
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

  it("a typed wake the CLI doesn't take (#376) gets Enter again, once; one it takes gets nothing more", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // The CLI's prompt count: a stand-in that takes the line only when told to (as Codex dropped an Enter on 7 Oct).
    const cli = { count: 0, takeOnType: false, takeOnEnter: true, enters: 0 }
    // A line still not taken is marked (#430), and nothing more is typed into it while it is.
    const marks: string[] = []
    let untaken = false
    Object.assign(sessions, {
      lineNotTaken: (_p: string, _id: string, runId: string, text: string) => {
        expect(runId).toBe('run-1')
        marks.push(text)
      },
      lineWaiting: () => untaken,
      promptsTaken: () => ({ runId: 'run-1', count: cli.count }),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        if (cli.takeOnType) cli.count++
        else st.status = 'finished'
      },
      submitAgain: (_p: string, _id: string, runId: string) => {
        expect(runId).toBe('run-1')
        cli.enters++
        if (cli.takeOnEnter) cli.count++
        return true
      }
    })
    watches.testHooks.takeMs = 150
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Dropped Enter', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(1)
      // Not taken: Enter once more after the wait, and it is taken then.
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: 2000 })
      await new Promise((r) => setTimeout(r, 400))
      expect(cli.enters).toBe(1)
      // Never taken: Enter once more only, never a third time.
      cli.takeOnEnter = false
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'more news', user))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: 2000 })
      await new Promise((r) => setTimeout(r, 500))
      expect(cli.enters).toBe(2)
      // Still not taken: marked once, with the line (#430); the next wake waits while it is, then goes in.
      expect(marks).toHaveLength(1)
      expect(marks[0]).toMatch(/^\[Hive\] #\d+ is in Todo; latest comment by You: "more news"/)
      untaken = true
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'while marked', user))
      await watches.evaluateWatches(w)
      await watches.tick()
      expect(st.typed).toHaveLength(2)
      cli.takeOnType = true
      untaken = false
      await watches.tick()
      await vi.waitFor(() => expect(st.typed).toHaveLength(3))
      // Taken as typed: no Enter again.
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'last news', user))
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(4)
      expect(marks).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 500))
      expect(cli.enters).toBe(2)
    } finally {
      watches.testHooks.takeMs = undefined
      delete (sessions as unknown as Record<string, unknown>).promptsTaken
      delete (sessions as unknown as Record<string, unknown>).submitAgain
      delete (sessions as unknown as Record<string, unknown>).lineNotTaken
      delete (sessions as unknown as Record<string, unknown>).lineWaiting
    }
    await disposeWorkspaceService(w)
  })

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
    // Already in Review: only a fresh move into it waits (#434).
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true, fresh: true })
    expect('watching' in r).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is in Review/)
    await disposeWorkspaceService(w)
  })
  it('a watch for a move into a column the card is already in answers at once, for anyone and after a failed review; one for a card elsewhere waits (#434)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const passed = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1', column: 'passed' }, user))
    const inReview = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', agent: 'a1', column: 'review' }, user))
    const verdictOrPassed = { changes: ['verdict' as const, 'column' as const], column: 'passed' as const, moveInto: true as const }
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [passed.number], ...verdictOrPassed })
    expect(r).toEqual({ already: expect.objectContaining({ number: passed.number, column: 'passed', changes: ['column'] }) })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // A card in Review after a failed review: "→ Review" holds, whoever asks (its reviewer, the card's own agent, the
    // Assistant) and whatever its history.
    const failed = await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'alpha', agent: 'a2', column: 'review' }, user))
    const rev = { kind: 'agent', name: 'R (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    await inWorkspace(w, () => tasks.updateTask(failed.number, { review: 'start' }, rev))
    const intoReview = { cards: [failed.number], changes: ['column' as const], column: 'review' as const, moveInto: true as const }
    // Its reviewer, mid-review.
    expect(await watches.registerWatch(w, alpha, 'a1', intoReview)).toEqual({ already: expect.objectContaining({ number: failed.number, column: 'review' }) })
    await inWorkspace(w, () => tasks.updateTask(failed.number, { review: 'failed' }, rev, { comment: 'Round 1: FAILED' }))
    for (const [host, id] of [[alpha, 'a1'], [alpha, 'a2'], [w.assistantHome, 'assistant']] as const) {
      expect(await watches.registerWatch(w, host, id, intoReview)).toEqual({ already: expect.objectContaining({ number: failed.number, column: 'review' }) })
      expect(watches.watchFor(host, id)).toBeNull()
    }
    // Fresh: the reviewer's wait for its next round waits.
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', { ...intoReview, fresh: true }))).toBe(true)
    // With a card still in Review among them: the one in Passed answers.
    expect('already' in (await watches.registerWatch(w, alpha, 'a1', { cards: [inReview.number, passed.number], ...verdictOrPassed }))).toBe(true)
    // A card in Review alone waits for its verdict or move.
    const waiting = await watches.registerWatch(w, alpha, 'a1', { cards: [inReview.number], ...verdictOrPassed })
    expect('watching' in waiting).toBe(true)
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(inReview.number, { column: 'passed' }, user))
    await watches.evaluateWatches(w)
    expect(st.typed).toHaveLength(1)
    expect(st.typed[0]).toMatch(/is in Passed/)
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
    // The reviewer watches for the card's next round (fresh, #434) just before its failed verdict (card-loop), and again
    // after it: both wait, and its own verdict doesn't wake it.
    const back = { cards: [c.number], changes: ['column' as const], column: 'review' as const, moveInto: true as const, fresh: true as const }
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', back))).toBe(true)
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'failed' }, rev, { comment: 'Round 1: FAILED' }))
    await watches.evaluateWatches(w)
    expect(st.typed).toEqual([])
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', back))).toBe(true)
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

  describe('two cards changing together (#224)', () => {
    const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
    // a1 builds (the stand-in session), a2 reviews.
    const builder = agent('a1', 'Builder')
    const rev = agent('a2', 'Reviewer')
    const verdictOrDone = { changes: ['verdict' as const, 'column' as const], column: 'done' as const, moveInto: true as const }
    const twoInReview = async (w: Parameters<typeof inWorkspace>[0]) => {
      const make = () => inWorkspace(w, () => tasks.createTask({ title: 'T', project: 'alpha', agent: 'a1', column: 'review' }, user))
      const [a, b] = [await make(), await make()]
      for (const c of [a, b]) await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, rev))
      return [a.number, b.number]
    }
    const verdict = (w: Parameters<typeof inWorkspace>[0], num: number, v: 'passed' | 'failed') => inWorkspace(w, () => tasks.updateTask(num, { review: v }, rev, { comment: `Round 1: ${v.toUpperCase()}` }))

    it('a second change landing just after the first is told in the same line', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      watches.testHooks.settleMs = 400
      try {
        await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
        await verdict(w, a, 'passed')
        await watches.evaluateWatches(w)
        await new Promise((r) => setTimeout(r, 100))
        await verdict(w, b, 'failed')
        await watches.evaluateWatches(w)
        expect(st.typed).toEqual([])
        await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: 3000 })
      } finally {
        watches.testHooks.settleMs = 0
      }
      expect(st.typed[0]).toMatch(new RegExp(`^\\[Hive\\] #${a} is in Review: Reviewer \\(alpha\\) passed it \\(latest comment by Reviewer \\(alpha\\): "Round 1: PASSED"\\); #${b} is in Review: Reviewer \\(alpha\\) failed it \\(latest comment by Reviewer \\(alpha\\): "Round 1: FAILED"\\)\\. Your card watch has ended`))
      await disposeWorkspaceService(w)
    })

    it('a watch started after a wake sees what changed in between, and not what the agent did itself', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      await verdict(w, a, 'passed')
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(1)
      expect(st.typed[0]).toContain(`#${a} is in Review: Reviewer (alpha) passed it`)
      // #b fails a moment after the wake, before the builder watches again (what deadlocked #119/#217).
      await new Promise((r) => setTimeout(r, 5))
      await verdict(w, b, 'failed')
      st.status = 'watching'
      const r = await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
      expect('watching' in r).toBe(true)
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: 3000 })
      expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] #${b} is in Review: Reviewer \\(alpha\\) failed it`))
      // After that wake, the builder's own work (a comment, a move to Doing and back) isn't news to its next watch…
      st.status = 'watching'
      await inWorkspace(w, () => tasks.updateTask(b, { column: 'doing' }, builder, { comment: 'Fixing' }))
      await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, builder, { comment: 'Fixed' }))
      await watches.registerWatch(w, alpha, 'a1', { cards: [b], changes: ['comment', 'column', 'verdict', 'agent'] })
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(2)
      // …the reviewer's is.
      await inWorkspace(w, () => tasks.commentTask(b, 'Looking at it', rev))
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(3)
      expect(st.typed[2]).toContain('latest comment by Reviewer (alpha): "Looking at it"')
      await disposeWorkspaceService(w)
    })

    it('a change between watches is news even in the same millisecond as the wake read the cards', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      // Every write and read from here at one instant (only Date is frozen; timers and I/O stay real).
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
      try {
        await verdict(w, a, 'passed')
        await watches.evaluateWatches(w)
        expect(st.typed).toHaveLength(1)
        await verdict(w, b, 'failed')
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: 3000 })
        expect(st.typed[1]).toContain(`#${b} is in Review: Reviewer (alpha) failed it`)
      } finally {
        vi.useRealTimers()
      }
      await disposeWorkspaceService(w)
    })

    it('the same verdict again in the same millisecond, after the wake told the first: the next watch is woken', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
      try {
        await verdict(w, a, 'passed')
        await verdict(w, b, 'failed')
        await watches.evaluateWatches(w)
        expect(st.typed).toHaveLength(1)
        expect(st.typed[0]).toMatch(new RegExp(`#${a} is in Review: Reviewer \\(alpha\\) passed it.*#${b} is in Review: Reviewer \\(alpha\\) failed it`))
        // Reviewed again and failed again, word for word, in the same millisecond as the first failure.
        await inWorkspace(w, () => tasks.updateTask(b, { review: 'start' }, rev))
        await verdict(w, b, 'failed')
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: 3000 })
        expect(st.typed[1]).toContain(`#${b} is in Review: Reviewer (alpha) failed it`)
        // The failure the wake told isn't told again: watching once more without a new change, nothing comes.
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await watches.evaluateWatches(w)
        expect(st.typed).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
      await disposeWorkspaceService(w)
    })

    it('given to another agent, or archived, between watches: the next watch is woken', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      const c = (await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'alpha', agent: 'a1', column: 'review' }, user))).number
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b, c], changes: ['agent', 'verdict'] })
      await verdict(w, a, 'passed')
      await watches.evaluateWatches(w)
      expect(st.typed).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 5))
      await inWorkspace(w, () => tasks.updateTask(b, { agent: 'a2' }, user))
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [b], changes: ['agent'] })
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: 3000 })
      expect(st.typed[1]).toMatch(new RegExp(`^\\[Hive\\] #${b} \\(Reviewer's card\\) is in Review`))
      // Archived between watches: told as gone.
      await inWorkspace(w, () => tasks.archiveTask(c, true))
      st.status = 'watching'
      // The previous wake told #b only; #c was in the watch before it, so it starts from what that wake told of it.
      await watches.registerWatch(w, alpha, 'a1', { cards: [b, c], changes: ['agent', 'verdict'] })
      await vi.waitFor(() => expect(st.typed).toHaveLength(3), { timeout: 3000 })
      expect(st.typed[2]).toContain(`#${c} was archived (off the board`)
      await disposeWorkspaceService(w)
    })
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
    // As many watches on 20 cards each as fit in 1 MB as saved (the most Hive reads), but not at their longest (fired,
    // being typed): about 1 KB more each.
    const count = Math.floor((1024 * 1024 - 1024) / (Buffer.byteLength(JSON.stringify(one)) + 16))
    const many = Array.from({ length: count }, (_, i) => ({ ...one, id: `w${i}`, agentId: `b${String(i).padStart(3, '0')}` }))
    writeFileSync(file, JSON.stringify({ version: 1, watches: many }))
    watches.forgetWatches(w)
    // The refusal is cheap (#321): every watch measured once (not the whole file's text again for each one set aside),
    // and each card read once for all the watches on it (not 20 cards for each of the 400). Counted (what JSON.stringify
    // writes, which cards are read while it reads the file back and refuses) and timed.
    const stringify = JSON.stringify
    let written = 0
    JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => {
      const s = stringify(...a)
      written += s?.length ?? 0
      return s
    }) as typeof JSON.stringify
    const reads: number[] = []
    watches.testHooks.cardRead = (c) => reads.push(c)
    let refusedMs = 0
    try {
      const t0 = performance.now()
      await expect(watches.registerWatch(w, alpha, 'zzzz', { cards, changes: ['comment'] })).rejects.toThrow(/Too many card watches/)
      refusedMs = performance.now() - t0
      await watches.evaluateWatches(w)
    } finally {
      JSON.stringify = stringify
      delete watches.testHooks.cardRead
    }
    expect(written).toBeLessThan(8 * 1024 * 1024)
    // Under 2 s: before #321 this refusal took 2.3–2.5 s on an idle machine (B3H's measure), so the old code fails it
    // even idle; it now takes a few hundred ms at most idle, leaving room for a loaded machine.
    expect(refusedMs, `refused in ${Math.round(refusedMs)} ms`).toBeLessThan(2000)
    // A few reads a card (the registration, each check of the watches), not one for each of the 400 watches on it.
    for (const c of cards) expect(reads.filter((x) => x === c).length, `#${c} read`).toBeLessThanOrEqual(6)
    // The file itself is rewritten without them by the tick.
    await watches.tick()
    const kept = JSON.parse(readFileSync(file, 'utf8')).watches
    const aside = keptAside(path)
    expect(aside).toHaveLength(1)
    const moved = JSON.parse(readFileSync(join(path, '.hive', aside[0]), 'utf8')).watches
    // Nothing lost: every watch is in one file or the other, the last ones moved.
    expect(kept.length + moved.length).toBe(count)
    expect(moved.at(-1).agentId).toBe(`b${String(count - 1).padStart(3, '0')}`)
    expect(Buffer.byteLength(readFileSync(file, 'utf8'))).toBeLessThanOrEqual(1024 * 1024)
    // Replacing one of them is still fine.
    await watches.registerWatch(w, alpha, kept[0].agentId, { cards, changes: ['verdict'] })
    await disposeWorkspaceService(w)
  })

  it("the watches file's size, measured watch by watch as its limit is checked (#321), is its text's exactly", () => {
    const one = { id: 'a1b2c3', projectPath: 'C:\\ws\\alpha', agentId: 'a1', cond: { cards: [1, 2], changes: ['comment'] }, marks: { 1: { column: 'doing', comment: 0, verdict: 0, agent: '', archived: false } }, since: '2026-10-08T00:00:00.000Z', limitMinutes: 120, limitAt: '2026-10-08T02:00:00.000Z' }
    const odd = { ...one, id: 'ffff00', agentId: 'b🐝', fired: { line: '[Hive] "quoted" ünïcødé\nline', at: '2026-10-08T01:00:00.000Z', cards: [], sending: '2026-10-08T01:00:01.000Z' }, released: [{ number: 3, why: 'blocked', detail: null }] }
    const text = (ws: object[], invalid: unknown[]) => Buffer.byteLength(JSON.stringify({ version: 1, watches: ws, ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n')
    for (const ws of [[], [one], [one, odd], Array.from({ length: 30 }, (_, i) => ({ ...odd, id: `w${i}` }))])
      for (const invalid of [[], [{ junk: true }, 'text', 42]]) expect(watches.savedFileBytes(ws, invalid), `${ws.length} watches, ${invalid.length} invalid`).toBe(text(ws, invalid))
  })

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
