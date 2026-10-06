// The Progress panel's store and rules: a run is its starter's (by token), others can't touch it; limits; merged
// updates; stale runs; the taskbar's combined bar; time left.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgressError, ProgressStore, admitReport, type ProgressCaller } from '../src/main/progress'
import { MAX_OPEN_PER_OWNER, MAX_RUNS_PER_WORKSPACE, PASSED_SHOWN_MS, STRIP_BARS, ALL_PROJECTS, NO_PROJECT, SHOW_ALL, activeFilter, agentChoices, filterChoices, filterRuns, inStrip, isListed, isOverdue, isRecent, runDetailsText, stripRuns, taskbarProgress, timeLeft, unseenTrouble } from '../src/shared/progress'
import type { ProgressRun } from '../src/shared/types'
import { setDateStyle } from '../src/shared/dates'

const WS = 'C:\\ws'
const alfie: ProgressCaller = { source: 'agent', workspacePath: WS, projectPath: 'C:\\ws\\alpha', agentId: 'a-1', agentName: 'Alfie', provider: 'claude-code' }
const betty: ProgressCaller = { source: 'agent', workspacePath: WS, projectPath: 'C:\\ws\\beta', agentId: 'a-2', agentName: 'Betty', provider: 'codex' }
// Same agent id in another project: still someone else.
const alfieTwin: ProgressCaller = { ...alfie, projectPath: 'C:\\ws\\gamma' }
const script: ProgressCaller = { source: 'api', workspacePath: WS }
const otherWsScript: ProgressCaller = { source: 'api', workspacePath: 'C:\\other' }
const assistant: ProgressCaller = { source: 'assistant', workspacePath: WS, agentName: 'Hive Assistant', provider: 'claude-code' }

let now = 1_000_000
let changes: { ws: string; runs: ProgressRun[] }[] = []
let running = true
const store = (): ProgressStore =>
  new ProgressStore({ now: () => now, changed: (ws, runs) => changes.push({ ws, runs }), ownerRunning: () => running, emitEveryMs: 250 })

const status = (fn: () => unknown): number | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ProgressError ? e.status : -1
  }
}

