import { createHash, randomUUID } from 'crypto'
import { basename, join, resolve, sep } from 'path'
import { createReadStream, existsSync } from 'original-fs'
import { lstat, readdir, readlink } from 'original-fs/promises'
import { projectAgents, slugify } from '../shared/defaults'
import type { AgentWorktree, UnusedWorktree, UnusedWorktreePreview, UnusedWorktreeRemoval, UnusedWorktrees } from '../shared/types'
import { lostLines } from '../shared/unusedWorktrees'
import { realPath } from './fsutil'
import { git, gitReading } from './git'
import { gitProblem } from './gitTool'
import { createLogger, userText } from './logger'
import { reserveForRemoval } from './projectAgents'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'

const log = createLogger('worktrees')

/**
 * Unused worktrees (#353): the git worktrees of a project that no agent of it works in, kept when their agent was
 * removed with "Keep worktree and branch" (or made outside Hive). Each is checked with #291's `worktreeCheck` (merged
 * into the repository's main branch and clean; anything git can't say counts as not removable, #346). Only folders git
 * lists as the project's worktrees, that exist, aren't the project, don't contain it or the workspace and aren't another
 * project. Removal is the user's alone (no Agent API route or tool): Remove deletes a merged, clean one and its branch
 * through `removeCheckedWorktree`; Remove anyway (forced) only what the user was shown it would lose.
 */

const key = (p: string): string => realPath(resolve(p)).toLowerCase()
/** Whether `a` is `b` or a folder containing it. */
const contains = (a: string, b: string): boolean => {
  const x = resolve(a).toLowerCase().replace(/[\\/]$/, '')
  const y = resolve(b).toLowerCase()
  return x === y || y.startsWith(x + sep)
}

/** Why Hive won't touch a listed worktree folder (null: it may), whoever uses it. */
async function unsafe(projectPath: string, path: string): Promise<string | null> {
  const ws = workspaceOf(projectPath)
  if (contains(path, projectPath) || (ws.path && contains(path, ws.path))) return 'it contains the project or the workspace'
  const projects = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  if (projects.some((p) => key(p) === key(path)) || workspace.isAssistantHome(path)) return 'it is another project of the workspace'
  return null
}

/** The worktrees git lists for the project that no agent works in, as they are now (no check yet). */
async function candidates(projectPath: string): Promise<{ listed: { path: string; branch: string | null }[]; problem?: string }> {
  const all = await wt.listWorktrees(projectPath)
  if (!all.length) {
    const problem = gitProblem()
    return problem ? { listed: [], problem } : { listed: [] }
  }
  const used = new Set(projectAgents(await workspace.projectConfig(projectPath)).flatMap((a) => (a.worktree ? [key(a.worktree.path)] : [])))
  const listed: { path: string; branch: string | null }[] = []
  for (const w of all) {
    if (key(w.path) === key(projectPath) || used.has(key(w.path)) || !existsSync(w.path)) continue
    if (await unsafe(projectPath, w.path)) continue
    listed.push(w)
  }
  return { listed }
}

/**
 * A detached worktree, never removable by Remove (no branch to check): its uncommitted files, and as `ahead` the commits
 * its HEAD alone holds (on no branch, tag or remote branch: removing the worktree loses them). Left out when git can't
 * count them, so nothing is offered that can't say what it loses.
 */
async function detachedCheck(projectPath: string, path: string): Promise<UnusedWorktree['check']> {
  const [dirty, alone] = await Promise.all([wt.dirtyCount(path), unreferencedCommits(path)])
  return { removable: false, into: await wt.primaryBranch(projectPath), reason: gitProblem() ?? 'it is not on a branch (detached HEAD)', ...(dirty === null ? {} : { dirty }), ...(alone === null ? {} : { ahead: alone }) }
}

/**
 * Commits a worktree's HEAD holds that no branch, tag or remote branch has (but `except`, the branch removing it would
 * delete); null when git can't say.
 */
