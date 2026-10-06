// Runs Hive's end-to-end suites: npm run e2e [suite…] [options]. See tests/e2e/README.md.
//   --jobs N        how many suites run at once (default 4; 1 runs them one after another). Suites that start a real
//                   CLI run one at a time in a lane of their own beside the others; those marked serial in suites.mjs
//                   (and the installer's) run last, alone.
//   --affected [B]  the suites the changes since branch B (default main) need, uncommitted ones included
//                   (affected.mjs), plus any suites named. B is taken only if it isn't a suite name.
//   --all           the full set before a merge to main (not with --affected): every suite that starts no real CLI (the
//                   fake tier). The real-CLI suites (needs claude/codex in suites.mjs) are listed as not run.
//   --real          the real tier too: every suite that starts the real Claude Code or Codex (--all --real: everything).
//   --only-real     only the real tier (with --affected, only the real suites the changes need). A step of a real suite
//                   that waits on the CLI (lib.cliStep) and fails because of the machine (usage or rate limit, sign-in,
//                   network, in that step's session) makes the suite a SKIP with the reason, not a FAIL; a CLI that isn't
//                   installed or signed in skips its suites.
//   --record        print and save a run record (the code's fingerprint, each suite's result) for a card comment. The
//                   record is marked not valid, and the run fails, if the code changed while the suites ran or the
//                   build isn't known to be from this source (build.mjs).
//   --repeat N      run the suites N times, stopping at the first run that fails; with --record, one record for all
//                   of them, valid only if every run passed. For changes that could make tests flaky.
//   --fingerprint   print the code's fingerprint and stop (to compare with a run record).
//   --build         build first (npx electron-vite build), only if the build isn't from this source (build.mjs).
//   --packaged      include the installer's suites (need npm run dist); --no-progress: don't report to Hive.
//   --no-wait       a heavy run (more than 5 suites, or --repeat) fails at once when every test slot on this machine is
//                   taken, instead of waiting for one (slots.mjs; HIVE_TEST_HEAVY_SLOTS, default 2).
// Needs a dev build. A suite fails when it exits non-zero or prints a line starting with FAIL. Each suite gets its own
// Agent API port (HIVE_E2E_PORT, read through lib.port()), so suites can run side by side; each runner claims a lane
// (lanes.mjs: ports and suite folders of its own), so runners in different worktrees can run at the same time.
// Run in a Hive agent's session, it shows in that Hive's Progress panel, one step per suite (../progressReport.mts).
// Each suite's environment comes from the run context (runContext.cjs): an allowlist and the suite's own folder and
// port, never the environment the runner was started from.
import { spawn, spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { e2eProgress, slotWaitProgress } from '../progressReport.mts'
import { SUITES } from './suites.mjs'
import { affectedSuites, changedFiles } from './affected.mjs'
import { fingerprint, recordMarkdown } from './record.mjs'
import { isRealCli, needsDevBuild, packagedStatus, parentSuite, parseArgs, portBase, realNotRun, repeatStatus, selectSuites, suiteOutcome } from './runner.mjs'
import { devBuild, ensureBuild } from './build.mjs'
import { FAILED_KEEP_MS, finishRunDirs, keepSuiteFiles, logsRootFor, markRunFailed, newRunDir, pruneRunDirs } from './logs.mjs'
import { LANES, claimLane, laneWork } from './lanes.mjs'
import { describeClaim, heavySlots, needsSlot, waitForSlot } from './slots.mjs'
import { autoClean } from './clean.mjs'
import { readUnpackedInfo } from '../../scripts/distCopy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const lib = createRequire(import.meta.url)('./lib.cjs')
const runContext = createRequire(import.meta.url)('./runContext.cjs')
const { clearSuiteDir, evidenceFor, freshFolder } = createRequire(import.meta.url)('./evidence.cjs')

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

// --- Which suites.
let affected = null
if (opts.affected) {
  affected = affectedSuites(changedFiles(opts.affected, root), SUITES.map((s) => s.name), SUITES.filter(isRealCli).map((s) => s.name))
  if (affected.all) console.log(`Affected since ${opts.affected}: every fake suite (${affected.why[0]})${affected.real.length ? `, and the real tier's ${affected.real.join(', ')}` : ''}`)
  else console.log(`Affected since ${opts.affected}: ${affected.suites.length ? affected.suites.join(', ') : 'none'}`)
  for (const w of affected.all ? affected.why.slice(1) : affected.why) console.log(`  ${w}`)
}
const chosen = selectSuites(SUITES, opts, affected)
// The real tier left out of a full or affected run: said, so it is never silent (and in the record).
const notRun = opts.named.length && !opts.all && !opts.affected ? [] : realNotRun(SUITES, chosen)
if (notRun.length) console.log(`Not run: the real tier (add --real): ${notRun.map((s) => s.name).join(', ')}\n`)
if (!chosen.length) {
  console.log(`\nNo suite to run${opts.affected ? ' for these changes' : ''}.`)
  process.exit(0)
}

// --- A heavy run (more than a few suites, or a repeat) waits for a test slot: at most a few go at once on this machine,
// across every worktree (slots.mjs), so runs don't slow each other until tests time out. A runner started inside a
// suite never waits (its parent holds one: needsSlot). --no-wait: fail at once instead.
const nested = !!parentSuite()
if (needsSlot({ count: chosen.length, repeat: opts.repeat })) {
  const what = `e2e: ${chosen.length} suites${opts.repeat > 1 ? ` × ${opts.repeat}` : ''}`
  const queue = slotWaitProgress('e2e', `npm run e2e -- ${args.join(' ')}`.trim(), args)
  let said = ''
  const got = await waitForSlot(runContext.HEAVY_DIR, {
    what,
    root,
    wait: !opts.noWait,
    onWait: ({ holders, ahead }) => {
      const who = holders.map((c) => describeClaim(c)).join('; ')
      const line = `Waiting for a test slot (${heavySlots()} heavy runs at once on this machine, HIVE_TEST_HEAVY_SLOTS)${ahead ? `, ${ahead} ahead of this one` : ''}: held by ${who || 'runs just finishing'}.`
      if (line !== said) console.log(line)
      said = line
      queue.waiting(who)
    }
  })
  if (got.refused) {
    console.error(`No test slot free (--no-wait): ${heavySlots()} heavy runs at once on this machine, held by ${got.refused.holders.map((c) => describeClaim(c)).join('; ')}.`)
    process.exit(2)
  }
  if (said) {
    const after = `${Math.round(got.waitedMs / 1000)} s`
    console.log(`Got a test slot after ${after}.
`)
    await queue.finish(`got a test slot after ${after}`)
  }
}

// The code under test, before anything runs: a run record names it only if it is still the same at the end.
const codeBefore = opts.record ? fingerprint(root) : null

// --- The build: made from the source as it is now (build.mjs), else the suites would test other code. Under the
// worktree's build lock: runners started together build it once.
const runBuild = () => {
  console.log('Building (the dev build is not from this source)…')
  devBuild(root)
}
// Only the installer's suites: they test dist/win-unpacked, not out/ (needsDevBuild), so out/ isn't looked at (#274).
const devBuildNeeded = needsDevBuild(chosen)
let buildCheck = { stale: false, built: false, waited: false, why: null }
try {
  if (devBuildNeeded) buildCheck = ensureBuild({ root, build: opts.build, runBuild })
} catch (e) {
  console.error(e.message)
  process.exit(e.status ?? 2)
}
if (buildCheck.waited) console.log(`Waited for another runner's build of this worktree${buildCheck.built ? '' : ': it is from this source'}.`)
const stale = buildCheck.stale
if (devBuildNeeded && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No dev build: add --build (or run npx electron-vite build first).')
  process.exit(2)
} else if (stale) {
  console.warn(`Warning: ${buildCheck.why}: the suites may test other code. Add --build to build first (only when needed)${opts.record ? '; the run record will say it is not valid' : ''}.\n`)
}
// The installer's suites test dist/win-unpacked: is it from this code? npm run dist records that inside it once it is
// sure what the build was made from (its own record, never dist/build-info.json, which describes the installer set and
// can be copied in from a worktree beside an older win-unpacked: scripts/distCopy.mjs). Looked at again at the end,
// for the record.
const packagedCheck = () => (chosen.some((s) => (s.needs ?? []).includes('packaged')) && existsSync(join(root, 'dist', 'win-unpacked')) ? packagedStatus(readUnpackedInfo(join(root, 'dist')), fingerprint(root)) : null)
const packagedStale = packagedCheck()
if (packagedStale) console.warn(`Warning: ${packagedStale}: the installer's suites may test other code. Run npm run dist first${opts.record ? '; the run record will say it is not valid' : ''}.\n`)

// The runner's lane (lanes.mjs): ports and suite folders no other runner on this machine uses while this one runs, so
// runners started at the same time from different worktrees don't take each other's. A runner started inside a suite
// (progressreport runs one in its agent's shell) claims none: it takes ports well clear of its parent's (portBase).
const lane = nested ? null : await claimLane(runContext.LANES_DIR, { root })
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

/**
 * A suite's environment (runContext.suiteEnv): the allowlist and the test settings passed on by name, nothing else of
 * the runner's (an agent session's HIVE_ variables, HIVE_PROGRESS_*, NO_COLOR…); its lane's folder, and side by side
 * its own Agent API port (suites read it with lib.port(); the test Hives they start get it through lib.hiveEnv). The
 * same said without the HIVE_ prefix (E2E_RUN_*), which Hive keeps in its sessions: a runner started in an agent's
 * shell inside the suite's Hive (progressreport does) knows it is inside a suite, and which port to keep clear of.
 */
const suiteEnv = (name, port, dir) => runContext.suiteEnv({ name, port, work: dir, runDir: dir ?? lib.WORK })
/**
 * What may be deleted (#253, evidence.cjs): never what a card that isn't Done cites, nothing earlier while the board
 * can't be read. Each suite has a folder of its own in the lane's, made fresh when it starts (`<suite>`, or `<suite>-2`…
 * while an earlier one holds evidence). When it passes (or skips), its folders go (profiles, workspaces, test homes:
 * over a gigabyte a lane otherwise), checked against the board as it is then: one a card cites stays, and they all stay
 * while the board can't be read (said at the end). Its files stay (screenshots, reports). When it fails, everything
 * stays for a look, until the suite runs again in this lane or the clean-up's age rule (clean.mjs).
 */
const evidence = evidenceFor(root)

const run = (name, port) =>
  new Promise((resolve) => {
    const started = Date.now()
    const dir = suiteWork ? freshFolder(join(suiteWork, name), evidence) : null
    // No tip card over what a suite clicks, unless its profile turns tips on (tips does).
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: suiteEnv(name, port, dir) })
    let out = ''
    const add = (d) => (out += d)
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    // Out of time: the suite and everything it started. Killing only the suite's node leaves its test copy of Hive running,
    // holding the lane's port, and the lane's next suites can't start their Agent API.
    const timer = setTimeout(() => {
      out += '\nFAIL timed out after 10 minutes: the suite and the processes it started were stopped\n'
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', env: runContext.baseEnv() })
      else child.kill()
    }, 10 * 60_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const outcome = suiteOutcome({ code, out })
      const cleared = dir && (outcome.ok || outcome.skipped) ? clearSuiteDir(dir, evidence) : null
      const kept = dir && outcome.ok === false ? 'it failed' : cleared?.kept.length ? cleared.kept[0] : null
      resolve({ name, ...outcome, code, out, seconds: Math.round((Date.now() - started) / 1000), dir, kept: kept && `${dir} (${kept})` })
    })
  })

