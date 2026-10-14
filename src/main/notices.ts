import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import { noticeRoute, type FocusedHive, type NoticeRoute } from '../shared/bursts'
import { englishText } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { asksYou } from '../shared/inbox'
import { config } from './config'
import { emit, emitTo, onHiveEvent, tellListeners } from './events'

/** The Hive window the user is using (visible, not minimised, focused), or none while Hive is in the background. */
let focused: () => (FocusedHive & { win: BrowserWindow }) | null = () => null

export function setFocusedHive(fn: () => (FocusedHive & { win: BrowserWindow }) | null): void {
  focused = fn
}

export function focusedHive(): (FocusedHive & { win: BrowserWindow }) | null {
  return focused()
}

/**
 * Tells an app-wide notice (plan usage, Hive closing) the way agent notices are told (noticeRoute): a banner in the
 * Hive window you are using, a Windows notification (`showWindows`), or nothing (notifications off, or Show nothing).
 * `apiTitle` is the title in English, for the Agent API's stream. Returns where it went.
 */
export function routeAppNotice(title: string, body: string, showWindows: () => void, apiTitle?: string): NoticeRoute {
  const at = focusedHive()
  const route = noticeRoute(config.settings.notifications, 'notice', at, { workspacePath: null, projectPath: null })
  const notice = { id: randomUUID(), kind: 'notice' as const, title, ...(apiTitle ? { apiTitle } : {}), body, projectPath: null }
  if (route === 'windows') {
    // The Agent API's stream hears of it either way (#620).
    tellListeners({ type: 'notice', notice, windows: true })
    showWindows()
  } else if (route === 'banner' && at) emitTo(at.win, { type: 'notice', notice })
  return route
}

const CLOSED = msg({ id: 'main.quit.closed', defaultMessage: 'Hive has closed', description: 'A notice after Hive quit without asking, its sessions stopped.' })
const CLOSED_BODY = msg({ id: 'main.quit.closedBody', defaultMessage: '{n, plural, one {# session was stopped. Resume it from Hive next time; nothing was lost.} other {# sessions were stopped. Resume them from Hive next time; nothing was lost.}}', description: 'The notice after Hive quit: how many sessions it stopped.' })

/** The notice after Hive quit without asking: in the language shown, its title in English for the Agent API too. */
export function closedNotice(stopped: number): { title: string; body: string; apiTitle: string } {
  return { title: tr(CLOSED), body: tr(CLOSED_BODY, { n: stopped }), apiTitle: englishText(CLOSED) }
}

/**
 * In-app banners (#157) for an agent waiting for you stay until handled: once the agent is no longer asking (answered,
 * or it moved on, stopped or ended), every window is told, and closes that agent's waiting banner if it shows one.
 * Returns the unsubscribe.
 */
export function startNoticeResolver(): () => void {
  const asking = new Set<string>()
  const key = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`
  return onHiveEvent((e) => {
    if (e.type === 'session-status') {
      const k = key(e.state.projectPath, e.state.agentId)
      if (asksYou(e.state)) asking.add(k)
      else if (asking.delete(k)) emit({ type: 'notice-resolved', projectPath: e.state.projectPath, agentId: e.state.agentId })
    } else if (e.type === 'session-exit') {
      if (asking.delete(key(e.projectPath, e.agentId))) emit({ type: 'notice-resolved', projectPath: e.projectPath, agentId: e.agentId })
    }
  })
}
