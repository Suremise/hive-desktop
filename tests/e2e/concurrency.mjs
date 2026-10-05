// Runners at the same time share nothing (#203), and heavy runs queue (#204):
//   npm run e2e:concurrency [-- --repeat N] [--keep] [--heavy]
//
// Starts four test runs at once from two worktrees, with both dev builds made stale first: in this worktree an e2e
// runner and a scenario run, and in a second worktree (a git worktree of this one's HEAD with its uncommitted changes,
// made for the check and removed after unless --keep) two e2e runners. One run in each worktree is started with the
// environment of an agent's shell inside an outer hive-progress (NO_COLOR, HIVE_PROGRESS_WRAPPED, a Hive Agent API
// token…) and a shell's git and Node settings pointing elsewhere (GIT_DIR and GIT_WORK_TREE at a decoy repository,
// NODE_OPTIONS loading a script that notes each Node process it starts in), the other with a plain one; the checker's
// own environment points git at the decoy too, for its own setup (#208). Checked, each round: every run passes; each
// holds a lane of its own (its own ports and folders) and its own logs folder; each worktree's build is made once (the
// build lock), stamped as its source; no build lock is left held; each e2e run's record names its own worktree's code;
// and the decoy is untouched and no Node process but the runners themselves got the NODE_OPTIONS (#208). --repeat N
// runs N rounds, stopping at the first that fails.
//
// --heavy checks the machine-wide limit on heavy runs instead (slots.mjs), in a pool of slots of its own (so real runs
// on the machine neither wait for it nor make it wait): three heavy runs (a repeat) started at once from three
// worktrees with two slots. Checked: two run and the third waits, saying so (and in the Progress panel, through a
// stand-in for Hive's Agent API), then starts when a slot is let go; no more than two hold slots at any moment; all
// pass; a run with --no-wait while the slots are taken fails at once, saying who holds them; the slot of a run that
// is killed is taken by the next run without waiting; and with the only slot held by a parent run, a heavy scenario run
// started inside its suite runs without asking for one (even with --no-wait), while the same run at the top level is
// refused (#211).
import { execFileSync, spawn, spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { BUILD_LOCKS, buildInputs, buildLock, buildStamp } from './build.mjs'
import { trySlot } from './slots.mjs'
import { fingerprint } from './record.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const runContext = createRequire(import.meta.url)('./runContext.cjs')

const argv = process.argv.slice(2)
const repeat = Math.max(1, Number(argv[argv.indexOf('--repeat') + 1]) || 1)
const keep = argv.includes('--keep')
const heavy = argv.includes('--heavy')
/** The small fake set each e2e runner runs, and the scenario. */
const SUITES = ['isolation', 'about', 'bridgereport', 'busy']
const SCENARIO = 'work-on-card'
/** An agent's shell in Hive running the tests through hive-progress, and a person's own settings. */
const AGENT_SHELL = {
  NO_COLOR: '1',
  FORCE_COLOR: '1',
  HIVE_PROGRESS_WRAPPED: '1',
  HIVE_PROGRESS_RUN_AS_NODE: '1',
  HIVE_PROGRESS_DATA: join(runContext.TEST_ROOT, 'concurrency', 'leaked-progress'),
  HIVE_API_URL: 'http://127.0.0.1:9',
  HIVE_API_TOKEN: 'leaked-token',
  HIVE_PROJECT: 'hive',
  CLAUDE_CONFIG_DIR: join(runContext.TEST_ROOT, 'concurrency', 'leaked-claude'),
  ELECTRON_RUN_AS_NODE: '1',
  HIVE_TEST_SLOW_IPC: 'tasks:list=1'
}
/**
 * A shell's git and Node settings pointing elsewhere (#208): a decoy repository the runs' git must never use, and a
 * script NODE_OPTIONS loads into every Node process started with it, noting which: only the runners themselves, never
 * a build, suite or other child, may have it.
 */
const DECOY = join(runContext.TEST_ROOT, 'concurrency', `decoy-${process.pid}`)
const NODE_SEEN = join(DECOY, '..', `node-options-${process.pid}.log`)
const NODE_MARKER = join(DECOY, '..', `node-options-${process.pid}.cjs`)
const SHELL_ELSEWHERE = { GIT_DIR: join(DECOY, '.git'), GIT_WORK_TREE: DECOY, NODE_OPTIONS: `--require "${NODE_MARKER.replaceAll('\\', '/')}"` }

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every child of the checker's own gets the allowlisted environment (runContext.baseEnv): git works in cwd's repository.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: runContext.baseEnv() })

