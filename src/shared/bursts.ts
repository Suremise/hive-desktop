/**
 * Agents finishing together: one chime at a time, and one notification for a burst of finishes instead of a
 * pop-up each. Waiting for input is never grouped or delayed (main/sessions.ts notify()).
 */

import type { AppSettings } from './types'

/** Where a notice goes: a banner in the focused Hive window, a Windows notification, or nowhere. */
export type NoticeRoute = 'banner' | 'windows' | 'none'

/** The Hive window you are using: the workspace it holds and the project it shows. */
export interface FocusedHive {
  workspacePath: string | null
  projectPath: string | null
}

const samePath = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** At most one chime this often (per window). */
export const CHIME_GAP_MS = 2000
/** Finishes within this long of the last one are told together. */
export const FINISH_GROUP_MS = 3000
/** A steady stream of finishes is told at least this often. */
export const FINISH_GROUP_MAX_MS = 10_000

/**
 * Where a notice goes now (Settings → Notifications): decided when it happens and again when a group of finishes is
 * shown, since the settings or the focus may have changed while it was collected.
 * - Notifications off, or that kind off: nowhere.
 * - No Hive window focused: a Windows notification.
 * - A Hive window focused (`focused`): per *While Hive is focused*: a banner in that window (Show in Hive), nothing, or
 *   a Windows notification. A banner only for what *Show banners for* covers: every window's notices, the focused
 *   window's workspace's, or the project it shows; one it leaves out shows nothing at all. A notice about no project
 *   (plan usage) is for every scope.
 */
export function noticeRoute(
  n: Pick<AppSettings['notifications'], 'desktopNotifications' | 'notifyOnFinished' | 'notifyOnWaiting' | 'whileFocused' | 'bannerScope'>,
  kind: 'finished' | 'waiting' | 'notice',
  focused: FocusedHive | null,
  from: { workspacePath: string | null; projectPath: string | null }
): NoticeRoute {
  if (!n.desktopNotifications) return 'none'
  if (kind === 'finished' && !n.notifyOnFinished) return 'none'
  if (kind === 'waiting' && !n.notifyOnWaiting) return 'none'
  if (!focused) return 'windows'
  if (n.whileFocused === 'nothing') return 'none'
  if (n.whileFocused === 'windows') return 'windows'
  if (!from.projectPath && !from.workspacePath) return 'banner'
  if (n.bannerScope === 'workspace' && !samePath(focused.workspacePath, from.workspacePath)) return 'none'
  if (n.bannerScope === 'project' && !samePath(focused.projectPath, from.projectPath)) return 'none'
  return 'banner'
}

/** How many banners show at once (more are behind "+N more"), and how many that close by themselves are kept. */
export const MAX_BANNERS = 4

/**
 * The banners a window keeps, newest first: every one that stays until handled (a waiting agent's, unless set to close
 * like the others), however many, and the newest MAX_BANNERS of the rest. A new notice never pushes out one waiting.
 */
export function keepNotices<T>(newestFirst: readonly T[], staysUntilHandled: (n: T) => boolean, max = MAX_BANNERS): T[] {
  let others = 0
  return newestFirst.filter((n) => staysUntilHandled(n) || others++ < max)
}

export function chimeAllowed(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= CHIME_GAP_MS
}

export interface Finish {
  projectPath: string
  /** The project's folder name, and the agent's name. */
  project: string
  agent: string
  /** The notification it would get alone. */
  title: string
  body: string
}

/** One notification for finishes that came together: alone as before; else counted, by agent in one project or by project across several. */
export function finishedNotice(items: readonly Finish[]): { title: string; body: string } {
  if (items.length === 1) return { title: items[0].title, body: items[0].body }
  const projects = [...new Set(items.map((i) => i.project))]
  if (projects.length === 1) return { title: `${items.length} agents finished in ${projects[0]}`, body: items.map((i) => i.agent).join(', ') }
  return { title: `${items.length} agents finished`, body: projects.map((p) => `${p} (${items.filter((i) => i.project === p).length})`).join(', ') }
}

/**
 * Collects finishes and hands them over together once none has come for FINISH_GROUP_MS (or FINISH_GROUP_MAX_MS
 * after the first, so a stream of them doesn't wait for ever).
 */
export class FinishBatcher {
  private items: Finish[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstAt = 0

  constructor(
    private readonly flush: (items: Finish[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  add(item: Finish): void {
    if (!this.items.length) this.firstAt = this.now()
    this.items.push(item)
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(FINISH_GROUP_MS, this.firstAt + FINISH_GROUP_MAX_MS - this.now()))
    this.timer = setTimeout(() => this.send(), wait)
  }

  private send(): void {
    this.timer = null
    const items = this.items
    this.items = []
    if (items.length) this.flush(items)
  }
}
