// Runners started at the same time from different worktrees (two agents each checking their card) must not share
// Agent API ports or suite folders. Each runner claims a lane: a range of ports and a work folder for its suites, no
// other runner on this machine uses while it runs. Claims are files in a folder under %LOCALAPPDATA%\hive-test, one
// per lane (`lane-<k>.json`, with the runner's process id), taken under a short lock and released when the runner
// ends. A crashed runner's claim expires (its process is gone, or the claim is a day old, like `.active` in logs.mjs).
// A lane is only taken when its ports are free, so something else holding them (an older runner without lanes, another
// app) just moves the runner to the next lane. A runner started inside a suite doesn't claim one: it takes ports
// above its parent's (runner.mjs's portBase). Scenario runs (tests/scenarios/run.mjs) claim lanes from the same pool,
// for their folders and Agent API port.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { processAlive } from './logs.mjs'

/**
 * Lane k's first slot port is LANE_FIRST + k × LANE_SPAN; it uses LANE_PORTS ports from one below that (the CLI lane)
 * up. Clear of the installed and dev Hives' (47821, 47822) and of the suites' own defaults (478xx–4791x) and the scenarios' (47930, tests/scenarios); and the
 * highest a runner inside a suite takes (1000 above its parent's slot) stays under 49152, where Windows hands out
 * ports to anything that asks (the hook server's among them).
 */
export const LANE_FIRST = 47940
export const LANE_SPAN = 20
export const LANES = 10
/** The CLI lane (base − 1) and up to eight slots (--jobs is at most 8), with one to spare. */
export const LANE_PORTS = 10
/** A claim older than this is from a runner that never finished (or one stuck far beyond any run). */
const CLAIM_MAX_MS = 24 * 60 * 60_000
/** The lock held while a runner looks at the claims and writes its own: only for milliseconds, so an old one is a crash. */
const LOCK = '.claiming'
const LOCK_MAX_MS = 10_000

/** Lane k's ports: { base (the first slot's), first, last }. */
export function lanePorts(k) {
  const base = LANE_FIRST + k * LANE_SPAN
  return { base, first: base - 1, last: base - 1 + LANE_PORTS - 1 }
}

/**
 * Where lane k's suites keep their profiles, workspaces and screenshots: lanes/<k> inside the work folder, never the
 * work folder itself (a suite run on its own uses that). There are at most LANES of them, each reused by the next
 * runner in that lane (each suite clears its own folders when it starts), so they never pile up.
 */
export function laneWork(work, k) {
  return join(work, 'lanes', String(k))
}

/** Whether a claim ({ pid, at }) still holds: its runner is running, and it isn't a day old. */
export function claimHeld(claim, alive = processAlive, now = Date.now()) {
  return !!claim && Number.isInteger(claim.pid) && claim.pid > 0 && alive(claim.pid) && now - Number(claim.at) < CLAIM_MAX_MS
}

/**
 * The lane to take: the lowest whose claim (claims[k], or none) doesn't hold and whose ports aren't busy
 * (busy: lane numbers). null when every lane is taken.
 */
export function pickLane(claims, busy = new Set(), alive = processAlive, now = Date.now()) {
  for (let k = 0; k < LANES; k++) if (!claimHeld(claims[k], alive, now) && !busy.has(k)) return k
  return null
}

/** Whether nothing listens on a port (on 127.0.0.1, where Hive's Agent API listens). */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function lanePortsFree(k, free) {
  const { first, last } = lanePorts(k)
  for (let p = first; p <= last; p++) if (!(await free(p))) return false
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Runs fn holding the claims lock (a folder: creating one is atomic). A lock older than LOCK_MAX_MS was left by a
 * runner that crashed while holding it, and is broken. */
async function withLock(dir, fn) {
  const lock = join(dir, LOCK)
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue // Just released.
      }
      if (age > LOCK_MAX_MS) rmSync(lock, { recursive: true, force: true })
      else if (Date.now() - start > 4 * LOCK_MAX_MS) throw new Error(`The e2e lane lock ${lock} is still held`, { cause: e })
      else await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function readClaims(dir) {
  const claims = []
  for (const name of readdirSync(dir)) {
    const m = /^lane-(\d+)\.json$/.exec(name)
    if (!m) continue
    try {
      claims[Number(m[1])] = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      // Unreadable: no claim.
    }
  }
  return claims
}

/**
 * Claims a lane in dir for this runner: { lane, ...lanePorts(lane), release() }, or null when every lane is taken.
 * Lanes held by a live claim are skipped without looking at their ports; the others are taken only if their ports are
 * free. release() removes the claim (only if it is still this runner's).
 */
export async function claimLane(dir, { owner = process.pid, root = '', alive = processAlive, free = portFree, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const claims = readClaims(dir)
    const busy = new Set()
    for (;;) {
      const k = pickLane(claims, busy, alive, now())
      if (k === null) return null
      if (!(await lanePortsFree(k, free))) {
        busy.add(k)
        continue
      }
      const file = join(dir, `lane-${k}.json`)
      writeFileSync(file, JSON.stringify({ pid: owner, at: now(), root }))
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
        } catch {
          // Gone already.
        }
      }
      return { lane: k, ...lanePorts(k), release }
    }
  })
}
