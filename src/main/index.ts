import { initWatches, onWatchedCardsMoved, watchKeepsQuitWaiting } from './watches'
import { initAssistantModes } from './assistantMode'
import { app, BrowserWindow, Menu, nativeTheme, Notification, protocol, screen, session, shell } from 'electron'
import { execFile } from 'child_process'
import { appendFileSync, createReadStream, existsSync } from 'original-fs'
import { basename, join, resolve, sep } from 'path'
import { readFile, stat } from 'original-fs/promises'
import { Readable } from 'stream'
import type { AppInfo, McpServerDef, QuitChoice, QuitScope, QuitSession, WindowState } from '../shared/types'
import { providerService } from './providerService'
import { checkGit } from './gitTool'
import { handoverSession, hiveInstructions, projectHandovers, withLatestHandover, wrapsLongCommands } from '../shared/hiveGuidance'
import { notesTree } from './notes'
import { assistantInstructions } from './personas'
import { ASSISTANT_NAME, assistantPersona } from '../shared/assistant'
import { MARKED_LOG } from '../shared/redact'
import { PROVIDERS, projectProviderConfig, providerSettings } from '../shared/providers'
import { projectAgents } from '../shared/defaults'
import { setDateStyle } from '../shared/dates'
import { SERVABLE_EXT, servableType, unwatchAll } from './files'
import { config } from './config'
import { archiveOldDone, endReviews } from './tasks'
import { emit, emitTo, onHiveEvent, toast } from './events'
import { recordLiveCards } from './cardSessions'
import { registerIpc } from './ipc'
import { watchRenderer } from './rendererWatch'
import { startPowerWatch } from './power'
import { startTaskbarFlash } from './taskbar'
import { setTitleBarColors, trackTitleBar } from './titleBar'
import { startBranchWatch } from './branchWatch'
import { createLogger, userText, logsDir } from './logger'
import { killAll } from './ptyHost'
import { installShims } from './progressReporters/shims'
import { insideArchive, onCorruptFile } from './fsutil'
import { apiEnv, assistantApiUrl, startApiServer, startHookServer } from './servers'
import { clearHookAuth } from './hookTokens'
import { assistantHome, assistantTokenFile, endAssistant, newAssistantToken, newTurn } from './assistantControl'
import { sessions } from './sessions'
import { notificationIcon } from './paths'
import { createTray, destroyTray, resourcesDir, setTrayPendingQuit, showWindow } from './tray'
import { keepOffScreen, offScreenOrigin, showOsNotification, testQuiet } from './testQuiet'
import { pinFollower } from './pin'
import { focusedHive, routeAppNotice, setFocusedHive, startNoticeResolver } from './notices'
import { initUpdater, installNow } from './updater'
import { flushMetrics } from './metrics'
import { createWorkspaceService, disposeWorkspaceService, inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { hiveWindows, lastFocused, TITLE_BAR_OVERLAY, registerWindow, unregisterWindow, windowForPath, type HiveWindow } from './windows'
import { abandonWindowStorage } from './storage'
import { agentTokenFile } from './agentTokens'
import { progress, setTaskbarTestHook, startProgress } from './progressService'

const log = createLogger('main')
let quitting = false

/**
 * Notes in hive.log when the main process was busy long enough to be felt (every terminal's typing goes
 * through it), at most once a minute, so pauses can be matched with what Hive was doing.
 */
function watchMainStalls(): void {
  const every = 500
  let last = performance.now()
  let logged = 0
  setInterval(() => {
    const now = performance.now()
    const late = now - last - every
    last = now
    if (late > 250 && Date.now() - logged > 60_000) {
      logged = Date.now()
      log.warn(`The main process was busy for ${Math.round(late)} ms`)
    }
  }, every).unref()
}

// Development builds use their own profile (and Agent API port, see servers.ts) so they can run
// alongside the installed Hive — e.g. while developing Hive from a session inside Hive.
// HIVE_USER_DATA overrides the profile folder for tests.
if (process.env.HIVE_USER_DATA) app.setPath('userData', process.env.HIVE_USER_DATA)
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Hive-Dev'))

// One Hive process, with a window per workspace (like VS Code): starting Hive again brings it forward.
// A quiet test copy's windows are off screen (testQuiet): Chromium mustn't take them for covered and stop drawing them.
if (testQuiet()) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Windows ties the taskbar icon and notification name/icon to this ID. Dev and test builds run as
// electron.exe, so they get their own ID; sharing it made Windows show Electron's icon for Hive.
const APP_ID = app.isPackaged ? 'com.hive.desktop' : 'com.hive.desktop.dev'
app.setAppUserModelId(APP_ID)
if (!app.isPackaged && process.platform === 'win32') registerDevAppId()

/** Names the dev app ID "Hive Dev" with the Hive icon, so its notifications don't say "Electron". */
function registerDevAppId(): void {
  const key = ['HKCU', 'Software', 'Classes', 'AppUserModelId', APP_ID].join('\\')
  const icon = notificationIcon()
  execFile('reg', ['add', key, '/v', 'DisplayName', '/d', 'Hive Dev', '/f'], { windowsHide: true }, () => undefined)
  execFile('reg', ['add', key, '/v', 'IconUri', '/d', icon, '/f'], { windowsHide: true }, () => undefined)
}

// hive-img://img/<encoded absolute path> serves images inside the workspace to the renderer (Images tab thumbnails).
protocol.registerSchemesAsPrivileged([{ scheme: 'hive-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

/** A script a plain Node process runs (hive-mcp.js, hive-progress.js): unpacked from the asar (electron-builder.yml). */
function unpackedScript(name: string): string {
  const p = join(__dirname, name)
  return app.isPackaged ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

function hiveMcpScript(): string {
  return unpackedScript('hive-mcp.js')
}

function appInfo(): AppInfo {
  return {
    name: 'Hive',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logsPath: logsDir(),
    isPackaged: app.isPackaged
  }
}

function titleBarColors(): { color: string; symbolColor: string } {
  const dark = config.settings.appearance.theme === 'dark' || (config.settings.appearance.theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#1f1f1f', symbolColor: '#cccccc' } : { color: '#f3f3f3', symbolColor: '#333333' }
}

/** Whether a saved position is still on a screen. */
function onScreen(b: WindowState): boolean {
  return (
    b.x !== undefined &&
    b.y !== undefined &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width && b.y! < a.y + a.height
    })
  )
}

/**
 * Opens a Hive window, with its own workspace service. `workspacePath` opens that workspace in it;
 * `bounds` places it (a restored window), else it goes over the last focused one, offset like VS Code's.
 */
function createWindow(opts: { workspacePath?: string | null; bounds?: WindowState; hidden?: boolean } = {}): HiveWindow {
  const from = lastFocused()
  let b: WindowState = opts.bounds ?? config.get().window
  if (!opts.bounds && from && !from.win.isDestroyed()) {
    const r = from.win.getNormalBounds()
    b = { x: r.x + 30, y: r.y + 30, width: r.width, height: r.height, maximized: false }
  }
  const visible = onScreen(b)
  // A quiet test copy's windows open off screen, never over the user's (testQuiet).
  const offScreen = testQuiet() ? offScreenOrigin(b.width) : null
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: offScreen ? offScreen.x : visible ? b.x : undefined,
    y: offScreen ? offScreen.y : visible ? b.y : undefined,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // Off screen and never handed the focus either: when the user's active window closes, Windows passes the focus to
    // the next window, and it mustn't be an invisible test window (testQuiet).
    focusable: !offScreen,
    title: 'Hive',
    icon: join(resourcesDir(), 'icon.png'),
    backgroundColor: titleBarColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: TITLE_BAR_OVERLAY },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Enables Chromium's built-in PDF viewer for the Files tab preview.
      plugins: true,
      spellcheck: false
    }
  })
  trackTitleBar(win, titleBarColors())
  // Maximising brings a window on screen and to the front: never for a quiet test copy, which stays off screen.
  if (b.maximized && !offScreen) win.maximize()
  if (offScreen) keepOffScreen(win)
  if (process.platform === 'win32') {
    // Taskbar identity for this window: the installed exe's icon, or the repo icon for dev builds.
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : join(__dirname, '../../build/icon.ico'),
      appIconIndex: 0,
      relaunchDisplayName: app.isPackaged ? 'Hive' : 'Hive Dev'
    })
  }
  const entry = registerWindow(win, createWorkspaceService())
  emit({ type: 'windows-changed', count: hiveWindows().length })
  // A page that crashes or hangs is reloaded (or the user asked); agents run here and keep going.
  watchRenderer(entry, { quitting: () => quitting, openLogs: () => void shell.openPath(logsDir()), quit: () => void quitNow(true) })

  win.once('ready-to-show', () => {
    if (opts.hidden) return
    // A quiet test copy (testQuiet) shows its window without taking focus from whatever the user is doing.
    if (testQuiet()) win.showInactive()
    else win.show()
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    // The last window moved or resized sets where a new window goes.
    config.update((c) => {
      c.window.maximized = maximized
      if (!maximized) Object.assign(c.window, win.getBounds())
    })
    saveWindowsSoon()
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  const sendState = (): void => emitTo(win, { type: 'window-state', maximized: win.isMaximized(), focused: win.isFocused(), alwaysOnTop: win.isAlwaysOnTop() })
  // Always on Top goes with the workspace the window shows (pin.ts): set when one opens in it, off on the welcome page.
  const followPin = pinFollower(win)
  const stopPin = onHiveEvent((e) => {
    if (e.type === 'workspace-changed' && followPin(entry.ws.path)) sendState()
  })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.on('focus', sendState)
  win.on('blur', sendState)

  win.on('minimize', () => {
    if (config.settings.general.minimizeToTray) win.hide()
  })
  win.on('close', (e) => {
    if (quitting || entry.closing) return
    e.preventDefault()
    // The last window: the tray keeps Hive running, or closing it quits (as before there were several).
    if (hiveWindows().length <= 1) {
      if (config.settings.general.closeToTray) win.hide()
      else void requestQuit()
      return
    }
    void requestCloseWindow(entry)
  })
  // The page going (the window closed, or the page reloaded) runs none of its clean-up: the Storage measurements it
  // asked for are abandoned, and those nothing else waits for stop (#260).
  const contents = win.webContents.id
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) abandonWindowStorage(contents)
  })
  win.on('closed', () => {
    stopPin()
    abandonWindowStorage(contents)
    unregisterWindow(entry)
    void disposeWorkspaceService(entry.ws)
    if (!quitting) saveWindows()
    emit({ type: 'windows-changed', count: hiveWindows().length })
  })

  // Links open in the user's browser, never inside Hive.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  if (opts.workspacePath) {
    const path = opts.workspacePath
    void inWorkspace(entry.ws, () => entry.ws.open(path)).catch((e) => log.warn(`Could not reopen ${userText(path)}`, e))
  }
  return entry
}

