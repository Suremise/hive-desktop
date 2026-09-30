import { Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { basename, join } from 'path'
import { mostUrgent } from '../shared/defaults'
import type { SessionStatus } from '../shared/types'
import { emit, onHiveEvent } from './events'
import { resourcesDir } from './paths'
import { sessions } from './sessions'
import { restartAndInstall, updateState } from './updater'
import { workspace } from './workspace'

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

function icon(name: 'tray' | 'tray-attention'): Electron.NativeImage {
  const img = nativeImage.createFromPath(join(resourcesDir(), `${name}.png`))
  const hi = nativeImage.createFromPath(join(resourcesDir(), `${name}@2x.png`))
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
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
    tray.setToolTip(
      `Hive${workspace.path ? ` — ${basename(workspace.path)}` : ''}${live.length ? `\n${working} working, ${waiting} need input` : ''}${pendingQuit ? '\nWill quit when agents finish' : ''}`
    )
    const active = workspace.activeNames()
    const projectItems: Electron.MenuItemConstructorOptions[] = active.length
      ? active.map((name) => {
          const p = workspace.path ? join(workspace.path, name) : name
          const states = sessions.projectStates(p)
          const st = mostUrgent(states)
          return {
            label: `${name}  —  ${STATUS_LABEL[st?.status ?? 'stopped']}${states.length > 1 ? ` (${states.length} agents)` : ''}`,
            click: () => {
              const w = getWindow()
              if (w) showWindow(w)
              emit({ type: 'menu-command', command: 'project.focus', args: [p] })
            }
          }
        })
      : [{ label: 'No active projects', enabled: false }]
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Hive', click: () => { const w = getWindow(); if (w) showWindow(w) } },
        { type: 'separator' },
        { label: 'Active projects', enabled: false },
        ...projectItems,
        { type: 'separator' },
        { label: 'Settings', click: () => { const w = getWindow(); if (w) showWindow(w); emit({ type: 'menu-command', command: 'settings.open' }) } },
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
  onHiveEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit' || e.type === 'workspace-changed' || e.type === 'update-state') rebuild()
  })
  rebuild()
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
