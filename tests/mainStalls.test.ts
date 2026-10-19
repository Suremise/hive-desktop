// "The main process was busy" (#1109): a gap spanning the PC's sleep isn't a stall, and a real one names the work that
// overlapped it (IPC calls, Agent API requests, hooks) and the main thread's CPU time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beginWork, stallClock, stallWatcher, workDuring, workEnded, STALL_TIMING } from '../src/main/mainStalls'

let now = 0
let base = 0
const realMono = stallClock.mono

/** A watcher on a fake clock and loop delay: its deferred decisions run when settle() is called. */
function watcher() {
  let delay = 0
  let cpu = 0
  const deferred: (() => void)[] = []
  const warnings: string[] = []
  const infos: string[] = []
  const w = stallWatcher({
    now: () => now,
    longestDelayMs: () => {
      const d = delay
      delay = 0
      return d
    },
    cpuMs: () => cpu,
    defer: (fn) => deferred.push(fn),
    warn: (l) => warnings.push(l),
    info: (l) => infos.push(l)
  })
  return {
    w,
    warnings,
    infos,
    /** The loop held for `ms` (using `cpuMs` of CPU), then the next tick. */
    stall(ms: number, cpuMs = ms) {
      now += ms
      cpu += cpuMs
      delay = ms
      w.tick()
    },
    tick(ms = STALL_TIMING.every) {
      now += ms
      w.tick()
    },
    /** The decisions deferred so far (the clock left as it is, so the next tick isn't late). */
    settle() {
      for (const fn of deferred.splice(0)) fn()
    }
  }
}

beforeEach(() => {
  // Each test on its own stretch of the fake clock, so work recorded by another never overlaps.
  base += 10_000_000
  now = base
  stallClock.mono = () => now
})
afterEach(() => {
  stallClock.mono = realMono
})

describe('main process stalls (#1109)', () => {
  it('does not warn for a gap spanning a suspend and resume, and says why in an info line', () => {
    const s = watcher()
    s.tick()
    s.w.power()
    s.stall(18_695, 3)
    s.w.power()
    s.settle()
    expect(s.warnings).toEqual([])
    expect(s.infos).toEqual(['The main process was paused for 18695 ms while the PC slept: not counted as busy'])
  })

  it('does not warn when the resume is only told after the late timer', () => {
    const s = watcher()
    s.tick()
    s.stall(5087, 2)
    s.w.power()
    s.settle()
    expect(s.warnings).toEqual([])
  })

  it('warns for a stall with no power event, naming the IPC call that blocked and the CPU time', () => {
    const s = watcher()
    s.tick()
    const done = beginWork('ipc test:block')
    s.stall(1500, 1490)
    done()
    s.settle()
    expect(s.warnings).toEqual(['The main process was busy for 1500 ms (main thread CPU 1490 ms); during it: ipc test:block (1.5 s)'])
  })

  it('names work still running and work that ended, the most overlap first, and counts the rest', () => {
    const s = watcher()
    s.tick()
    const long = beginWork('ipc git:status')
    workEnded('api GET /v1/tasks', 0)
    s.stall(2000)
    workEnded('api POST /v1/tasks/:n', 1900)
    workEnded('hook PreToolUse', 60)
    workEnded('hook Stop', 20)
    now += 1000
    s.settle()
    long()
    expect(s.warnings[0]).toBe('The main process was busy for 2000 ms (main thread CPU 2000 ms); during it: ipc git:status (3.0 s, still running), api POST /v1/tasks/:n (1.9 s), hook PreToolUse (0.1 s) and 1 more')
  })

  it('says when nothing tracked was running, and leaves CPU out where it is unknown', () => {
    const lines: string[] = []
    let t = now
    const w = stallWatcher({ now: () => t, longestDelayMs: () => 0, cpuMs: () => null, defer: (fn) => fn(), warn: (l) => lines.push(l), info: () => undefined })
    t += 500 + 800
    w.tick()
    expect(lines).toEqual(['The main process was busy for 800 ms; no IPC call, Agent API request or hook was under way'])
  })

  it('ignores short delays and a power event long before the stall', () => {
    const s = watcher()
    s.w.power()
    for (let i = 0; i < 10; i++) s.tick()
    s.stall(200)
    s.settle()
    expect(s.warnings).toEqual([])
    s.stall(900)
    s.settle()
    expect(s.warnings).toHaveLength(1)
  })

  it('warns at most once a minute, counting the stalls left out', () => {
    const s = watcher()
    s.stall(400)
    s.settle()
    s.stall(400)
    s.settle()
    s.stall(400)
    s.settle()
    expect(s.warnings).toHaveLength(1)
    for (let i = 0; i < 120; i++) s.tick()
    s.stall(600)
    s.settle()
    expect(s.warnings).toHaveLength(2)
    expect(s.warnings[1]).toMatch(/; 2 more stall\(s\) since the last warning, not logged$/)
  })

  it('lists the work overlapping a span only', () => {
    workEnded('ipc before', 100)
    now += 1000
    const done = beginWork('ipc inside')
    now += 100
    done()
    now += 1000
    expect(workDuring(base + 900, base + 1200).work).toEqual(['ipc inside (0.1 s)'])
  })
})