// ---------------------------------------------------------------------------
// Which windows were open, reopened at the next start (like VS Code).
// ---------------------------------------------------------------------------

function saveWindows(): void {
  const list = hiveWindows().map((e) => {
    const maximized = e.win.isMaximized()
    const r = e.win.getNormalBounds()
    return { workspace: e.ws.path, x: r.x, y: r.y, width: r.width, height: r.height, maximized }
  })
  if (!list.length) return
  config.update((c) => {
    c.windows = list
    // 0.1 reopened one workspace: the last focused window's.
    c.lastWorkspace = lastFocused()?.ws.path ?? list[0].workspace
  })
}

let saveTimer: NodeJS.Timeout | null = null
function saveWindowsSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!quitting) saveWindows()
  }, 500)
}

/** The windows to open at start: those open when Hive last quit, else one window with the last workspace. */
function windowsToRestore(): { workspacePath: string | null; bounds?: WindowState }[] {
  const c = config.get()
  const reopen = config.settings.general.reopenLastWorkspace
  const saved = (c.windows ?? []).filter((w) => !w.workspace || existsSync(w.workspace))
  if (reopen && saved.length) {
    const seen = new Set<string>()
    const out = []
    for (const w of saved) {
      const key = w.workspace?.toLowerCase()
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      out.push({ workspacePath: w.workspace, bounds: { x: w.x, y: w.y, width: w.width, height: w.height, maximized: w.maximized } })
    }
    return out
  }
  const last = reopen && c.lastWorkspace && existsSync(c.lastWorkspace) ? c.lastWorkspace : null
  return [{ workspacePath: last, bounds: c.window }]
}

