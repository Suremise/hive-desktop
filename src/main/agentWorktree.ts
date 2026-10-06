import { existsSync } from 'original-fs'
import { mkdir, readFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { AgentDef, WorktreeGone } from '../shared/types'
import { projectAgents, slugify } from '../shared/defaults'
import { samePath } from '../shared/movePaths'
import { config } from './config'
import { git } from './git'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'
import { copyIgnored, createWorktree, currentBranch, listWorktrees, uniqueFolder } from './worktrees'

/**
 * An agent's worktree whose folder is gone (#146): deleted after its work was merged, or a workspace copied to another
 * computer without its worktrees folder. Its branch lives in the repository, so the worktree can be made again on it
 * (Recreate), or, with the branch gone too, made new from its base. Only ever when the folder is truly missing, and
 * never by pruning another worktree's link that something may still need.
 */

const log = createLogger('worktrees')

const branchExists = async (repo: string, branch: string): Promise<boolean> => (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok

/** The agent's worktree when its folder is missing, with whether its branch survives; null when there's nothing missing. */
export async function missingWorktree(projectPath: string, agentId: string): Promise<WorktreeGone | null> {
  const a = projectAgents(await workspace.projectConfig(projectPath)).find((x) => x.id === agentId)
  if (!a?.worktree || existsSync(a.worktree.path)) return null
  return { agentName: a.name, path: a.worktree.path, branch: a.worktree.branch, base: a.worktree.base, branchExists: await branchExists(projectPath, a.worktree.branch) }
}

/**
 * The worktree entries `git worktree prune` would remove (their folders are missing), by the path each was at. Pruning
 * drops git's link to a worktree, which a moved one still needs to be repaired, so it only runs when it would remove
 * nothing but the entries being recreated.
 */
async function prunable(repo: string): Promise<string[]> {
  const r = await git(repo, ['worktree', 'prune', '--dry-run', '--verbose'])
  if (!r.ok) return []
  const common = (await git(repo, ['rev-parse', '--git-common-dir'])).out.trim()
  const out: string[] = []
  for (const m of `${r.out}\n${r.err}`.matchAll(/^Removing worktrees\/([^:]+):/gm)) {
    const gitdir = await readFile(join(resolve(repo, common), 'worktrees', m[1], 'gitdir'), 'utf8').catch(() => '')
    out.push(gitdir.trim() ? dirname(resolve(gitdir.trim())) : `(${m[1]})`)
  }
  return out
}

/** Whether a folder's parent exists or can be made (an unplugged drive, say, can't). */
async function usableParent(p: string): Promise<boolean> {
  try {
    await mkdir(dirname(p), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Makes a missing agent worktree again: on its branch (`git worktree add <path> <branch>`, no -b) when it survives,
 * else a new one from its base (as Add Agent does). At `prefer` (Repair's moved-along place), else the recorded path,
 * else, if that can't be used, the agent's default worktree location. Prunes git's stale entry first, refusing if the
 * prune would drop another worktree's link (unless it is in `alsoRecreating`) or if git still lists the folder as there.
 * Then the copied ignored files and, at the next start, the project's setup command, as for a new worktree; the agent's
 * record is updated under the lock, with, at a new place, the move its sessions and data are to follow (pendingCopies).
 * Its caller finishes that (finishPending in workspaceMove.ts, or Repair).
 */
export async function recreateWorktree(projectPath: string, agentId: string, opts: { prefer?: string; alsoRecreating?: string[] } = {}): Promise<AgentDef> {
  const cfg = await workspace.projectConfig(projectPath)
  const a = projectAgents(cfg).find((x) => x.id === agentId)
  if (!a) throw new Error('That agent no longer exists.')
  if (!a.worktree) throw new Error(`${a.name} doesn't work in a worktree.`)
  const old = a.worktree
  if (existsSync(old.path)) throw new Error(`${a.name}'s worktree folder is there (${old.path}): there's nothing to recreate.`)
  if (sessions.liveFor(projectPath, agentId)) throw new Error(`Stop ${a.name} first.`)
  const others = (await prunable(projectPath)).filter((p) => !samePath(p, old.path) && !(opts.alsoRecreating ?? []).some((q) => samePath(p, q)))
  if (others.length) {
    throw new Error(`Recreating runs git worktree prune, which would also drop git's link to ${others.join(', ')} (missing too). Locate, recreate or remove ${others.length === 1 ? 'that worktree' : 'those worktrees'} first.`)
  }
  await git(projectPath, ['worktree', 'prune'])
  if ((await listWorktrees(projectPath)).some((l) => samePath(l.path, old.path))) throw new Error(`git still lists ${old.path} as a worktree (it may be locked): unlock it, or run git worktree prune, then try again.`)
  const fallback = (): string => uniqueFolder(join(workspaceOf(projectPath).worktreesRoot, basename(projectPath), slugify(a.name)))
  let dest = opts.prefer ?? old.path
  if (existsSync(dest) || !(await usableParent(dest))) dest = fallback()
  const onBranch = await branchExists(projectPath, old.branch)
  let base = old.base
  if (onBranch) {
    const r = await git(projectPath, ['worktree', 'add', dest, old.branch])
    if (!r.ok) throw new Error((r.err || 'git worktree add failed').trim())
  } else {
    const from = (await branchExists(projectPath, old.base)) ? old.base : await currentBranch(projectPath)
    if (!from) throw new Error(`${a.name}'s branch ${old.branch} is gone, and the project folder isn't on a branch to start a new one from.`)
    await createWorktree(projectPath, dest, old.branch, from)
    base = from
  }
  const copied = await copyIgnored(projectPath, dest, cfg.worktreeCopy ?? config.settings.agents.worktreeCopy).catch(() => [] as string[])
  log.info(`${onBranch ? 'Recreated' : 'Created a new'} worktree for ${userText(a.name)} at ${userText(dest)} on ${userText(old.branch)}${copied.length ? `; copied ${userText(copied.join(', '))}` : ''}`)
  // At a new place, its sessions and the CLIs' data for the old folder are to follow it (workspaceMove.ts finishes
  // that): the move is recorded in the same locked change as the new path, so a failure or exit after it can't lose it.
  const moved = !samePath(dest, old.path)
  let next: AgentDef | undefined
  await workspace.mutateProjectConfig(projectPath, (now) => {
    const setup = !!now.worktreeSetup.trim()
    const agents = projectAgents(now).map((x) => {
      if (x.id !== agentId || !x.worktree) return x
      next = { ...x, worktree: { ...x.worktree, path: dest, base }, ...(setup ? { needsSetup: true } : {}) }
      return next
    })
    const m = { from: old.path, to: dest, of: `${a.name}'s worktree` }
    const pending = (now.pendingCopies ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to)))
    return { agents, ...(moved ? { pendingCopies: [...pending, m] } : {}) }
  })
  if (!next) throw new Error('That agent no longer exists.')
  return next
}

/** Drops the worktree link of an agent whose worktree folder is missing: it works in the project folder from now on. */
export async function unlinkMissingWorktree(projectPath: string, agentId: string): Promise<AgentDef> {
  let next: AgentDef | undefined
  await workspace.mutateProjectConfig(projectPath, (cfg) => {
    const agents = projectAgents(cfg).map((x) => {
      if (x.id !== agentId) return x
      if (!x.worktree) throw new Error(`${x.name} doesn't work in a worktree.`)
      if (existsSync(x.worktree.path)) throw new Error(`${x.name}'s worktree folder is there (${x.worktree.path}): remove the agent to remove its worktree.`)
      next = { ...x, worktree: undefined, needsSetup: undefined }
      log.info(`Removed ${userText(x.name)}'s link to its missing worktree ${userText(x.worktree.path)}`)
      return next
    })
    return { agents }
  })
  if (!next) throw new Error('That agent no longer exists.')
  return next
}
