import { basename, dirname, join, resolve } from 'path'
import { copyFile, mkdir } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import type { AgentBranchStatus, AgentWorktree, MergeResult, WorktreeCheck } from '../shared/types'
import { copyDir, isDir } from './fsutil'
import { git, gitReading } from './git'
import { gitProblem } from './gitTool'
import { samePath } from '../shared/movePaths'
import { createLogger, userText } from './logger'

const log = createLogger('worktrees')

/** Where Hive creates worktrees: next to the workspace, so the project's own tools don't scan them and they aren't taken for projects. */
export function worktreesRoot(workspacePath: string): string {
  return join(dirname(workspacePath), `${basename(workspacePath)}.worktrees`)
}

/**
 * The branch checked out in a folder, or null when it is detached (git answers "HEAD"). Throws when git can't say
 * (#346): a failed read is not a detached HEAD, which callers deciding what is merged must tell apart.
 */
export async function checkedOutBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!r.ok) throw new Error(`git couldn't read the branch checked out in ${cwd} (${gitProblem() ?? (r.err.split(/\r?\n/)[0] || 'git rev-parse failed')})`)
  const b = r.out.trim()
  return b && b !== 'HEAD' ? b : null
}

/** The branch checked out in a folder; null when it is detached or git can't say (for choices, never for what is merged). */
export async function currentBranch(cwd: string): Promise<string | null> {
  return checkedOutBranch(cwd).catch(() => null)
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

/** A branch name that doesn't exist yet: wanted, else wanted-2, wanted-3… `taken`: names to avoid too (a plan's earlier ones). */
export async function uniqueBranch(cwd: string, wanted: string, taken: ReadonlySet<string> = new Set()): Promise<string> {
  const existing = new Set(await localBranches(cwd))
  const free = (b: string): boolean => !existing.has(b) && !taken.has(b)
  if (free(wanted)) return wanted
  for (let i = 2; ; i++) if (free(`${wanted}-${i}`)) return `${wanted}-${i}`
}

/** A folder that doesn't exist yet: wanted, else wanted-2… `taken`: folders to avoid too, lower-cased (a plan's earlier ones). */
export function uniqueFolder(wanted: string, taken: ReadonlySet<string> = new Set()): string {
  const free = (f: string): boolean => !existsSync(f) && !taken.has(f.toLowerCase())
  if (free(wanted)) return wanted
  for (let i = 2; ; i++) if (free(`${wanted}-${i}`)) return `${wanted}-${i}`
}

export async function createWorktree(projectPath: string, dest: string, branch: string, base: string): Promise<void> {
  const check = await git(projectPath, ['check-ref-format', '--branch', branch])
  if (!check.ok) throw new Error(check.missing ? `${gitProblem()}.` : `"${branch}" is not a valid branch name.`)
  await mkdir(dirname(dest), { recursive: true })
  const r = await git(projectPath, ['worktree', 'add', '-b', branch, dest, base])
  if (!r.ok) throw new Error(r.err || 'git worktree add failed')
  log.info(`Created worktree ${userText(dest)} on ${userText(branch)} from ${userText(base)}`)
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
  log.info(`Removed worktree ${userText(wt.path)}${deleteBranch ? ` and branch ${userText(wt.branch)}` : ''}`)
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
      log.warn(`Could not copy ${userText(rel)} into the worktree`, e)
    }
  }
  return copied
}

/** Uncommitted files in a worktree; null when git can't say (a damaged index, say). */
export async function dirtyCount(cwd: string): Promise<number | null> {
  const r = await gitReading(cwd, ['status', '--porcelain', '-z'])
  return r.ok ? r.out.split('\0').filter((l) => l && !l.slice(3).startsWith('.hive/')).length : null
}

/**
 * A worktree branch's commits not merged and its uncommitted files. A git command that fails (git missing included)
 * throws, never counting as nothing to merge or nothing to lose (#346).
 */
export async function branchStatus(projectPath: string, wt: AgentWorktree): Promise<AgentBranchStatus> {
  // Detached is a real answer (counted against the base); a failed read isn't, and stops here.
  const into = await checkedOutBranch(projectPath).catch((e: Error) => {
    throw new Error(`Git couldn't check ${wt.branch}: ${e.message}.`)
  })
  const count = await git(projectPath, ['rev-list', '--count', `${into ?? wt.base}..${wt.branch}`])
  const dirty = existsSync(wt.path) ? await dirtyCount(wt.path) : 0
  if (!count.ok || dirty === null) {
    throw new Error(`Git couldn't check ${wt.branch}: ${gitProblem() ?? ((count.ok ? 'git status failed in its folder' : count.err.trim()) || 'unknown error')}.`)
  }
  let ahead = parseInt(count.out.trim(), 10) || 0
  if (ahead > 0 && (await alreadyMerged(projectPath, into ?? wt.base, wt.branch))) ahead = 0
  const diff = ahead > 0 || dirty ? await diffSummary(wt.path, ahead > 0 ? (into ?? wt.base) : null) : undefined
  return { branch: wt.branch, base: wt.base, into, ahead, dirty: dirty ?? 0, ...(diff ? { diff } : {}) }
}