beforeEach(() => {
  now = 1_000_000
  changes = []
  running = true
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('progress runs', () => {
  it("is the starter's: its agent, name and provider come from the caller, not the request", () => {
    const s = store()
    const r = s.start(alfie, { title: 'e2e: 12 suites', total: 12, agentName: 'Mallory', source: 'api' })
    expect(r).toMatchObject({ agentName: 'Alfie', agentId: 'a-1', projectPath: 'C:\\ws\\alpha', provider: 'claude-code', source: 'agent', total: 12, step: 0, state: 'running' })
    expect(s.start(script, { title: 'build' })).toMatchObject({ agentName: 'Script', agentId: null, source: 'api' })
    expect(s.start(assistant, { title: 'x' })).toMatchObject({ agentName: 'Hive Assistant', source: 'assistant' })
  })

  it("only its owner (or a script in the workspace) updates or finishes it; others get 404 as for an unknown run", () => {
    const s = store()
    const r = s.start(alfie, { title: 'tests', total: 3 })
    for (const who of [betty, alfieTwin, assistant, otherWsScript]) {
      expect(status(() => s.update(who, r.id, { step: 1 }))).toBe(404)
      expect(status(() => s.finish(who, r.id, { ok: true }))).toBe(404)
    }
    expect(status(() => s.update(alfie, 'nope', { step: 1 }))).toBe(404)
    expect(s.update(alfie, r.id, { step: 1, stepName: 'carddialog' })).toMatchObject({ step: 1, stepName: 'carddialog' })
    expect(s.update(script, r.id, { step: 2 }).step).toBe(2)
    const a = s.start(assistant, { title: 'assistant run' })
    expect(status(() => s.update(alfie, a.id, {}))).toBe(404)
    expect(s.update(assistant, a.id, { estimateMs: 1000 }).estimateMs).toBe(1000)
  })

  it('validates input and caps text', () => {
    const s = store()
    expect(status(() => s.start(alfie, {}))).toBe(400)
    expect(status(() => s.start(alfie, { title: '   ' }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 0 }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 'many' }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 3, step: 4 }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', estimateMs: -1 }))).toBe(400)
    const long = s.start(alfie, { title: 'y'.repeat(500), command: 'z'.repeat(500), stepName: 'w\n'.repeat(200) })
    expect(long.title.length).toBe(120)
    expect(long.command!.length).toBe(200)
    expect(long.stepName!.length).toBeLessThanOrEqual(120)
    expect(status(() => s.update(alfie, long.id, { step: 1.5e9 }))).toBe(400)
    expect(status(() => s.finish(alfie, long.id, {}))).toBe(400)
  })

  it('takes a late total once, on a run started without one; a run with a total keeps it', () => {
    const s = store()
    const late = s.start(alfie, { title: 'counts late' })
    s.update(alfie, late.id, { step: 7, stepName: 'setup' })
    // A refused update changes nothing: out of range, or a step past the new total.
    expect(status(() => s.update(alfie, late.id, { total: 0 }))).toBe(400)
    expect(status(() => s.update(alfie, late.id, { total: 4, step: 5 }))).toBe(400)
    expect(late).toMatchObject({ total: null, step: 7, stepName: 'setup' })
    // A step already past the total is kept within it.
    expect(s.update(alfie, late.id, { total: 5 })).toMatchObject({ total: 5, step: 5, stepName: 'setup' })
    expect(s.update(alfie, late.id, { step: 2 }).step).toBe(2)
    expect(status(() => s.update(alfie, late.id, { total: 5 }))).toBe(409)
    expect(status(() => s.update(alfie, late.id, { total: 8, step: 3 }))).toBe(409)
    expect(late).toMatchObject({ total: 5, step: 2 })
    const early = s.start(alfie, { title: 'counts early', total: 3 })
    expect(status(() => s.update(alfie, early.id, { total: 6 }))).toBe(409)
    expect(s.update(alfie, s.start(alfie, { title: 'with name' }).id, { total: 3, step: 1, stepName: 'b' })).toMatchObject({ total: 3, step: 1, stepName: 'b' })
  })

  it(`allows ${MAX_OPEN_PER_OWNER} open runs per owner, counted separately for each`, () => {
    const s = store()
    const ids = Array.from({ length: MAX_OPEN_PER_OWNER }, (_, i) => s.start(alfie, { title: `run ${i}` }).id)
    expect(status(() => s.start(alfie, { title: 'one too many' }))).toBe(429)
    expect(status(() => s.start(betty, { title: 'mine' }))).toBeNull()
    expect(status(() => s.start(script, { title: 'a script' }))).toBeNull()
    s.finish(alfie, ids[0], { ok: true })
    expect(status(() => s.start(alfie, { title: 'room again' }))).toBeNull()
  })

  it(`keeps at most ${MAX_RUNS_PER_WORKSPACE} runs, dropping finished ones oldest first, never open ones`, () => {
    const s = store()
    const first = s.start(betty, { title: 'open, oldest' })
    for (let i = 0; i < MAX_RUNS_PER_WORKSPACE + 5; i++) {
      const r = s.start(alfie, { title: `r${i}` })
      s.finish(alfie, r.id, { ok: true })
    }
    const list = s.list(WS)
    expect(list.length).toBe(MAX_RUNS_PER_WORKSPACE)
    expect(list.some((r) => r.id === first.id)).toBe(true)
    expect(list[0].title).toBe(`r${MAX_RUNS_PER_WORKSPACE + 4}`)
  })

  it('finishing: passed fills the bar, failed marks the failure unseen until the panel is looked at; no changes after', () => {
    const s = store()
    const a = s.start(alfie, { title: 'unit', total: 10 })
    expect(s.finish(alfie, a.id, { ok: true, summary: 'all good' })).toMatchObject({ state: 'passed', step: 10, finishedAt: now })
    expect(status(() => s.update(alfie, a.id, { step: 3 }))).toBe(409)
    expect(status(() => s.finish(alfie, a.id, { ok: false }))).toBe(409)
    expect(s.failureUnseen(WS)).toBe(false)
    const b = s.start(alfie, { title: 'e2e' })
    s.finish(alfie, b.id, { ok: false, summary: '2 suites failed' })
    expect(s.failureUnseen(WS)).toBe(true)
    s.seen(WS)
    expect(s.failureUnseen(WS)).toBe(false)
  })

  it('seen: each failed or stale run the user had not seen is marked, once; a new report or failure is unseen again (#220)', () => {
    const s = store()
    const f = s.start(alfie, { title: 'e2e' })
    s.finish(alfie, f.id, { ok: false, summary: '1 failed' })
    expect(s.list(WS)[0].seenAt).toBeNull()
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === f.id)!.seenAt).toBe(now)
    const seenAt = now
    now += 5000
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === f.id)!.seenAt).toBe(seenAt)
    // A stale run seen, then reporting again: unseen again if it goes stale or fails later.
    const q = s.start(betty, { title: 'build' })
    running = false
    s.sweep()
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === q.id)!.seenAt).toBe(now)
    running = true
    expect(s.update(betty, q.id, { step: 1 }).seenAt).toBeNull()
    expect(s.finish(betty, q.id, { ok: false }).seenAt).toBeNull()
  })

  it('finish takes an exit code and a log path (both optional); the first estimate gives the expected time (#220)', () => {
    const s = store()
    const r = s.start(alfie, { title: 'e2e', estimateMs: 60_000 })
    expect(r.expectedMs).toBe(60_000)
    expect(status(() => s.finish(alfie, r.id, { ok: false, exitCode: 'one' }))).toBe(400)
    expect(status(() => s.finish(alfie, r.id, { ok: false, logPath: 7 }))).toBe(400)
    expect(s.finish(alfie, r.id, { ok: false, exitCode: 3, logPath: 'C:\\logs\\run-record.md' })).toMatchObject({ exitCode: 3, logPath: 'C:\\logs\\run-record.md' })
    const late = s.start(alfie, { title: 'unit' })
    expect(late.expectedMs).toBeNull()
    now += 10_000
    expect(s.update(alfie, late.id, { estimateMs: 20_000 }).expectedMs).toBe(30_000)
    now += 5000
    expect(s.update(alfie, late.id, { estimateMs: 99_000 }).expectedMs).toBe(30_000)
    expect(s.finish(alfie, late.id, { ok: true })).toMatchObject({ exitCode: null, logPath: null })
  })

  it('dismissing moves a finished or stale run to Recent; a running one stays', () => {
    const s = store()
    const r = s.start(alfie, { title: 'x' })
    s.dismiss(WS, r.id)
    expect(s.list(WS)[0].dismissed).toBe(false)
    s.finish(alfie, r.id, { ok: false })
    s.dismiss(WS, r.id)
    expect(s.list(WS)[0].dismissed).toBe(true)
  })

  it('goes stale when quiet for longer than expected or when its agent stops; a report revives it', () => {
    const s = store()
    const quiet = s.start(alfie, { title: 'no estimate' })
    const timed = s.start(betty, { title: 'steps', total: 4, step: 0, estimateMs: 4 * 60_000 })
    now += 2 * 60_000 + 59_000
    s.sweep()
    expect(s.list(WS).find((r) => r.id === timed.id)!.state).toBe('running')
    now += 2_000 // one step's share (1 min) + 2 min grace has passed
    s.sweep()
    expect(s.list(WS).find((r) => r.id === timed.id)).toMatchObject({ state: 'stale', staleReason: 'quiet' })
    expect(s.list(WS).find((r) => r.id === quiet.id)!.state).toBe('running')
    s.update(betty, timed.id, { step: 1 })
    expect(s.list(WS).find((r) => r.id === timed.id)).toMatchObject({ state: 'running', staleReason: null })
    running = false
    s.sweep()
    expect(s.list(WS).every((r) => r.state === 'stale' && r.staleReason === 'agent-stopped')).toBe(true)
    // A script's run has no session to stop.
    running = true
    const sc = s.start(script, { title: 'script' })
    running = false
    s.sweep()
    expect(s.list(WS).find((r) => r.id === sc.id)!.state).toBe('running')
  })

  it('merges rapid updates into at most one window event per interval, with the latest state', () => {
    const s = store()
    const r = s.start(alfie, { title: 'fast', total: 100 })
    changes = []
    for (let i = 1; i <= 50; i++) s.update(alfie, r.id, { step: i })
    expect(changes.length).toBe(0)
    now += 250
    vi.advanceTimersByTime(250)
    expect(changes.length).toBe(1)
    expect(changes[0].runs[0].step).toBe(50)
  })

  it('reports the latest open run of an agent, matched by project and agent', () => {
    const s = store()
    expect(s.openRunOf(alfie.source === 'agent' ? alfie.projectPath : '', 'a-1')).toBeNull()
    const r = s.start(alfie, { title: 'mine' })
    s.start(alfieTwin, { title: 'twin' })
    expect(s.openRunOf('c:\\WS\\ALPHA', 'a-1')?.id).toBe(r.id)
    s.finish(alfie, r.id, { ok: true })
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toBeNull()
  })

  // --- Review round 1 (Codex): each finding, as found.

  it(`holds the workspace to ${MAX_RUNS_PER_WORKSPACE} runs across many owners, stale ones counting as open`, () => {
    const s = store()
    const owner = (i: number): ProgressCaller => ({ ...alfie, agentId: `a-${i}`, agentName: `A${i}` })
    const first = s.start(owner(0), { title: 'stale soon' })
    running = false
    s.sweep() // the first goes stale: still open
    running = true
    for (let i = 1; i < MAX_RUNS_PER_WORKSPACE; i++) s.start(owner(i), { title: `r${i}` })
    expect(s.list(WS).length).toBe(MAX_RUNS_PER_WORKSPACE)
    expect(status(() => s.start(owner(999), { title: 'one too many' }))).toBe(429)
    expect(status(() => s.start(script, { title: 'a script too' }))).toBe(429)
    expect(s.list(WS).length).toBe(MAX_RUNS_PER_WORKSPACE)
    // An ended run makes room: a dismissed stale one, then a finished one.
    s.dismiss(WS, first.id)
    expect(status(() => s.start(owner(999), { title: 'room' }))).toBeNull()
    expect(s.list(WS).length).toBe(MAX_RUNS_PER_WORKSPACE)
    expect(s.list(WS).some((r) => r.id === first.id)).toBe(false)
    expect(status(() => s.start(owner(1000), { title: 'full again' }))).toBe(429)
    // Another workspace has its own bound.
    expect(status(() => s.start(otherWsScript, { title: 'elsewhere' }))).toBeNull()
  })

  it("clearing a workspace (closed or switched) forgets its runs, unseen failure and timers; others' runs stay", () => {
    const s = store()
    const mine = s.start(script, { title: 'mine', total: 10 })
    const failed = s.start(script, { title: 'failed' })
    s.finish(script, failed.id, { ok: false })
    const theirs = s.start(otherWsScript, { title: 'other window' })
    s.update(script, mine.id, { step: 1 })
    s.update(script, mine.id, { step: 2 }) // a merged window event is pending
    changes = []
    s.clear(WS)
    expect(changes).toEqual([{ ws: WS, runs: [] }])
    expect(s.list(WS)).toEqual([])
    expect(s.failureUnseen(WS)).toBe(false)
    expect(status(() => s.update(script, mine.id, { step: 3 }))).toBe(404)
    // The pending event was dropped with it: nothing more is sent for the closed workspace.
    now += 1000
    vi.advanceTimersByTime(1000)
    expect(changes.length).toBe(1)
    expect(s.list('C:\\other').map((r) => r.id)).toEqual([theirs.id])
    // Reopened, it starts empty and works as new.
    expect(s.start(script, { title: 'after' }).title).toBe('after')
  })

  it('a rejected finish changes nothing, for either outcome, and can be sent again', () => {
    const s = store()
    for (const ok of [true, false]) {
      const r = s.start(script, { title: `finish ${ok}`, total: 4, step: 1 })
      changes = []
      expect(status(() => s.finish(script, r.id, { ok, summary: 123 }))).toBe(400)
      expect(s.list(WS).find((x) => x.id === r.id)).toMatchObject({ state: 'running', finishedAt: null, step: 1, summary: null })
      expect(changes).toEqual([])
      expect(s.failureUnseen(WS)).toBe(false)
      expect(s.finish(script, r.id, { ok, summary: 'done' }).state).toBe(ok ? 'passed' : 'failed')
      expect(s.failureUnseen(WS)).toBe(!ok)
      s.seen(WS)
    }
    // A rejected start or update changes nothing either.
    const before = s.list(WS).length
    expect(status(() => s.start(script, { title: 'x', command: 5 }))).toBe(400)
    expect(s.list(WS).length).toBe(before)
    const r = s.start(script, { title: 'u', total: 4 })
    expect(status(() => s.update(script, r.id, { step: 2, stepName: 7 }))).toBe(400)
    expect(s.list(WS).find((x) => x.id === r.id)!.step).toBe(0)
  })

  it('a dismissed stale run has ended: out of status and the taskbar, takes no reports, frees its owner', () => {
    // Only the agents named here are running.
    const up = new Set(['a-2'])
    const s = new ProgressStore({ now: () => now, changed: () => undefined, ownerRunning: (r) => up.has(r.agentId ?? ''), emitEveryMs: 250 })
    const r = s.start(alfie, { title: 'long run', total: 10 })
    const other = s.start(betty, { title: 'still going', total: 4, step: 2 })
    s.sweep()
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toMatchObject({ id: r.id, state: 'stale' })
    s.dismiss(WS, r.id)
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toBeNull()
    // Mixed: the dismissed stale run no longer counts; the running one does.
    expect(taskbarProgress(s.list(WS), false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(status(() => s.update(alfie, r.id, { step: 1 }))).toBe(409)
    expect(status(() => s.finish(alfie, r.id, { ok: true }))).toBe(409)
    s.dismiss(WS, other.id) // running: not dismissable
    expect(s.openRunOf('C:\\ws\\beta', 'a-2')?.id).toBe(other.id)
    // The last open run goes stale and is dismissed: the taskbar goes off.
    up.clear()
    s.sweep()
    expect(taskbarProgress(s.list(WS), false).mode).toBe('normal')
    s.dismiss(WS, other.id)
    expect(taskbarProgress(s.list(WS), false).mode).toBe('none')
    expect(s.openRunOf('C:\\ws\\beta', 'a-2')).toBeNull()
  })

  it("an update without an estimate keeps the deadline; only a new estimate moves it", () => {
    const s = store()
    const r = s.start(alfie, { title: 'timed', total: 4, estimateMs: 60_000 })
    now += 30_000
    s.update(alfie, r.id, { step: 1 })
    expect(timeLeft(s.list(WS)[0], now)).toBe(30_000)
    now += 10_000
    s.update(alfie, r.id, { stepName: 'heartbeat' })
    expect(timeLeft(s.list(WS)[0], now)).toBe(20_000)
    now += 30_000
    s.update(alfie, r.id, { stepName: 'late' })
    expect(timeLeft(s.list(WS)[0], now)).toBe(0)
    s.update(alfie, r.id, { estimateMs: 45_000 })
    expect(timeLeft(s.list(WS)[0], now)).toBe(45_000)
    // A run without an estimate stays without one.
    const n = s.start(alfie, { title: 'untimed' })
    s.update(alfie, n.id, { stepName: 'x' })
    expect(s.list(WS).find((x) => x.id === n.id)!.estimateMs).toBeNull()
  })

  // --- Review round 2 (Codex): a report whose caller is still being looked up when the setting changes.

  it('a report resolving while the panel is turned off (or off and on again) is ignored and stores nothing', async () => {
    let on = true
    let generation = 0
    const gate = { on: () => on, generation: () => generation }
    const toggle = (v: boolean): void => {
      on = v
      generation++
    }
    const s = store()
    /** A caller lookup the test finishes when it chooses (as reading project.json can take a while). */
    const slow = (): { resolve: () => Promise<ProgressCaller>; release: () => void } => {
      let release!: () => void
      const ready = new Promise<void>((r) => (release = r))
      return { resolve: async () => (await ready, alfie), release }
    }
    const IGNORED: unknown = { ignored: true }
    const startOf = (c: ProgressCaller) => s.start(c, { title: 'late after panel off' })

    // Off while resolving: ignored, nothing stored, nothing on again.
    let lookup = slow()
    let reply = admitReport(gate, IGNORED, lookup.resolve, startOf)
    toggle(false)
    s.clear()
    lookup.release()
    expect(await reply).toBe(IGNORED)
    expect(s.list(WS)).toEqual([])
    toggle(true)
    expect(s.list(WS)).toEqual([])

    // Off and on again while resolving: an older lifetime can't recreate a run.
    lookup = slow()
    reply = admitReport(gate, IGNORED, lookup.resolve, startOf)
    toggle(false)
    s.clear()
    toggle(true)
    lookup.release()
    expect(await reply).toBe(IGNORED)
    expect(s.list(WS)).toEqual([])

    // Updates and finishes the same way: the run (started after) is untouched.
    const run = admitReport(gate, IGNORED, async () => alfie, startOf)
    const id = ((await run) as ProgressRun).id
    for (const change of [(c: ProgressCaller) => s.update(c, id, { step: 5 }), (c: ProgressCaller) => s.finish(c, id, { ok: false })]) {
      lookup = slow()
      reply = admitReport(gate, IGNORED, lookup.resolve, change)
      toggle(false)
      toggle(true)
      lookup.release()
      expect(await reply).toBe(IGNORED)
    }
    expect(s.list(WS)[0]).toMatchObject({ id, state: 'running', step: null, finishedAt: null })
    expect(s.failureUnseen(WS)).toBe(false)

    // Off before it starts: ignored without looking the caller up. On and unchanged: admitted.
    on = false
    let looked = false
    expect(await admitReport(gate, IGNORED, async () => ((looked = true), alfie), startOf)).toBe(IGNORED)
    expect(looked).toBe(false)
    on = true
    expect(((await admitReport(gate, IGNORED, async () => alfie, startOf)) as ProgressRun).title).toBe('late after panel off')
  })

  it('forgets runs when cleared (the panel turned off)', () => {
    const s = store()
    const r = s.start(alfie, { title: 'x' })
    s.clear()
    expect(s.list(WS)).toEqual([])
    expect(status(() => s.update(alfie, r.id, {}))).toBe(404)
  })
})

