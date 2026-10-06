// npm run dist [-- --here | --replace]: builds Hive and its Windows installer (dist/Hive-Setup-<version>.exe, with its
// blockmap and latest.yml; never published: npm run release does that, RELEASING.md), and writes dist/build-info.json:
// what the installer was built from (the code's fingerprint, commit, branch, version, time), only if that didn't change
// while it was built. Built in an agent's git worktree, the installer is also copied to the main checkout's dist, where
// the user looks for it (distCopy.mjs, #150), unless --here; one of the same name there built from other code is never
// replaced without --replace.
// Its `npm run build` makes the dev build in out/ that the app is packaged from: that is stamped as `npm run e2e --
// --build` stamps it (tests/e2e/build.mjs, under the worktree's build lock), so the packaged checks run straight after
// it (npm run e2e -- packaged packaged-mcp packaged-progress --record) find out/ from this source (#274).
import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { makeDist } from './distCopy.mjs'
import { buildStamped } from '../tests/e2e/build.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const unknown = args.filter((a) => !['--here', '--replace'].includes(a))
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(' ')}: --here keeps a worktree's installer in it, --replace copies it over a different build.`)
  process.exit(2)
}
const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
// An earlier build's records go first, so a build that fails part way leaves nothing vouching for its installer and
// dist/win-unpacked, and the e2e runner's packaged checks say so (tests/e2e/runner.mjs packagedStatus): makeDist.
const lines = makeDist({ root, here: args.includes('--here'), replace: args.includes('--replace'), run, buildStamped })
console.log(`\n${lines.join('\n')}`)
