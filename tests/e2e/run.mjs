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
//   --fingerprint   print the code's fingerprint and stop (to compare with a run record).
//   --build         build first (npx electron-vite build), only if the build isn't from this source (build.mjs).
//   --packaged      include the installer's suites (need npm run dist); --no-progress: don't report to Hive.
// Needs a dev build. A suite fails when it exits non-zero or prints a line starting with FAIL. Each suite gets its own
// Agent API port (HIVE_E2E_PORT, read through lib.port()), so suites can run side by side.
// Run in a Hive agent's session, it shows in that Hive's Progress panel, one step per suite (../progressReport.mts).
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { e2eProgress } from '../progressReport.mts'
import { SUITES } from './suites.mjs'
import { affectedSuites, changedFiles } from './affected.mjs'
import { fingerprint, recordMarkdown } from './record.mjs'
import { parseArgs, recordStatus, selectSuites } from './runner.mjs'
import { ensureBuild } from './build.mjs'

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

// Run from an agent's session, the variables that make it that agent (its Hive, token, project) stay out of the suites
// and the test copies of Hive they start: those have their own profile, port and sessions.
const SESSION_VARS = ['HIVE_API_URL', 'HIVE_API_TOKEN', 'HIVE_API_TOKEN_FILE', 'HIVE_HOOK_TOKEN', 'HIVE_PROJECT', 'HIVE_PROJECT_PATH', 'HIVE_WORKSPACE', 'HIVE_RUN_ID', 'HIVE_SESSION_ID', 'HIVE_AGENT', 'HIVE_PROVIDER', 'HIVE_PROGRESS_DATA']
/** A suite's environment; side by side, its own Agent API port (suites read it with lib.port(), or inherit it). */
const suiteEnv = (port) => {
  const env = { HIVE_TEST_TIPS: 'off', ...process.env }
  for (const k of SESSION_VARS) delete env[k]
  // A suite run one at a time uses its own port, never one inherited from a runner that started this one.
  delete env.HIVE_E2E_PORT
  delete env.HIVE_API_PORT
  if (port) {
    env.HIVE_E2E_PORT = String(port)
    env.HIVE_API_PORT = String(port)
  }
  return env
}

const run = (name, port) =>
  new Promise((resolve) => {
    const started = Date.now()
    // No tip card over what a suite clicks, unless its profile turns tips on (tips does).
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: suiteEnv(port) })
    let out = ''
    const add = (d) => (out += d)
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => child.kill(), 10 * 60_000)
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

// Each run keeps its own logs (logs/run-<date>-<time>), so a later run never overwrites a failure's; the last ten are kept.
const logsRoot = join(lib.WORK, 'logs')
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const logDir = join(logsRoot, `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`)
mkdirSync(logDir, { recursive: true })
for (const old of readdirSync(logsRoot).filter((d) => /^run-\d{8}-\d{6}$/.test(d)).sort().slice(0, -10)) rmSync(join(logsRoot, old), { recursive: true, force: true })
const results = []
const startedAt = Date.now()
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
const progress = e2eProgress([...sideBySide, ...cliLane, ...last].map((s) => s.name), args)
let finished = 0
const running = new Set()
const report = () => progress.suite(finished, [...running].join(', '))

function finish(s, r) {
  finished++
  running.delete(s.name)
  progress.done(s.name, r.seconds * 1000, r.ok)
  writeFileSync(join(logDir, `${s.name}.log`), r.out)
  console.log(`${s.name.padEnd(22)}${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? '' : `  (exit ${r.code}${r.failed.length ? `; ${r.failed.length} failed check${r.failed.length === 1 ? '' : 's'}` : ''})`}`)
  for (const f of r.failed) console.log(`    ${f.trim()}`)
  // A failure with no FAIL line (an exception, a timeout): its last lines say why.
  if (!r.ok && !r.failed.length) for (const line of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(-5)) console.log(`    | ${line.trim().slice(0, 200)}`)
  results.push(r)
  report()
}

/** Runs suites one after another (skipping those that can't run here), each with this port (null: its own). */
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

// Each slot has its own port, clear of the installed and dev Hives' (47821, 47822) and of the suites' own defaults
// (478xx–479xx). The CLI lane takes one of the slots.
// A runner started inside a suite (progressreport runs one in its agent's shell) takes ports well clear of its parent's.
const PORT_BASE = process.env.HIVE_E2E_PORT ? Number(process.env.HIVE_E2E_PORT) + 1000 : 48300
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
await inTurn(last, jobs === 1 ? null : PORT_BASE)

for (const r of results.filter((x) => x.skipped)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
const failed = results.filter((r) => r.ok === false)
const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
const summary = `${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped in ${minutes} min`
console.log(`\n${summary}. Logs: ${logDir}`)
let recordInvalid = false
if (opts.record) {
  // Named for the code as it was when the run started, and only valid if it is still that code, built fresh.
  const ordered = chosen.map((s) => results.find((r) => r.name === s.name)).filter(Boolean)
  const status = recordStatus({ before: codeBefore, after: fingerprint(root), buildStale: stale })
  recordInvalid = !status.valid
  const md = recordMarkdown({ code: codeBefore, when: new Date().toISOString().slice(0, 16).replace('T', ' '), jobs, results: ordered, logDir, summary, problems: status.problems })
  writeFileSync(join(logDir, 'run-record.md'), md)
  // The latest record is also at logs/run-record.md.
  writeFileSync(join(logsRoot, 'run-record.md'), md)
  console.log(`\n${md}\n\n(Saved as ${join(logDir, 'run-record.md')})`)
}
await progress.finish(!failed.length && !recordInvalid, summary)
process.exit(failed.length || recordInvalid ? 1 : 0)