// ---------------------------------------------------------------------------
// Quitting, and closing one window. Stopping a session loses nothing (it can be resumed), but stopping an
// agent that is working interrupts it — so by default Hive only asks when that would happen, in its own dialog.
// ---------------------------------------------------------------------------

let pendingQuit = false
/** Restart and Update was chosen: install the downloaded update instead of just quitting. */
let installOnQuit = false

/** The running sessions of every window, or of one workspace. */
const quitSessions = (ws?: WorkspaceService): QuitSession[] =>
  sessions
    .liveStates()
    .filter((s) => !ws || workspaceFor(s.projectPath) === ws)
    .map((s) => {
      // A watching agent says what for, and whether quitting when agents finish waits for it (the same rule as workingCount).
      const watch = s.status === 'watching' && s.watch ? { watch: s.watch.label, ...(watchKeepsQuitWaiting(s) ? { keepsQuitWaiting: true } : {}) } : {}
      const wsPath = workspaceOf(s.projectPath).path
      const where = wsPath ? { workspace: basename(wsPath), workspacePath: wsPath } : {}
      if (workspace.isAssistantHome(s.projectPath)) return { projectPath: s.projectPath, project: ASSISTANT_NAME, status: s.status, provider: s.provider, ...where, ...watch }
      const agents = workspaceOf(s.projectPath).info()?.projects.find((p) => p.path.toLowerCase() === s.projectPath.toLowerCase())?.agents.length ?? 1
      return { projectPath: s.projectPath, project: basename(s.projectPath), status: s.status, provider: s.provider, ...where, ...(agents > 1 ? { agent: s.agentName } : {}), ...watch }
    })