/** The decoy repository (one commit) and the NODE_OPTIONS script, made before the checker's own environment points at them. */
function makeDecoy() {
  rmSync(DECOY, { recursive: true, force: true })
  mkdirSync(DECOY, { recursive: true })
  writeFileSync(join(DECOY, 'decoy.txt'), 'not the code under test\n')
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'decoy']]) git(DECOY, ...a)
  writeFileSync(NODE_MARKER, `require('fs').appendFileSync(${JSON.stringify(NODE_SEEN)}, JSON.stringify(process.argv.slice(1)) + '\\n')\n`)
  rmSync(NODE_SEEN, { force: true })
  return git(DECOY, 'rev-parse', 'HEAD').trim()
}


/** Another worktree (name): this one's HEAD and uncommitted changes, sharing its node_modules (a junction). */
function otherWorktree(name = 'worktree') {
  const wt = join(runContext.TEST_ROOT, 'concurrency', name)
  removeWorktree(wt)
  mkdirSync(dirname(wt), { recursive: true })
  git(root, 'worktree', 'add', '--detach', '--force', wt, 'HEAD')
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, maxBuffer: 256 * 1024 * 1024, env: runContext.baseEnv() })
  if (diff.length) execFileSync('git', ['apply', '--whitespace=nowarn'], { cwd: wt, input: diff, env: runContext.baseEnv() })
  for (const f of git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(wt, f)), { recursive: true })
    copyFileSync(join(root, f), join(wt, f))
  }
  spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(wt, 'node_modules'), join(root, 'node_modules')], { stdio: 'ignore', env: runContext.baseEnv() })
  if (!existsSync(join(wt, 'node_modules', 'electron'))) throw new Error(`Couldn't link node_modules into ${wt}`)
  return wt
}

/** Removes the second worktree: its node_modules junction first (only the link: rmdir never follows it), then the rest. */
function removeWorktree(wt) {
  if (existsSync(join(wt, 'node_modules'))) spawnSync('cmd.exe', ['/c', 'rmdir', join(wt, 'node_modules')], { stdio: 'ignore', env: runContext.baseEnv() })
  if (existsSync(join(wt, 'node_modules'))) throw new Error(`Couldn't remove the node_modules link in ${wt}; remove it by hand (rmdir, not a recursive delete)`)
  spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root, stdio: 'ignore', env: runContext.baseEnv() })
  rmSync(wt, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore', env: runContext.baseEnv() })
}

/** Starts a run: { name, cwd, args, polluted, env } → { name, cwd, code, out, ms }; started(child) when it starts. */
function start({ name, cwd, script, args, polluted, env: extra = {}, started = () => {} }) {
  const env = { ...runContext.childEnv(), ...(polluted ? { ...AGENT_SHELL, ...SHELL_ELSEWHERE } : {}), ...extra }
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(cwd, script), ...args], { cwd, env })
    started(p)
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ name, cwd, script, code, out, polluted, ms: Date.now() - t0 }))
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Waits until fn() is true, checking every 100 ms, up to ms; returns whether it was. */
async function until(fn, ms) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (fn()) return true
  return false
}

