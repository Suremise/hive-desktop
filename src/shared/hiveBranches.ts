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

/**
 * Where a project is, for its branches: its workspace's folder name and its own. `space`: the workspace part its new
 * branches take in this repository (`branchSpace`), when known; else the workspace's own part.
 */
export interface BranchHome {
  workspace: string
  project: string
  space?: string
}

const workspacePart = (home: BranchHome): string => refPart(home.workspace, 'workspace')
const projectPart = (home: BranchHome): string => refPart(home.project, 'project')

/**
 * The workspace part for new branches in a repository that has `branches` (#703 round 2): the workspace's own, unless a
 * branch from before is in the way. Git can't make hive/ws/alpha/b1 while a branch hive/ws exists (an agent once called
 * "ws" had it) or hive/ws/alpha does, case aside on Windows: then ws-2, ws-3… The branch in the way is left as it is.
 */
export function branchSpace(home: BranchHome, branches: readonly string[]): string {
  const taken = new Set(branches.map((b) => b.toLowerCase()))
  const w = workspacePart(home)
  const p = projectPart(home)
  for (let n = 1; ; n++) {
    const space = n === 1 ? w : `${w}-${n}`
    if (!taken.has(`hive/${space}`.toLowerCase()) && !taken.has(`hive/${space}/${p}`.toLowerCase())) return space
  }
}

/** An agent's part of its full-form branch: its slug (as its worktree's folder is named), with git's ref rules applied too. */
export const agentPart = (agent: string): string => refPart(slugify(agent), 'agent')

/** The branch Hive makes for an agent's new worktree: hive/<workspace>/<project>/<agent>. */
export function hiveBranch(home: BranchHome, agent: string): string {
  return `hive/${home.space ?? workspacePart(home)}/${projectPart(home)}/${agentPart(agent)}`
}

/** The branch Hive made before #703 for an agent of that name, exactly: hive/<its slug> (B--1: hive/b--1). */
export const oldHiveBranch = (agent: string): string => `hive/${slugify(agent)}`

/** 0 when `part` is `stem`, n when it is `stem-n` (numbered when taken), else null; case aside. */
function numberOf(part: string, stem: string): number | null {
  const p = part.toLowerCase()
  const s = stem.toLowerCase()
  if (p === s) return 0
  const rest = p.startsWith(`${s}-`) ? p.slice(s.length + 1) : ''
  return /^\d+$/.test(rest) ? Number(rest) : null
}

/**
 * Whether `branch` is one Hive made for an agent called `name` in this project: 0 its own, n one numbered "-n" when it
 * was taken, null not. Either form: hive/<agent> from before, compared with the agent's slug exactly as Hive made it
 * then; hive/<workspace>/<project>/<agent> for this workspace (its own part, or one numbered by `branchSpace`) and
 * project, case aside. Another workspace's or project's branch is never this project's.
 */
export function hiveBranchNumber(branch: string, home: BranchHome, name: string): number | null {
  const old = /^hive\/([^/]+)$/.exec(branch)
  if (old) return numberOf(old[1], slugify(name))
  const full = /^hive\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(branch)
  if (!full || numberOf(full[1], workspacePart(home)) === null || full[2].toLowerCase() !== projectPart(home).toLowerCase()) return null
  return numberOf(full[3], agentPart(name))
}

/**
 * The branches a new worktree on `branch` for an agent called `name` may find an unused worktree on (#456): that branch,
 * and when it is that agent's own full-form branch here, the branch Hive made for that name before (hive/<its slug>).
 */
export function reusableBranches(branch: string, home: BranchHome, name?: string): string[] {
  return name && /^hive\/[^/]+\/[^/]+\/[^/]+$/.test(branch) && hiveBranchNumber(branch, home, name) === 0 ? [branch, oldHiveBranch(name)] : [branch]
}