async function unreferencedCommits(path: string, except?: string): Promise<number | null> {
  const r = await git(path, ['rev-list', '--count', 'HEAD', '--not', ...(except ? [`--exclude=refs/heads/${except}`] : []), '--branches', '--tags', '--remotes'])
  const n = parseInt(r.out.trim(), 10)
  return r.ok && Number.isFinite(n) ? n : null
}

async function describe(projectPath: string, w: { path: string; branch: string | null }): Promise<UnusedWorktree> {
  const check = w.branch ? await wt.worktreeCheck(projectPath, { path: w.path, branch: w.branch, base: '' }) : await detachedCheck(projectPath, w.path)
  const [head, last] = await Promise.all([git(w.path, ['rev-parse', '--verify', '--quiet', 'HEAD']), git(w.path, ['log', '-1', '--format=%cI%x00%s'])])
  const [at, subject] = last.ok ? last.out.trim().split('\0') : []
  return {
    path: w.path,
    branch: w.branch,
    check,
    ...(head.ok && head.out.trim() ? { head: head.out.trim() } : {}),
    ...(at ? { lastCommit: { at, subject: subject ?? '' } } : {})
  }
}

/** The folders of the project's unused worktrees, unchecked (Storage measures them). */
export async function unusedWorktreeFolders(projectPath: string): Promise<{ path: string; branch: string | null }[]> {
  return (await candidates(projectPath).catch(() => ({ listed: [] }))).listed
}

/** The project's unused worktrees, each checked. */
export async function unusedWorktrees(projectPath: string): Promise<UnusedWorktrees> {
  projectPath = workspace.assertProject(projectPath)
  const { listed, problem } = await candidates(projectPath)
  if (problem) return { worktrees: [], gitProblem: problem }
  const worktrees: UnusedWorktree[] = []
  for (const w of listed) worktrees.push(await describe(projectPath, w))
  return { worktrees }
}

/** Counts for the Assistant's project status (#353): how many, and how many are merged and clean. Null with none. */
export async function unusedWorktreeCounts(projectPath: string): Promise<{ count: number; merged: number } | null> {
  const { worktrees } = await unusedWorktrees(projectPath).catch(() => ({ worktrees: [] as UnusedWorktree[] }))
  return worktrees.length ? { count: worktrees.length, merged: worktrees.filter((w) => w.check.removable).length } : null
}

/**
 * The project's unused worktrees named after these agents as Hive names worktrees (`hive/<slug>` in
 * `<worktrees>/<project>/<slug>`, or numbered `-2`…): what a deleted template's worktree agents left (#353's hint).
 */
export async function unusedWorktreesNamed(projectPath: string, names: string[]): Promise<string[]> {
  const slugs = new Set(names.map(slugify))
  if (!slugs.size) return []
  const root = join(workspaceOf(projectPath).worktreesRoot, basename(projectPath))
  const { listed } = await candidates(projectPath).catch(() => ({ listed: [] as { path: string; branch: string | null }[] }))
  const base = (s: string): string => s.replace(/-\d+$/, '')
  return listed
    .filter((w) => key(resolve(w.path, '..')) === key(root) && slugs.has(base(basename(w.path).toLowerCase())) && !!w.branch && w.branch.startsWith('hive/') && slugs.has(base(w.branch.slice(5))))
    .map((w) => w.path)
}

/**
 * What Remove anyway would delete, exactly as it is now (#353): the folder (canonical path), its branch or detached HEAD,
 * the commit checked out, the main branch and its commit it was checked against, the commits and uncommitted files only
 * it holds, and a fingerprint of everything in the folder, ignored files included, and of its git index (`fingerprint`:
 * whole contents, not sizes and times). Taken for the confirmation and again just before
 * the removal, which goes ahead only if the two are the same. Throws when any of it can't be read: what can't be named
 * isn't offered.
 */
