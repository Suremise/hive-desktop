/**
 * Agents finishing together: one chime at a time, and one notification for a burst of finishes instead of a
 * pop-up each. Waiting for input is never grouped or delayed (main/sessions.ts notify()).
 */

import type { AppSettings } from './types'

/** At most one chime this often (per window). */
export const CHIME_GAP_MS = 2000
/** Finishes within this long of the last one are told together. */
export const FINISH_GROUP_MS = 3000
/** A steady stream of finishes is told at least this often. */
export const FINISH_GROUP_MAX_MS = 10_000

/**
 * Whether a notification may be shown now (Settings → Notifications): checked when it happens and again when a
 * group of finishes is shown, since the settings or the window's focus may have changed while it was collected.
 * `attentive`: the window showing its project is visible and focused.
 */
export function notificationAllowed(
  n: Pick<AppSettings['notifications'], 'desktopNotifications' | 'notifyOnFinished' | 'notifyOnWaiting' | 'onlyWhenUnfocused'>,
  kind: 'finished' | 'waiting' | 'notice',
  attentive: boolean
): boolean {
  if (!n.desktopNotifications) return false
  if (kind === 'finished' && !n.notifyOnFinished) return false
  if (kind === 'waiting' && !n.notifyOnWaiting) return false
  return !(n.onlyWhenUnfocused && attentive)
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