/** Agents that are working, or waiting on background tasks that will set them working again. */
// A watching agent whose card is being worked on by another agent isn't done either: it carries on when woken.
const workingCount = (): number => sessions.liveStates().filter((s) => s.status === 'working' || s.status === 'background' || !!watchKeepsQuitWaiting(s)).length

/** Shows the quit (or close) dialog in a window and waits for the answer. */
function ask(e: HiveWindow, req: { sessions: QuitSession[]; unsaved: string[]; scope: QuitScope }): Promise<QuitChoice> {
  showWindow(e.win)
  return new Promise<QuitChoice>((answer) => {
    e.question = { request: req.sessions, unsaved: req.unsaved, scope: req.scope, answer }
    emitTo(e.win, { type: 'quit-request', sessions: req.sessions, unsaved: req.unsaved, scope: req.scope })
  }).finally(() => {
    e.question = null
  })
}

async function requestQuit(opts: { force?: boolean } = {}): Promise<void> {
  if (quitting) return
  // Already waiting to quit: asking again means "now".
  if (pendingQuit) return quitNow(true)
  const asking = hiveWindows().find((e) => e.question)
  if (asking) {
    // A dialog is already open: just bring it forward.
    showWindow(asking.win)
    return
  }
  // Only a quit that goes ahead from here on installs the update; a cancelled one forgets it.
  const forUpdate = installOnQuit
  installOnQuit = false
  const live = sessions.liveStates()
  const mode = config.settings.general.confirmOnQuit
  const unsavedIn = hiveWindows().filter((e) => e.unsaved.length > 0)
  const askSessions = !opts.force && live.length > 0 && (mode === 'always' || (mode === 'working' && sessions.busyStates().length > 0))
  const target = unsavedIn.find((e) => e === lastFocused()) ?? unsavedIn[0] ?? lastFocused()
  if ((askSessions || unsavedIn.length > 0) && target) {
    // Unsaved edits live in each window's page: a window with some is asked about them first.
    for (const other of unsavedIn.filter((e) => e !== target)) {
      const first = await ask(other, { sessions: [], unsaved: other.unsaved, scope: 'app' })
      if (first === 'cancel') return
      // Its files are dealt with, but its agents weren't listed: closing it asks about them as Close Window does.
      if (first === 'window') return closeWindowOnly(other, { unsaved: true })
    }
    const choice = await ask(target, { sessions: askSessions ? quitSessions() : [], unsaved: target.unsaved, scope: 'app' })
    if (choice === 'cancel') return
    // Close this window only: the Close Window path, without asking again about what the dialog listed.
    if (choice === 'window') return closeWindowOnly(target, { sessions: askSessions, unsaved: true })
    installOnQuit = forUpdate
    if (choice === 'wait') return startPendingQuit()
    return quitNow(!askSessions && live.length > 0)
  }
  installOnQuit = forUpdate
  return quitNow(live.length > 0)
}

