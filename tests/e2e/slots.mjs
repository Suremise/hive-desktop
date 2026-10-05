// Heavy test runs, machine-wide (#204). Several agents checking their cards at once on one machine (full e2e sets,
// repeats, scenario runs) slowed each other until tests timed out: the flakes were the load, not the code. So at most
// a few heavy runs go at once across every worktree (HIVE_TEST_HEAVY_SLOTS, default 2); a heavy run started while
// they are all taken waits for one, in the order the runs asked, saying who holds them (and in Hive's Progress panel).
// A run that isn't heavy (a few suites, a single scenario) never waits, nor does a runner started inside a suite.
//
// Claims are files in a folder of the run context (runContext.HEAVY_DIR), as lanes are (lanes.mjs): `slot-<k>.json`
// for a run holding a slot and `wait-<pid>.json` for one waiting (when it asked), each with its runner's process id,
// changed only under the claims lock. A crashed run's claim expires: its process is gone (or it is a day old).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { processAlive } from './logs.mjs'
import { claimHeld, withLock } from './lanes.mjs'

/** Heavy runs at once, unless HIVE_TEST_HEAVY_SLOTS says otherwise. */
export const DEFAULT_SLOTS = 2
/** A run of more suites or scenarios than this (or any repeat) is heavy. */
export const HEAVY_OVER = 5

/** How many heavy runs may go at once: HIVE_TEST_HEAVY_SLOTS (a whole number, 1 or more), else DEFAULT_SLOTS. */
export function heavySlots(env = process.env) {
  const n = Number(env.HIVE_TEST_HEAVY_SLOTS)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_SLOTS
}

/** Whether a run is heavy: more than HEAVY_OVER suites or scenarios, or run more than once (--repeat). */
export function isHeavy({ count, repeat = 1 }) {
  return repeat > 1 || count > HEAVY_OVER
}

/** The claims in dir whose names start with prefix: [{ file, claim }] (an unreadable one is { claim: null }). */
function claims(dir, prefix) {
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => {
      try {
        return { file: join(dir, f), claim: JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      } catch {
        return { file: join(dir, f), claim: null }
      }
    })
}

/**
 * One look, under the claims lock: takes a slot if one is free and no run that asked earlier is still waiting for it.
 * Returns { slot } (its number), or { holders, ahead }: the claims holding the slots, and how many runs wait ahead of
 * this one. Waiting (wait: true), this run's place in the queue is kept (wait-<pid>.json, with when it first asked);
 * otherwise it leaves no trace. Claims whose runner is gone are removed.
 */
export async function trySlot(dir, { slots = heavySlots(), owner = process.pid, what = '', root = '', wait = true, alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const t = now()
    const live = (prefix) =>
      claims(dir, prefix).filter(({ file, claim }) => {
        if (claimHeld(claim, alive, t)) return true
        rmSync(file, { force: true })
        return false
      })
    const held = live('slot-').map((c) => c.claim)
    const mine = join(dir, `wait-${owner}.json`)
    const waiting = live('wait-').map((c) => c.claim)
    const me = waiting.find((c) => c.pid === owner) ?? { pid: owner, at: t, root, what }
    const queue = [...waiting.filter((c) => c.pid !== owner), me].sort((a, b) => a.at - b.at || a.pid - b.pid)
    const ahead = queue.indexOf(me)
    const free = slots - held.length
    if (ahead < free) {
      const used = new Set(held.map((c) => c.slot))
      let k = 0
      while (used.has(k)) k++
      writeFileSync(join(dir, `slot-${k}.json`), JSON.stringify({ pid: owner, at: t, slot: k, root, what }))
      rmSync(mine, { force: true })
      return { slot: k }
    }
    if (wait) writeFileSync(mine, JSON.stringify(me))
    else rmSync(mine, { force: true })
    return { holders: held, ahead }
  })
}

/** A claim, for a person: what it runs and where, its process and for how long. */
export function describeClaim(c, now = Date.now()) {
  const min = Math.max(0, Math.round((now - c.at) / 60_000))
  return `${c.what || 'a heavy run'} in ${c.root || 'another worktree'} (process ${c.pid}, ${min} min)`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits for a slot (wait: false, only one look): { slot, waitedMs, release() }, or { refused: { holders, ahead } }.
 * onWait({ holders, ahead }) is called at each look that finds none, every pollMs. release() lets the slot go (only if
 * it is still this run's); it is also let go when the process exits, and expires if it crashes.
 */
export async function waitForSlot(dir, { wait = true, pollMs = 2000, onWait = () => {}, ...opts } = {}) {
  const started = Date.now()
  const owner = opts.owner ?? process.pid
  const queued = join(dir, `wait-${owner}.json`)
  const leaveQueue = () => rmSync(queued, { force: true })
  process.on('exit', leaveQueue)
  try {
    for (;;) {
      const r = await trySlot(dir, { ...opts, owner, wait })
      if (r.slot !== undefined) {
        const file = join(dir, `slot-${r.slot}.json`)
        const release = () => {
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
          } catch {
            // Gone already.
          }
        }
        process.on('exit', release)
        return { slot: r.slot, waitedMs: Date.now() - started, release }
      }
      if (!wait) return { refused: r }
      onWait(r)
      await sleep(pollMs)
    }
  } finally {
    process.off('exit', leaveQueue)
  }
}
