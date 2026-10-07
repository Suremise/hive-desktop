// npm run tested-clis [run-record.json]: writes the release's tested-with manifest (resources/tested-clis.json, #365)
// from a real-tier e2e run record: the latest one (the e2e logs' run-record.json) unless a file is given. Run it after
// `npm run e2e -- --all --real --build --record` on the commit being released, then commit the manifest (RELEASING.md).
// Exits 1 when it couldn't vouch for every CLI (it still writes those it could).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { SUITES } from '../tests/e2e/suites.mjs'
import { CLI_PROVIDERS, MANIFEST, manifestFromRecord } from './testedClis.mjs'

const root = join(import.meta.dirname, '..')
const runContext = createRequire(import.meta.url)('../tests/e2e/runContext.cjs')
const file = process.argv[2] ?? join(runContext.WORK, 'logs', 'run-record.json')
if (!existsSync(file)) {
  console.error(`No run record at ${file}. Run the real tier with a record first: npm run e2e -- --all --real --build --record`)
  process.exit(1)
}
const record = JSON.parse(readFileSync(file, 'utf8'))
const out = join(root, MANIFEST)
const current = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
const { manifest, updated, problems } = manifestFromRecord(record, SUITES, current)
console.log(`Run record: ${file} (code ${record.code ?? '?'}, ${record.when ?? '?'})`)
if (updated.length) {
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const id of updated) console.log(`  ${Object.values(CLI_PROVIDERS).find((p) => p.id === id).name}: tested with ${manifest[id].version}`)
  console.log(`Wrote ${MANIFEST}: commit it.`)
}
for (const p of problems) console.log(`  Not updated: ${p}`)
process.exit(problems.length ? 1 : 0)
