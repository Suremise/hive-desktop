// Is the dev build in out/ made from the source as it is now? The runner (run.mjs) asks before running suites, so a run
// record never vouches for code that wasn't built. File times can't say: deleting a source file, or restoring an older
// copy, leaves every remaining file older than the build. So a build made with --build stamps out/ with a hash of
// everything it was made from (the paths and their contents), and a run compares that with the source now. A build
// made another way (npx electron-vite build) has no stamp, so which code it holds is unknown.
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'

/** What the build reads: its source, bundled resources and docs, the root files the app imports, and its config. */
export const BUILD_INPUTS = ['src', 'resources', 'docs', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']
const STAMP = join('out', '.e2e-build.json')

/** A hash of the build's inputs: every file's path and contents (line endings ignored), so an added, deleted or changed
 * file changes it, whatever its modification time. */
export function buildInputs(root) {
  const files = []
  const walk = (p) => {
    if (!existsSync(p)) return
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p)) if (e !== 'node_modules') walk(join(p, e))
    } else files.push(p)
  }
  for (const p of BUILD_INPUTS) walk(join(root, p))
  const h = createHash('sha256')
  for (const f of files.map((p) => relative(root, p).split(sep).join('/')).sort()) {
    h.update(`${f}\0`)
    h.update(readFileSync(join(root, f)).toString('latin1').replace(/\r\n/g, '\n'))
    h.update('\0')
  }
  return h.digest('hex')
}

/** The hash out/ was stamped with by its build, or null (no build, or one made without --build). */
export function buildStamp(root) {
  try {
    return JSON.parse(readFileSync(join(root, STAMP), 'utf8')).inputs ?? null
  } catch {
    return null
  }
}

/**
 * Makes sure the build is the source's, or says why not. { stale, built, why }:
 * - fresh (the stamp matches the source): nothing to do;
 * - otherwise, with build: removes the old stamp, runs runBuild() and stamps out/ with the inputs it was made from, only
 *   if they didn't change while it built; without build: stale, with why (no build, a build of unknown code, or one of
 *   other code).
 */
export function ensureBuild({ root, build, runBuild }) {
  const hasBuild = existsSync(join(root, 'out', 'main', 'index.js'))
  const stamp = buildStamp(root)
  const before = buildInputs(root)
  if (hasBuild && stamp === before) return { stale: false, built: false, why: null }
  if (!build) {
    const why = !hasBuild ? 'there is no dev build' : !stamp ? "the dev build wasn't made with --build, so which code it holds is unknown" : 'the dev build was made from other source than this'
    return { stale: true, built: false, why }
  }
  // The old stamp goes before the build touches out/: a build that fails, or whose source changes while it runs, leaves
  // output that no stamp vouches for (and a later run with the old source mustn't match the old stamp).
  rmSync(join(root, STAMP), { force: true })
  runBuild()
  const after = buildInputs(root)
  if (after !== before) return { stale: true, built: true, why: 'the source changed while it was building' }
  writeFileSync(join(root, STAMP), JSON.stringify({ inputs: before, at: new Date().toISOString() }) + '\n')
  return { stale: false, built: true, why: null }
}
