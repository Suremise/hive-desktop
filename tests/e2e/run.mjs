// Runs Hive's end-to-end suites: npm run e2e [suite…] [options]. See tests/e2e/README.md.
//   --jobs N        how many suites run at once (default 4; 1 runs them one after another). Suites that start a real
//                   CLI run one at a time in a lane of their own beside the others; those marked serial in suites.mjs
//                   (and the installer's) run last, alone.
//   --affected [B]  the suites the changes since branch B (default main) need, uncommitted ones included
//                   (affected.mjs), plus any suites named. B is taken only if it isn't a suite name.
//   --all           every suite: the full run before a merge to main (not with --affected).
//   --record        print and save a run record (the code's fingerprint, each suite's result) for a card comment. The
//                   record is marked not valid, and the run fails, if the code changed while the suites ran or the
//                   build isn't known to be from this source (build.mjs).
//   --repeat N      run the suites N times, stopping at the first run that fails; with --record, one record for all
//                   of them, valid only if every run passed. For changes that could make tests flaky.
//   --fingerprint   print the code's fingerprint and stop (to compare with a run record).
//   --build         build first (npx electron-vite build), only if the build isn't from this source (build.mjs).
//   --packaged      include the installer's suites (need npm run dist); --no-progress: don't report to Hive.
// Needs a dev build. A suite fails when it exits non-zero or prints a line starting with FAIL. Each suite gets its own
// Agent API port (HIVE_E2E_PORT, read through lib.port()), so suites can run side by side; each runner claims a lane
// (lanes.mjs: ports and suite folders of its own), so runners in different worktrees can run at the same time.
// Run in a Hive agent's session, it shows in that Hive's Progress panel, one step per suite (../progressReport.mts).
import { spawn, spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { e2eProgress } from '../progressReport.mts'
import { SUITES } from './suites.mjs'
import { affectedSuites, changedFiles } from './affected.mjs'
import { fingerprint, recordMarkdown } from './record.mjs'
import { parentSuite, parseArgs, portBase, repeatStatus, selectSuites } from './runner.mjs'
import { ensureBuild } from './build.mjs'
import { finishRunDirs, logsRootFor, newRunDir, pruneRunDirs } from './logs.mjs'
import { LANES, claimLane, laneWork } from './lanes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const lib = createRequire(import.meta.url)('./lib.cjs')

const args = process.argv.slice(2)
const opts = parseArgs(args, SUITES.map((s) => s.name))
if (opts.error) {
  console.error(`${opts.error}. Suites: ${SUITES.map((s) => s.name).join(', ')}`)
  process.exit(2)
}
const { jobs } = opts

if (opts.fingerprint) {
  console.log(fingerprint(root))
  process.exit(0)
}
// The code under test, before anything runs: a run record names it only if it is still the same at the end.
const codeBefore = opts.record ? fingerprint(root) : null

// --- The build: made from the source as it is now (build.mjs), else the suites would test other code.
const runBuild = () => {
  console.log('Building (the dev build is not from this source)…')
  const r = spawnSync('npx electron-vite build', { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const buildCheck = ensureBuild({ root, build: opts.build, runBuild })
const stale = buildCheck.stale
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No dev build: add --build (or run npx electron-vite build first).')
  process.exit(2)
} else if (stale) {
  console.warn(`Warning: ${buildCheck.why}: the suites may test other code. Add --build to build first (only when needed)${opts.record ? '; the run record will say it is not valid' : ''}.\n`)
}

// --- Which suites.
let affected = null
if (opts.affected) {
  affected = affectedSuites(changedFiles(opts.affected, root), SUITES.map((s) => s.name))
  console.log(affected.all ? `Affected since ${opts.affected}: every suite (${affected.why[0]})` : `Affected since ${opts.affected}: ${affected.suites.length ? affected.suites.join(', ') : 'none'}`)
  for (const w of affected.all ? [] : affected.why) console.log(`  ${w}`)
}
const chosen = selectSuites(SUITES, opts, affected)
if (!chosen.length) {
  console.log(`\nNo suite to run${opts.affected ? ' for these changes' : ''}.`)
  process.exit(0)
}

// The runner's lane (lanes.mjs): ports and suite folders no other runner on this machine uses while this one runs, so
// runners started at the same time from different worktrees don't take each other's. A runner started inside a suite
// (progressreport runs one in its agent's shell) claims none: it takes ports well clear of its parent's (portBase).
const nested = !!parentSuite()
const lane = nested ? null : await claimLane(join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'e2e-lanes'), { root })
if (!nested) {
  if (!lane) {
    console.error(`Every e2e lane (${LANES}) is taken by runners still going: wait for one to finish.`)
    process.exit(2)
  }
  process.on('exit', lane.release)
  process.on('SIGINT', () => process.exit(130))
}
/**
 * Where the suites keep their profiles, workspaces and screenshots: the lane's folder (the logs stay in lib.WORK). A
 * runner inside a suite uses nested/ in its parent's (E2E_RUN_DIR: Hive drops HIVE_E2E_DIR from an agent's shell).
 */
const suiteWork = lane ? laneWork(lib.WORK, lane.lane) : process.env.E2E_RUN_DIR ? join(process.env.E2E_RUN_DIR, 'nested') : null
// Each slot has its own port, from the lane's: the CLI lane takes the one below the first slot's.
const PORT_BASE = portBase(process.env, lane?.base)
if (lane) console.log(`Lane ${lane.lane}: ports ${lane.first}–${lane.last}\n  suites' folders: ${suiteWork}\n  logs: ${logsRootFor(lib.WORK)}\n`)

// Run from an agent's session, the variables that make it that agent (its Hive, token, project) stay out of the suites
// and the test copies of Hive they start: those have their own profile, port and sessions.
const SESSION_VARS = ['HIVE_API_URL', 'HIVE_API_TOKEN', 'HIVE_API_TOKEN_FILE', 'HIVE_HOOK_TOKEN', 'HIVE_PROJECT', 'HIVE_PROJECT_PATH', 'HIVE_WORKSPACE', 'HIVE_RUN_ID', 'HIVE_SESSION_ID', 'HIVE_AGENT', 'HIVE_PROVIDER', 'HIVE_PROGRESS_DATA']
/** A suite's environment; side by side, its own Agent API port (suites read it with lib.port(), or inherit it). */
const suiteEnv = (name, port) => {
  // Quiet: the test copies of Hive show their windows without taking focus and raise no Windows notification, taskbar
  // flash or chime (src/main/testQuiet.ts). A suite can still turn either off in its own environment.
  const env = { HIVE_TEST_TIPS: 'off', HIVE_TEST_QUIET: '1', ...process.env }
  for (const k of SESSION_VARS) delete env[k]
  // Never the opt-in native window checks (carddialog's HIVE_E2E_NATIVE): they take over the screen.
  delete env.HIVE_E2E_NATIVE
  if (suiteWork) env.HIVE_E2E_DIR = suiteWork
  // Never a port inherited from a runner that started this one.
  delete env.HIVE_E2E_PORT
  delete env.HIVE_API_PORT
  delete env.E2E_RUN_PORT
  if (port) {
    env.HIVE_E2E_PORT = String(port)
    env.HIVE_API_PORT = String(port)
  }
  // Also said without the HIVE_ prefix, which Hive strips from its sessions: a runner started in an agent's shell inside
  // the suite's Hive (progressreport does) still knows it is inside a suite, and which port to keep clear of (runner.mjs).
  env.E2E_RUN_SUITE = name
  env.E2E_RUN_DIR = suiteWork ?? lib.WORK
  if (port) env.E2E_RUN_PORT = String(port)
  return env
}

const run = (name, port) =>
  new Promise((resolve) => {
    const started = Date.now()
    // No tip card over what a suite clicks, unless its profile turns tips on (tips does).
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: suiteEnv(name, port) })
    let out = ''
    const add = (d) => (out += d)
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    // Out of time: the suite and everything it started. Killing only the suite's node leaves its test copy of Hive running,
    // holding the lane's port, and the lane's next suites can't start their Agent API.
    const timer = setTimeout(() => {
      out += '\nFAIL timed out after 10 minutes: the suite and the processes it started were stopped\n'
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill()
    }, 10 * 60_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const failed = out.split(/\r?\n/).filter((l) => /^\s*FAIL/.test(l))
      resolve({ name, ok: code === 0 && !failed.length, code, failed, out, seconds: Math.round((Date.now() - started) / 1000) })
    })
  })