/**
 * The repository's main branch, which a worktree must be merged into before Hive deletes it unasked (#291, #289): the
 * local branch origin/HEAD names, else main, else master. Not the project folder's current branch, which can be any
 * feature branch and change at any time. Null: none of them, or git couldn't say (`primaryBranchStrict` tells them apart).
 */
export async function primaryBranch(projectPath: string): Promise<string | null> {
  return primaryBranchStrict(projectPath).catch(() => null)
}

/**
 * `primaryBranch`, strictly (#353): null only when git says the repository has none of them; throws when git can't list
 * the branches or read origin/HEAD (anything but its "no such symbolic ref", exit 1 with nothing said), so a removal
 * never takes an unknown main branch for none.
 */
export async function primaryBranchStrict(projectPath: string): Promise<string | null> {
  const heads = await git(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!heads.ok) throw new Error(`git couldn't list the branches (${gitProblem() ?? (heads.err.split(/\r?\n/)[0] || 'for-each-ref failed')})`)
  const local = new Set(heads.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const remote = await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (!remote.ok && !(remote.code === 1 && !remote.err)) throw new Error(`git couldn't read origin/HEAD (${gitProblem() ?? (remote.err.split(/\r?\n/)[0] || 'symbolic-ref failed')})`)
  const named = remote.ok ? remote.out.trim().replace(/^origin\//, '') : ''
  return [named, 'main', 'master'].find((b) => b && local.has(b)) ?? null
}

/** The commit a branch points at, or null. */
export async function tipOf(projectPath: string, branch: string): Promise<string | null> {
  const r = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  return r.ok ? r.out.trim() || null : null
}

/** Commits of `tip` not in `into`, or 0 when its changes are there already (a squash merge); null when git can't say. */
export async function unmergedCommits(projectPath: string, into: string, tip: string): Promise<number | null> {
  const count = await git(projectPath, ['rev-list', '--count', `${into}..${tip}`])
  if (!count.ok) return null
  const n = parseInt(count.out.trim(), 10) || 0
  return n > 0 && (await alreadyMerged(projectPath, into, tip)) ? 0 : n
}

/**
 * Whether deleting a worktree and its branch loses nothing: git lists it as one of the project's worktrees (not the
 * project folder) on its branch, the branch's commit is fully merged into the repository's main branch
 * (`primaryBranch`; a squash merge counts) and the worktree has no uncommitted changes. Strict: anything git can't say
 * counts as not removable. `tip` is the commit checked, for `removeCheckedWorktree`. Shared by Remove All (#291) and
 * loading templates (#289).
 */
export async function worktreeCheck(projectPath: string, wt: AgentWorktree): Promise<WorktreeCheck> {
  const into = await primaryBranch(projectPath)
  // Git that can't run says nothing about the repository: that is the reason, not "no main branch" (#346).
  const unusable = (reason: string): WorktreeCheck => ({ removable: false, into, reason: gitProblem() ?? reason })
  if (!into) return unusable('the repository has no main branch (main or master) to check it against')
  const listed = await listWorktrees(projectPath)
  if (samePath(wt.path, projectPath) || !listed.some((l) => samePath(l.path, wt.path) && l.branch === wt.branch)) return unusable(`git doesn't list it as a worktree on ${wt.branch}`)
  if (!existsSync(wt.path)) return { removable: false, into, reason: 'its folder is missing' }
  // Both commits, so what is checked is fixed: the deletion is guarded against either branch moving afterwards.
  const [tip, intoTip] = await Promise.all([tipOf(projectPath, wt.branch), tipOf(projectPath, into)])
  const [ahead, dirty] = tip && intoTip ? await Promise.all([unmergedCommits(projectPath, intoTip, tip), dirtyCount(wt.path)]) : [null, null]
  if (!tip || !intoTip || ahead === null || dirty === null) return unusable(`git couldn't check ${wt.branch}`)
  const why = [ahead ? `${ahead} commit${ahead === 1 ? '' : 's'} not merged into ${into}` : '', dirty ? `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` : ''].filter(Boolean)
  return why.length ? { removable: false, into, reason: why.join(' and '), ahead, dirty, tip, intoTip } : { removable: true, into, tip, intoTip, ahead: 0, dirty: 0 }
}

/** Why the refs a check rested on no longer hold, or null when both still point at the commits checked. */
async function refsMoved(projectPath: string, wt: AgentWorktree, into: string, tip: string, intoTip: string): Promise<string | null> {
  const [t, m] = await Promise.all([tipOf(projectPath, wt.branch), tipOf(projectPath, into)])
  return t !== tip ? `${wt.branch} changed since it was checked` : m !== intoTip ? `${into} changed since it was checked` : null
}

/**
 * The last step of `removeCheckedWorktree`: deletes the branch in one git ref transaction, all or nothing, that verifies
 * the main branch still points at the commit it was found merged into and deletes the branch only from the commit
 * checked. Null when deleted; otherwise why it was kept.
 */
export async function deleteCheckedBranch(projectPath: string, wt: AgentWorktree, into: string, tip: string, intoTip: string): Promise<string | null> {
  const tx = ['start', `verify refs/heads/${into} ${intoTip}`, `delete refs/heads/${wt.branch} ${tip}`, 'prepare', 'commit', ''].join('\n')
  const r = await git(projectPath, ['update-ref', '--stdin'], undefined, tx)
  return r.ok ? null : ((await refsMoved(projectPath, wt, into, tip, intoTip)) ?? `git kept it: ${r.err.split(/\r?\n/)[0] || 'update-ref failed'}`)
}

/**
 * Deletes a worktree and its branch that `worktreeCheck` found removable, guarded against anything since. Refused
 * (nothing touched) when the main branch isn't the one checked and the one the user was shown (`expectInto`), or when
 * the worktree's branch or the main branch no longer points at the commit checked. The worktree goes without --force,
 * so git refuses one with files written since. The branch is deleted in one git ref transaction that also verifies the
 * main branch still points at the commit it was found merged into: if either moved meanwhile, the branch is kept (and
 * the reply says so; the worktree, clean, is then gone but its commits stay on the branch). Never the forced removal
 * Discard uses. Returns what it did: `deleted` the worktree, `branchKept` with the reason.
 */
export async function removeCheckedWorktree(projectPath: string, wt: AgentWorktree, check: WorktreeCheck, expectInto?: string | null): Promise<{ deleted: boolean; branchKept?: boolean; reason?: string }> {
  const { into, tip, intoTip } = check
  if (!check.removable || !into || !tip || !intoTip) return { deleted: false, reason: check.reason ?? 'not checked' }
  const now = await primaryBranch(projectPath)
  if (now !== into || (expectInto !== undefined && expectInto !== into)) return { deleted: false, reason: `the main branch is ${now ?? 'gone'}, not ${expectInto ?? into} as checked` }
  const moved = await refsMoved(projectPath, wt, into, tip, intoTip)
  if (moved) return { deleted: false, reason: moved }
  const removed = await git(projectPath, ['worktree', 'remove', wt.path])
  if (!removed.ok) return { deleted: false, reason: `git kept it: ${removed.err.split(/\r?\n/)[0] || 'git worktree remove failed'}` }
  const kept = await deleteCheckedBranch(projectPath, wt, into, tip, intoTip)
  log.info(`Removed merged, clean worktree ${userText(wt.path)}${kept ? ` (branch ${userText(wt.branch)} kept: ${userText(kept)})` : ` and branch ${userText(wt.branch)}`}`)
  return kept ? { deleted: true, branchKept: true, reason: kept } : { deleted: true }
}

/**
 * Files, lines added and lines removed in a worktree compared with where its branch left `into` (its commits and its
 * tracked uncommitted changes), or with its own last commit when `into` is null. Null when git can't say.
 */
async function diffSummary(cwd: string, into: string | null): Promise<AgentBranchStatus['diff'] | null> {
  if (!existsSync(cwd)) return null
  let from = 'HEAD'
  if (into) {
    const base = await git(cwd, ['merge-base', into, 'HEAD'])
    if (!base.ok) return null
    from = base.out.trim()
  }
  const r = await git(cwd, ['diff', '--shortstat', from])
  if (!r.ok) return null
  const n = (re: RegExp): number => parseInt(re.exec(r.out)?.[1] ?? '0', 10)
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) }
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
  let into: string | null
  try {
    into = await checkedOutBranch(projectPath)
  } catch (e) {
    return { ok: false, error: `Nothing was merged: ${(e as Error).message}.` }
  }
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
  log.info(`Merged ${userText(wt.branch)} into ${userText(into)}${opts.squash ? ' (squash)' : ''}`)
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
  log.info(`Moved ${userText(wt.branch)} to ${userText(into)} after the squash merge`)
  return true
}