/** Whether to ask before stopping these sessions: the Confirm on quit setting, the same for quitting, windows and workspaces. */
function askBeforeStopping(mine: QuitSession[]): boolean {
  const mode = config.settings.general.confirmOnQuit
  // The same as quitting's (sessions.busyStates): a watching agent is in the middle of its card loop too.
  const busy = mine.some((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'background' || s.status === 'watching')
  return mine.length > 0 && (mode === 'always' || (mode === 'working' && busy))
}

/**
 * Closing a window's workspace, or switching the window to another one: its agents are stopped, after asking as
 * closing the window does. False when the user cancels. Unsaved files were already dealt with by the page.
 */
async function stopWorkspaceAgents(from: BrowserWindow, scope: 'workspace' | 'switch'): Promise<boolean> {
  const e = hiveWindows().find((x) => x.win === from)
  if (!e) return false
  if (e.question) {
    showWindow(e.win)
    return false
  }
  const mine = quitSessions(e.ws)
  if (mine.length && askBeforeStopping(mine) && (await ask(e, { sessions: mine, unsaved: [], scope })) === 'cancel') return false
  // Also cancels agents still starting (not listed: they have no session yet). No new one starts until the
  // workspace has closed or switched (ipc clears the flag).
  e.ws.closing = true
  await sessions.stopWhereAndWait((s) => workspaceFor(s.projectPath) === e.ws, 3000)
  return true
}

/** What the quit dialog has just dealt with, before Close this window only: its agents (listed) and its unsaved files. */
type AlreadyAsked = { sessions?: boolean; unsaved?: boolean }

/**
 * Closing a window (not the last): its workspace's agents are stopped, after asking as quitting does, about what the
 * quit dialog hasn't already (`done`).
 */
async function requestCloseWindow(e: HiveWindow, done: AlreadyAsked = {}): Promise<void> {
  if (e.question) return showWindow(e.win)
  const mine = quitSessions(e.ws)
  const askSessions = !done.sessions && askBeforeStopping(mine)
  const unsaved = done.unsaved ? [] : e.unsaved
  if (askSessions || unsaved.length) {
    const choice = await ask(e, { sessions: askSessions ? mine : [], unsaved, scope: 'window' })
    if (choice === 'cancel') return
  }
  e.ws.closing = true
  await sessions.stopWhereAndWait((s) => workspaceFor(s.projectPath) === e.ws, 3000)
  saveWindowsWithout(e)
  e.closing = true
  e.win.close()
}

/**
 * The quit dialog's Close this window only (shown only with several windows open). Were it the last window by now,
 * it closes as the last window's X does: to the tray, or quitting.
 */
function closeWindowOnly(e: HiveWindow, done: AlreadyAsked): Promise<void> {
  if (hiveWindows().length > 1) return requestCloseWindow(e, done)
  if (config.settings.general.closeToTray) {
    e.win.hide()
    return Promise.resolve()
  }
  return quitNow(sessions.liveCount() > 0)
}

/** Remembers the windows as they will be once this one has closed. */
function saveWindowsWithout(e: HiveWindow): void {
  const others = hiveWindows().filter((x) => x !== e)
  if (!others.length) return
  config.update((c) => {
    c.windows = (c.windows ?? []).filter((w) => w.workspace?.toLowerCase() !== e.ws.path?.toLowerCase() || !e.ws.path)
  })
}

function startPendingQuit(): void {
  pendingQuit = true
  setTrayPendingQuit(true)
  emit({ type: 'quit-pending', pending: true, working: workingCount() })
  for (const e of hiveWindows()) e.win.hide()
  checkPendingQuit()
}

function cancelPendingQuit(): void {
  if (!pendingQuit) return
  pendingQuit = false
  installOnQuit = false
  setTrayPendingQuit(false)
  emit({ type: 'quit-pending', pending: false, working: 0 })
}

function checkPendingQuit(): void {
  if (!pendingQuit) return
  const working = workingCount()
  if (working === 0) void quitNow(true)
  else emit({ type: 'quit-pending', pending: true, working })
}

async function quitNow(tellUser: boolean): Promise<void> {
  if (quitting) return
  // Remember the windows before they close.
  saveWindows()
  quitting = true
  const stopped = sessions.liveCount()
  // Quitting without a dialog (or after waiting): say where the sessions went, as other notices are told (a banner in
  // the window you are using while it is still open, a Windows notification with Hive in the background, or nothing).
  if (tellUser && stopped > 0) {
    const title = 'Hive has closed'
    const body = `${stopped} session${stopped === 1 ? ' was' : 's were'} stopped. Resume ${stopped === 1 ? 'it' : 'them'} from Hive next time; nothing was lost.`
    routeAppNotice(title, body, () => {
      if (Notification.isSupported()) showOsNotification(new Notification({ title, icon: notificationIcon(), body, silent: true }), title, body)
    })
  }
  await sessions.stopAllAndWait(3000)
  await sessions.flushUsageCache()
  await progress.saveNow().catch(() => undefined)
  await flushMetrics().catch(() => undefined)
  await config.flush()
  if (installOnQuit) installNow()
  else app.quit()
}

/** Archives Done cards past Settings → Board's days in every open workspace (also on open: ipc.ts). */
function archiveOldDoneEverywhere(): void {
  for (const w of openWorkspaces()) void archiveOldDone(w).catch((e) => log.warn('archiving old Done cards', e))
}

function wireSettingsEffects(): void {
  config.onSettingsChanged((s, prev) => {
    emit({ type: 'settings-changed', settings: s })
    setDateStyle({ date: s.general.dateFormat, time: s.general.timeFormat })
    if (s.board.archiveDoneDays !== prev.board.archiveDoneDays) archiveOldDoneEverywhere()
    if (s.general.launchAtLogin !== prev.general.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin, args: ['--hidden'] })
    }
    if (s.appearance.theme !== prev.appearance.theme) {
      nativeTheme.themeSource = s.appearance.theme
      for (const e of hiveWindows()) {
        setTitleBarColors(e.win, titleBarColors())
      }
    }
    const refreshAll = (): void => {
      for (const w of openWorkspaces()) w.scheduleRefresh()
    }
    if (JSON.stringify(s.agentApi) !== JSON.stringify(prev.agentApi)) void startApiServer().then(refreshAll)
    // Session settings changed: refresh "restart to apply", and offer to switch running agents to a new permission mode.
    else if (JSON.stringify(s.providers) !== JSON.stringify(prev.providers) || s.defaultProvider !== prev.defaultProvider || JSON.stringify(s.assistant) !== JSON.stringify(prev.assistant)) refreshAll()
    for (const p of PROVIDERS) {
      const now = providerSettings(s, p.id)
      const before = providerSettings(prev, p.id)
      if (before.enableDangerousMode && !now.enableDangerousMode) void revertDangerousModes(p.id)
      if (JSON.stringify(now.prices) !== JSON.stringify(before.prices)) sessions.clearUsageCache()
      if (now.executablePath !== before.executablePath || (now.enabled && !before.enabled)) void providerService.refresh(p.id, now.enabled)
    }
  })
}