interface Snapshot {
  path: string
  branch: string | null
  head: string
  into: string | null
  intoTip: string | null
  ahead: number
  dirty: number
  files: string
}

/** Entries a fingerprint walks at most, and bytes it reads: a bigger folder isn't fingerprinted (Remove anyway refuses). */
const SNAPSHOT_MAX_ENTRIES = 300_000
const SNAPSHOT_MAX_BYTES = 4 * 1024 ** 3

/**
 * Every entry of a worktree's folder (its `.git` file aside) as it is: each path and kind, a file's whole content
 * (streamed, ignored and large ones too), a link's target; plus its git index as git lists it (staged content: mode,
 * blob and stage per path). Two fingerprints are the same only when nothing a forced removal would discard differs.
 * Throws when anything can't be read, or the folder is past the bounds.
 */
async function fingerprint(root: string): Promise<string> {
  const h = createHash('sha256')
  const index = await gitReading(root, ['ls-files', '--stage', '-z'])
  if (!index.ok) throw new Error(`git couldn't list its index (${index.err.split(/\r?\n/)[0] || 'ls-files failed'})`)
  h.update('index\0').update(index.buf)
  let entries = 0
  let bytes = 0
  const dirs = ['']
  const found: { rel: string; kind: 'd' | 'f' | 'l' }[] = []
  while (dirs.length) {
    const rel = dirs.pop()!
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      // The worktree's .git file is git's, not the work's.
      if (!rel && e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const kind = e.isSymbolicLink() ? 'l' : e.isDirectory() ? 'd' : 'f'
      if (++entries > SNAPSHOT_MAX_ENTRIES) throw new Error(`it holds more than ${SNAPSHOT_MAX_ENTRIES.toLocaleString('en')} files and folders, too many to check`)
      found.push({ rel: r, kind })
      if (kind === 'd') dirs.push(r)
    }
  }
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const f of found) {
    h.update(`\n${f.kind}\0${f.rel}\0`)
    const abs = join(root, f.rel)
    if (f.kind === 'l') h.update(await readlink(abs))
    else if (f.kind === 'f') {
      const size = (await lstat(abs)).size
      if ((bytes += size) > SNAPSHOT_MAX_BYTES) throw new Error(`it holds more than ${SNAPSHOT_MAX_BYTES / 1024 ** 3} GB of files, too much to check`)
      h.update(`${size}\0`)
      await new Promise<void>((res, rej) => {
        const s = createReadStream(abs)
        s.on('data', (chunk) => h.update(chunk))
        s.on('error', rej)
        s.on('end', () => res())
      })
    }
  }
  return h.digest('hex')
}

/** The snapshot of an unused worktree as it is now; throws (saying why) when git or the folder can't say. */
async function snapshot(projectPath: string, path: string): Promise<Snapshot> {
  const fail = (why: string): never => {
    throw new Error(`Hive couldn't check what it holds: ${gitProblem() ?? why}`)
  }
  const head = await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const tip = head.ok ? head.out.trim() : ''
  if (!tip) fail('git could not read its HEAD')
  const sym = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  // Exit 1 with nothing said: detached. Anything else that fails: can't tell.
  if (!sym.ok && !(sym.code === 1 && !sym.err)) fail('git could not read its branch')
  const branch = sym.ok ? sym.out.trim() : null
  // Strictly: a main branch git couldn't look for is not "none" (that would count the commits against no branch).
  let into: string | null = null
  try {
    into = await wt.primaryBranchStrict(projectPath)
  } catch (e) {
    fail((e as Error).message)
  }
  const intoTip = into ? await wt.tipOf(projectPath, into) : null
  if (into && !intoTip) fail(`git could not read ${into}`)
  // On a branch: its commits not on the main branch (a squash merge counting). Detached, or no main branch: the commits
  // no branch, tag or remote branch has.
  const ahead = branch && intoTip ? await wt.unmergedCommits(projectPath, intoTip, tip) : await unreferencedCommits(path, branch ?? undefined)
  if (ahead === null) fail('git could not count its commits')
  const dirty = await wt.dirtyCount(path)
  if (dirty === null) fail('git status failed')
  let files = ''
  try {
    files = await fingerprint(path)
  } catch (e) {
    fail((e as Error).message)
  }
  return { path: realPath(resolve(path)), branch, head: tip, into, intoTip, ahead: ahead!, dirty: dirty!, files }
}

