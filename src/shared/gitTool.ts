// Whether git itself can run, and what to tell the user when it can't (#346): shared by the main process, the window and their tests.

/**
 * Git as Hive found it. `missing`: no git on Hive's PATH (or it failed to start); `old`: older than GIT_MIN; `unknown`:
 * not checked yet, or `git --version` answered something else. `version` as git gave it (2.45.1), `path` the executable.
 */
export interface GitTool {
  state: 'ok' | 'missing' | 'old' | 'unknown'
  version?: string
  path?: string
  /** When `unknown`: what went wrong. */
  error?: string
}

/**
 * The oldest git Hive works fully with: `git merge-tree --write-tree` (2.38) checks a merge for conflicts before it
 * starts, recognises squash-merged branches (the unmerged counts, Remove All and template cleanup) and is what the
 * merge-ready skill runs. Below it, those fall back as `gitOldText` says.
 */
export const GIT_MIN = '2.38'
/** The oldest git Hive's commands run with at all: every call passes `--no-optional-locks` (2.15) and removing a worktree is `git worktree remove` (2.17). */
export const GIT_REQUIRED = '2.17'

export const GIT_DOWNLOAD = 'https://git-scm.com/download/win'

/** The user guide's heading on git. */
export const GIT_GUIDE = 'Git'

/** Negative, zero or positive as version a is older than, the same as or newer than b (numbers only: 2.45.1.windows.1 is 2.45.1). */
export function compareGitVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The version in `git --version`'s answer ("git version 2.45.1.windows.1" → 2.45.1), or null. */
export function parseGitVersion(out: string): string | null {
  return /git version (\d+\.\d+(?:\.\d+)?)/i.exec(out)?.[1] ?? null
}

/** The state a version gives. */
export function gitStateOf(version: string): GitTool['state'] {
  return compareGitVersions(version, GIT_MIN) < 0 ? 'old' : 'ok'
}

/** Whether Hive's git commands can't run at all: no git, or one older than GIT_REQUIRED. */
export function gitUnusable(t: GitTool | null | undefined): boolean {
  return t?.state === 'missing' || (t?.state === 'old' && !!t.version && compareGitVersions(t.version, GIT_REQUIRED) < 0)
}

/** What every git-dependent screen says when git can't run (`gitUnusable`), in place of "not a git repository". */
export function gitProblemText(t: GitTool | null | undefined): string | null {
  if (t?.state === 'missing') return "Git isn't installed (or isn't on Hive's PATH)"
  if (gitUnusable(t)) return `Git ${t!.version} is too old for Hive (it needs ${GIT_MIN} or later)`
  return null
}

/** How to fix git missing or too old, after the problem. */
export function gitFixText(t: GitTool | null | undefined): string {
  return t?.state === 'old'
    ? `Update Git for Windows to ${GIT_MIN} or later, then restart Hive.`
    : `Install Git for Windows (${GIT_MIN} or later), or add the folder holding git.exe to your PATH, then restart Hive.`
}

/** What doesn't work with an old git that still runs, for Agent Setup. */
export function gitOldText(version: string): string {
  if (compareGitVersions(version, GIT_REQUIRED) < 0) return `Hive's git commands fail with Git ${version}: worktrees, merging, the Changes tab and the unmerged counts don't work.`
  const lost = [
    'merging can\'t check for conflicts before it starts (the merge still stops at one)',
    'squash-merged branches still count as unmerged, so Remove All and loading a template keep their worktrees',
    'the merge-ready skill can\'t check a branch for conflicts'
  ]
  if (compareGitVersions(version, '2.27') < 0) lost.push('Remove All and loading a template keep the branches of the worktrees they remove')
  if (compareGitVersions(version, '2.30') < 0) lost.push('moving a workspace can\'t repair its worktrees')
  return `With Git ${version}: ${lost.join('; ')}.`
}
