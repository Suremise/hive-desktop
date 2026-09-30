// Runs Hive's end-to-end suites one after another: npm run e2e [suite…] [--packaged]
// Needs a dev build (npx electron-vite build); the packaged suites need npm run dist (dist/win-unpacked).
// A suite fails when it exits non-zero or prints a line starting with FAIL. See tests/e2e/README.md.
import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const lib = createRequire(import.meta.url)('./lib.cjs')

// needs: claude = starts Claude Code sessions; codex = the signed-in test Codex home; packaged = dist/win-unpacked.
const SUITES = [
  { name: 'about' },
  { name: 'mcp' },
  { name: 'skills' },
  { name: 'providers' },
  { name: 'agents-ui' },
  { name: 'pages' },
  { name: 'agents', needs: ['claude'] },
  { name: 'windows', needs: ['claude'] },
  { name: 'launchrace', needs: ['claude'] },
  { name: 'assistant', needs: ['claude'] },
  { name: 'rail' },
  { name: 'resize' },
  { name: 'keys' },
  { name: 'editor' },
  { name: 'files' },
  { name: 'unsaved' },
  { name: 'drafts' },
  { name: 'transcript' },
  { name: 'update' },
  { name: 'image', needs: ['claude'] },
  { name: 'mode', needs: ['claude'] },
  { name: 'plan', needs: ['claude'] },
  { name: 'compact', needs: ['claude'] },
  { name: 'restart', needs: ['claude'] },
  { name: 'resume', needs: ['claude'] },
  { name: 'quit', needs: ['claude'] },
  { name: 'agentview', needs: ['claude'] },
  { name: 'codex-setup', needs: ['codex'] },
  { name: 'codex', needs: ['codex'] },
  { name: 'codex-extra', needs: ['codex'] },
  { name: 'codex-handover', needs: ['codex'] },
  { name: 'packaged', needs: ['packaged'] },
  { name: 'packaged-mcp', needs: ['packaged'] },
  { name: 'packaged-transcript', needs: ['packaged'] }
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

const run = (name) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: process.env })
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
for (const s of SUITES) {
  if (named.length && !named.includes(s.name)) continue
  const needs = s.needs ?? []
  if (needs.includes('packaged') && !packaged) continue
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
  writeFileSync(join(logDir, `${s.name}.log`), r.out)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? '' : `  (exit ${r.code}${r.failed.length ? `; ${r.failed.length} failed check${r.failed.length === 1 ? '' : 's'}` : ''})`}`)
  for (const f of r.failed) console.log(`    ${f.trim()}`)
  results.push(r)
}
for (const r of results.filter((x) => x.skipped)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
const failed = results.filter((r) => r.ok === false)
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped. Logs: ${logDir}`)
process.exit(failed.length ? 1 : 0)