/** A provider's no-guardrails mode was turned off: projects and agents set to it (in every window) go back to Inherit. */
async function revertDangerousModes(provider: string): Promise<void> {
  const danger = PROVIDERS.find((p) => p.id === provider)?.permissionModes.find((m) => m.danger)
  if (!danger) return
  const changed: string[] = []
  for (const w of openWorkspaces()) {
    for (const p of await w.listProjectPaths()) {
      const cfg = await workspace.projectConfig(p)
      let touched = false
      if (projectProviderConfig(cfg, provider).permissionMode === danger.value) {
        await workspace.mutateProjectConfig(p, (now) => ({ providers: { ...now.providers, [provider]: { ...projectProviderConfig(now, provider), permissionMode: 'inherit' } } }))
        touched = true
      }
      for (const a of projectAgents(cfg)) {
        if (a.permissionMode === danger.value) {
          await workspace.updateAgent(p, a.id, { permissionMode: undefined })
          touched = true
        }
      }
      if (touched) changed.push(basename(p))
    }
  }
  if (changed.length) {
    toast('warning', `${danger.label} turned off`, `These projects were switched back to Inherit: ${changed.join(', ')}. Running sessions keep their mode until restarted.`)
  }
}

/** Damaged settings or records found before a window can show them (config.json at startup) wait here. */
const corruptReports: [string, string, boolean][] = []
let reportsReady = false
function showCorrupt(file: string, aside: string, restored: boolean): void {
  log.warn(`${userText(file)} could not be read; set aside as ${userText(aside)}${restored ? ', restored from its .bak copy' : ''}`)
  toast(
    restored ? 'warning' : 'error',
    restored ? `${basename(file)} was damaged and has been restored` : `${basename(file)} was damaged`,
    `${restored ? 'Hive went back to its last good copy.' : 'Hive had no good copy, so it started from defaults.'} The damaged file was kept as ${aside}.`,
    undefined,
    file
  )
}
onCorruptFile((file, aside, restored) => (reportsReady ? showCorrupt(file, aside, restored) : void corruptReports.push([file, aside, restored])))

