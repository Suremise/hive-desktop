// The branches Hive makes for worktree agents (#703, Darren's decision on #702): hive/<workspace>/<project>/<agent>, e.g.
// hive/HIVE/amberlight/amb1, always in full, so several workspaces can share a repository, even with projects of the same
// name, and never take each other's branches. Branches from before (hive/<agent>) stay Hive's: template reuse,
// unused-worktree clean-up and Add Agent's reuse of an unused worktree recognise both forms.
import { slugify } from './defaults'

/** The longest a workspace's or project's part of a branch is. */
const PART_MAX = 40

/**
 * A workspace's or project's folder name as one part of a git branch name: its case kept, anything git's ref rules
 * refuse (spaces, ~ ^ : ? * [ \, control characters, "..", "@{", a leading ".", a trailing "." or ".lock") turned into
 * "-" or dropped, at most 40 characters; `fallback` when nothing is left.
 */
export function refPart(name: string, fallback: string): string {
  let s = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .slice(0, PART_MAX)
  for (let before = ''; before !== s; ) {
    before = s
    s = s.replace(/^[.-]+/, '').replace(/[.-]+$/, '').replace(/\.lock$/i, '')
  }
  return s || fallback
}

/** Where a project is, for its branches: its workspace's folder name and its own. */
export interface BranchHome {
  workspace: string
  project: string
}

/** An agent's part of its branch: its slug (as its worktree's folder is named), with git's ref rules applied too. */
export const agentPart = (agent: string): string => refPart(slugify(agent), 'agent')

/** The branch Hive makes for an agent's new worktree: hive/<workspace>/<project>/<agent>. */
export function hiveBranch(home: BranchHome, agent: string): string {
  return `hive/${refPart(home.workspace, 'workspace')}/${refPart(home.project, 'project')}/${agentPart(agent)}`
}

/** The branch hive/<agent> Hive made before #703, for the same agent. */
export const oldHiveBranch = (agent: string): string => `hive/${agentPart(agent)}`

/**
 * The agent part (its slug, perhaps numbered "-2") of a branch Hive made for this project, in either form: hive/<agent>
 * from before, or hive/<workspace>/<project>/<agent> for this workspace and project (case aside). Null for any other
 * branch, another workspace's or project's included.
 */
export function hiveBranchAgent(branch: string, home: BranchHome): string | null {
  const old = /^hive\/([^/]+)$/.exec(branch)
  if (old) return old[1]
  const full = /^hive\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(branch)
  if (!full) return null
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  return same(full[1], refPart(home.workspace, 'workspace')) && same(full[2], refPart(home.project, 'project')) ? full[3] : null
}

/**
 * The branches an agent's new worktree on `branch` may find an unused worktree on (#456): that branch, and when it is
 * Hive's full form for this project, the same agent's branch from before (hive/<agent>).
 */
export function reusableBranches(branch: string, home: BranchHome): string[] {
  const agent = /^hive\/[^/]+\/[^/]+\/[^/]+$/.test(branch) ? hiveBranchAgent(branch, home) : null
  return agent ? [branch, `hive/${agent}`] : [branch]
}
