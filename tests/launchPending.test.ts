// A launch's task on its CLI's command line (#712): the CLI is ready at its SessionStart and takes the task only after,
// so until its first prompt the agent counts as given a task (pending: working to a wait), at most 30 s after it became
// ready. The real SessionManager's agentNow, with hand-made live states.
import { afterEach, describe, expect, it } from 'vitest'
import { sessions } from '../src/main/sessions'
import { agentBusy } from '../src/shared/agentWatch'

const project = 'C:/fake-ws/alpha'
const id = 'b1'
type Entry = { state: { runId: string; status: string; statusSince?: string }; prompts: number; launchTask?: true; typed?: { at: number; prompts: number } }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const key = `${project.toLowerCase()}#${id}`
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

function running(over: Partial<Entry> & { status?: string; since?: string } = {}): Entry {
  const { status = 'ready', since = ago(0), ...rest } = over
  const e: Entry = { state: { runId: 'run1', status, statusSince: since }, prompts: 0, ...rest }
  live.set(key, e)
  return e
}
const now = () => sessions.agentNow(project, id)!

describe("a launch's task until its CLI takes it (#712)", () => {
  afterEach(() => live.delete(key))

  it('ready but not on its task yet is pending, so a wait waits', () => {
    running({ launchTask: true, since: ago(2000) })
    expect(now().pending).toBe(true)
    expect(agentBusy(now(), false)).toBe(true)
  })

  it('once its CLI takes the task, it is the turn that counts', () => {
    const e = running({ launchTask: true })
    e.prompts = 1
    expect(now().pending).toBe(false)
    e.state.status = 'working'
    expect(agentBusy(now(), false)).toBe(true)
    e.state.status = 'finished'
    expect(agentBusy(now(), false)).toBe(false)
  })

  it('not taken 30 s after it became ready, it is idle again (a wait mustn’t hang on a dropped task)', () => {
    running({ launchTask: true, since: ago(31_000) })
    expect(now().pending).toBe(false)
  })

  it('waiting for the user (a question at start) is that, not pending', () => {
    running({ launchTask: true, status: 'waiting' })
    expect(now().pending).toBe(false)
  })

  it('a launch with no task is idle when ready', () => {
    running()
    expect(now().pending).toBe(false)
    expect(agentBusy(now(), false)).toBe(false)
  })
})
