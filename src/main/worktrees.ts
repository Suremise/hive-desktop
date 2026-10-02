import { basename, dirname, join, resolve } from 'path'
import { copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import type { AgentBranchStatus, AgentWorktree, MergeResult } from '../shared/types'
import { copyDir, isDir } from './fsutil'
import { git } from './git'
import { createLogger } from './logger'

const log = createLogger('worktrees')

/** Where Hive creates worktrees: next to the workspace, so the project's own tools don't scan them and they aren't taken for projects. */
export function worktreesRoot(workspacePath: string): string {
  return join(dirname(workspacePath), `${basename(workspacePath)}.worktrees`)
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const b = r.out.trim()
  return r.ok && b && b !== 'HEAD' ? b : null
}

export async function localBranches(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return r.ok ? r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
}

/** The project's worktrees (including the project folder itself), from `git worktree list`. */
export async function listWorktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out: { path: string; branch: string | null }[] = []
  for (const block of r.out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    out.push({ path: resolve(path.trim()), branch: branch?.trim() ?? null })
  }
  return out
}

/** A branch name that doesn't exist yet: wanted, else wanted-2, wanted-3… */
export async function uniqueBranch(cwd: string, wanted: string): Promise<string> {
  const existing = new Set(await localBranches(cwd))
  if (!existing.has(wanted)) return wanted
  for (let i = 2; ; i++) if (!existing.has(`${wanted}-${i}`)) return `${wanted}-${i}`
}

export function uniqueFolder(wanted: string): string {
  if (!existsSync(wanted)) return wanted
  for (let i = 2; ; i++) if (!existsSync(`${wanted}-${i}`)) return `${wanted}-${i}`
}

export async function createWorktree(projectPath: string, dest: string, branch: string, base: string): Promise<void> {
  const check = await git(projectPath, ['check-ref-format', '--branch', branch])
  if (!check.ok) throw new Error(`"${branch}" is not a valid branch name.`)
  await mkdir(dirname(dest), { recursive: true })
  const r = await git(projectPath, ['worktree', 'add', '-b', branch, dest, base])
  if (!r.ok) throw new Error(r.err || 'git worktree add failed')
  log.info(`Created worktree ${dest} on ${branch} from ${base}`)
}

export async function removeWorktree(projectPath: string, wt: AgentWorktree, deleteBranch: boolean): Promise<void> {
  if (existsSync(wt.path)) {
    const r = await git(projectPath, ['worktree', 'remove', '--force', wt.path])
    if (!r.ok) throw new Error(r.err || 'git worktree remove failed')
  } else {
    await git(projectPath, ['worktree', 'prune'])
  }
  if (deleteBranch) {
    const b = await git(projectPath, ['branch', '-D', wt.branch])
    if (!b.ok && !/not found/i.test(b.err)) throw new Error(b.err || `Could not delete branch ${wt.branch}`)
  }
  log.info(`Removed worktree ${wt.path}${deleteBranch ? ` and branch ${wt.branch}` : ''}`)
}

