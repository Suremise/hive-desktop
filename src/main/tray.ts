import { Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { basename, join } from 'path'
import { mostUrgent } from '../shared/defaults'
import { branchSummary, firstAcross, inbox, inboxStateText, type Inbox, type InboxItem } from '../shared/inbox'
import type { LiveSessionState, ProjectInfo, SessionStatus } from '../shared/types'
import { knownStatus } from './branchWatch'
import { emitTo, onHiveEvent } from './events'
import { resourcesDir } from './paths'
import { presentWindow } from './testQuiet'
import { sessions } from './sessions'
import { restartAndInstall, updateState } from './updater'
import { openWorkspaces, type WorkspaceService } from './workspace'

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
  background: 'Background tasks',
  watching: 'Waiting on cards',
  finished: 'Finished',
  error: 'Error'
}

/** Items the tray lists per section; the rest are counted. */
const TRAY_ITEMS = 10

/** A window's inbox, with each agent's state as it is now (the workspace's cached info has it as of its last refresh). */
function windowInbox(w: WorkspaceService, live: LiveSessionState[]): Inbox {
  const info = w.info()
  if (!info) return { needYou: [], toReview: [] }
  const now = new Map(live.map((s) => [`${s.projectPath.toLowerCase()}#${s.agentId}`, s]))
  const fresh = (p: ProjectInfo): ProjectInfo => ({ ...p, agents: p.agents.map((a) => ({ ...a, live: now.get(`${p.path.toLowerCase()}#${a.id}`) ?? null })) })
  return inbox(info.projects.map(fresh), info.assistant ? fresh(info.assistant) : null, knownStatus)
}

export function showWindow(win: BrowserWindow): void {
  presentWindow(win)
}

export function createTray(getWindow: () => BrowserWindow | null, actions: TrayActions): Tray {
  tray = new Tray(icon('tray'))
  tray.setToolTip('Hive')
  const rebuild = (): void => {
    if (!tray) return
    const live = sessions.liveStates()
    const open = openWorkspaces()
    const boxes = open.map((w) => ({ w, box: windowInbox(w, live) }))
    const needYou = boxes.reduce((n, b) => n + b.box.needYou.length, 0)
    attention = needYou > 0
    tray.setImage(icon(attention ? 'tray-attention' : 'tray'))
    const working = live.filter((s) => s.status === 'working' || s.status === 'background').length
    tray.setToolTip(
      `Hive${open.length ? ` — ${open.map((w) => basename(w.path!)).join(', ')}` : ''}${live.length ? `\n${working} working, ${needYou} need${needYou === 1 ? 's' : ''} you` : ''}${pendingQuit ? '\nWill quit when agents finish' : ''}`
    )
    // The inbox, oldest first across every window: each item shows its agent in the window showing its workspace.
    const inboxSection = (title: string, pick: (b: Inbox) => InboxItem[]): Electron.MenuItemConstructorOptions[] => {
      const { shown, total } = firstAcross(boxes.map(({ w, box }) => ({ owner: w, items: pick(box) })), TRAY_ITEMS)
      if (!total) return []
      const items: Electron.MenuItemConstructorOptions[] = shown.map(({ owner: w, item }) => ({
        label: `${item.assistant ? item.projectName : `${item.projectName} · ${item.agentName}`}  —  ${item.kind === 'review' && item.branch ? branchSummary(item.branch) : inboxStateText(item)}`.slice(0, 120),
        click: () => {
          const win = w.window ?? getWindow()
          if (!win) return
          showWindow(win)
          emitTo(win, { type: 'menu-command', command: 'agent.show', args: [item.projectPath, item.agentId] })
        }
      }))
      if (total > shown.length) items.push({ label: `and ${total - shown.length} more`, enabled: false })
      return [{ label: `${title} (${total})`, enabled: false }, ...items, { type: 'separator' }]
    }
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
        ...inboxSection('Need you', (b) => b.needYou),
        ...inboxSection('To review', (b) => b.toReview),
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
    if (e.type !== 'session-status' && e.type !== 'session-exit' && e.type !== 'workspace-changed' && e.type !== 'update-state' && e.type !== 'branch-status') return
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