async function round(k, wt, decoyHead) {
  console.log(`\n--- Round ${k} of ${repeat}`)
  // Both builds stale: each worktree's runners find it so at the same time.
  for (const w of [root, wt]) rmSync(join(w, 'out', '.e2e-build.json'), { force: true })
  rmSync(NODE_SEEN, { force: true })
  const e2e = ['tests/e2e/run.mjs', [...SUITES, '--build', '--record', '--no-progress']]
  const runs = await Promise.all([
    start({ name: 'this worktree, e2e (agent shell)', cwd: root, script: e2e[0], args: e2e[1], polluted: true }),
    start({ name: 'this worktree, scenario (plain)', cwd: root, script: 'tests/scenarios/run.mjs', args: ['--only', SCENARIO], polluted: false }),
    start({ name: 'second worktree, e2e (plain)', cwd: wt, script: e2e[0], args: e2e[1], polluted: false }),
    start({ name: 'second worktree, e2e (agent shell)', cwd: wt, script: e2e[0], args: e2e[1], polluted: true })
  ])
  for (const r of runs) {
    check(`${r.name}: passes`, r.code === 0, `exit ${r.code}\n${r.out.split(/\r?\n/).filter((l) => /FAIL|ERROR|Error|failed/.test(l)).slice(0, 12).join('\n')}`)
    r.lane = /Lane (\d+):/.exec(r.out)?.[1]
    r.logs = /Logs: (.+)$/m.exec(r.out)?.[1]?.trim() ?? null
    r.folders = /suites' folders: (.+)$|folders in (.+)$/m.exec(r.out)?.slice(1).find(Boolean)?.trim() ?? null
    r.ports = /ports (\d+)–(\d+)|Agent API port (\d+)/.exec(r.out)?.slice(1).filter(Boolean).map(Number) ?? []
  }
  const lanes = runs.map((r) => r.lane)
  check('each run holds a lane of its own', lanes.every((l) => l !== undefined) && new Set(lanes).size === runs.length, lanes.join(', '))
  const folders = runs.map((r) => r.folders)
  check('…and so folders of its own', folders.every(Boolean) && new Set(folders.map((f) => f.toLowerCase())).size === runs.length, folders.join(' | '))
  const spans = runs.map((r) => [r.ports[0], r.ports.at(-1)])
  const overlap = spans.some(([a, b], i) => spans.some(([c, d], j) => i !== j && a <= d && c <= b))
  check('…and ports no other run uses', spans.every(([a]) => a) && !overlap, JSON.stringify(spans))
  const logs = runs.filter((r) => r.logs).map((r) => r.logs.toLowerCase())
  check('each e2e run keeps its own logs folder', logs.length === 3 && new Set(logs).size === 3, logs.join(' | '))
  for (const [w, label] of [[root, 'this worktree'], [wt, 'the second worktree']]) {
    const inIt = runs.filter((r) => r.cwd === w)
    const builds = inIt.reduce((n, r) => n + (r.out.match(/^Building \(the dev build/gm)?.length ?? 0), 0)
    check(`${label}: built once by its two runs at the same time`, builds === 1, `${builds} builds`)
    check(`${label}: its build is stamped as its source`, buildStamp(w) === buildInputs(w))
    check(`${label}: no build lock left held`, !existsSync(buildLock(w).folder))
    // The record's code is this worktree's (with GIT_DIR leaked, it would be the decoy's commit).
    const code = fingerprint(w)
    for (const r of inIt.filter((x) => x.script === e2e[0])) check(`${r.name}: its record names this worktree's code`, r.out.includes(`code \`${code}\``), /code `[^`]+`/.exec(r.out)?.[0] ?? 'no record')
  }
  // The decoy: same commit, nothing added, changed or registered as a worktree; and NODE_OPTIONS only in the runners.
  const decoyStatus = git(DECOY, 'status', '--porcelain', '--ignored').trim()
  const decoyClean = git(DECOY, 'rev-parse', 'HEAD').trim() === decoyHead && !decoyStatus && git(DECOY, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length === 1
  check("no run's git used the shell's GIT_DIR/GIT_WORK_TREE (the decoy is untouched)", decoyClean, decoyStatus)
  const seen = existsSync(NODE_SEEN) ? readFileSync(NODE_SEEN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)[0] ?? '') : []
  const others = seen.filter((f) => !/[\\/]tests[\\/]e2e[\\/]run\.mjs$/.test(f))
  check('NODE_OPTIONS reached the polluted runners and no Node process they started', seen.length === 2 && !others.length, `${seen.length} started with it: ${others.join(', ')}`)
}

/** The heavy-run queue (--heavy): see the top of this file. */
async function heavyRound(k, worktrees) {
  console.log(`\n--- Round ${k} of ${repeat} (heavy runs)`)
  const pool = join(runContext.TEST_ROOT, 'concurrency', 'heavy-slots')
  rmSync(pool, { recursive: true, force: true })
  // A stand-in for Hive's Agent API: the runs report their progress to it.
  const reports = []
  const api = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      reports.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : {} })
      res.setHeader('Content-Type', 'application/json')
      res.end(req.method === 'POST' && req.url === '/v1/progress' ? JSON.stringify({ id: `r${reports.length}` }) : '{}')
    })
  })
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  const env = { HIVE_TEST_HEAVY_DIR: pool, HIVE_TEST_HEAVY_SLOTS: '2', HIVE_API_URL: `http://127.0.0.1:${api.address().port}`, HIVE_API_TOKEN: 'agent-token' }
  const slots = () => (existsSync(pool) ? readdirSync(pool).filter((f) => /^slot-\d+\.json$/.test(f)).length : 0)
  const waiting = () => (existsSync(pool) ? readdirSync(pool).filter((f) => f.startsWith('wait-')).length : 0)
  // Heavy by repeating: two quick suites, twice.
  const args = ['isolation', 'about', '--repeat', '2', '--build']
  let most = 0
  const watch = setInterval(() => (most = Math.max(most, slots())), 50)
  try {
    const runs = Promise.all(worktrees.map((w, i) => start({ name: `worktree ${i + 1}, heavy e2e`, cwd: w, script: 'tests/e2e/run.mjs', args, env })))
    // While two hold the slots and one waits: a run with --no-wait fails at once.
    const queued = await until(() => slots() === 2 && waiting() === 1, 120_000)
    check('two heavy runs hold the slots and the third waits', queued, `slots ${slots()}, waiting ${waiting()}`)
    const refused = await start({ name: '--no-wait', cwd: root, script: 'tests/e2e/run.mjs', args: [...args.slice(0, -1), '--no-wait'], env })
    check('a run with --no-wait fails at once, saying who holds the slots', refused.code === 2 && /No test slot free \(--no-wait\).*held by .*e2e: 2 suites × 2/.test(refused.out) && refused.ms < 15_000, `exit ${refused.code} in ${refused.ms} ms: ${refused.out.trim().split('\n').at(-1)}`)
    const done = await runs
    for (const r of done) check(`${r.name}: passes`, r.code === 0, `exit ${r.code}\n${r.out.split(/\r?\n/).filter((l) => /FAIL|ERROR|Error|failed/.test(l)).slice(0, 12).join('\n')}`)
    check('never more than two at once', most === 2, `${most} at once`)
    const waited = done.filter((r) => /^Waiting for a test slot \(2 heavy runs at once/m.test(r.out))
    check('one run waited, saying who held the slots, and started once one was let go', waited.length === 1 && /held by .*e2e: 2 suites × 2 in /.test(waited[0].out) && /^Got a test slot after \d+ s/m.test(waited[0].out), done.map((r) => r.out.split('\n').filter((l) => /test slot/.test(l)).join(' / ')).join(' | '))
    // The stand-in gives each run the id r<n>, n its place among the requests.
    const row = reports.findIndex((x) => x.method === 'POST' && x.url === '/v1/progress' && x.body.title === 'e2e: waiting for a test slot')
    const id = `r${row + 1}`
    const named = reports.some((x) => x.method === 'PATCH' && x.url === `/v1/progress/${id}` && /waiting for a test slot: .*e2e: 2 suites × 2/.test(x.body.stepName ?? ''))
    const ended = reports.some((x) => x.url === `/v1/progress/${id}/finish` && x.body.ok === true && /got a test slot after/.test(x.body.summary ?? ''))
    check('…and showed in the Progress panel as waiting, naming who held the slots, until it got one', row >= 0 && named && ended, JSON.stringify(reports.filter((x) => /waiting|slot/.test(JSON.stringify(x.body))).slice(0, 4)))
    check('every slot is let go at the end', slots() === 0 && waiting() === 0, readdirSync(pool).join(', '))

    // A run killed while it holds a slot: with one slot, the next run takes it without waiting.
    let child
    const killed = start({ name: 'killed', cwd: root, script: 'tests/e2e/run.mjs', args, env: { ...env, HIVE_TEST_HEAVY_SLOTS: '1' }, started: (p) => (child = p) })
    const held = await until(() => slots() === 1, 60_000)
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', env: runContext.baseEnv() })
    await killed
    const next = await start({ name: 'after a killed run', cwd: root, script: 'tests/e2e/run.mjs', args, env: { ...env, HIVE_TEST_HEAVY_SLOTS: '1' } })
    check("a killed run's slot is taken by the next run without waiting", held && next.code === 0 && !/Waiting for a test slot/.test(next.out), `held ${held}, exit ${next.code}`)

    // A heavy scenario run inside a suite (#211): its parent (this checker, standing in for an e2e run) holds the only slot.
    const parent = await trySlot(pool, { slots: 1, what: 'the parent e2e run', root })
    try {
      const one = { ...env, HIVE_TEST_HEAVY_SLOTS: '1' }
      const scenarios = ['--repeat', '2', '--only', SCENARIO, '--no-wait', '--no-progress']
      // What a suite's agent shell keeps of its run context (E2E_RUN_*).
      const inSuite = { ...one, E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: join(pool, 'parent-run'), E2E_RUN_PORT: '47950' }
      const nested = await start({ name: 'nested heavy scenarios', cwd: root, script: 'tests/scenarios/run.mjs', args: scenarios, env: inSuite })
      check('a heavy scenario run inside a suite runs without a slot while its parent holds the only one, even with --no-wait', parent.slot === 0 && nested.code === 0 && !/test slot/i.test(nested.out), `parent slot ${parent.slot}, exit ${nested.code}: ${nested.out.trim().split('\n').slice(-3).join(' / ')}`)
      const top = await start({ name: 'top-level heavy scenarios', cwd: root, script: 'tests/scenarios/run.mjs', args: scenarios, env: one })
      check('…while the same run at the top level is refused, naming the holder', top.code === 2 && /No test slot free \(--no-wait\).*held by the parent e2e run/.test(top.out) && top.ms < 15_000, `exit ${top.code} in ${top.ms} ms: ${top.out.trim().split('\n').at(-1)}`)
    } finally {
      rmSync(join(pool, `slot-${parent.slot}.json`), { force: true })
    }
  } finally {
    clearInterval(watch)
    api.close()
  }
}

const made = []
let decoyHead = null
try {
  if (!heavy) {
    decoyHead = makeDecoy()
    // The checker's own children too (its worktree setup and clean-up, the fingerprints it checks): none may follow it.
    Object.assign(process.env, { GIT_DIR: SHELL_ELSEWHERE.GIT_DIR, GIT_WORK_TREE: SHELL_ELSEWHERE.GIT_WORK_TREE })
  }
  if (heavy) {
    made.push(otherWorktree('worktree'), otherWorktree('worktree-3'))
    console.log(`Other worktrees: ${made.join(', ')}`)
  } else {
    made.push(otherWorktree())
    console.log(`Second worktree: ${made[0]}\nBuild locks: ${BUILD_LOCKS}`)
  }
  for (let k = 1; k <= repeat; k++) {
    if (heavy) await heavyRound(k, [root, ...made])
    else await round(k, made[0], decoyHead)
    if (failed) {
      if (k < repeat) console.log(`\nRound ${k} failed: stopping here.`)
      break
    }
  }
} catch (e) {
  check('the check ran', false, e.stack ?? String(e))
} finally {
  if (!keep) for (const w of made) removeWorktree(w)
  if (!keep) for (const f of [DECOY, NODE_SEEN, NODE_MARKER]) rmSync(f, { recursive: true, force: true })
}
check("this worktree's node_modules is untouched", existsSync(join(root, 'node_modules', 'electron')) && readdirSync(join(root, 'node_modules')).length > 50)
console.log(failed ? `\n${failed} failed` : `\nAll passed (${repeat} round${repeat === 1 ? '' : 's'}).`)
process.exit(failed ? 1 : 0)
