import { basename, join } from 'path'
import { app, BrowserWindow, nativeTheme, screen, shell, type WebContents } from 'electron'
import type { HiveEvent, WindowState } from '../shared/types'
import { config } from './config'
import { onHiveEvent } from './events'
import { keepOffScreen, offScreenOrigin, testQuiet } from './testQuiet'
import { resourcesDir } from './tray'
import type { HiveWindow } from './windows'

/**
 * The developer console's window (#366, #637): its own window like Chrome DevTools, so it can go on a second screen, one
 * per Hive window and on the workspace that window showed when it opened. It calls only the console's channels (ipc.ts),
 * closes with the window that opened it or when that window leaves its workspace (another opens in it, or it closes), and
 * remembers its size and position.
 */

const consoles = new Map<HiveWindow, BrowserWindow>()
/** A console window's page → the Hive window it belongs to. */
const owners = new Map<number, HiveWindow>()
/** Each console's workspace (lower case): the one its owner showed when it opened. */
const workspaces = new Map<BrowserWindow, string>()

const workspaceKey = (path: string | null | undefined): string => (path ?? '').toLowerCase()

let following = false
/** Closes a console whose owner no longer shows its workspace: its capture and its list end with it. */
function followWorkspaces(): void {
  if (following) return
  following = true
  onHiveEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const [owner, win] of consoles) {
      if (!win.isDestroyed() && workspaceKey(owner.ws.path) !== workspaces.get(win)) win.destroy()
    }
  })
}

const DEFAULT_BOUNDS: WindowState = { width: 1100, height: 720, maximized: false }

/** The IPC channels a console window may call: its sources and subscription, and the settings for its theme. */
export const CONSOLE_WINDOW_CHANNELS: ReadonlySet<string> = new Set(['console:sources', 'console:subscribe', 'console:snapshot', 'settings:get'])

/** The Hive window a console window's page belongs to. */
export function consoleOwner(sender: WebContents): HiveWindow | null {
  return owners.get(sender.id) ?? null
}

/** The console window open for a Hive window. */
export function consoleWindowOf(owner: HiveWindow): BrowserWindow | null {
  const w = consoles.get(owner)
  return w && !w.isDestroyed() ? w : null
}

function dark(): boolean {
  const t = config.settings.appearance.theme
  return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors)
}

function visible(b: WindowState): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return screen.getAllDisplays().some(({ workArea: a }) => b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width && b.y! < a.y + a.height)
}

/** Opens the Hive window's console on its workspace, or brings it forward when it is open. */
export function openConsoleWindow(owner: HiveWindow): BrowserWindow {
  if (!owner.ws.path) throw new Error("Open a workspace first: the developer console shows a workspace's agents and Hive's work there.")
  followWorkspaces()
  const open = consoleWindowOf(owner)
  if (open) {
    if (open.isMinimized()) open.restore()
    // A quiet test copy never takes the focus (testQuiet).
    if (testQuiet()) open.showInactive()
    else open.focus()
    return open
  }
  const b = { ...DEFAULT_BOUNDS, ...config.get().consoleWindow }
  const offScreen = testQuiet() ? offScreenOrigin(b.width) : null
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: offScreen ? offScreen.x : visible(b) ? b.x : undefined,
    y: offScreen ? offScreen.y : visible(b) ? b.y : undefined,
    minWidth: 560,
    minHeight: 320,
    show: false,
    focusable: !offScreen,
    title: `Developer Console — ${basename(owner.ws.path ?? '') || 'Hive'}`,
    icon: join(resourcesDir(), 'icon.png'),
    backgroundColor: dark() ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.removeMenu()
  // Its title names its workspace, which the page doesn't know.
  win.on('page-title-updated', (e) => e.preventDefault())
  if (b.maximized && !offScreen) win.maximize()
  if (offScreen) keepOffScreen(win)
  const id = win.webContents.id
  consoles.set(owner, win)
  owners.set(id, owner)
  workspaces.set(win, workspaceKey(owner.ws.path))
  win.on('closed', () => {
    owners.delete(id)
    workspaces.delete(win)
    if (consoles.get(owner) === win) consoles.delete(owner)
  })
  // It goes with the window that opened it.
  const closeWithOwner = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  owner.win.once('closed', closeWithOwner)
  win.once('closed', () => {
    if (!owner.win.isDestroyed()) owner.win.removeListener('closed', closeWithOwner)
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    const { x, y, width, height } = win.getBounds()
    config.update((c) => {
      const was = c.consoleWindow ?? DEFAULT_BOUNDS
      // A quiet test copy's window is off screen: its size is kept, never that place.
      c.consoleWindow = maximized ? { ...was, maximized } : offScreen ? { ...was, width, height, maximized } : { x, y, width, height, maximized }
    })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.once('ready-to-show', () => (testQuiet() ? win.showInactive() : win.show()))

  // Nothing opens or navigates inside it: links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#console`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'console' })
  return win
}

/** Closes every console window (developer features turned off). */
export function closeConsoleWindows(): void {
  for (const w of consoles.values()) if (!w.isDestroyed()) w.close()
}

/** Sends an event to every console window (the settings, for its theme). */
export function sendToConsoles(event: HiveEvent): void {
  for (const w of consoles.values()) if (!w.isDestroyed()) w.webContents.send('hive:event', event)
}