describe('progress rules', () => {
  it(`the folded strip: a bar for the newest ${STRIP_BARS}, the rest counted with the worst state, and every run in words`, () => {
    const runs = (states: ProgressRun['state'][]): ProgressRun[] => states.map((state, i) => ({ ...run({ state }), id: `r${i}` }))
    expect(stripRuns([])).toEqual({ bars: [], more: [], moreState: null, summary: '' })
    expect(stripRuns(runs(['stale'])).summary).toBe('1 run, stopped reporting')
    const six = stripRuns(runs(['running', 'failed', 'running', 'stale', 'passed', 'running']))
    expect([six.bars.length, six.more.length, six.moreState]).toEqual([6, 0, null])
    expect(six.summary).toBe('6 runs: 3 running, 1 failed, 1 stopped reporting, 1 passed')
    const nine = stripRuns(runs(['running', 'running', 'running', 'running', 'running', 'running', 'running', 'stale', 'failed']))
    expect(nine.bars.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(nine.more.map((r) => r.id)).toEqual(['r6', 'r7', 'r8'])
    expect(nine.moreState).toBe('failed')
    expect(nine.summary).toBe('9 runs: 7 running, 1 failed, 1 stopped reporting')
    expect(stripRuns(runs(['running', 'running', 'running', 'running', 'running', 'running', 'stale'])).moreState).toBe('stale')
    expect(stripRuns(runs(['failed', 'running', 'running', 'running', 'running', 'running', 'running'])).moreState).toBeNull()
  })

  const run = (over: Partial<ProgressRun>): ProgressRun => ({
    id: 'r',
    workspacePath: WS,
    projectPath: null,
    agentId: null,
    agentName: 'x',
    provider: null,
    source: 'api',
    title: 't',
    command: null,
    total: null,
    step: null,
    stepName: null,
    estimateMs: null,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: null,
    state: 'running',
    staleReason: null,
    summary: null,
    dismissed: false,
    seenAt: null,
    expectedMs: null,
    exitCode: null,
    logPath: null,
    ...over
  })

  it('a failed or stale run is listed until seen and a few seconds more, then is under Recent; the strip drops it when seen (#220)', () => {
    const failed = run({ state: 'failed', finishedAt: 100 })
    expect([isListed(failed, 1e9), inStrip(failed, 1e9), isRecent(failed, 1e9), unseenTrouble(failed)]).toEqual([true, true, false, true])
    const seen = { ...failed, seenAt: 1000 }
    expect([isListed(seen, 1000 + PASSED_SHOWN_MS - 1), inStrip(seen, 1000), isRecent(seen, 1000), unseenTrouble(seen)]).toEqual([true, false, false, false])
    expect([isListed(seen, 1000 + PASSED_SHOWN_MS), isRecent(seen, 1000 + PASSED_SHOWN_MS)]).toEqual([false, true])
    const stale = run({ state: 'stale', seenAt: 0 })
    expect([isListed(stale, PASSED_SHOWN_MS), isRecent(stale, PASSED_SHOWN_MS)]).toEqual([false, true])
    expect(isListed(run({ state: 'stale' }), 1e9)).toBe(true)
    const passed = run({ state: 'passed', finishedAt: 0 })
    expect([isListed(passed, PASSED_SHOWN_MS - 1), isRecent(passed, PASSED_SHOWN_MS)]).toEqual([true, true])
    expect([isListed(run({ state: 'failed', finishedAt: 0, dismissed: true }), 0), isRecent(run({ state: 'failed', finishedAt: 0, dismissed: true }), 0)]).toEqual([false, true])
    expect([isListed(run({}), 1e9), isRecent(run({}), 1e9)]).toEqual([true, false])
  })

  it('time left counts from the last report, never below zero', () => {
    expect(timeLeft(run({ estimateMs: 60_000, updatedAt: 1000 }), 31_000)).toBe(30_000)
    expect(timeLeft(run({ estimateMs: 60_000, updatedAt: 1000 }), 999_999)).toBe(0)
    expect(timeLeft(run({}), 5)).toBeNull()
  })

  it('overdue: ten minutes without an estimate; the estimate plus two minutes; a step share with steps', () => {
    expect(isOverdue(run({}), 10 * 60_000)).toBe(false)
    expect(isOverdue(run({}), 10 * 60_000 + 1)).toBe(true)
    expect(isOverdue(run({ estimateMs: 60_000 }), 3 * 60_000 + 1)).toBe(true)
    expect(isOverdue(run({ estimateMs: 60_000 }), 3 * 60_000)).toBe(false)
    expect(isOverdue(run({ estimateMs: 10 * 60_000, total: 10, step: 0 }), 3 * 60_000 + 1)).toBe(true)
  })

  it('taskbar: combined steps, indeterminate without steps, red while a failure is unseen, off when idle', () => {
    expect(taskbarProgress([], false)).toEqual({ mode: 'none', value: 0 })
    expect(taskbarProgress([run({ total: 4, step: 1 }), run({ total: 6, step: 4 })], false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(taskbarProgress([run({})], false).mode).toBe('indeterminate')
    // A run without steps doesn't drag the combined fraction down.
    expect(taskbarProgress([run({ total: 2, step: 1 }), run({})], false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(taskbarProgress([run({ state: 'passed', total: 2, step: 2 })], false).mode).toBe('none')
    expect(taskbarProgress([run({ state: 'failed' })], true)).toEqual({ mode: 'error', value: 1 })
    expect(taskbarProgress([run({ total: 4, step: 1 })], true)).toEqual({ mode: 'error', value: 0.25 })
  })

  it('the filter (#251): one project, one agent in it, or the runs without a project; all when there is nothing to choose', () => {
    const a1 = run({ id: 'a1', projectPath: 'C:\\ws\\Alpha', agentId: 'x', agentName: 'Alfie', source: 'agent' })
    const a2 = run({ id: 'a2', projectPath: 'C:\\ws\\alpha', agentId: 'y', agentName: 'Ada', source: 'agent' })
    const b1 = run({ id: 'b1', projectPath: 'C:\\ws\\beta', agentId: 'z', agentName: 'Betty', source: 'agent' })
    const s1 = run({ id: 's1', agentName: 'Script' })
    const all = [a1, a2, b1, s1]
    const names = (p: string): string => p.split('\\').pop()!.toLowerCase()
    expect(filterChoices(all, names)).toEqual([{ value: 'c:\\ws\\alpha', label: 'alpha' }, { value: 'c:\\ws\\beta', label: 'beta' }, { value: NO_PROJECT, label: 'Assistant and scripts' }])
    expect(agentChoices(all, 'c:\\ws\\alpha')).toEqual([{ value: 'y', label: 'Ada' }, { value: 'x', label: 'Alfie' }])
    const ids = (f: Parameters<typeof filterRuns>[1]): string[] => filterRuns(all, activeFilter(all, f)).map((r) => r.id)
    expect(ids({ project: 'c:\\ws\\alpha' })).toEqual(['a1', 'a2'])
    expect(ids({ project: 'c:\\ws\\alpha', agent: 'x' })).toEqual(['a1'])
    expect(ids({ project: NO_PROJECT })).toEqual(['s1'])
    expect(ids({ project: ALL_PROJECTS })).toEqual(['a1', 'a2', 'b1', 's1'])
    // A project with no runs left, or an agent with none: back to all, or to the whole project.
    expect(activeFilter(all, { project: 'c:\\ws\\gone' })).toBe(SHOW_ALL)
    expect(activeFilter(all, { project: 'c:\\ws\\beta', agent: 'x' })).toEqual({ project: 'c:\\ws\\beta' })
    // Every run in one project: nothing to choose between, so no filter.
    expect(activeFilter([a1, a2], { project: 'c:\\ws\\alpha', agent: 'x' })).toBe(SHOW_ALL)
    expect(activeFilter(all, undefined)).toBe(SHOW_ALL)
  })

  it("Copy details is every field the details show, in their order, then the summary (#251)", () => {
    setDateStyle({ date: 'ymd', time: '24h' })
    const start = new Date(2026, 9, 5, 20, 57).getTime()
    const full = run({ title: 'e2e: full set before merging', command: 'npm run e2e -- --all --real --build --record', agentName: 'Claudio', provider: 'claude-code', source: 'agent', total: 96, step: 95, stepName: 'taskbar', startedAt: start, finishedAt: start + 10 * 60_000, expectedMs: 9 * 60_000, state: 'failed', exitCode: 1, logPath: 'C:\\t\\run-record.md', summary: '1 failed: taskbar' })
    expect(runDetailsText(full, 'hive', start + 11 * 60_000)).toBe(
      [
        'Run: e2e: full set before merging',
        'Command: npm run e2e -- --all --real --build --record',
        'Agent: Claudio · hive',
        'Provider: Claude Code',
        'Started: 2026-10-05 20:57',
        'Ended: 2026-10-05 21:07',
        'Took: 10 min · expected about 9 min',
        'Steps: 95 of 96 done · last: taskbar',
        'State: Failed',
        'Exit code: 1',
        'Log: C:\\t\\run-record.md',
        'Summary: 1 failed: taskbar'
      ].join('\n')
    )
    // Only what a run has: no command, provider, steps, exit code, log or summary.
    expect(runDetailsText(run({ title: 'build', agentName: 'Script', startedAt: start }), null, start + 40_000)).toBe(['Run: build', 'Agent: Script', 'Started: 2026-10-05 20:57', 'Took: 40 s so far', 'State: Running'].join('\n'))
  })
})
