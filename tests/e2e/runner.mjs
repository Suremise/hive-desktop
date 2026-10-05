// The e2e runner's decisions, kept pure so tests/e2esuites.test.ts can check them without running suites: what the
// command line asks for (parseArgs), which suites that is (selectSuites), and whether a run record can be trusted
// (recordStatus). run.mjs does the running.

const VALUE_FLAGS = ['--jobs', '--affected', '--repeat']
const PLAIN_FLAGS = ['--all', '--real', '--only-real', '--record', '--fingerprint', '--build', '--packaged', '--no-progress']

/** Whether a suite starts a real CLI (Claude Code, or Codex in its test home): the real tier, opt-in with --real. */
export const isRealCli = (s) => (s.needs ?? []).some((n) => n === 'claude' || n === 'codex')

/**
 * The command line: { jobs, all, affected (a base, or null), named, tier, record, fingerprint, build, packaged } or
 * { error }. tier: 'fake' (default: no real-CLI suite unless named or, with --affected, needed), 'real' (--real: the
 * real tier too) or 'only' (--only-real). A flag's value is taken only when it really is one: --jobs takes a number;
 * --affected takes a base only if the next word is neither a flag nor a suite name (so `--affected board` means board,
 * plus what changed since main). Every suite name given is kept.
 */
export function parseArgs(argv, suiteNames) {
  const o = { jobs: 4, repeat: 1, all: false, affected: null, named: [], tier: 'fake', record: false, fingerprint: false, build: false, packaged: false }
  const tiers = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--jobs') {
      const n = Number(next)
      if (!next || !Number.isInteger(n) || n < 1) return { error: '--jobs needs a whole number of suites to run at once (1 runs them one after another)' }
      o.jobs = Math.min(8, n)
      i++
    } else if (a === '--repeat') {
      const n = Number(next)
      if (!next || !Number.isInteger(n) || n < 1) return { error: '--repeat needs a whole number of runs (1 or more)' }
      o.repeat = n
      i++
    } else if (a === '--affected') {
      const isBase = next !== undefined && !next.startsWith('--') && !suiteNames.includes(next)
      o.affected = isBase ? next : 'main'
      if (isBase) i++
    } else if (a.startsWith('--')) {
      if (!PLAIN_FLAGS.includes(a) && !VALUE_FLAGS.includes(a)) return { error: `Unknown option ${a}` }
      if (a === '--all') o.all = true
      if (a === '--real') tiers.add('real')
      if (a === '--only-real') tiers.add('only')
      if (a === '--record') o.record = true
      if (a === '--fingerprint') o.fingerprint = true
      if (a === '--build') o.build = true
      if (a === '--packaged') o.packaged = true
    } else {
      o.named.push(a)
    }
  }
  const unknown = o.named.filter((n) => !suiteNames.includes(n))
  if (unknown.length) return { error: `Unknown suite(s): ${unknown.join(', ')}` }
  if (o.all && o.affected) return { error: '--all runs every suite and --affected only some: use one of them' }
  if (tiers.size > 1) return { error: '--real adds the real tier and --only-real runs only it: use one of them' }
  o.tier = [...tiers][0] ?? 'fake'
  if (o.named.some((n) => n.startsWith('packaged'))) o.packaged = true
  return o
}

/**
 * The suites to run, in suites.mjs order. Suites named always run. The full set (--all, or nothing named and no
 * --affected) is the fake tier: every suite that starts no real CLI. With --affected, the suites the changes need
 * (affected: { suites } or { all, real }: every fake suite plus the real ones it names). tier 'real' (--real) adds every
 * real-CLI suite; 'only' (--only-real) keeps only those. Installer suites only with packaged.
 */
export function selectSuites(suites, { all, named, packaged, tier = 'fake' }, affected = null) {
  // With --affected, nothing needed and nothing named means none (not every suite).
  const everything = all || (!affected && !named.length)
  const wanted = (s) => {
    const real = isRealCli(s)
    if (named.includes(s.name)) return true
    if (tier === 'only' && !real) return false
    if (real && tier === 'real') return true
    if (everything) return !real || tier === 'only'
    if (affected?.all) return !real || (affected.real ?? []).includes(s.name)
    return !!affected && affected.suites.includes(s.name)
  }
  return suites.filter((s) => wanted(s) && (packaged || !(s.needs ?? []).includes('packaged')))
}

