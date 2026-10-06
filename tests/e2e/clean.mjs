// Housekeeping for %LOCALAPPDATA%\hive-test (#253): what the tests leave behind there is removed once it is no longer
// needed, so the folder stays small without anyone tidying it by hand.
//
//   npm run test:clean                  removes what is stale and prints each area's size
//   npm run test:clean -- --dry-run     lists what it would remove (and what it keeps, and why), removes nothing
//   npm run test:clean -- --days N      the age after which leftovers go (default 3; 0: everything not kept below)
//
// The e2e runner and the scenario runner run the same clean-up when they finish (bounded: autoClean), so nothing piles
// up; `test:clean` is for on-demand use and for the sizes.
//
// What goes:
// - In an idle lane (no runner holds its claim: lanes.mjs; the clean-up claims it while it works, so no runner starts
//   in it meanwhile): a suite's folder (kept because the suite failed, or holding its screenshots) older than the age,
//   and anything left from before suites had folders of their own (their profiles and workspaces directly in the lane),
//   whatever its age. The same for the scenario runner's lanes.
// - In the e2e work folder: anything but `lanes` and `logs` older than the age (suites run on their own, probes).
// - Anything else in hive-test older than the age (one-off folders and files: reviewers' and builders' probes).
//   `scratch\<agent>-<date>` is the place for probes that must be under hive-test: its folders go by the same age.
// What stays, always:
// - The CLI test homes (`codex`, `claude`: their sign-ins), never opened; scenario results and baselines; the claims
//   and locks (`e2e-lanes`, `heavy-slots`, `build-locks`), the concurrency checker's folders (it removes its own:
//   tempWorktrees.mjs) and the Progress panel's timings. Logs (`e2e\logs`) are pruned by the runner (logs.mjs).
// - A lane a runner holds.
// - Anything a card that isn't Done (nor archived) cites (evidence.cjs: its path, a path inside it, or a folder it is
//   in), listed as "kept: cited by #n"; once the card is Done, the age rule applies. While the board can't be read (none
//   found up from this repository's main checkout, or a card that can't be read), nothing at all is removed: what is
//   cited can't be known. The same rules hold wherever tests delete their output (evidence.cjs).
// Links (a worktree's node_modules is a junction) are removed as links, never followed.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { LANES, claimHeld, withLock } from './lanes.mjs'
import { processAlive } from './logs.mjs'
import { SUITES } from './suites.mjs'

const require = createRequire(import.meta.url)
const runContext = require('./runContext.cjs')
const { evidenceFor, safeList, sizeOf, removeTree } = require('./evidence.cjs')

/** Leftovers older than this many days go (--days). */
export const PRUNE_DAYS = 3
const DAY = 24 * 60 * 60_000

/** What stays in hive-test whatever its age, and why (the names of its own folders and files). */
export const KEPT = {
  codex: 'the Codex test home (its sign-in)',
  claude: 'the Claude Code test home (its sign-in)',
  scenarios: 'scenario results and baselines (Performance → Compare)',
  'e2e-lanes': "the lanes' claims",
  'heavy-slots': 'the heavy-run slots',
  'build-locks': "the worktrees' build locks",
  concurrency: "the concurrency checker's folders (it removes its own)",
  'progress-timings.json': "the Progress panel's suite timings"
}

/** Holds lane k's claim (lanes.mjs) for the clean-up: its release, or null when a runner holds it. */
export async function holdLane(dir, k, { owner = process.pid, alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const file = join(dir, `lane-${k}.json`)
    let claim = null
    try {
      claim = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // No claim.
    }
    if (claimHeld(claim, alive, now())) return null
    writeFileSync(file, JSON.stringify({ pid: owner, at: now(), root: 'test:clean' }))
    return () => {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
      } catch {
        // Gone already.
      }
    }
  })
}

/** When something was last changed: it, or anything directly in it (a profile's mtime alone misses new files deeper). */
export function lastChanged(p) {
  let t = lstatSync(p).mtimeMs
  if (lstatSync(p).isDirectory())
    for (const name of safeList(p))
      try {
        t = Math.max(t, lstatSync(join(p, name)).mtimeMs)
      } catch {
        // Gone meanwhile.
      }
  return t
}

/**
 * What the clean-up would do in root (hive-test): [{ path, rel, remove, why }] for each thing it looked at (not the
 * kept areas), in order. held(k): whether lane k's claim is held (the clean-up claims an idle lane before removing
 * anything in it: clean()). ev: the evidence rules (evidence.cjs), which keep what cards cite and, while the board
 * can't be read, everything.
 */