/** Why a suite can't run here, or null. */
function skipReason(s) {
  const needs = s.needs ?? []
  if (needs.includes('packaged') && !existsSync(join(root, 'dist', 'win-unpacked'))) return 'no dist/win-unpacked (npm run dist)'
  if (needs.includes('codex') && !lib.codexSignedIn()) return `Codex isn't signed in to ${lib.CODEX_HOME}`
  return null
}

// Three groups. Side by side: suites with no needs, several at once. The CLI lane: suites that start the real Claude
// Code or use the Codex test home share those with each other (not with the rest), so they run one at a time, in one
// slot beside the side-by-side ones. Last, alone: those marked serial (window focus…) and the installer's.
// With --jobs 1 everything runs one after another, as before.
const NEEDS = ['claude', 'codex', 'packaged']
const rank = (s) => Math.max(-1, ...(s.needs ?? []).map((n) => NEEDS.indexOf(n)))
const needs = (s, n) => (s.needs ?? []).includes(n)
const isLast = (s) => !!s.serial || needs(s, 'packaged')
const isCli = (s) => !isLast(s) && (needs(s, 'claude') || needs(s, 'codex'))
const sideBySide = jobs === 1 ? [] : chosen.filter((s) => !isLast(s) && !isCli(s))
const cliLane = jobs === 1 ? [] : chosen.filter(isCli).sort((a, b) => rank(a) - rank(b))
const last = jobs === 1 ? [...chosen].sort((a, b) => rank(a) - rank(b)) : chosen.filter(isLast).sort((a, b) => rank(a) - rank(b))
const order = [...sideBySide, ...cliLane, ...last].map((s) => s.name)
const { repeat } = opts
// One progress run for the whole repeat: a step per suite in each run.
const progress = e2eProgress(repeat > 1 ? Array.from({ length: repeat }, (_, k) => order.map((n) => `run ${k + 1}: ${n}`)).flat() : order, args)
const step = (k, name) => (repeat > 1 ? `run ${k}: ${name}` : name)
let finished = 0

