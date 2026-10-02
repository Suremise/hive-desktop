import { shouldFlash } from '../shared/taskbar'
import { config } from './config'
import { onHiveEvent } from './events'
import { windowForPath } from './windows'

/**
 * Flashes a window's taskbar button when one of its agents starts waiting for your input while the window isn't
 * focused (Settings → Notifications). It stops when the window is focused. The badge and title count are the
 * window's own (renderer, from its attention inbox).
 */
export function startTaskbarFlash(): void {
  const last = new Map<string, string>()
  onHiveEvent((e) => {
    if (e.type === 'session-exit') last.delete(`${e.projectPath.toLowerCase()}#${e.agentId}`)
    if (e.type !== 'session-status') return
    const key = `${e.state.projectPath.toLowerCase()}#${e.state.agentId}`
    const before = last.get(key)
    last.set(key, e.state.status)
    const win = windowForPath(e.state.projectPath)?.win
    if (!win || win.isDestroyed()) return
    if (!shouldFlash(before, e.state.status, win.isFocused(), config.settings.notifications.flashOnWaiting)) return
    win.flashFrame(true)
    win.once('focus', () => !win.isDestroyed() && win.flashFrame(false))
  })
}