/** The real-CLI suites a run leaves out (listed in its output and record as not run, so the tier is never silent). */
export const realNotRun = (suites, chosen) => suites.filter((s) => isRealCli(s) && !chosen.includes(s))

/**
 * A finished suite's result from its exit code and output: { ok, failed } (failed: its FAIL lines), or { skipped } when
 * it skipped itself: a `SKIPPED <why>` line and a clean exit, from lib.skip (no failure) or from lib.cliStep, when a step
 * that waits on the real CLI failed because of the environment (usage or rate limit, sign-in, network: `environment: …`).
 * cliStep says how many failed checks it put down to that (`SKIPPED-FAILS n`); a FAIL line beyond those (a check
 * before the step, a page error) keeps the suite a FAIL. An `ENVIRONMENT` line alone never makes a skip.
 */
export function suiteOutcome({ code, out }) {
  const lines = out.split(/\r?\n/)
  const failed = lines.filter((l) => /^\s*FAIL/.test(l))
  const ok = code === 0 && !failed.length
  const said = (tag) => lines.map((l) => new RegExp(`^${tag} (.+)$`).exec(l.trim())?.[1]).find(Boolean) ?? null
  const self = said('SKIPPED')
  const explained = Number(said('SKIPPED-FAILS') ?? 0)
  if (code === 0 && self && failed.length <= explained) return { skipped: self, environment: self.startsWith('environment:') }
  return { ok, failed }
}

/**
 * Whether a run record can be trusted for the code it names: the code didn't change while the suites ran (same
 * fingerprint before and after), and the dev build wasn't older than the source. Returns { valid, problems }.
 */
/**
 * The suite this runner was started inside, or null: the runner marks each suite's environment (E2E_RUN_SUITE, and
 * HIVE_E2E_PORT), and E2E_RUN_SUITE survives into the sessions of the Hive a suite starts, which drop HIVE_ variables.
 */
export function parentSuite(env = process.env) {
  if (!env.E2E_RUN_SUITE && !env.HIVE_E2E_PORT) return null
  const port = Number(env.E2E_RUN_PORT || env.HIVE_E2E_PORT) || null
  return { name: env.E2E_RUN_SUITE ?? null, port }
}

/**
 * The first port the runner's slots use: its lane's (lanes.mjs), or 1000 above the parent suite's port for a runner
 * inside a suite (which claims no lane).
 */
export function portBase(env = process.env, laneBase = 47940) {
  const parent = parentSuite(env)
  return parent ? (parent.port ?? laneBase) + 1000 : laneBase
}

/**
 * A repeat's record (--repeat N): valid only if all N runs ran and passed, on the same code from the first run's start to
 * the last one's end, with a build from that code. A repeat stops at its first failed run, so a later pass never makes up
 * for it. With one run, a failed suite shows in the record but doesn't make it invalid (it is still a true record).
 */
export function repeatStatus({ repeat, runs, before, after, buildStale }) {
  const { problems } = recordStatus({ before, after, buildStale })
  if (repeat > 1) {
    const failedAt = runs.findIndex((r) => !r.ok)
    if (failedAt >= 0) problems.unshift(failedAt + 1 < repeat ? `stopped after run ${failedAt + 1} of ${repeat} failed` : `run ${repeat} of ${repeat} failed`)
    else if (runs.length < repeat) problems.unshift(`only ${runs.length} of ${repeat} runs ran`)
  }
  return { valid: !problems.length, problems }
}

export function recordStatus({ before, after, buildStale }) {
  const problems = []
  if (before !== after) problems.push(`the code changed while the suites ran (${before} at the start, ${after} at the end): these results are for neither, run them again`)
  if (buildStale) problems.push("the dev build isn't known to be from this source, so the suites may have tested other code: run with --build")
  return { valid: !problems.length, problems }
}
