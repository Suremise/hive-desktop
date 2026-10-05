// Runners at the same time share nothing (#203): npm run e2e:concurrency [-- --repeat N] [--keep]
//
// Starts four test runs at once from two worktrees, with both dev builds made stale first: in this worktree an e2e
// runner and a scenario run, and in a second worktree (a git worktree of this one's HEAD with its uncommitted changes,
// made for the check and removed after unless --keep) two e2e runners. One run in each worktree is started with the
// environment of an agent's shell inside an outer hive-progress (NO_COLOR, HIVE_PROGRESS_WRAPPED, a Hive Agent API
// token…), the other with a plain one. Checked, each round: every run passes; each holds a lane of its own (its own
// ports and folders) and its own logs folder; each worktree's build is made once (the build lock), stamped as its
// source; and no build lock is left held. --repeat N runs N rounds, stopping at the first that fails.
import { execFileSync, spawn, spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { BUILD_LOCKS, buildInputs, buildLock, buildStamp } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const runContext = createRequire(import.meta.url)('./runContext.cjs')

const argv = process.argv.slice(2)
const repeat = Math.max(1, Number(argv[argv.indexOf('--repeat') + 1]) || 1)
const keep = argv.includes('--keep')
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

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** The second worktree: this one's HEAD and uncommitted changes, sharing its node_modules (a junction). */
function secondWorktree() {
  const wt = join(runContext.TEST_ROOT, 'concurrency', 'worktree')
  removeWorktree(wt)
  mkdirSync(dirname(wt), { recursive: true })
  git(root, 'worktree', 'add', '--detach', '--force', wt, 'HEAD')
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  if (diff.length) execFileSync('git', ['apply', '--whitespace=nowarn'], { cwd: wt, input: diff })
  for (const f of git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(wt, f)), { recursive: true })
    copyFileSync(join(root, f), join(wt, f))
  }
  spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(wt, 'node_modules'), join(root, 'node_modules')], { stdio: 'ignore' })
  if (!existsSync(join(wt, 'node_modules', 'electron'))) throw new Error(`Couldn't link node_modules into ${wt}`)
  return wt
}

/** Removes the second worktree: its node_modules junction first (only the link: rmdir never follows it), then the rest. */
function removeWorktree(wt) {
  if (existsSync(join(wt, 'node_modules'))) spawnSync('cmd.exe', ['/c', 'rmdir', join(wt, 'node_modules')], { stdio: 'ignore' })
  if (existsSync(join(wt, 'node_modules'))) throw new Error(`Couldn't remove the node_modules link in ${wt}; remove it by hand (rmdir, not a recursive delete)`)
  spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root, stdio: 'ignore' })
  rmSync(wt, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' })
}

/** Starts a run: { name, cwd, args, polluted } → { name, cwd, code, out }. */
function start({ name, cwd, script, args, polluted }) {
  const env = polluted ? { ...runContext.childEnv(), ...AGENT_SHELL } : runContext.childEnv()
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(cwd, script), ...args], { cwd, env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ name, cwd, code, out, polluted }))
  })
}

async function round(k, wt) {
  console.log(`\n--- Round ${k} of ${repeat}`)
  // Both builds stale: each worktree's runners find it so at the same time.
  for (const w of [root, wt]) rmSync(join(w, 'out', '.e2e-build.json'), { force: true })
  const e2e = ['tests/e2e/run.mjs', [...SUITES, '--build', '--no-progress']]
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
  }
}

let wt = null
try {
  wt = secondWorktree()
  console.log(`Second worktree: ${wt}\nBuild locks: ${BUILD_LOCKS}`)
  for (let k = 1; k <= repeat; k++) {
    await round(k, wt)
    if (failed) {
      if (k < repeat) console.log(`
Round ${k} failed: stopping here.`)
      break
    }
  }
} catch (e) {
  check('the check ran', false, e.stack ?? String(e))
} finally {
  if (wt && !keep) removeWorktree(wt)
}
check("this worktree's node_modules is untouched", existsSync(join(root, 'node_modules', 'electron')) && readdirSync(join(root, 'node_modules')).length > 50)
console.log(failed ? `\n${failed} failed` : `\nAll passed (${repeat} round${repeat === 1 ? '' : 's'}).`)
process.exit(failed ? 1 : 0)
