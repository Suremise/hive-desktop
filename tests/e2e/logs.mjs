// Where a run's logs go (run.mjs): a folder of its own for each run, so no run overwrites another's logs or record, and
// only the latest few finished ones kept. A run still going (this runner's or another's) is marked active and never
// pruned. A runner started inside a suite (progressreport runs one) keeps its runs apart, under logs/nested, so they
// never push real runs out.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { parentSuite } from './runner.mjs'

const { linkOnPath } = createRequire(import.meta.url)('./evidence.cjs')

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

/**
 * A run that failed (a suite failed, or its record isn't valid) is kept beyond KEEP_RUNS for a day (#223): with several
 * agents testing at once, ten newer runs can come within minutes, before a reviewer reads the failure a builder cited.
 * At most FAILED_MAX of them, the newest; after a day, the usual rule. (A run a card cites stays anyway: evidence.cjs.)
 */
export const FAILED_KEEP_MS = 24 * 60 * 60_000
export const FAILED_MAX = 20
/** In a run folder whose run failed: what failed. Its time is when the run ended. */
const FAILED = '.failed'

/** Marks a run folder as a failed run's (what: the failed suites, or why its record isn't valid). */
export function markRunFailed(dir, what) {
  writeFileSync(join(dir, FAILED), `${what}\n`)
}

/** When a run folder was marked failed (ms), or null. */
export function runFailedAt(dir) {
  try {
    return statSync(join(dir, FAILED)).mtimeMs
  } catch {
    return null
  }
}

/** A suite's folder of screenshots or reports (`restart-shots`, `pshots`, `screenshots`, `artifacts`, `reports`), kept with its files. */
export const EVIDENCE_DIR = /shots$|^(?:screenshots|artifacts|reports)$/i
/**
 * What is never kept, at any depth, inside a screenshot folder too: a profile (`board-profile`), a workspace (`board-ws`,
 * `ws-b`, `ws2`, `x-ws.worktrees`), a CLI home (`board-claude-home`, `codex`) or node_modules; and sign-in files.
 */
export const PROTECTED_DIR = /(?:^|-)(?:profile|ws\d*|ws-[a-z0-9]+|ws\.worktrees|home|claude-home|codex-home|claude|codex)$|^node_modules$/i
export const PROTECTED_FILE = /^(?:\.credentials\.json|auth\.json)$/i

/**
 * Keeps a suite's own files with its run (#223, #284; a failed suite's, or with --keep-files a passed one's): the files
 * at the top of its folder (screenshots, notification logs, reports) and everything in its folders of screenshots or
 * reports (EVIDENCE_DIR, at any depth, as laid out), copied to <run folder>/<suite>, where they stay as long as the
 * run's logs, whatever later runs do to the lane. Never its other folders, and never a profile, workspace, CLI home or
 * sign-in file at any depth, inside a screenshot folder too (PROTECTED_DIR, PROTECTED_FILE). Never through a link: a
 * suite folder with a link anywhere on its path is not read at all, and a junction or symlink inside it is left out,
 * not followed. Left out too: a file over maxBytes, and whatever would go past maxFiles or maxTotal. Returns
 * { copied, omitted: [{ path, why }] }, paths relative to the suite folder ('.' for the folder itself).
 */
export function keepSuiteFiles(suiteDir, runDir, name, { maxBytes = 20 * 1024 * 1024, maxFiles = 500, maxTotal = 200 * 1024 * 1024 } = {}) {
  const size = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`)
  const result = { copied: 0, omitted: [] }
  // A link on the way to the suite's folder (or the folder itself one) would copy from wherever it points.
  const link = linkOnPath(suiteDir)
  if (link) {
    result.omitted.push({ path: '.', why: `reached through a link (${link}): not read` })
    return result
  }
  let total = 0
  const visit = (rel, inEvidence) => {
    let entries
    try {
      entries = readdirSync(join(suiteDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name
      if (e.isSymbolicLink()) {
        if (inEvidence || EVIDENCE_DIR.test(e.name) || !rel) result.omitted.push({ path: r, why: 'a link (not followed)' })
        continue
      }
      if (e.isDirectory()) {
        if (PROTECTED_DIR.test(e.name)) {
          if (inEvidence) result.omitted.push({ path: r, why: 'a profile, workspace or CLI home' })
        } else if (inEvidence || EVIDENCE_DIR.test(e.name)) visit(r, true)
        continue
      }
      if (!e.isFile()) continue
      if (PROTECTED_FILE.test(e.name)) {
        result.omitted.push({ path: r, why: 'a sign-in file' })
        continue
      }
      try {
        const bytes = statSync(join(suiteDir, r)).size
        if (bytes > maxBytes) result.omitted.push({ path: r, why: `over ${size(maxBytes)}` })
        else if (result.copied >= maxFiles) result.omitted.push({ path: r, why: `past ${maxFiles} files` })
        else if (total + bytes > maxTotal) result.omitted.push({ path: r, why: `past ${size(maxTotal)} in all` })
        else {
          mkdirSync(join(runDir, name, rel), { recursive: true })
          copyFileSync(join(suiteDir, r), join(runDir, name, r))
          result.copied++
          total += bytes
        }
      } catch {
        // Gone or in use: the rest are still copied.
      }
    }
  }
  visit('', false)
  return result
}

/** What keepSuiteFiles left out, said in a line ("big.png (over 20 MB), linked (a link …)", the first few). */
export const omittedLine = (omitted, max = 5) =>
  omitted.slice(0, max).map((o) => `${o.path} (${o.why})`).join(', ') + (omitted.length > max ? ` and ${omitted.length - max} more` : '')

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
 * can't be read: evidence.cjs); those don't count towards `keep`. Nor a failed run less than a day old (the newest
 * FAILED_MAX of them: #223).
 */
export function pruneRunDirs(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null, { now = Date.now() } = {}) {
  const old = runDirsToPrune(root, keep, protect, alive, spare, { now })
  for (const name of old) rmSync(join(root, name), { recursive: true, force: true })
  return old
}

/**
 * pruneRunDirs for the runner (#285): before each run folder goes, release(runDir) removes what the run kept outside it
 * (its failed suites' folders in a lane: evidence.cjs releaseKept), awaited, in lanes it may work in.
 */
export async function pruneRunDirsReleasing(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null, { now = Date.now(), release = async () => {} } = {}) {
  const old = runDirsToPrune(root, keep, protect, alive, spare, { now })
  for (const name of old) {
    await release(join(root, name))
    rmSync(join(root, name), { recursive: true, force: true })
  }
  return old
}

/** The run folders pruneRunDirs removes (oldest first), without removing them. */
export function runDirsToPrune(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null, { now = Date.now() } = {}) {
  if (!existsSync(root)) return []
  const mine = new Set(protect.map((p) => p.split(/[\\/]/).pop()))
  const finished = runDirsInOrder(readdirSync(root)).filter((name) => !runDirActive(join(root, name), alive) && !spare(join(root, name)))
  const failedRecently = new Set(
    finished
      .filter((name) => {
        const at = runFailedAt(join(root, name))
        return at !== null && now - at < FAILED_KEEP_MS
      })
      .slice(-FAILED_MAX)
  )
  return finished.slice(0, Math.max(0, finished.length - keep)).filter((name) => !mine.has(name) && !failedRecently.has(name))
}
