// What Hive says about unused worktrees (#353): shared by the window and its tests.
import type { UnusedWorktree } from './types'
import type { TemplateDeleted } from './templates'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The user guide's heading on kept worktrees. */
export const UNUSED_WORKTREES_GUIDE = 'Unused worktrees'

/** Whether it holds work that is nowhere else: commits not on the main branch, or uncommitted files. */
export const holdsWork = (w: UnusedWorktree): boolean => !w.check.removable && ((w.check.ahead ?? 0) > 0 || (w.check.dirty ?? 0) > 0)

/** Its state in a few words: "Merged into main · clean", "3 commits not on main · 2 changed files", or why git couldn't say. */
export function unusedState(w: UnusedWorktree): string {
  const c = w.check
  if (c.removable) return `Merged into ${c.into} · clean`
  const parts = [(c.ahead ?? 0) > 0 ? (w.branch ? `${plural(c.ahead!, 'commit')} not on ${c.into ?? 'the main branch'}` : `${plural(c.ahead!, 'commit')} on no branch`) : '', (c.dirty ?? 0) > 0 ? plural(c.dirty!, 'changed file') : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : (c.reason ?? "Hive couldn't check it")
}

/** What removing a worktree anyway loses, one line each, as its danger confirm lists them (#353). */
export function lostLines(w: { path: string; branch: string | null; into: string | null; ahead: number; dirty: number }): string[] {
  return [
    ...(w.ahead ? [w.branch ? `${plural(w.ahead, 'commit')} on ${w.branch} not on ${w.into ?? 'any other branch'}` : `${plural(w.ahead, 'commit')} on no branch (only its detached HEAD has ${w.ahead === 1 ? 'it' : 'them'})`] : []),
    ...(w.dirty ? [`${plural(w.dirty, 'uncommitted file')} in ${w.path}`] : []),
    `the files git ignores in its folder (build output, copied .env files)`
  ]
}

/**
 * What Remove anyway loses, as the list shows it; null when git couldn't count it (then there is no Remove anyway: what
 * would go can't be named). The confirmation itself shows what a fresh check finds (`worktrees:removalPreview`).
 */
export function lostByRemoving(w: UnusedWorktree): string[] | null {
  const c = w.check
  if (c.dirty === undefined || c.ahead === undefined) return null
  return lostLines({ path: w.path, branch: w.branch, into: c.into, ahead: c.ahead, dirty: c.dirty })
}

/** The Changes tab's notice (#353), or null: only for unused worktrees holding work. */
export function unusedWorkNotice(list: UnusedWorktree[]): string | null {
  const n = list.filter(holdsWork).length
  if (!n) return null
  const into = list.find(holdsWork)?.check.into
  return `${plural(n, 'unused worktree')} ${n === 1 ? 'has' : 'have'} work that isn't on ${into ?? 'the main branch'}`
}

/**
 * The one notice after deleting a template whose worktree agents left unused worktrees (#353), or null: "3 unused
 * worktrees in hive", with the project to review (the one with most).
 */
export function templateWorktreesHint(left: TemplateDeleted, nameOf: (path: string) => string): { title: string; detail: string; project: string } | null {
  const list = [...left.unusedWorktrees].filter((u) => u.count > 0).sort((a, b) => b.count - a.count)
  if (!list.length) return null
  const n = list.reduce((sum, u) => sum + u.count, 0)
  const where = list.length === 1 ? nameOf(list[0].project) : `${list.length} projects`
  return {
    title: `${plural(n, 'unused worktree')} in ${where}`,
    detail: "The template's worktree agents worked in them. Deleting the template left them as they are: review them in the Overview.",
    project: list[0].project
  }
}
