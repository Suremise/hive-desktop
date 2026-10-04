// Runs Hive's end-to-end suites one after another: npm run e2e [suite…] [--packaged] [--no-progress]
// Needs a dev build (npx electron-vite build); the packaged suites need npm run dist (dist/win-unpacked).
// A suite fails when it exits non-zero or prints a line starting with FAIL. See tests/e2e/README.md.
// Run in a Hive agent's session, it shows in that Hive's Progress panel, one step per suite (../progressReport.mts).
import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { e2eProgress } from '../progressReport.mts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const lib = createRequire(import.meta.url)('./lib.cjs')

// needs: claude = starts Claude Code sessions; codex = the signed-in test Codex home; packaged = dist/win-unpacked.
// Sorted by name, so suites added on different branches land in different places (tests/e2esuites.test.ts checks).
const SUITES = [
  { name: 'about' },
  { name: 'agents', needs: ['claude'] },
  { name: 'agents-ui' },
  { name: 'agentview', needs: ['claude'] },
  { name: 'assistant', needs: ['claude'] },
  { name: 'assistant-control' },
  { name: 'assistantend' },
  { name: 'attention' },
  { name: 'background' },
  { name: 'bell' },
  { name: 'board' },
  { name: 'boardscope' },
  { name: 'boardscroll' },
  { name: 'bridgereport' },
  { name: 'bursts' },
  { name: 'busy' },
  { name: 'cardchip' },
  { name: 'carddialog' },
  { name: 'cardloop' },
  { name: 'changes' },
  { name: 'codex', needs: ['codex'] },
  { name: 'codex-background', needs: ['codex'] },
  { name: 'codex-extra', needs: ['codex'] },
  { name: 'codex-handover', needs: ['codex'] },
  { name: 'codex-setup', needs: ['codex'] },
  { name: 'compact', needs: ['claude'] },
  { name: 'context' },
  { name: 'ctxpercent' },
  { name: 'doingmove' },
  { name: 'donemove' },
  { name: 'drafts' },
  { name: 'editor' },
  { name: 'filelinks' },
  { name: 'files' },
  { name: 'icons' },
  { name: 'image', needs: ['claude'] },
  { name: 'inbox' },
  { name: 'keys' },
  { name: 'launchrace', needs: ['claude'] },
  { name: 'loadfail' },
  { name: 'longsession' },
  { name: 'mcp' },
  { name: 'mode', needs: ['claude'] },
  { name: 'numbers' },
  { name: 'overview' },
  { name: 'packaged', needs: ['packaged'] },
  { name: 'packaged-mcp', needs: ['packaged'] },
  { name: 'packaged-progress', needs: ['packaged'] },
  { name: 'packaged-transcript', needs: ['packaged'] },
  { name: 'pages' },
  { name: 'paneheader' },
  { name: 'perfcompare' },
  { name: 'performance' },
  { name: 'plan', needs: ['claude'] },
  { name: 'progress' },
  { name: 'progressreport' },
  { name: 'providers' },
  { name: 'quit', needs: ['claude'] },
  { name: 'quitwait' },
  { name: 'rail' },
  { name: 'rendercrash' },
  { name: 'reorder' },
  { name: 'replysize' },
  { name: 'resize' },
  { name: 'restart', needs: ['claude'] },
  { name: 'resume', needs: ['claude'] },
  { name: 'resumeall' },
  { name: 'review' },
  { name: 'sessionname' },
  { name: 'sessionorigin' },
  { name: 'skillaudience' },
  { name: 'skilldelivery' },
  { name: 'skills' },
  { name: 'startfail' },
  { name: 'storage' },
  { name: 'taskbar' },
  { name: 'taskoverview' },
  { name: 'tipcorner' },
  { name: 'tips' },
  { name: 'transcript' },
  { name: 'unmerged' },
  { name: 'unsaved' },
  { name: 'update' },
  { name: 'windows', needs: ['claude'] },
  { name: 'wsoverview' }
]

const args = process.argv.slice(2)
const named = args.filter((a) => !a.startsWith('--'))
const packaged = args.includes('--packaged') || named.some((n) => n.startsWith('packaged'))
const unknown = named.filter((n) => !SUITES.some((s) => s.name === n))
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Suites: ${SUITES.map((s) => s.name).join(', ')}`)
  process.exit(2)
}
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No dev build: run npx electron-vite build first.')
  process.exit(2)
}

// Run from an agent's session, the variables that make it that agent (its Hive, token, project) stay out of the suites
// and the test copies of Hive they start: those have their own profile, port and sessions.
const SESSION_VARS = ['HIVE_API_URL', 'HIVE_API_TOKEN', 'HIVE_API_TOKEN_FILE', 'HIVE_HOOK_TOKEN', 'HIVE_PROJECT', 'HIVE_PROJECT_PATH', 'HIVE_WORKSPACE', 'HIVE_RUN_ID', 'HIVE_SESSION_ID', 'HIVE_AGENT', 'HIVE_PROVIDER', 'HIVE_PROGRESS_DATA']
const suiteEnv = () => {
  const env = { HIVE_TEST_TIPS: 'off', ...process.env }
  for (const k of SESSION_VARS) delete env[k]
  return env
}

const run = (name) =>
  new Promise((resolve) => {
    const started = Date.now()
    // No tip card over what a suite clicks, unless its profile turns tips on (tips does).
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: suiteEnv() })
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

const logDir = join(lib.WORK, 'logs')
mkdirSync(logDir, { recursive: true })
const results = []
// Each suite stands alone; the quick ones run first: those that need nothing, then Claude Code, Codex, the installer.
const NEEDS = ['claude', 'codex', 'packaged']
const rank = (s) => Math.max(-1, ...(s.needs ?? []).map((n) => NEEDS.indexOf(n)))
const chosen = [...SUITES].sort((a, b) => rank(a) - rank(b)).filter((s) => (!named.length || named.includes(s.name)) && (packaged || !(s.needs ?? []).includes('packaged')))
const progress = e2eProgress(chosen.map((s) => s.name), args)
for (const [i, s] of chosen.entries()) {
  progress.suite(i, s.name)
  const needs = s.needs ?? []
  if (needs.includes('packaged') && !existsSync(join(root, 'dist', 'win-unpacked'))) {
    results.push({ name: s.name, skipped: 'no dist/win-unpacked (npm run dist)' })
    continue
  }
  if (needs.includes('codex') && !lib.codexSignedIn()) {
    results.push({ name: s.name, skipped: `Codex isn't signed in to ${lib.CODEX_HOME}` })
    continue
  }
  process.stdout.write(`${s.name.padEnd(22)}`)
  const r = await run(s.name)
  progress.done(s.name, r.seconds * 1000, r.ok)
  writeFileSync(join(logDir, `${s.name}.log`), r.out)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? '' : `  (exit ${r.code}${r.failed.length ? `; ${r.failed.length} failed check${r.failed.length === 1 ? '' : 's'}` : ''})`}`)
  for (const f of r.failed) console.log(`    ${f.trim()}`)
  results.push(r)
}
for (const r of results.filter((x) => x.skipped)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
const failed = results.filter((r) => r.ok === false)
const summary = `${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped`
console.log(`\n${summary}. Logs: ${logDir}`)
await progress.finish(!failed.length, summary)
process.exit(failed.length ? 1 : 0)
