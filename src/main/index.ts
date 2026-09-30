import { app, BrowserWindow, Menu, nativeTheme, net, Notification, protocol, screen, session, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { readFile } from 'fs/promises'
import { pathToFileURL } from 'url'
import type { AppInfo, QuitChoice, QuitSession } from '../shared/types'
import { providerService } from './providerService'
import { hiveInstructions, projectHandovers, withLatestHandover } from '../shared/hiveGuidance'
import { notesTree } from './notes'
import { PROVIDERS, projectProviderConfig, providerSettings } from '../shared/providers'
import { projectAgents } from '../shared/defaults'
import { SERVABLE_EXT, unwatchAll } from './files'
import { config } from './config'
import { emit, onHiveEvent, setEventWindow, toast } from './events'
import { registerIpc } from './ipc'
import { createLogger, logsDir } from './logger'
import { killAll } from './ptyHost'
import { onCorruptFile } from './fsutil'
import { apiEnv, startApiServer, startHookServer } from './servers'
import { sessions } from './sessions'
import { notificationIcon } from './paths'
import { createTray, destroyTray, resourcesDir, setTrayPendingQuit, showWindow } from './tray'
import { initUpdater, installNow } from './updater'
import { workspace } from './workspace'

const log = createLogger('main')
let mainWindow: BrowserWindow | null = null
let quitting = false

// Development builds use their own profile (and Agent API port, see servers.ts) so they can run
// alongside the installed Hive — e.g. while developing Hive from a session inside Hive.
// HIVE_USER_DATA overrides the profile folder for tests.
if (process.env.HIVE_USER_DATA) app.setPath('userData', process.env.HIVE_USER_DATA)
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Hive-Dev'))

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

function hiveMcpScript(): string {
  const p = join(__dirname, 'hive-mcp.js')
  // The script is unpacked from the asar archive (see electron-builder.yml) so a plain Node process can run it.
  return app.isPackaged ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
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

function createWindow(): BrowserWindow {
  const saved = config.get().window
  const visible = saved.x !== undefined && saved.y !== undefined && screen.getAllDisplays().some((d) => {
    const b = d.workArea
    return saved.x! >= b.x - 50 && saved.y! >= b.y - 50 && saved.x! < b.x + b.width && saved.y! < b.y + b.height
  })
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: visible ? saved.x : undefined,
    y: visible ? saved.y : undefined,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Hive',
    icon: join(resourcesDir(), 'icon.png'),
    backgroundColor: titleBarColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: 34 },
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
  if (saved.maximized) win.maximize()
  if (process.platform === 'win32') {
    // Taskbar identity for this window: the installed exe's icon, or the repo icon for dev builds.
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : join(__dirname, '../../build/icon.ico'),
      appIconIndex: 0,
      relaunchDisplayName: app.isPackaged ? 'Hive' : 'Hive Dev'
    })
  }

  win.once('ready-to-show', () => {
    const hidden = config.settings.general.startMinimized || process.argv.includes('--hidden')
    if (!hidden) win.show()
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    config.update((c) => {
      c.window.maximized = maximized
      if (!maximized) Object.assign(c.window, win.getBounds())
    })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  const sendState = (): void => emit({ type: 'window-state', maximized: win.isMaximized(), focused: win.isFocused() })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.on('focus', sendState)
  win.on('blur', sendState)

  win.on('minimize', () => {
    if (config.settings.general.minimizeToTray) win.hide()
  })
  win.on('close', (e) => {
    if (!quitting && config.settings.general.closeToTray) {
      e.preventDefault()
      win.hide()
    } else if (!quitting) {
      e.preventDefault()
      void requestQuit()
    }
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
  return win
}

// ---------------------------------------------------------------------------
// Quitting. Stopping a session loses nothing (it can be resumed), but stopping an agent that is
// working interrupts it — so by default Hive only asks when that would happen, in its own dialog.
// ---------------------------------------------------------------------------

let quitRequest: QuitSession[] | null = null
/** Files with unsaved edits in the window (reported by the renderer): quitting always asks about them. */
let unsavedFiles: string[] = []
let answerQuit: ((choice: QuitChoice) => void) | null = null
let pendingQuit = false
/** Restart and Update was chosen: install the downloaded update instead of just quitting. */
let installOnQuit = false

const quitSessions = (): QuitSession[] =>
  sessions.liveStates().map((s) => {
    const agents = workspace.info()?.projects.find((p) => p.path.toLowerCase() === s.projectPath.toLowerCase())?.agents.length ?? 1
    return { projectPath: s.projectPath, project: basename(s.projectPath), status: s.status, provider: s.provider, ...(agents > 1 ? { agent: s.agentName } : {}) }
  })
const workingCount = (): number => sessions.liveStates().filter((s) => s.status === 'working').length

async function requestQuit(opts: { force?: boolean } = {}): Promise<void> {
  if (quitting) return
  // Already waiting to quit: asking again means "now".
  if (pendingQuit) return quitNow(true)
  if (answerQuit) {
    // The dialog is already open: just bring it forward.
    if (mainWindow) showWindow(mainWindow)
    return
  }
  // Only a quit that goes ahead from here on installs the update; a cancelled one forgets it.
  const forUpdate = installOnQuit
  installOnQuit = false
  const live = sessions.liveStates()
  const mode = config.settings.general.confirmOnQuit
  const ask = !opts.force && ((live.length > 0 && (mode === 'always' || (mode === 'working' && sessions.busyStates().length > 0))) || unsavedFiles.length > 0)
  if (ask && mainWindow) {
    showWindow(mainWindow)
    quitRequest = quitSessions()
    const choice = await new Promise<QuitChoice>((answer) => {
      answerQuit = answer
      emit({ type: 'quit-request', sessions: quitRequest!, unsaved: unsavedFiles })
    })
    answerQuit = null
    quitRequest = null
    if (choice === 'cancel') return
    installOnQuit = forUpdate
    if (choice === 'wait') return startPendingQuit()
    return quitNow(false)
  }
  installOnQuit = forUpdate
  return quitNow(live.length > 0)
}

function startPendingQuit(): void {
  pendingQuit = true
  setTrayPendingQuit(true)
  emit({ type: 'quit-pending', pending: true, working: workingCount() })
  mainWindow?.hide()
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
  quitting = true
  const stopped = sessions.liveCount()
  // Quitting without a dialog (or after waiting): say where the sessions went.
  if (tellUser && stopped > 0 && Notification.isSupported() && config.settings.notifications.desktopNotifications) {
    new Notification({
      title: 'Hive has closed',
      icon: notificationIcon(),
      body: `${stopped} session${stopped === 1 ? ' was' : 's were'} stopped. Resume ${stopped === 1 ? 'it' : 'them'} from Hive next time; nothing was lost.`,
      silent: true
    }).show()
  }
  await sessions.stopAllAndWait(3000)
  await config.flush()
  if (installOnQuit) installNow()
  else app.quit()
}

function wireSettingsEffects(): void {
  config.onSettingsChanged((s, prev) => {
    emit({ type: 'settings-changed', settings: s })
    if (s.general.launchAtLogin !== prev.general.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin, args: ['--hidden'] })
    }
    if (s.appearance.theme !== prev.appearance.theme) {
      nativeTheme.themeSource = s.appearance.theme
      try {
        mainWindow?.setTitleBarOverlay({ ...titleBarColors(), height: 34 })
      } catch {
        // ignore
      }
    }
    if (JSON.stringify(s.agentApi) !== JSON.stringify(prev.agentApi)) void startApiServer().then(() => workspace.path && workspace.scheduleRefresh())
    // Session settings changed: refresh "restart to apply", and offer to switch running agents to a new permission mode.
    else if ((JSON.stringify(s.providers) !== JSON.stringify(prev.providers) || s.defaultProvider !== prev.defaultProvider) && workspace.path) workspace.scheduleRefresh()
    for (const p of PROVIDERS) {
      const now = providerSettings(s, p.id)
      const before = providerSettings(prev, p.id)
      if (before.enableDangerousMode && !now.enableDangerousMode) void revertDangerousModes(p.id)
      if (JSON.stringify(now.prices) !== JSON.stringify(before.prices)) sessions.clearUsageCache()
      if (now.executablePath !== before.executablePath || (now.enabled && !before.enabled)) void providerService.refresh(p.id, now.enabled)
    }
  })
}

/** A provider's no-guardrails mode was turned off: projects and agents set to it go back to Inherit. */
async function revertDangerousModes(provider: string): Promise<void> {
  if (!workspace.path) return
  const danger = PROVIDERS.find((p) => p.id === provider)?.permissionModes.find((m) => m.danger)
  if (!danger) return
  const changed: string[] = []
  for (const p of await workspace.listProjectPaths()) {
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
  if (changed.length) {
    toast('warning', `${danger.label} turned off`, `These projects were switched back to Inherit: ${changed.join(', ')}. Running sessions keep their mode until restarted.`)
  }
}

/** Damaged settings or records found before the window can show them (config.json at startup) wait here. */
const corruptReports: [string, string, boolean][] = []
let reportsReady = false
function showCorrupt(file: string, aside: string, restored: boolean): void {
  log.warn(`${file} could not be read; set aside as ${aside}${restored ? ', restored from its .bak copy' : ''}`)
  toast(
    restored ? 'warning' : 'error',
    restored ? `${basename(file)} was damaged and has been restored` : `${basename(file)} was damaged`,
    `${restored ? 'Hive went back to its last good copy.' : 'Hive had no good copy, so it started from defaults.'} The damaged file was kept as ${aside}.`
  )
}
onCorruptFile((file, aside, restored) => (reportsReady ? showCorrupt(file, aside, restored) : void corruptReports.push([file, aside, restored])))

/** What Hive's window may use: the clipboard (paste, copy). Everything else web pages can ask for is refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])

app.whenReady().then(async () => {
  config.load()
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  protocol.handle('hive-img', (req) => {
    const p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    if (!SERVABLE_EXT.test(p) || !workspace.isAllowedPath(p)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(p).toString())
  })
  nativeTheme.themeSource = config.settings.appearance.theme
  Menu.setApplicationMenu(null)
  log.info(`Hive ${app.getVersion()} starting (Electron ${process.versions.electron})`)

  workspace.setLiveProvider((p, cfg) => sessions.liveInfo(p, cfg))
  sessions.apiEnv = apiEnv
  sessions.hiveMcp = (projectPath) => {
    const s = config.settings.agentApi
    const env = apiEnv()
    if (!s.enabled || !s.provideHiveMcp || !env.HIVE_API_URL) return null
    return {
      command: process.execPath,
      args: [hiveMcpScript()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_API_URL: env.HIVE_API_URL,
        HIVE_API_TOKEN_FILE: env.HIVE_API_TOKEN_FILE,
        HIVE_PROJECT: basename(projectPath)
      }
    }
  }
  // The hive MCP server's instructions, for providers that don't show MCP instructions to the model (Codex).
  sessions.hiveGuidance = async (projectPath) => {
    if (!sessions.hiveMcp(projectPath)) return ''
    const project = basename(projectPath)
    const names = (await workspace.listProjectPaths()).map((p) => basename(p))
    const latest = (await projectHandovers(await notesTree(), project, names, (rel) => readFile(join(workspace.sharedDir, rel), 'utf8')))[0]
    return withLatestHandover(hiveInstructions(project), latest?.relPath)
  }
  sessions.latestHandover = async (projectPath) => {
    const names = (await workspace.listProjectPaths()).map((p) => basename(p))
    const latest = (await projectHandovers(await notesTree(), basename(projectPath), names, (rel) => readFile(join(workspace.sharedDir, rel), 'utf8')))[0]
    return latest ? { relPath: latest.relPath, modified: latest.modified ?? '' } : null
  }
  sessions.setWindowProvider(() => mainWindow)
  providerService.setLiveSessionCounter((p) => sessions.liveCount(p))

  await startHookServer()
  await startApiServer()
  wireSettingsEffects()

  registerIpc(() => mainWindow, appInfo, {
    quit: () => void requestQuit(),
    decide: (choice, dontAskAgain) => {
      if (dontAskAgain && choice !== 'cancel') config.updateSettings({ general: { confirmOnQuit: 'never' } })
      answerQuit?.(choice)
    },
    cancelPending: cancelPendingQuit,
    state: () => ({ request: quitRequest, unsaved: quitRequest ? unsavedFiles : [], pending: pendingQuit, working: pendingQuit ? workingCount() : 0 }),
    setUnsaved: (paths) => {
      unsavedFiles = paths
    }
  })
  mainWindow = createWindow()
  setEventWindow(mainWindow)
  mainWindow.webContents.once('did-finish-load', () => {
    // Give the renderer a moment to subscribe to events.
    setTimeout(() => {
      reportsReady = true
      for (const r of corruptReports.splice(0)) showCorrupt(...r)
    }, 1500)
  })
  createTray(() => mainWindow, {
    quit: () => void requestQuit(),
    quitNow: () => void quitNow(true),
    cancelPendingQuit
  })
  onHiveEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit') checkPendingQuit()
  })
  initUpdater({
    restart: () => {
      installOnQuit = true
      void requestQuit()
    }
  })

  const last = config.get().lastWorkspace
  if (config.settings.general.reopenLastWorkspace && last && existsSync(last)) {
    await workspace.open(last).catch((e) => log.warn(`Could not reopen ${last}`, e))
  }
  void providerService.refresh()
})

app.on('second-instance', () => {
  if (mainWindow) showWindow(mainWindow)
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