/** What Hive's windows may use: the clipboard (paste, copy). Everything else web pages can ask for is refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])

app.whenReady().then(async () => {
  config.load()
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  protocol.handle('hive-img', async (req) => {
    const p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    if (!SERVABLE_EXT.test(p) || insideArchive(p) || !workspace.isAllowedPath(p)) return new Response('Not found', { status: 404 })
    // Read with original-fs, never Electron's file: loader, which would open an archive on the path and keep it (#246, #261).
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) return new Response('Not found', { status: 404 })
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { headers: { 'Content-Type': servableType(p), 'Content-Length': String(st.size) } })
  })
  nativeTheme.themeSource = config.settings.appearance.theme
  setDateStyle({ date: config.settings.general.dateFormat, time: config.settings.general.timeFormat })
  Menu.setApplicationMenu(null)
  // Says the log marks the user's own text (userText()), so Copy Diagnostics can tell this run's lines from older ones.
  log.info(`Hive ${app.getVersion()} starting (Electron ${process.versions.electron}; ${MARKED_LOG})`)
  watchMainStalls()
  setInterval(archiveOldDoneEverywhere, 3_600_000).unref()

  workspace.setLiveProvider((p, cfg) => sessions.liveInfo(p, cfg))
  sessions.apiEnv = apiEnv
  // hive-progress on every session's PATH (#137): shims in Hive's bin folder, timings beside them.
  void installShims(join(app.getPath('userData'), 'bin'), { exec: process.execPath, script: unpackedScript('hive-progress.js'), data: join(app.getPath('userData'), 'progress') }).then((dir) => {
    sessions.binDir = dir
    if (!dir) log.warn("Couldn't write the hive-progress command into Hive's bin folder; sessions start without it")
  })
  /** Tests only (development builds): where the hive MCP servers log the calls they ran (tests/scenarios). */
  const testMcpLog = (): Record<string, string> => (!app.isPackaged && process.env.HIVE_TEST_MCP_LOG ? { HIVE_TEST_MCP_LOG: process.env.HIVE_TEST_MCP_LOG } : {})
  sessions.hiveMcp = (projectPath, agentId): McpServerDef | null => {
    const s = config.settings.agentApi
    // The Hive Assistant always has Hive's tools, with its own token and its control level (Settings → Assistant).
    if (workspace.isAssistantHome(projectPath)) {
      const url = assistantApiUrl()
      const ws = workspaceOf(projectPath).path
      if (!url || !ws) return null
      return {
        command: process.execPath,
        args: [hiveMcpScript()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HIVE_API_URL: url,
          HIVE_API_TOKEN_FILE: assistantTokenFile(ws),
          HIVE_PROJECT: '',
          HIVE_WORKSPACE: ws,
          HIVE_ROLE: 'assistant',
          HIVE_ASSISTANT_CONTROL: config.settings.assistant?.control ?? 'projects',
          // Its settings tool (hive_update_setting) is offered only with Change settings on: a change restarts it.
          HIVE_ASSISTANT_SETTINGS: config.settings.assistant?.changeSettings === true ? '1' : '0',
          ...testMcpLog()
        }
      }
    }
    const url = assistantApiUrl()
    if (!s.enabled || !s.provideHiveMcp || !url) return null
    return {
      command: process.execPath,
      args: [hiveMcpScript()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_API_URL: url,
        // The agent's own token (made at each launch), which confines its board calls to its project.
        HIVE_API_TOKEN_FILE: agentId ? agentTokenFile(projectPath, agentId) : '',
        // The Assistant looks after the whole workspace: its tools have no project of their own.
        HIVE_PROJECT: workspace.isAssistantHome(projectPath) ? '' : basename(projectPath),
        // With several windows, the API answers the session's tools for its own workspace.
        HIVE_WORKSPACE: workspaceOf(projectPath).path ?? '',
        // Which agent's tools these are: Hive names it as the author of the handovers it writes.
        ...(agentId ? { HIVE_AGENT_ID: agentId } : {}),
        // Whether its instructions tell it to run long commands through hive-progress unasked.
        HIVE_PROGRESS_COMMANDS: wrapsLongCommands(config.settings.general) ? '1' : '0',
        ...testMcpLog()
      }
    }
  }
  // The hive MCP server's instructions, for providers that don't show MCP instructions to the model (Codex).
  initWatches()
  initAssistantModes()
  // A watcher stops keeping a pending quit waiting when the card it waits on leaves another agent's work (no wake comes).
  onWatchedCardsMoved(() => checkPendingQuit())
  sessions.hiveGuidance = (projectPath) =>
    inWorkspace(workspaceOf(projectPath), async () => {
      if (!sessions.hiveMcp(projectPath)) return ''
      if (workspace.isAssistantHome(projectPath)) return hiveInstructions('', 'assistant')
      const project = basename(projectPath)
      const names = (await workspace.listProjectPaths()).map((p) => basename(p))
      const latest = (await projectHandovers(await notesTree(), project, names, (rel) => readFile(join(workspace.sharedDir, rel), 'utf8')))[0]
      return withLatestHandover(hiveInstructions(project, 'agent', wrapsLongCommands(config.settings.general)), latest?.relPath)
    })
  sessions.recentHandovers = (projectPath, count) =>
    inWorkspace(workspaceOf(projectPath), async () => {
      const names = (await workspace.listProjectPaths()).map((p) => basename(p))
      const recent = (await projectHandovers(await notesTree(), basename(projectPath), names, (rel) => readFile(join(workspace.sharedDir, rel), 'utf8'))).slice(0, count)
      return Promise.all(
        recent.map(async (h) => ({ relPath: h.relPath, modified: h.modified ?? '', session: handoverSession(await readFile(join(workspace.sharedDir, h.relPath), 'utf8').catch(() => '')) }))
      )
    })
  // Each Assistant launch gets a new token; each message to it starts a new turn (with a fresh limit of changes).
  sessions.onAssistantLaunch = async (projectPath) => {
    const ws = workspaceOf(projectPath).path
    if (ws) await newAssistantToken(ws)
  }
  sessions.onAssistantPrompt = (projectPath) => {
    const ws = workspaceOf(projectPath).path
    if (ws) newTurn(ws)
  }
  // When it stops, its token stops working and its questions are withdrawn (its workspace may be closed by now).
  sessions.onAssistantExit = (projectPath) => {
    const ws = resolve(projectPath, '..', '..')
    if (assistantHome(ws).toLowerCase() === resolve(projectPath).toLowerCase()) endAssistant(ws)
  }
  // The Assistant's role and persona (its workspace's choice, else Settings → Assistant's), for its launches.
  sessions.assistantInstructions = (projectPath, agent) => inWorkspace(workspaceOf(projectPath), () => assistantInstructions(assistantPersona(agent, config.settings), config.settings.assistant?.control ?? 'projects', config.settings.assistant?.changeSettings === true))
  // A project's notifications and focus checks use the window showing it.
  sessions.setWindowProvider((projectPath) => (projectPath ? windowForPath(projectPath)?.win : null) ?? lastFocused()?.win ?? null)
  // The window the user is using, for in-app banners (#157): visible, not minimised, focused.
  setFocusedHive(() => {
    const e = hiveWindows().find((x) => !x.win.isDestroyed() && x.win.isVisible() && !x.win.isMinimized() && x.win.isFocused())
    return e ? { win: e.win, workspacePath: e.ws.path, projectPath: e.showing } : null
  })
  sessions.setFocusedWindowProvider(focusedHive)
  // An agent no longer waiting for you: its waiting banner closes, in whichever window shows it.
  startNoticeResolver()
  providerService.setLiveSessionCounter((p) => sessions.liveCount(p))
  // Agents stopped by a refused sign-in can carry on once the CLI is signed in again (#309).
  providerService.onSignedIn((p) => sessions.signedInAgain(p, true))

  // Hook auth files of an earlier run of Hive: their tokens died with it (#345).
  await clearHookAuth()
  await startHookServer()
  await startApiServer()
  wireSettingsEffects()
  startBranchWatch()

  registerIpc(appInfo, {
    quit: () => void requestQuit(),
    decide: (from, choice, dontAskAgain) => {
      const e = hiveWindows().find((x) => x.win === from)
      if (dontAskAgain && (choice === 'now' || choice === 'wait') && e?.question?.scope === 'app') config.updateSettings({ general: { confirmOnQuit: 'never' } })
      e?.question?.answer(choice)
    },
    cancelPending: cancelPendingQuit,
    state: (from) => {
      const q = hiveWindows().find((x) => x.win === from)?.question
      return { request: q?.request ?? null, unsaved: q?.unsaved ?? [], scope: q?.scope ?? 'app', pending: pendingQuit, working: pendingQuit ? workingCount() : 0 }
    },
    setUnsaved: (from, paths) => {
      const e = hiveWindows().find((x) => x.win === from)
      if (e) e.unsaved = paths
    },
    stopWorkspaceAgents,
    newWindow: () => {
      createWindow()
      saveWindowsSoon()
    }
  })

  // Keeps the PC awake while agents work, backs up transcripts when Windows shuts down, refreshes after sleep.
  startPowerWatch()
  startTaskbarFlash()
  // Long runs agents report (the Progress panel): stale runs, and the setting.
  startProgress()
  // Test builds can record the taskbar's progress calls, which the page can't see.
  if (!app.isPackaged && process.env.HIVE_TEST_TASKBAR_LOG) {
    const file = process.env.HIVE_TEST_TASKBAR_LOG
    setTaskbarTestHook((ws, bar) => appendFileSync(file, `${JSON.stringify({ ws, ...bar })}\n`))
  }
  const hidden = config.settings.general.startMinimized || process.argv.includes('--hidden')
  const restore = windowsToRestore()
  for (const w of restore) createWindow({ ...w, hidden })
  // The last restored window is on top: it counts as focused first.
  const first = hiveWindows()[0]
  first?.win.webContents.once('did-finish-load', () => {
    // Give the page a moment to subscribe to events.
    setTimeout(() => {
      reportsReady = true
      for (const r of corruptReports.splice(0)) showCorrupt(...r)
    }, 1500)
  })
  createTray(() => lastFocused()?.win ?? null, {
    quit: () => void requestQuit(),
    quitNow: () => void quitNow(true),
    cancelPendingQuit
  })
  onHiveEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit') checkPendingQuit()
    // A window opened or closed its workspace: remember it for the next start.
    if (e.type === 'workspace-changed') saveWindowsSoon()
    // A card moved to Doing (or was given to a running agent): its session records it.
    if (e.type === 'tasks-changed') void recordLiveCards(e.workspacePath, sessions.liveStates())
    // A reviewer whose session ended isn't reviewing any more: its cards stop showing it.
    if (e.type === 'session-exit' && !workspaceOf(e.projectPath).isAssistantHome(e.projectPath)) {
      void endReviews(basename(e.projectPath), e.agentId, 'its session ended', workspaceOf(e.projectPath)).catch(() => undefined)
    }
  })
  initUpdater({
    restart: () => {
      installOnQuit = true
      void requestQuit()
    }
  })
  void providerService.refresh()
  void checkGit()
})

app.on('second-instance', () => {
  const w = lastFocused()
  if (w) showWindow(w.win)
})

app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault()
    void requestQuit()
  }
})

app.on('will-quit', () => {
  killAll()
  unwatchAll()
  destroyTray()
})

app.on('window-all-closed', () => {
  // Hive lives in the tray; quitting is explicit.
})

process.on('uncaughtException', (e) => log.error('uncaughtException', e))
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))
