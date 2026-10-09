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

/** Who made it, in a few words (#476): "was B4" (the Hive agent that worked there), "made by Hive", "not made by Hive". */
export function originLabel(w: Pick<UnusedWorktree, 'origin'>): string {
  const o = w.origin
  if (!o) return ''
  if (o.madeBy === 'other') return 'not made by Hive'
  return o.agentName ? `was ${o.agentName}` : 'made by Hive'
}

/** One unused worktree in the Changes tab's picker (#476): "hive/b4 · was B4 · holds work". */
export function unusedPickerLabel(w: UnusedWorktree): string {
  return [w.branch ?? '(detached)', originLabel(w), w.check.removable ? 'merged, clean' : holdsWork(w) ? 'holds work' : 'not checked'].filter(Boolean).join(' · ')
}

/** What each page of the Changes tab shows, in one sentence at the top of the page's right side (#476). */
export const CHANGES_ABOUT = {
  unused: (project: string, into: string | null) =>
    `Worktrees no agent of ${project} works in: kept when their agent was removed, or made outside Hive (by an agent's own git worktree add, say). Open one to see its changes and merge them, or give it to an agent.${into ? ` Those merged into ${into} and clean can go with their branches; the others hold work that is nowhere else.` : ''}`,
  unusedOne: (branch: string, into: string) => `An unused worktree: everything on ${branch} that isn't on ${into}. Merge it, or go back to Unused worktrees to give it to an agent or remove it.`,
  agent: (name: string, branch: string, base: string) => `${name}'s worktree: everything on ${branch} since it left ${base}. Merge… brings it into ${base}.`,
  project: "The project folder: what isn't committed yet, from you or the agents working in the folder itself (those without a worktree)."
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

/** The Overview's line (#400): "7 unused worktrees (7 merged)", or null with none. */
export function unusedSummary(list: UnusedWorktree[]): string | null {
  if (!list.length) return null
  const merged = list.filter((w) => w.check.removable).length
  return `${plural(list.length, 'unused worktree')} (${merged} merged)`
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
    detail: "The template's worktree agents worked in them. Deleting the template left them as they are: review them in Changes.",
    project: list[0].project
  }
}