/** Glob patterns (one per line or comma separated) as regular expressions. A pattern without "/" matches any file or folder name. */
export function copyPatterns(text: string): RegExp[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .map((p) => {
      const rx = p
        .split('**')
        .map((part) => part.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*')
      return new RegExp(p.includes('/') ? `^${rx}$` : `(^|/)${rx}$`, 'i')
    })
}

/**
 * Copies git-ignored files matching the patterns (e.g. .env files) from the project folder into a
 * new worktree, which only gets tracked files from git. Returns the copied paths.
 */
export async function copyIgnored(projectPath: string, dest: string, patterns: string): Promise<string[]> {
  const rx = copyPatterns(patterns)
  if (!rx.length) return []
  const r = await git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
  if (!r.ok) return []
  const copied: string[] = []
  for (const raw of r.out.split('\0').filter(Boolean)) {
    const rel = raw.replace(/\/$/, '')
    if (rel === '.hive' || rel.startsWith('.hive/') || !rx.some((x) => x.test(rel))) continue
    const src = join(projectPath, rel)
    const target = join(dest, rel)
    try {
      await mkdir(dirname(target), { recursive: true })
      if (await isDir(src)) await copyDir(src, target)
      else await copyFile(src, target)
      copied.push(rel)
    } catch (e) {
      log.warn(`Could not copy ${rel} into the worktree`, e)
    }
  }
  return copied
}

/** Uncommitted files in a worktree; null when git can't say (a damaged index, say). */
async function dirtyCount(cwd: string): Promise<number | null> {
  const r = await git(cwd, ['status', '--porcelain', '-z'])
  return r.ok ? r.out.split('\0').filter((l) => l && !l.slice(3).startsWith('.hive/')).length : null
}

/**
 * A worktree branch's commits not merged and its uncommitted files. With `strict` (before removing it), a git
 * command that fails throws instead of counting as nothing to lose.
 */
export async function branchStatus(projectPath: string, wt: AgentWorktree, opts: { strict?: boolean } = {}): Promise<AgentBranchStatus> {
  const into = await currentBranch(projectPath)
  const count = await git(projectPath, ['rev-list', '--count', `${into ?? wt.base}..${wt.branch}`])
  const dirty = existsSync(wt.path) ? await dirtyCount(wt.path) : 0
  if (opts.strict && (!count.ok || dirty === null)) {
    throw new Error(`Git couldn't check ${wt.branch}: ${(count.ok ? 'git status failed in its folder' : count.err.trim()) || 'unknown error'}.`)
  }
  let ahead = count.ok ? parseInt(count.out.trim(), 10) || 0 : 0
  if (ahead > 0 && (await alreadyMerged(projectPath, into ?? wt.base, wt.branch))) ahead = 0
  return { branch: wt.branch, base: wt.base, into, ahead, dirty: dirty ?? 0 }
}

/**
 * Whether merging `branch` would leave `into` as it is: its commits were squash-merged (or their changes
 * made) already, though git still counts them as not merged. A conflict or a git error counts as not merged.
 */
async function alreadyMerged(projectPath: string, into: string, branch: string): Promise<boolean> {
  const [merged, tree] = await Promise.all([
    git(projectPath, ['merge-tree', '--write-tree', '--no-messages', into, branch]),
    git(projectPath, ['rev-parse', `${into}^{tree}`])
  ])
  return merged.ok && tree.ok && merged.out.split('\n')[0].trim() === tree.out.trim()
}

/**
 * Merges a worktree agent's branch into the project folder's current branch. Uncommitted work in
 * the worktree is committed first. Conflicts are detected before anything in the project folder
 * changes (git merge-tree); if there are any, nothing is merged and the files are returned.
 */
export async function mergeWorktree(projectPath: string, wt: AgentWorktree, opts: { squash: boolean; message: string; moveBranch?: boolean }): Promise<MergeResult> {
  const message = opts.message.trim() || `Merge ${wt.branch}`
  const dirty = existsSync(wt.path) ? await dirtyCount(wt.path) : 0
  // Git can't say what is uncommitted there: merging (and removing the worktree afterwards) could lose it.
  if (dirty === null) return { ok: false, error: `Git couldn't check the worktree for uncommitted changes (git status failed in ${wt.path}). Fix it, then merge again.` }
  if (dirty > 0) {
    const add = await git(wt.path, ['add', '-A'])
    const commit = add.ok ? await git(wt.path, ['commit', '-m', message]) : add
    if (!commit.ok) return { ok: false, error: `Could not commit the agent's changes: ${commit.err || commit.out}` }
  }
  const into = await currentBranch(projectPath)
  if (!into) return { ok: false, error: 'The project folder is not on a branch (detached HEAD). Check out the branch to merge into first.' }
  if (into === wt.branch) return { ok: false, error: `The project folder has ${wt.branch} checked out.` }
  // With nothing staged in the project folder, undoing a failed merge (reset --merge) can't touch the user's own work.
  if ((await git(projectPath, ['diff', '--cached', '--quiet'])).code === 1) {
    return { ok: false, error: 'The project folder has staged changes. Commit or unstage them before merging.' }
  }

  const check = await git(projectPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', into, wt.branch])
  if (check.code === 1) {
    const conflicts = check.out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
    return { ok: false, conflicts: conflicts.length ? conflicts : ['(unknown files)'] }
  }
  // Any other failure means this git can't do the check (older than 2.38); the merge itself still refuses to lose work.

  if (opts.squash) {
    const m = await git(projectPath, ['merge', '--squash', wt.branch])
    if (!m.ok) {
      await git(projectPath, ['reset', '--merge'])
      return { ok: false, error: m.err || m.out || 'git merge --squash failed' }
    }
    const c = await git(projectPath, ['commit', '-m', message])
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) {
      await git(projectPath, ['reset', '--merge'])
      return { ok: false, error: c.err || c.out || 'git commit failed' }
    }
  } else {
    const m = await git(projectPath, ['merge', '--no-ff', '-m', message, wt.branch])
    if (!m.ok) {
      await git(projectPath, ['merge', '--abort'])
      return { ok: false, error: m.err || m.out || 'git merge failed' }
    }
  }
  log.info(`Merged ${wt.branch} into ${into}${opts.squash ? ' (squash)' : ''}`)
  if (!opts.squash || !opts.moveBranch) return { ok: true }
  const moved = await moveBranchTo(projectPath, wt, into)
  return moved === true ? { ok: true, branchMoved: true } : { ok: true, moveError: moved }
}

/**
 * After a squash merge that keeps the worktree: moves the agent's branch to `into`, which now holds all its
 * work in the squash commit, so its next merge brings only what is new instead of conflicting with its own
 * old commits. Only when merging the branch again would change nothing (git merge-tree), and with
 * `reset --keep`, which refuses rather than lose uncommitted changes. Returns true, or why it didn't.
 */
export async function moveBranchTo(projectPath: string, wt: AgentWorktree, into: string): Promise<true | string> {
  if (!existsSync(wt.path)) return `${wt.path} is missing.`
  const head = await git(wt.path, ['symbolic-ref', '--short', 'HEAD'])
  if (!head.ok || head.out.trim() !== wt.branch) return `The worktree isn't on ${wt.branch}.`
  if (!(await alreadyMerged(projectPath, into, wt.branch))) return `${into} doesn't have everything on ${wt.branch}.`
  const r = await git(wt.path, ['reset', '--keep', into])
  if (!r.ok) return r.err || r.out || 'git reset failed'
  log.info(`Moved ${wt.branch} to ${into} after the squash merge`)
  return true
}
