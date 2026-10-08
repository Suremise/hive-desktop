// A line Hive types that its CLI doesn't take (#430), with the real SessionManager and the terminal's writes caught:
// nothing more is typed over a line still waiting to be taken (typed and not yet taken, or marked not taken), whoever
// types it; the user's Enter alone doesn't count as taken; only the CLI taking a prompt clears the mark. And a wake's
// Enter again, when it can't be pressed at once, is pressed once it can, else the line is marked, saying so.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessions } from '../src/main/sessions'
import * as pty from '../src/main/ptyHost'
import * as watches from '../src/main/watches'

const project = 'C:/fake-ws/alpha'
const id = 'a1'
type Entry = { state: Record<string, unknown>; prompts: number; typed?: { at: number; prompts: number } }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const key = `${project.toLowerCase()}#${id}`

describe('a line still waiting to be taken (#430)', () => {
  afterEach(() => {
    live.delete(key)
    vi.restoreAllMocks()
  })
  const running = (over: Partial<Entry> = {}): Entry => {
    const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'Watcher', runId: 'run1', status: 'ready' }, prompts: 0, ...over }
    live.set(key, e)
    return e
  }

  it('nothing more is typed over it: not while it waits to be taken, not while marked; once taken, typing goes on', async () => {
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    // Typed a moment ago (a wake being confirmed): another wake or a task is refused before anything is written.
    const e = running({ typed: { at: Date.now(), prompts: 0 } })
    expect(sessions.lineWaiting(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, 'SECOND LINE')).rejects.toThrow(/hasn't taken the line Hive typed before/)
    expect(writes).toEqual([])
    // Taken (the CLI reported the prompt): typing goes on.
    e.prompts = 1
    expect(sessions.lineWaiting(project, id)).toBe(false)
    await sessions.sendPrompt(project, id, 'NEXT')
    expect(writes.join('')).toContain('NEXT')
    // Marked not taken: refused, however long ago it was typed.
    writes.length = 0
    e.typed = { at: Date.now() - 60 * 60_000, prompts: 1 }
    e.state.untakenLine = { since: new Date().toISOString(), text: '[Hive] #1 is in Review' }
    await expect(sessions.sendPrompt(project, id, 'THIRD')).rejects.toThrow(/hasn't taken/)
    expect(writes).toEqual([])
  })

  it("the user's Enter there isn't proof it was taken: the mark stays until its CLI takes a prompt", () => {
    const e = running()
    e.state.untakenLine = { since: new Date().toISOString(), text: '[Hive] #1 is in Review' }
    sessions.noteUserInput(`session:${key}`, '\r')
    expect(sessions.lineUntaken(project, id)).toBe(true)
  })
})

describe('a wake being confirmed holds its input the whole time (#430 round 2)', () => {
  afterEach(() => {
    live.delete(key)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('past 30 s while Enter again is unsafe, nothing else is typed over it; then Enter again once, taken late, and the hold is gone', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    // Just typed (prompts 0), busy (Enter again unsafe while working).
    const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'Watcher', runId: 'run1', status: 'working' }, prompts: 0, typed: { at: Date.now(), prompts: 0 } }
    live.set(key, e)
    const done = watches.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sessions.lineWaiting(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, 'A TASK')).rejects.toThrow(/hasn't taken/)
    expect(writes).toEqual([])
    // Safe now: Enter again, once.
    e.state.status = 'finished'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual(['\r'])
    expect(sessions.lineWaiting(project, id)).toBe(true)
    // Its CLI takes it, late: confirmed, and the input is free again.
    e.prompts = 1
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await done).toBe(true)
    expect(sessions.lineWaiting(project, id)).toBe(false)
    expect(writes).toEqual(['\r'])
  })
})

describe("a wake's Enter again (#430)", () => {
  afterEach(() => {
    watches.testHooks.takeMs = undefined
    vi.restoreAllMocks()
  })

  it("pressed once it can be when it can't be at once, never a third time; if it never can, the line is marked, saying Enter wasn't pressed again", async () => {
    watches.testHooks.takeMs = 200
    const before = { runId: 'run1', count: 0 }
    vi.spyOn(sessions, 'promptsTaken').mockReturnValue(before)
    const marks: { line: string; retried: boolean }[] = []
    vi.spyOn(sessions, 'lineNotTaken').mockImplementation((_p, _a, _r, line, retried = true) => void marks.push({ line, retried }))
    // Busy (or the user typing) for a while, then safe: Enter again then, once.
    let tries = 0
    let enters = 0
    vi.spyOn(sessions, 'submitAgain').mockImplementation(() => (++tries > 3 ? (enters++, true) : false))
    expect(await watches.confirmTaken(project, id, before, 'WAKE')).toBe(false)
    expect(enters).toBe(1)
    expect(marks).toEqual([{ line: 'WAKE', retried: true }])
    // Never safe within the wait: no Enter again, and the mark says so.
    marks.length = 0
    vi.spyOn(sessions, 'submitAgain').mockReturnValue(false)
    expect(await watches.confirmTaken(project, id, before, 'WAKE 2')).toBe(false)
    expect(marks).toEqual([{ line: 'WAKE 2', retried: false }])
  })

  it('taken late, while it waited to press Enter again: nothing more', async () => {
    watches.testHooks.takeMs = 50
    let count = 0
    vi.spyOn(sessions, 'promptsTaken').mockImplementation(() => ({ runId: 'run1', count }))
    const marks: string[] = []
    vi.spyOn(sessions, 'lineNotTaken').mockImplementation((_p, _a, _r, line) => void marks.push(line))
    const submit = vi.spyOn(sessions, 'submitAgain').mockImplementation(() => {
      count = 1
      return false
    })
    expect(await watches.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE')).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([])
  })
})