export function plan({ root, days = PRUNE_DAYS, now = Date.now(), held = () => false, ev, suites = SUITES.map((s) => s.name) }) {
  const out = []
  const maxAge = days * DAY
  const suiteNames = new Set(suites)
  /** A suite's folder: its name, or `<name>-2`… when an earlier one was kept (evidence.cjs freshFolder). */
  const suiteFolder = (name) => suiteNames.has(name.replace(/-\d+$/, '')) || suiteNames.has(name)
  const look = (path, { legacy = false, area }) => {
    const rel = relative(root, path).split(sep).join('/')
    let age
    try {
      // A file just written can be stamped a moment after now.
      age = Math.max(0, now - lastChanged(path))
    } catch {
      return
    }
    const kept = ev.protects(path)
    const item = { path, rel, area, age }
    if (kept) out.push({ ...item, remove: false, why: kept })
    else if (legacy) out.push({ ...item, remove: true, why: 'left in the lane from before suites had folders of their own' })
    else if (age >= maxAge) out.push({ ...item, remove: true, why: `${(age / DAY).toFixed(1)} days old` })
    else out.push({ ...item, remove: false, why: `newer than ${days} days` })
  }
  const lane = (dir, k, kind) => {
    if (!existsSync(dir)) return
    if (held(k)) {
      out.push({ path: dir, rel: relative(root, dir).split(sep).join('/'), area: 'lane', remove: false, why: 'a runner holds the lane', lane: k })
      return
    }
    for (const name of safeList(dir)) look(join(dir, name), { area: 'lane', legacy: kind === 'e2e' && !suiteFolder(name) })
  }
  const e2e = join(root, 'e2e')
  for (let k = 0; k < LANES; k++) {
    lane(join(e2e, 'lanes', String(k)), k, 'e2e')
    lane(join(root, 'scenarios', 'lanes', String(k)), k, 'scenarios')
  }
  for (const name of safeList(e2e)) if (name !== 'lanes' && name !== 'logs') look(join(e2e, name), { area: 'e2e' })
  for (const name of safeList(join(root, 'scratch'))) look(join(root, 'scratch', name), { area: 'scratch' })
  for (const name of safeList(root)) if (!(name in KEPT) && name !== 'e2e' && name !== 'scratch') look(join(root, name), { area: 'other' })
  return out
}

/** Which lanes of the plan each item is in (e2e or scenarios lane k), so the clean-up claims them first. */
function laneOf(root, p) {
  const m = /^(?:e2e|scenarios)\/lanes\/(\d+)(?:\/|$)/.exec(relative(root, p).split(sep).join('/'))
  return m ? Number(m[1]) : null
}

/**
 * Removes what plan() says goes, each idle lane under its claim. budgetMs bounds the time (a runner's clean-up at its
 * end): what is left goes next time. Returns { removed: [{ rel, size }], kept, failed: [{ rel, error }], freed, stopped }.
 */
export async function clean({ root = runContext.TEST_ROOT, lanesDir = runContext.LANES_DIR, days = PRUNE_DAYS, dryRun = false, budgetMs = Infinity, ev, now = Date.now(), alive = processAlive, owner = process.pid } = {}) {
  const start = Date.now()
  const heldNow = new Set()
  for (let k = 0; k < LANES; k++) {
    let claim = null
    try {
      claim = JSON.parse(readFileSync(join(lanesDir, `lane-${k}.json`), 'utf8'))
    } catch {
      // None.
    }
    if (claimHeld(claim, alive, now)) heldNow.add(k)
  }
  // One look at the board to list what goes; each removal looks again (ev.protects reads it afresh).
  const look = ev.snapshot()
  const items = plan({ root, days, now, held: (k) => heldNow.has(k), ev: look })
  const result = { items, removed: [], failed: [], freed: 0, stopped: false, blocked: look.ok ? null : look.why }
  if (dryRun || !look.ok) return result
  const releases = new Map()
  try {
    for (const item of items.filter((i) => i.remove)) {
      if (Date.now() - start > budgetMs) {
        result.stopped = true
        break
      }
      const k = laneOf(root, item.path)
      if (k !== null && !releases.has(k)) {
        const release = await holdLane(lanesDir, k, { owner, alive })
        releases.set(k, release)
      }
      if (k !== null && !releases.get(k)) {
        result.failed.push({ rel: item.rel, error: 'a runner took the lane meanwhile' })
        continue
      }
      // Cited since the plan (the cards are read again after a while)?
      const kept = ev.protects(item.path)
      if (kept) {
        result.failed.push({ rel: item.rel, error: kept })
        continue
      }
      try {
        const size = removeTree(item.path)
        result.removed.push({ rel: item.rel, size })
        result.freed += size
      } catch (e) {
        result.failed.push({ rel: item.rel, error: e.code ?? e.message })
      }
    }
  } finally {
    for (const release of releases.values()) release?.()
  }
  return result
}