// Each run keeps its own logs (logs.mjs): a folder no other run shares, the last few kept; a runner started inside a
// suite keeps its runs under logs/nested.
const logsRoot = logsRootFor(lib.WORK)
/** Runs the chosen suites once (run k of the repeat): { ok, results, logDir, summary }. */
async function runOnce(k) {
  const logDir = newRunDir(logsRoot)
  const results = []
  const startedAt = Date.now()
  const running = new Set()
  const report = () => progress.suite(finished, [...running].map((n) => step(k, n)).join(', '))
  if (repeat > 1) console.log(`\n--- Run ${k} of ${repeat}`)

  function finish(s, r) {
    finished++
    running.delete(s.name)
    progress.done(step(k, s.name), r.seconds * 1000, r.ok)
    writeFileSync(join(logDir, `${s.name}.log`), r.out)
    console.log(`${s.name.padEnd(22)}${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? '' : `  (exit ${r.code}${r.failed.length ? `; ${r.failed.length} failed check${r.failed.length === 1 ? '' : 's'}` : ''})`}`)
    for (const f of r.failed) console.log(`    ${f.trim()}`)
    // A failure with no FAIL line (an exception, a timeout): its last lines say why.
    if (!r.ok && !r.failed.length) for (const line of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(-5)) console.log(`    | ${line.trim().slice(0, 200)}`)
    results.push(r)
    report()
  }

  /** Runs suites one after another (skipping those that can't run here), each with this port. */
  async function inTurn(list, port) {
    for (const s of list) {
      const why = skipReason(s)
      if (why) {
        finished++
        results.push({ name: s.name, skipped: why })
        continue
      }
      running.add(s.name)
      report()
      finish(s, await run(s.name, port))
    }
  }

  const queue = [...sideBySide]
  const poolSlots = Math.max(1, cliLane.length ? jobs - 1 : jobs)
  await Promise.all([
    inTurn(cliLane, PORT_BASE - 1),
    ...Array.from({ length: Math.min(poolSlots, queue.length) }, async (_, slot) => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        running.add(s.name)
        report()
        finish(s, await run(s.name, PORT_BASE + slot))
      }
    })
  ])
  // Also with --jobs 1: a suite's own default port could be another runner's suite's.
  await inTurn(last, PORT_BASE)

  for (const r of results.filter((x) => x.skipped)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
  const failed = results.filter((r) => r.ok === false)
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
  const summary = `${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped in ${minutes} min`
  console.log(`\n${repeat > 1 ? `Run ${k} of ${repeat}: ` : ''}${summary}. Logs: ${logDir}`)
  // In the chosen order, for the record.
  const ordered = chosen.map((s) => results.find((r) => r.name === s.name)).filter(Boolean)
  return { ok: !failed.length, results: ordered, logDir, summary }
}