/** Previews shown in a Remove anyway confirmation, by token: good for 15 minutes, at most 50 kept, each used once. */
const previews = new Map<string, { project: string; at: number; snap: Snapshot }>()
export const PREVIEW_MS = 15 * 60_000

/**
 * A preview's token presented to remove (#373): taken off the list whatever comes of the removal (used once), and
 * refused once older than PREVIEW_MS, whether or not another preview has pruned it yet.
 */
function takePreview(token: string): { ok: true; preview: { project: string; at: number; snap: Snapshot } } | { ok: false; reason: string } {
  const shown = previews.get(token)
  previews.delete(token)
  if (!shown) return { ok: false, reason: 'what it holds was not checked for this removal: look again' }
  if (Date.now() - shown.at > PREVIEW_MS) return { ok: false, reason: `what it holds was checked more than ${PREVIEW_MS / 60_000} minutes ago: nothing was removed, look again` }
  return { ok: true, preview: shown }
}

/**
 * Remove anyway's confirmation (#353): what removing the worktree loses, from a snapshot kept under a token that the
 * removal must present. Throws when what it holds can't be established (then there is nothing to confirm).
 */
export async function removalPreview(projectPath: string, path: string): Promise<UnusedWorktreePreview> {
  projectPath = workspace.assertProject(projectPath)
  const listed = (await wt.listWorktrees(projectPath)).find((w) => key(w.path) === key(path))
  if (!listed || key(listed.path) === key(projectPath)) throw new Error(gitProblem() ?? "git doesn't list it as one of the project's worktrees")
  const why = await unsafe(projectPath, listed.path)
  if (why) throw new Error(`Hive doesn't remove it: ${why}.`)
  const snap = await snapshot(projectPath, listed.path)
  const now = Date.now()
  for (const [k, p] of previews) if (now - p.at > PREVIEW_MS) previews.delete(k)
  while (previews.size >= 50) previews.delete(previews.keys().next().value!)
  const token = randomUUID()
  previews.set(token, { project: key(projectPath), at: now, snap })
  return { token, path: listed.path, branch: snap.branch, lost: lostLines({ path: listed.path, branch: snap.branch, into: snap.into, ahead: snap.ahead, dirty: snap.dirty }) }
}

/** What each snapshot field is, for the refusal. */
const SNAPSHOT_FIELD: Record<keyof Snapshot, string> = {
  path: 'its folder',
  branch: 'its branch',
  head: 'its commit',
  into: 'the main branch',
  intoTip: "the main branch's commit",
  ahead: 'its unmerged commits',
  dirty: 'its uncommitted files',
  files: 'its files'
}

/**
 * Removes an unused worktree (#353), the user's choice from the Overview. Reserved first, so no agent can be given it
 * meanwhile (`reserveForRemoval`, which addAgent and template loads check under the project file's lock), then refused
 * if git no longer lists it, an agent works in it, or it is a folder Hive never deletes. Without `force` (Remove), only
 * a merged, clean one, checked now (`worktreeCheck`, then `removeCheckedWorktree`: never --force, its branch deleted only
 * from the commit checked, and only while the main branch the user was shown, `expectInto`, still holds it). With
 * `force` (Remove anyway), the token of the preview the user confirmed (used once, and only within PREVIEW_MS of it,
 * #373): the worktree is snapshotted again and removed only
 * if nothing differs (folder, branch, commit, main branch, every file); then the folder (forced) and the branch the
 * preview named, only from the commit it showed.
 */
