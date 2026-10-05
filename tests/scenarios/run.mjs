// Runs the scenarios (scenarios.cjs) with a provider and writes what happened.
//
//   npm run scenarios                                     # the fake Claude Code: free, deterministic, every check
//   npm run scenarios -- --provider fake-codex            # the fake Codex, the same
//   npm run scenarios -- --provider claude-code --model haiku --budget 2      # model trials (opt-in, cost tokens)
//   npm run scenarios -- --provider codex --model gpt-5.6-luna --only work-on-card,review-card
//
// --budget N (USD, API-equivalent, above 0, default 2) stops a model run once the scenarios so far cost that much, or
// as soon as a trial reports no cost (the spend can't be checked then; --allow-unknown-cost goes on anyway); --only runs
// some; --keep leaves each scenario's profile and workspace; --repeat N runs each N times (samples, for spread);
// --save-baseline NAME keeps this run's benchmark as a named baseline (an older one of that name is kept, not
// overwritten). Results go to %LOCALAPPDATA%\hive-test\scenarios\results (the newest 30 runs are kept): results.json
// (every scenario's checks, skills read, hive calls, versions, usage, measures), benchmark.json (hive-benchmark/1: the
// Performance page compares two) and summary.md. With a fake provider a failed check fails the run (exit 1); model
// trials only report (models vary). A dev build that isn't from the source as it is now (tests/e2e/build.mjs) is rebuilt
// first, so a run (and a baseline) never measures other code.
//
// Runs at the same time (from different worktrees, or the same one) don't share folders or ports: each run claims a
// lane, from the same pool as the e2e runner (tests/e2e/lanes.mjs), and keeps its scenarios' profiles and workspaces in
// %LOCALAPPDATA%\hive-test\scenarios\lanes\<k> (--keep leaves them there) with the lane's first port as their Agent API
// port (#183, #184). Results and baselines stay shared: Performance → Compare reads them.
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureBuild } from '../e2e/build.mjs'
import { LANES, claimLane, laneWork } from '../e2e/lanes.mjs'

