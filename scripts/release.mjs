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
// Create the draft first: electron-builder uploads the files in parallel and, with no release yet,
// each upload creates its own draft (you end up with two drafts, the files split between them).
const tag = `v${pkg.version}`
const view = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { shell: true, env: { ...process.env, GH_TOKEN: token } })
const exists = view.status === 0
// Only ever upload to a draft: a published release is what installed copies update from.
if (exists && JSON.parse(view.stdout.toString() || '{}').isDraft !== true) {
  console.error(`${tag} is already published. Bump the version in package.json for a new release.`)
  process.exit(1)
}
if (!exists) run('gh', ['release', 'create', tag, '--draft', '--title', pkg.version, '--notes', '""'])
run('npx', ['electron-builder', '--win', '--publish', 'always'])
console.log(`\nDraft release v${pkg.version} uploaded. Review it at https://github.com/Suremise/hive-desktop/releases and publish it there.`)