export async function removeUnusedWorktree(projectPath: string, path: string, opts: { expectInto?: string | null; force?: string } = {}): Promise<UnusedWorktreeRemoval> {
  projectPath = workspace.assertProject(projectPath)
  // The token is spent now, whatever happens next: a refused removal asks for a new look.
  const taken = opts.force !== undefined ? takePreview(opts.force) : null
  let release: () => void
  try {
    release = reserveForRemoval(path)
  } catch (e) {
    return { deleted: false, reason: (e as Error).message }
  }
  try {
    const listed = (await wt.listWorktrees(projectPath)).find((w) => key(w.path) === key(path))
    if (!listed || key(listed.path) === key(projectPath)) return { deleted: false, reason: gitProblem() ?? "git doesn't list it as one of the project's worktrees" }
    const why = await unsafe(projectPath, listed.path)
    if (why) return { deleted: false, reason: why }
    // Under the project file's lock, after the reservation: an agent given it before keeps it; none can be from now on.
    let owned = false
    await workspace.mutateProjectConfig(projectPath, (now) => {
      owned = projectAgents(now).some((a) => a.worktree && key(a.worktree.path) === key(listed.path))
      return {}
    })
    if (owned) return { deleted: false, reason: 'an agent works in it now' }
    let done: UnusedWorktreeRemoval
    if (opts.force !== undefined) {
      if (!taken?.ok) return { deleted: false, reason: taken?.reason ?? 'what it holds was not checked for this removal: look again' }
      const shown = taken.preview
      if (shown.project !== key(projectPath) || shown.snap.path !== realPath(resolve(listed.path))) return { deleted: false, reason: 'what it holds was not checked for this removal: look again' }
      let now: Snapshot
      try {
        now = await snapshot(projectPath, listed.path)
      } catch (e) {
        return { deleted: false, reason: (e as Error).message }
      }
      const changed = (Object.keys(now) as (keyof Snapshot)[]).filter((k) => now[k] !== shown.snap[k])
      if (changed.length) return { deleted: false, reason: `it changed since you were shown what it holds (${changed.map((k) => SNAPSHOT_FIELD[k]).join(', ')}): nothing was removed, look again` }
      const snap = shown.snap
      await wt.removeWorktree(projectPath, { path: listed.path, branch: snap.branch ?? '', base: '' }, false)
      // The branch shown, and only from the commit shown (git refuses otherwise).
      const branch = snap.branch ? await git(projectPath, ['update-ref', '-d', `refs/heads/${snap.branch}`, snap.head]) : null
      done = branch && !branch.ok ? { deleted: true, branchKept: true, reason: `git kept ${snap.branch}: ${branch.err.split(/\r?\n/)[0] || 'update-ref failed'}` } : { deleted: true }
      log.info(`Removed unused worktree ${userText(listed.path)} anyway (${snap.ahead} commits only it held, ${snap.dirty} uncommitted files)`)
    } else {
      if (!listed.branch) return { deleted: false, reason: 'it is not on a branch (detached HEAD)' }
      const tree: AgentWorktree = { path: listed.path, branch: listed.branch, base: '' }
      const check = await wt.worktreeCheck(projectPath, tree)
      done = await wt.removeCheckedWorktree(projectPath, tree, check, opts.expectInto).catch((e: Error) => ({ deleted: false, reason: e.message.split('\n')[0] }))
    }
    if (done.deleted) {
      // A removed worktree's setup isn't pending any more.
      await workspace.mutateProjectConfig(projectPath, (now) => (Array.isArray(now.setupPending) ? { setupPending: now.setupPending.filter((p) => typeof p !== 'string' || key(p) !== key(listed.path)) } : {}))
    }
    return done
  } finally {
    release()
  }
}
