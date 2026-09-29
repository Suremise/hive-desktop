// Builds the installer and uploads it to a DRAFT GitHub release for the version in package.json,
// with latest.yml (what the updater reads) and the .blockmap (for smaller downloads). Uses the GitHub
// CLI's login. Nothing reaches users until the draft is reviewed and published on GitHub.
// See RELEASING.md.
import { execSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let token
try {
  token = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {
  console.error('The GitHub CLI is not logged in. Run: gh auth login')
  process.exit(1)
}
const dirty = execSync('git status --porcelain').toString().trim()
if (dirty) {
  console.error('Commit or stash your changes first; a release is built from a clean tree.\n' + dirty)
  process.exit(1)
}

console.log(`Building Hive ${pkg.version} and uploading a draft release…`)
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', '--publish', 'always'])
console.log(`\nDraft release v${pkg.version} uploaded. Review it at https://github.com/Suremise/hive-desktop/releases and publish it there.`)