// --repeat N: run after run, stopping at the first that fails (a later pass doesn't make up for it).
const runs = []
for (let k = 1; k <= repeat; k++) {
  const r = await runOnce(k)
  runs.push(r)
  if (!r.ok) {
    if (k < repeat) console.log(`\nRun ${k} of ${repeat} failed: stopping here (runs ${k + 1}–${repeat} not started). Fix it, then start the repeat again.`)
    break
  }
}
const lastRun = runs.at(-1)
const passedRuns = runs.filter((r) => r.ok).length
const summary = repeat > 1 ? `${passedRuns} of ${repeat} runs passed${runs.length < repeat ? ` (stopped after run ${runs.length})` : ''}` : lastRun.summary
if (repeat > 1) console.log(`\n${summary}.`)
let recordInvalid = false
if (opts.record) {
  // Named for the code as it was when the first run started, and only valid if it is still that code, built fresh (and,
  // for a repeat, every run passed).
  const status = repeatStatus({ repeat, runs, before: codeBefore, after: fingerprint(root), buildStale: stale })
  recordInvalid = !status.valid
  const md = recordMarkdown({ code: codeBefore, when: new Date().toISOString().slice(0, 16).replace('T', ' '), jobs, results: lastRun.results, logDir: lastRun.logDir, summary, problems: status.problems, runs: repeat > 1 ? Object.assign(runs, { repeat }) : null })
  for (const r of runs) writeFileSync(join(r.logDir, 'run-record.md'), md)
  // The latest record is also at logs/run-record.md.
  writeFileSync(join(logsRoot, 'run-record.md'), md)
  console.log(`\n${md}\n\n(Saved as ${join(lastRun.logDir, 'run-record.md')})`)
}
// This repeat's folders are finished now (its record is saved). Older finished runs go only now, never this repeat's
// own (a repeat of more than ten keeps them all until the next run prunes) or another runner's still going.
finishRunDirs(runs.map((r) => r.logDir))
pruneRunDirs(logsRoot, undefined, runs.map((r) => r.logDir))
await progress.finish(lastRun.ok && runs.length === repeat && !recordInvalid, summary)
process.exit(!lastRun.ok || recordInvalid ? 1 : 0)
