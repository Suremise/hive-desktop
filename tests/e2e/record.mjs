// A run record (npm run e2e -- <suites> --record): what was tested, on exactly which code, with what result, so a
// reviewer can trust a builder's run instead of repeating it (tests/e2e/README.md, the card-loop skill). The code's
// fingerprint is HEAD plus a hash of every uncommitted change, untracked files included; `--fingerprint` prints the
// current one, to compare with a record's.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/** Not code under test: builds used to rewrite it with only line-ending changes (fixed by #148), and a checkout without that fix still does. */
const NOT_CODE = ['THIRD_PARTY_NOTICES.md']

/**
 * The code's fingerprint: `<HEAD short>` when the tree is clean, else `<HEAD short>+<hash>` over the uncommitted
 * changes (tracked diffs and untracked files' contents, line endings ignored so a checkout's CRLF doesn't count).
 */
export function fingerprint(root = process.cwd()) {
  // core.safecrlf=false: no "LF will be replaced by CRLF" warnings in the runner's output.
  const git = (...a) => execFileSync('git', ['-c', 'core.safecrlf=false', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
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

/** The record as Markdown, to paste into a card comment: the fingerprint, each suite's result and time, the logs; and
 * first, if it can't be trusted (recordStatus), why. After the table: the real tier not run (notRun), and the suites
 * skipped for the environment (a real CLI's usage limit, sign-in, network), which are no result for the code. */
export function recordMarkdown({ code, when, jobs, results, logDir, summary, problems = [], runs = null, notRun = [] }) {
  // A skip's reason can quote the CLI: no | to break the table.
  const skippedCell = (r) => `skipped: ${r.skipped.replace(/\|/g, '/')}`
  const cell = (r) => (!r ? '–' : r.skipped ? skippedCell(r) : `${r.ok ? 'pass' : `**FAIL**${r.failed?.length ? ` (${r.failed.length} check${r.failed.length === 1 ? '' : 's'})` : ''}`} ${r.seconds ?? '–'}s`)
  // A record that can't be trusted says so first, so nobody matches its fingerprint by mistake.
  const warning = problems.length ? [`**Not valid — don't trust this record:** ${problems.join('; ')}.`, ''] : []
  const head = `**e2e run record** · code \`${code}\` · ${when} · ${jobs > 1 ? `${jobs} at a time` : 'one at a time'}`
  const envSkipped = [...new Set((runs ?? [{ results }]).flatMap((r) => r.results.filter((x) => x.environment).map((x) => x.name)))]
  const notes = [
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