export const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`)

/**
 * The runners' clean-up when they finish (run.mjs, tests/scenarios/run.mjs): the same rules, at most budgetMs, one line
 * said (nothing when there was nothing to do). Never fails the run.
 */
export async function autoClean({ root, ev = evidenceFor(root), log = console.log, budgetMs = 60_000 } = {}) {
  try {
    const r = await clean({ budgetMs, ev })
    if (r.blocked) log(`\nHousekeeping (hive-test): nothing removed: ${r.blocked}.`)
    else if (r.removed.length || r.failed.length || r.stopped)
      log(`\nHousekeeping (hive-test): removed ${r.removed.length} stale item${r.removed.length === 1 ? '' : 's'} (${mb(r.freed)})${r.failed.length ? `, ${r.failed.length} kept (in use, or cited meanwhile)` : ''}${r.stopped ? '; the rest next time' : ''}. npm run test:clean -- --dry-run lists what is there.`)
  } catch (e) {
    log(`\nHousekeeping (hive-test) didn't run: ${e.message}`)
  }
}

/** Each area's size, for the report. */
export function areaSizes(root = runContext.TEST_ROOT) {
  const rows = []
  const add = (label, p) => existsSync(p) && rows.push([label, sizeOf(p)])
  const e2e = join(root, 'e2e')
  for (let k = 0; k < LANES; k++) add(`e2e\\lanes\\${k}`, join(e2e, 'lanes', String(k)))
  add('e2e\\logs', join(e2e, 'logs'))
  rows.push(['e2e (suites run on their own, probes)', safeList(e2e).filter((n) => n !== 'lanes' && n !== 'logs').reduce((t, n) => t + sizeOf(join(e2e, n)), 0)])
  for (const name of Object.keys(KEPT)) add(name, join(root, name))
  add('scratch', join(root, 'scratch'))
  rows.push(['other (one-off)', safeList(root).filter((n) => !(n in KEPT) && n !== 'e2e' && n !== 'scratch').reduce((t, n) => t + sizeOf(join(root, n)), 0)])
  return rows
}

// --- npm run test:clean
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const at = args.indexOf('--days')
  const days = at >= 0 ? Number(args[at + 1]) : PRUNE_DAYS
  const unknown = args.filter((a, i) => a !== '--dry-run' && a !== '--days' && !(i === at + 1 && at >= 0))
  if (!Number.isFinite(days) || days < 0 || unknown.length) {
    console.error(`Usage: npm run test:clean [-- --dry-run] [--days N]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`)
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ev = evidenceFor(root)
  console.log(`hive-test: ${runContext.TEST_ROOT}`)
  if (!ev.ok) console.log(`Nothing is removed: ${ev.why}.`)
  const r = await clean({ days, dryRun, ev })
  for (const i of r.items.filter((x) => !x.remove && x.why !== `newer than ${days} days`)) console.log(`  kept: ${i.rel} (${i.why})`)
  if (dryRun) {
    const goes = r.items.filter((i) => i.remove)
    for (const i of goes) console.log(`  would remove: ${i.rel} (${i.why})`)
    console.log(`\n${goes.length} item${goes.length === 1 ? '' : 's'} would go (measuring)…`)
    console.log(`They hold ${mb(goes.reduce((t, i) => t + sizeOf(i.path), 0))}.`)
  } else {
    for (const i of r.removed) console.log(`  removed: ${i.rel} (${mb(i.size)})`)
    for (const f of r.failed) console.log(`  couldn't remove: ${f.rel} (${f.error})`)
    console.log(`\nRemoved ${r.removed.length} item${r.removed.length === 1 ? '' : 's'}, freed ${mb(r.freed)}.`)
  }
  console.log('\nSizes (measuring)…')
  const rows = areaSizes()
  for (const [label, size] of rows) console.log(`  ${label.padEnd(40)}${mb(size).padStart(9)}`)
  console.log(`  ${'total'.padEnd(40)}${mb(rows.reduce((t, [, s]) => t + s, 0)).padStart(9)}`)
}