const require = createRequire(import.meta.url)
const lib = require('../e2e/lib.cjs')
const { runScenario, sourceFingerprint, claudeSignedIn, CLAUDE_TEST_HOME, PROVIDERS } = require('./harness.cjs')
const { SCENARIOS, FIXTURES_VERSION } = require('./scenarios.cjs')
const { benchmarkOf, pruneResults, saveBaseline, resultsFolder, parseBudget, budgetGate, spendText } = require('./benchmark.cjs')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const provider = arg('provider', 'fake')
const model = arg('model', undefined)
const effort = arg('effort', undefined)
let budget
try {
  budget = parseBudget(arg('budget', '2'))
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const allowUnknownCost = argv.includes('--allow-unknown-cost')
const only = arg('only', '')?.split(',').filter(Boolean)
const keep = argv.includes('--keep')
const repeats = Math.max(1, Math.min(20, Number(arg('repeat', '1')) || 1))
const baselineName = arg('save-baseline', '')
const fake = !!PROVIDERS[provider]?.fake
if (!PROVIDERS[provider]) {
  console.error(`Unknown provider "${provider}": fake, fake-codex, claude-code or codex.`)
  process.exit(2)
}
// Model trials run only in the providers' test homes, signed in once by hand: never the user's own, never a login here.
const notSignedIn =
  provider === 'codex' && !lib.codexSignedIn()
    ? `Codex isn't signed in to its test home (${lib.CODEX_HOME}): see tests/e2e/README.md.`
    : provider === 'claude-code' && !claudeSignedIn()
      ? `Claude Code isn't signed in to its test home (${CLAUDE_TEST_HOME}): see tests/scenarios/README.md.`
      : null
if (notSignedIn) {
  console.log(`SKIP all scenarios: ${notSignedIn}`)
  process.exit(0)
}

const build = ensureBuild({
  root: lib.ROOT,
  build: true,
  runBuild: () => {
    console.log('Building (the dev build is not from this source)…')
    const r = spawnSync('npx electron-vite build', { cwd: lib.ROOT, stdio: 'inherit', shell: true })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
})
if (build.stale) {
  console.error(`The dev build isn't from this source (${build.why}): run the scenarios again once it has stopped changing.`)
  process.exit(2)
}

// This run's lane: its own folders and Agent API port, so another run at the same time can't remove, open or answer
// for this one's test Hive.
const lane = await claimLane(join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'e2e-lanes'), { root: lib.ROOT })
if (!lane) {
  console.error(`Every test lane (${LANES}) is taken by e2e or scenario runs still going: wait for one to finish.`)
  process.exit(2)
}
process.on('exit', lane.release)
process.on('SIGINT', () => process.exit(130))
const workRoot = laneWork(join(lib.WORK, '..', 'scenarios'), lane.lane)
console.log(`Lane ${lane.lane}: Agent API port ${lane.first}, folders in ${workRoot}`)

const chosen = SCENARIOS.filter((s) => !only?.length || only.includes(s.id))
// The source this run tests, taken before it starts (and checked again at the end).
const sourceAtStart = sourceFingerprint()
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const resultsDir = join(lib.WORK, '..', 'scenarios', 'results')
pruneResults(resultsDir, 29)
const out = resultsFolder(resultsDir, `${stamp}-${provider}`)
const results = []
let spent = 0
let unknownCostTrials = 0
// Models of the trials without a cost (the guard names them: usually Hive has no price for one).
const noCostModels = new Set()
for (let sample = 1; sample <= repeats; sample++) {
  for (const sc of chosen) {
    const gate = budgetGate({ fake, budget, spentKnown: spent, unknownCostTrials, allowUnknownCost, noCostModels: [...noCostModels] })
    if (!gate.ok) {
      results.push({ scenario: sc.id, title: sc.title, provider, sample, skipped: gate.reason })
      console.log(`SKIP ${sc.id}: ${gate.reason}`)
      continue
    }
    process.stdout.write(`${sc.id} (${provider}${repeats > 1 ? `, ${sample}/${repeats}` : ''})… `)
    const r = await runScenario(sc, provider, { model, effort, keep, workRoot, port: lane.first, timeoutMs: fake ? 60000 : 360000 })
    r.sample = sample
    // A trial's cost as reported; none reported is unknown (counted), never $0.
    if (typeof r.usage?.costUsd === 'number') spent += r.usage.costUsd
    else if (!fake) {
      unknownCostTrials++
      noCostModels.add(r.usage?.model ?? r.model)
    }
    results.push(r)
    const failed = r.checks.filter((c) => c.ok === false)
    console.log(`${r.error ? `ERROR (${r.error.split('\n')[0]})` : failed.length ? `${failed.length} failed` : 'ok'}, ${r.seconds}s${r.usage?.costUsd ? `, $${r.usage.costUsd.toFixed(3)}` : ''}`)
    for (const c of r.checks) console.log(`  ${c.ok === null ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok === false && c.detail ? ` (${c.detail})` : ''}`)
  }
}

const sourceAtEnd = sourceFingerprint()
const meta = {
  fixturesVersion: FIXTURES_VERSION,
  source: sourceAtStart,
  ...(sourceAtEnd.head !== sourceAtStart.head || sourceAtEnd.dirty !== sourceAtStart.dirty ? { sourceChangedDuringRun: sourceAtEnd } : {}),
  guidance: results.find((r) => r.guidance?.atStart)?.guidance.atStart.revision ?? null,
  provider, model: model ?? '(default)', effort: effort ?? '(default)', mode: PROVIDERS[provider].mode, repeats, budgetUsd: budget, when: new Date().toISOString(), spentUsd: Math.round(spent * 1000) / 1000, unknownCostTrials }
writeFileSync(join(out, 'results.json'), JSON.stringify({ meta, results }, null, 2))
const appVersion = JSON.parse(readFileSync(join(lib.ROOT, 'package.json'), 'utf8')).version
const benchmarkFile = join(out, 'benchmark.json')
writeFileSync(benchmarkFile, JSON.stringify(benchmarkOf(meta, results, appVersion), null, 2))
if (baselineName) console.log(`Baseline "${baselineName}": ${saveBaseline(join(lib.WORK, '..', 'scenarios', 'baselines'), baselineName, benchmarkFile)}`)
/** What Hive's own parts cost in the scenario (its measures): tool reply characters, requests, guidance at launch. */
const hiveCost = (m) => (m ? `${m.toolChars.toLocaleString('en')} chars in ${m.toolCalls} tool calls; ${m.apiRequests} requests; ${(m.coreBytes + m.customBytes + m.roleBytes + m.personaBytes + m.catalogBytes).toLocaleString('en')} B guidance` : 'not measured')
const row = (r) => {
  if (r.skipped) return `| ${r.scenario} | skipped: ${r.skipped} | | | | | |`
  const passed = r.checks.filter((c) => c.ok === true).length
  const failed = r.checks.filter((c) => c.ok === false)
  const skipped = r.checks.filter((c) => c.ok === null).length
  return `| ${r.scenario} | ${r.error ? `error: ${r.error.split('\n')[0]}` : failed.length ? `**${failed.length} failed**: ${failed.map((c) => c.name).join('; ')}` : 'pass'} | ${passed}/${r.checks.length}${skipped ? ` (${skipped} skipped)` : ''} | ${r.observed?.skillsRead.join(', ') || '–'} | ${[...new Set(r.observed?.hiveCalls.map((c) => c.tool) ?? [])].join(', ') || '–'} | ${hiveCost(r.measures)} | ${r.usage?.costUsd != null ? `$${r.usage.costUsd.toFixed(3)}` : '–'}, ${r.seconds}s |`
}
const cli = results.find((r) => r.cliVersion)?.cliVersion ?? 'unknown'
writeFileSync(
  join(out, 'summary.md'),
  [
    `# Scenarios: ${provider}${model ? ` (${model})` : ''}${repeats > 1 ? `, ${repeats} samples each` : ''}`,
    '',
    `Fixtures v${FIXTURES_VERSION}; source ${meta.source.head}${meta.source.dirty ? ` + changes ${meta.source.dirty}` : ''}; guidance ${meta.guidance}; CLI ${cli}; ${meta.when}; spent ${spendText(meta)}.`,
    '',
    '| Scenario | Result | Checks | Skills read | Hive tools | Hive’s cost | Provider cost, time |',
    '|---|---|---|---|---|---|---|',
    ...results.map(row)
  ].join('\n') + '\n'
)
console.log(`\nResults: ${out}`)
const hardFailures = fake ? results.filter((r) => r.error || r.checks?.some((c) => c.ok === false)).length : 0
process.exit(hardFailures ? 1 : 0)
