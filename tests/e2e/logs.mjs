// Where a run's logs go (run.mjs): a folder of its own for each run, so no run overwrites another's logs or record, and
// only the latest few finished ones kept. A run still going (this runner's or another's) is marked active and never
// pruned. A runner started inside a suite (progressreport runs one) keeps its runs apart, under logs/nested, so they
// never push real runs out.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parentSuite } from './runner.mjs'

/** How many run folders are kept, at the top level and under nested/ each. */
export const KEEP_RUNS = 10
const RUN_DIR = /^run-(\d{8}-\d{6})(?:-(\d+))?$/
/** In a run folder while its runner is still going: the runner's process id. */
const ACTIVE = '.active'
/** A marker older than this is from a runner that never finished (or one stuck far beyond any run). */
const ACTIVE_MAX_MS = 24 * 60 * 60_000

/** Whether a process is still running (signal 0 only checks; EPERM means it exists but isn't ours). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The logs folder for this runner: logs/, or logs/nested for a runner started inside a suite (runner.mjs's
 * parentSuite). */
export function logsRootFor(work, env = process.env) {
  return parentSuite(env) ? join(work, 'logs', 'nested') : join(work, 'logs')
}

/** `run-<date>-<time>` in local time. */
export function runDirName(when) {
  const pad = (n) => String(n).padStart(2, '0')
  return `run-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
}

/**
 * Creates a new run folder under root and returns its path: `run-<date>-<time>`, or with `-2`, `-3`… when another run
 * started in the same second. The suffix is always above any already there for that second, so a name is never reused
 * after pruning (a newer run never sorts as older). Each name is created exclusively (mkdir fails if it exists), so two
 * runners at once never share one, whichever creates it first.
 */
export function newRunDir(root, when = new Date(), owner = process.pid) {
  mkdirSync(root, { recursive: true })
  const base = runDirName(when)
  const taken = readdirSync(root).map((name) => RUN_DIR.exec(name)).filter((m) => m && `run-${m[1]}` === base).map((m) => Number(m[2] ?? 1))
  for (let n = taken.length ? Math.max(...taken) + 1 : 1; ; n++) {
    const dir = join(root, n === 1 ? base : `${base}-${n}`)
    try {
      mkdirSync(dir)
      // Active until its runner finishes (finishRunDirs): no other runner prunes it meanwhile.
      writeFileSync(join(dir, ACTIVE), String(owner))
      return dir
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/** The runner has finished with these folders (its record is saved): they count as finished runs from now. */
export function finishRunDirs(dirs) {
  for (const dir of dirs) rmSync(join(dir, ACTIVE), { force: true })
}

/** Whether a run folder's runner is still going: it is marked active by a process that is still running, recently. */
export function runDirActive(dir, alive = processAlive, now = Date.now()) {
  const marker = join(dir, ACTIVE)
  if (!existsSync(marker)) return false
  try {
    const pid = Number(readFileSync(marker, 'utf8'))
    return Number.isInteger(pid) && pid > 0 && alive(pid) && now - statSync(marker).mtimeMs < ACTIVE_MAX_MS
  } catch {
    return false
  }
}

/** Run folders oldest first: by time, then by suffix (run-…-2 after run-…, run-…-10 after run-…-9). */
export function runDirsInOrder(names) {
  const key = (name) => {
    const m = RUN_DIR.exec(name)
    return m ? [m[1], Number(m[2] ?? 1)] : null
  }
  return names.filter((n) => key(n)).sort((a, b) => {
    const [ta, na] = key(a)
    const [tb, nb] = key(b)
    return ta < tb ? -1 : ta > tb ? 1 : na - nb
  })
}

/**
 * Removes all but the newest `keep` finished run folders under root. Never one still active (another runner's, or an
 * unfinished repeat's earlier runs), never one in `protect` (the runner prunes once, after saving its record, and
 * protects its own runs, so a repeat of more than `keep` keeps them all until the next runner prunes), and nothing that
 * isn't a run folder (nested/, run-record.md). Nor one spare(path) keeps (#253: a card cites it as evidence, or the board
 * can't be read: evidence.cjs); those don't count towards `keep`.
 */
export function pruneRunDirs(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null) {
  if (!existsSync(root)) return []
  const mine = new Set(protect.map((p) => p.split(/[\\/]/).pop()))
  const finished = runDirsInOrder(readdirSync(root)).filter((name) => !runDirActive(join(root, name), alive) && !spare(join(root, name)))
  const old = finished.slice(0, Math.max(0, finished.length - keep)).filter((name) => !mine.has(name))
  for (const name of old) rmSync(join(root, name), { recursive: true, force: true })
  return old
}