/** A CLI's path: on the PATH, or where its installer puts it (Hive looks there too); null when it isn't installed. */
const cliPath = (cmd, places) => {
  const r = spawnSync('where.exe', [cmd], { encoding: 'utf8', env: runContext.baseEnv() })
  return (r.status === 0 && r.stdout.split(/\r?\n/)[0].trim()) || places.find((p) => existsSync(p)) || null
}
const cliInstalled = {
  claude: () => cliPath('claude', [join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')]),
  codex: () => cliPath('codex', [join(process.env.APPDATA || '', 'npm', 'codex.cmd')])
}
/**
 * False only when Claude Code itself says it isn't signed in (`claude auth status --json`); an answer that can't be read
 * counts as signed in, so the suites run and say what is wrong. Asked once a run.
 */
let claudeSignedIn
const claudeLoggedIn = () => {
  if (claudeSignedIn !== undefined) return claudeSignedIn
  // In the environment the suites' Claude Code gets (no CLAUDE_CONFIG_DIR of the runner's), so it asks about the same sign-in.
  const r = spawnSync(cliInstalled.claude(), ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000, env: runContext.childEnv() })
  try {
    claudeSignedIn = JSON.parse(r.stdout).loggedIn !== false
  } catch {
    claudeSignedIn = true
  }
  return claudeSignedIn
}

/** Why a suite can't run here, or null. "environment: …" for the machine's CLIs (the record says so). */
function skipReason(s) {
  const needs = s.needs ?? []
  if (needs.includes('packaged') && !existsSync(join(root, 'dist', 'win-unpacked'))) return 'no dist/win-unpacked (npm run dist)'
  if (needs.includes('claude') && !cliInstalled.claude()) return "environment: Claude Code isn't installed (claude)"
  if (needs.includes('claude') && !claudeLoggedIn()) return "environment: Claude Code isn't signed in (claude auth status)"
  if (needs.includes('codex') && !cliInstalled.codex()) return "environment: Codex isn't installed (codex)"
  if (needs.includes('codex') && !lib.codexSignedIn()) return `environment: Codex isn't signed in to ${lib.CODEX_HOME}`
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
    progress.done(step(k, s.name), r.seconds * 1000, r.ok !== false)
    writeFileSync(join(logDir, `${s.name}.log`), r.out)
    if (r.skipped) console.log(`${s.name.padEnd(22)}SKIP  ${r.seconds}s  (${r.skipped})`)
    else console.log(`${s.name.padEnd(22)}${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? '' : `  (exit ${r.code}${r.failed.length ? `; ${r.failed.length} failed check${r.failed.length === 1 ? '' : 's'}` : ''})`}`)
    for (const f of r.skipped ? [] : r.failed) console.log(`    ${f.trim()}`)
    // A failure with no FAIL line (an exception, a timeout): its last lines say why.
    if (r.ok === false && !r.failed.length) for (const line of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(-5)) console.log(`    | ${line.trim().slice(0, 200)}`)
    if (r.kept && r.ok === false) console.log(`    its profiles and workspaces are kept: ${r.kept}`)
    else if (r.kept) keptAfterPass.push(r.kept)
    results.push(r)
    report()
  }

  /** Runs suites one after another (skipping those that can't run here), each with this port. */
  async function inTurn(list, port) {
    for (const s of list) {
      const why = skipReason(s)
      if (why) {
        finished++
        results.push({ name: s.name, skipped: why, environment: why.startsWith('environment:') })
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

  for (const r of results.filter((x) => x.skipped && x.seconds === undefined)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
  const failed = results.filter((r) => r.ok === false)
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
  const summary = `${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped in ${minutes} min`
  console.log(`\n${repeat > 1 ? `Run ${k} of ${repeat}: ` : ''}${summary}. Logs: ${logDir}`)
  // A failed run outlives KEEP_RUNS for a day, with its failed suites' screenshots (#223): a path a builder cites in a
  // card is still there when the reviewer looks.
  if (failed.length) {
    markRunFailed(logDir, failed.map((r) => r.name).join(', '))
    const copied = failed.filter((r) => r.dir && keepSuiteFiles(r.dir, logDir, r.name) > 0).map((r) => r.name)
    console.log(`It failed: its logs are kept for ${FAILED_KEEP_MS / 3_600_000} hours${copied.length ? `, with the screenshots and files of ${copied.join(', ')} in ${copied.length === 1 ? `${logDir}\\${copied[0]}` : `${logDir}\\<suite>`}` : ''}.`)
  }
  // In the chosen order, for the record.
  const ordered = chosen.map((s) => results.find((r) => r.name === s.name)).filter(Boolean)
  return { ok: !failed.length, results: ordered, logDir, summary }
}

// Passed suites whose folders stayed (a card cites them, or the board couldn't be read): said once at the end, so growth
// while the board can't be read is seen.
const keptAfterPass = []
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
  const status = repeatStatus({ repeat, runs, before: codeBefore, after: fingerprint(root), buildStale: stale, packagedStale: packagedStale ?? packagedCheck() })
  recordInvalid = !status.valid
  // A record that isn't valid: its run is kept as a failed one's (#223).
  if (recordInvalid) markRunFailed(lastRun.logDir, `record not valid: ${status.problems.join('; ')}`)
  const md = recordMarkdown({ code: codeBefore, when: new Date().toISOString().slice(0, 16).replace('T', ' '), jobs, results: lastRun.results, logDir: lastRun.logDir, summary, problems: status.problems, notRun: notRun.map((s) => s.name), runs: repeat > 1 ? Object.assign(runs, { repeat }) : null })
  for (const r of runs) writeFileSync(join(r.logDir, 'run-record.md'), md)
  // The latest record is also at logs/run-record.md.
  writeFileSync(join(logsRoot, 'run-record.md'), md)
  console.log(`\n${md}\n\n(Saved as ${join(lastRun.logDir, 'run-record.md')})`)
}
// This repeat's folders are finished now (its record is saved). Older finished runs go only now, never this repeat's
// own (a repeat of more than ten keeps them all until the next run prunes) or another runner's still going, nor one a
// card cites (evidence.cjs).
finishRunDirs(runs.map((r) => r.logDir))
pruneRunDirs(logsRoot, undefined, runs.map((r) => r.logDir), undefined, (p) => evidence.protects(p))
if (keptAfterPass.length) console.log(`\nKept the folders of ${keptAfterPass.length} passed suite${keptAfterPass.length === 1 ? '' : 's'}: ${keptAfterPass.slice(0, 3).join('; ')}${keptAfterPass.length > 3 ? '; …' : ''}`)
// What tests left in hive-test that is no longer needed (clean.mjs), this lane's included: it is let go first. Not from
// a runner inside a suite (its parent's does it).
if (lane) {
  lane.release()
  await autoClean({ root, ev: evidence })
}
await progress.finish(lastRun.ok && runs.length === repeat && !recordInvalid, summary, opts.record ? join(lastRun.logDir, 'run-record.md') : lastRun.logDir)
process.exit(!lastRun.ok || recordInvalid ? 1 : 0)
