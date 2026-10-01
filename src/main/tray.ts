import { Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { basename, join } from 'path'
import { mostUrgent } from '../shared/defaults'
import type { SessionStatus } from '../shared/types'
import { emitTo, onHiveEvent } from './events'
import { resourcesDir } from './paths'
import { sessions } from './sessions'
import { restartAndInstall, updateState } from './updater'
import { openWorkspaces } from './workspace'

let tray: Tray | null = null
let attention = false
let pendingQuit = false
let rebuildTray: () => void = () => undefined

export interface TrayActions {
  quit: () => void
  quitNow: () => void
  cancelPendingQuit: () => void
}

/** Shows or clears the "will quit when agents finish" state in the tray. */
export function setTrayPendingQuit(pending: boolean): void {
  pendingQuit = pending
  rebuildTray()
}

export { resourcesDir }

/** Loaded once: the tray is rebuilt on every status change. */
const icons = new Map<string, Electron.NativeImage>()

function icon(name: 'tray' | 'tray-attention'): Electron.NativeImage {
  const cached = icons.get(name)
  if (cached) return cached
  const img = nativeImage.createFromPath(join(resourcesDir(), `${name}.png`))
  const hi = nativeImage.createFromPath(join(resourcesDir(), `${name}@2x.png`))
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
  icons.set(name, img)
  return img
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  ready: 'Ready',
  working: 'Working…',
  waiting: 'Needs input',
  finished: 'Finished',
  error: 'Error'
}

export function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function createTray(getWindow: () => BrowserWindow | null, actions: TrayActions): Tray {
  tray = new Tray(icon('tray'))
  tray.setToolTip('Hive')
  const rebuild = (): void => {
    if (!tray) return
    const live = sessions.liveStates()
    attention = live.some((s) => s.unseen && (s.status === 'finished' || s.status === 'waiting'))
    tray.setImage(icon(attention ? 'tray-attention' : 'tray'))
    const waiting = live.filter((s) => s.status === 'waiting').length
    const working = live.filter((s) => s.status === 'working').length
    const open = openWorkspaces()
    tray.setToolTip(
      `Hive${open.length ? ` — ${open.map((w) => basename(w.path!)).join(', ')}` : ''}${live.length ? `\n${working} working, ${waiting} need input` : ''}${pendingQuit ? '\nWill quit when agents finish' : ''}`
    )
    // Each window's active projects; a project opens in the window showing its workspace.
    const projectItems: Electron.MenuItemConstructorOptions[] = []
    for (const w of open) {
      const active = w.activeNames()
      if (open.length > 1 && active.length) projectItems.push({ label: basename(w.path!), enabled: false })
      for (const name of active) {
        const p = join(w.path!, name)
        const states = sessions.projectStates(p)
        const st = mostUrgent(states)
        projectItems.push({
          label: `${open.length > 1 ? '   ' : ''}${name}  —  ${STATUS_LABEL[st?.status ?? 'stopped']}${states.length > 1 ? ` (${states.length} agents)` : ''}`,
          click: () => {
            const win = w.window ?? getWindow()
            if (!win) return
            showWindow(win)
            emitTo(win, { type: 'menu-command', command: 'project.focus', args: [p] })
          }
        })
      }
    }
    if (!projectItems.length) projectItems.push({ label: 'No active projects', enabled: false })
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Hive', click: () => { const w = getWindow(); if (w) showWindow(w) } },
        { type: 'separator' },
        { label: 'Active projects', enabled: false },
        ...projectItems,
        { type: 'separator' },
        { label: 'Settings', click: () => { const w = getWindow(); if (w) { showWindow(w); emitTo(w, { type: 'menu-command', command: 'settings.open' }) } } },
        ...(updateState().status === 'ready' ? [{ label: `Restart to Update (${updateState().version})`, click: restartAndInstall }] : []),
        ...(pendingQuit
          ? [
              { label: `Quitting when ${working === 1 ? 'the agent finishes' : `${working} agents finish`}`, enabled: false },
              { label: 'Quit Now', click: actions.quitNow },
              { label: 'Cancel Pending Quit', click: actions.cancelPendingQuit }
            ]
          : [{ label: 'Quit Hive', click: actions.quit }])
      ])
    )
  }
  rebuildTray = rebuild
  tray.on('click', () => {
    const w = getWindow()
    if (!w) return
    if (w.isVisible() && w.isFocused()) w.hide()
    else showWindow(w)
  })
  // A working agent's status changes many times a minute (its cost with every status line): rebuild at most every 500 ms.
  let pending: NodeJS.Timeout | null = null
  onHiveEvent((e) => {
    if (e.type !== 'session-status' && e.type !== 'session-exit' && e.type !== 'workspace-changed' && e.type !== 'update-state') return
    pending ??= setTimeout(() => {
      pending = null
      rebuild()
    }, 500)
  })
  rebuild()
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
