// A run record (npm run e2e -- <suites> --record): what was tested, on exactly which code, with what result, so a
// reviewer can trust a builder's run instead of repeating it (tests/e2e/README.md, the card-loop skill). The code's
// fingerprint is HEAD plus a hash of every uncommitted change, untracked files included; `--fingerprint` prints the
// current one, to compare with a record's.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import { join, win32 } from 'path'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** Not code under test: builds used to rewrite it with only line-ending changes (fixed by #148), and a checkout without that fix still does. */
const NOT_CODE = ['THIRD_PARTY_NOTICES.md']

/**
 * The code's fingerprint: `<HEAD short>` when the tree is clean, else `<HEAD short>+<hash>` over the uncommitted
 * changes (tracked diffs and untracked files' contents, line endings ignored so a checkout's CRLF doesn't count).
 */
export function fingerprint(root = process.cwd()) {
  // core.safecrlf=false: no "LF will be replaced by CRLF" warnings in the runner's output.
  const git = (...a) => execFileSync('git', ['-c', 'core.safecrlf=false', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: runContext.baseEnv() })
  const head = git('rev-parse', '--short=12', 'HEAD').trim()
  const tracked = git('diff', 'HEAD', '--name-only').split(/\r?\n/).filter(Boolean)
  const untracked = git('ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean)
  const files = [...new Set([...tracked, ...untracked])].filter((f) => !NOT_CODE.includes(f)).sort()
  if (!files.length) return head
  const h = createHash('sha256')
  for (const f of files) {
    h.update(`${f}\0`)
    const p = join(root, f)
    // A deleted file counts as its absence.
    h.update(existsSync(p) ? readFileSync(p).toString('latin1').replace(/\r\n/g, '\n') : '<deleted>')
    h.update('\0')
  }
  return `${head}+${h.digest('hex').slice(0, 12)}`
}

/** The real CLIs a run can use (suites.mjs `needs`): the provider each one is, by its id and name. */
export const REAL_CLIS = { claude: { id: 'claude-code', name: 'Claude Code' }, codex: { id: 'codex', name: 'Codex' }, copilot: { id: 'copilot', name: 'GitHub Copilot' } }

/** The file in a suite's folder where its test copies of Hive note the CLIs they selected (HIVE_TEST_CLI_LOG). */
export const CLI_LOG = 'hive-clis.jsonl'

/**
 * The CLIs a suite's test copies of Hive selected (#365): each provider's executable and version as Hive's own
 * detection chose them (main's noteSelectedCli writes a line per check to HIVE_TEST_CLI_LOG), once each. Not a probe of
 * the runner's: what the suite ran is what Hive picked (a standalone CLI, never an editor extension's copy).
 */
export function readCliLog(text) {
  const seen = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    try {
      const o = JSON.parse(line)
      // The home it ran in (its sign-in and config, #368), when the line says.
      const home = typeof o?.home === 'string' && o.home ? { home: o.home } : {}
      if (typeof o?.provider === 'string' && typeof o?.version === 'string') seen.set(`${o.provider}\0${o.version}\0${o.path ?? ''}\0${home.home ?? ''}`, { provider: o.provider, version: o.version, path: typeof o.path === 'string' ? o.path : null, ...home })
    } catch {
      // Not a line Hive wrote (a partial one): ignored.
    }
  }
  return [...seen.values()]
}

/**
 * The homes each real suite's own CLI ran in (#368), from what its Hive noted: `homes` a line per suite ("claude-real:
 * Claude Code in C:\…\claude-real-claude-home"), and `own` the suites that ran one in the user's own home
 * (%USERPROFILE%\.claude, .codex or .copilot), which no suite may: the record isn't valid then.
 */
export function realCliHomes(results, suites, userProfile = process.env.USERPROFILE ?? '') {
  const homes = []
  const own = []
  // One spelling for one folder, as Windows reads it: either slash, dot segments resolved, no trailing slash, any case.
  const same = (p) => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const userHomes = userProfile ? ['.claude', '.codex', '.copilot'].map((d) => same(win32.join(userProfile, d))) : []
  for (const s of suites) {
    const r = results.find((x) => x.name === s.name)
    if (!r || r.skipped) continue
    for (const need of s.needs ?? []) {
      const cli = REAL_CLIS[need]
      if (!cli) continue
      const used = [...new Set((r.clis ?? []).filter((c) => c.provider === cli.id && c.home).map((c) => c.home))]
      if (!used.length) continue
      homes.push(`${s.name}: ${cli.name} in ${used.join(' and ')}`)
      if (used.some((h) => userHomes.includes(same(h)))) own.push(s.name)
    }
  }
  return { homes, own }
}

/**
 * The versions of each real CLI that the real suites of it ran, from what their Hive selected: { claude: ['2.1.292'] }.
 * More than one means the suites ran different versions.
 */
export function realCliVersions(results, suites) {
  const out = {}
  for (const [need, { id }] of Object.entries(REAL_CLIS)) {
    const names = new Set(suites.filter((s) => (s.needs ?? []).includes(need)).map((s) => s.name))
    const versions = [...new Set(results.filter((r) => names.has(r.name)).flatMap((r) => (r.clis ?? []).filter((c) => c.provider === id).map((c) => c.version)))]
    if (versions.length) out[need] = versions.sort()
  }
  return out
}

/** The real CLIs' versions, in words: "Claude Code 2.1.292, Codex 0.160.1" (several: "Codex 0.160.1 and 0.161.0"). */
const cliLine = (clis) =>
  Object.entries(clis)
    .map(([k, v]) => `${REAL_CLIS[k]?.name ?? k} ${v.join(' and ')}`)
    .join(', ')

/**
 * The record as data (run-record.json beside run-record.md), for scripts: `npm run tested-clis` makes the release's
 * tested-with manifest from it (#365). The code, whether it can be trusted, the real CLIs' versions, each suite's
 * result (the last run's, for a repeat: a valid record had every run pass) with the CLIs its Hive selected.
 */
export function recordJson({ code, when, results, problems = [], notRun = [], clis = {} }) {
  return {
    code,
    when,
    valid: !problems.length,
    problems,
    clis,
    results: results.map((r) => ({ name: r.name, ok: !!r.ok, skipped: r.skipped ?? null, environment: !!r.environment, clis: r.clis ?? [] })),
    notRun
  }
}

/** The record as Markdown, to paste into a card comment: the fingerprint, each suite's result and time, the logs; and
 * first, if it can't be trusted (recordStatus), why. After the table: the real CLIs' versions (clis, when real suites
 * ran), the real tier not run (notRun), and the suites skipped for the environment (a real CLI's usage limit, sign-in,
 * network), which are no result for the code. */
export function recordMarkdown({ code, when, jobs, results, logDir, summary, problems = [], runs = null, notRun = [], clis = {}, homes = [] }) {
  // A skip's reason can quote the CLI: no | to break the table.
  const skippedCell = (r) => `skipped: ${r.skipped.replace(/\|/g, '/')}`
  const cell = (r) => (!r ? '–' : r.skipped ? skippedCell(r) : `${r.ok ? 'pass' : `**FAIL**${r.failed?.length ? ` (${r.failed.length} check${r.failed.length === 1 ? '' : 's'})` : ''}`} ${r.seconds ?? '–'}s`)
  // A record that can't be trusted says so first, so nobody matches its fingerprint by mistake.
  const warning = problems.length ? [`**Not valid — don't trust this record:** ${problems.join('; ')}.`, ''] : []
  const head = `**e2e run record** · code \`${code}\` · ${when} · ${jobs > 1 ? `${jobs} at a time` : 'one at a time'}`
  const envSkipped = [...new Set((runs ?? [{ results }]).flatMap((r) => r.results.filter((x) => x.environment).map((x) => x.name)))]
  const notes = [
    ...(Object.keys(clis).length ? [`Real CLIs (as Hive selected them): ${cliLine(clis)}.`] : []),
    ...(homes.length ? [`Real CLIs' homes (#368): ${homes.join('; ')}.`] : []),
    ...(notRun.length ? [`Not run: the real tier (\`--real\`): ${notRun.join(', ')}.`] : []),
    ...(envSkipped.length ? [`**Skipped for the environment** (no result for the code; the reviewer decides whether a merge needs them run again): ${envSkipped.join(', ')}.`] : [])
  ]
  const tail = notes.length ? ['', ...notes] : []
  if (!runs) {
    const rows = results.map((r) => `| ${r.name} | ${r.skipped ? skippedCell(r) : r.ok ? 'pass' : `**FAIL**${r.failed?.length ? ` (${r.failed.length} check${r.failed.length === 1 ? '' : 's'})` : ''}`} | ${r.seconds ?? '–'}s |`)
    return [...warning, head, '', '| Suite | Result | Time |', '|---|---|---|', ...rows, '', `${summary}. Logs: \`${logDir}\``, ...tail].join('\n')
  }
  // A repeat (--repeat N): each run's result, time and logs, then each suite's result in each run.
  const names = results.map((r) => r.name)
  return [
    ...warning,
    `${head} · ${runs.length} of ${runs.repeat ?? runs.length} runs`,
    '',
    '| Run | Result | Logs |',
    '|---|---|---|',
    ...runs.map((r, i) => `| ${i + 1} | ${r.ok ? 'pass' : '**FAIL**'}: ${r.summary} | \`${r.logDir}\` |`),
    '',
    `| Suite | ${runs.map((_, i) => `Run ${i + 1}`).join(' | ')} |`,
    `|---|${runs.map(() => '---|').join('')}`,
    ...names.map((n) => `| ${n} | ${runs.map((r) => cell(r.results.find((x) => x.name === n))).join(' | ')} |`),
    '',
    summary,
    ...tail
  ].join('\n')
}
