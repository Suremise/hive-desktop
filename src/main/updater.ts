import { app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'

const log = createLogger('updates')

const FIRST_CHECK_DELAY = 30_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: ReturnType<typeof setInterval> | null = null
let restartForUpdate: () => void = () => undefined
/** The check in progress was started by the user, so its result is shown even if nothing is found. */
let manualCheck = false

function set(patch: Partial<UpdateState>, replace = false): void {
  state = replace ? { current: app.getVersion(), ...patch } as UpdateState : { ...state, ...patch }
  emit({ type: 'update-state', state })
}

export function updateState(): UpdateState {
  return state
}

/**
 * Updates come from GitHub Releases (electron-updater reads latest.yml there and checks the
 * installer's SHA-512). Development builds never update, except in tests, which point
 * HIVE_UPDATE_FEED at a local server.
 */
const testFeed = (): string | undefined => (app.isPackaged ? undefined : process.env.HIVE_UPDATE_FEED)
/** The test download cache's folder in %LOCALAPPDATA%: hive-test-updater, or the one HIVE_UPDATE_CACHE names (an e2e lane's). */
const testCache = (): string => {
  const name = process.env.HIVE_UPDATE_CACHE ?? ''
  return /^hive-test-updater-[\w-]+$/.test(name) ? name : 'hive-test-updater'
}

function enabledReason(): string | null {
  if (app.isPackaged) return null
  if (testFeed()) return null
  return 'Updates are checked by the installed app, not development builds.'
}

function applySettings(): void {
  const s = config.settings.updates
  // Downloads are started here rather than by electron-updater, so skipped versions and the
  // "download automatically" setting are honoured.
  autoUpdater.autoDownload = false
  // Test builds (HIVE_UPDATE_FEED) never run what they download.
  autoUpdater.autoInstallOnAppQuit = s.install === 'auto' && !testFeed()
  autoUpdater.allowPrerelease = s.prerelease
  autoUpdater.allowDowngrade = false
  log.info(`Update settings: check ${s.checkAutomatically ? 'on' : 'off'}, download ${s.downloadAutomatically ? 'auto' : 'manual'}, install ${s.install}, pre-releases ${s.prerelease ? 'on' : 'off'}`)
  if (timer) clearInterval(timer)
  timer = s.checkAutomatically && !enabledReason() ? setInterval(() => void check(false), CHECK_INTERVAL) : null
}

function notesOf(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes
  if (!n) return undefined
  if (typeof n === 'string') return n
  return n.map((x) => (x.note ? `### ${x.version}\n\n${x.note}` : '')).filter(Boolean).join('\n\n')
}

function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e)
  if (/\b404\b|not found|no published versions|unable to find latest version|cannot find latest\.yml/i.test(msg)) return 'No release of Hive has been published yet.'
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|net::ERR_/i.test(msg)) return "Couldn't reach GitHub to check for updates. Check your internet connection."
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update did not match its checksum and was discarded.'
  return msg.split('\n')[0].slice(0, 300)
}

const skipped = (version: string): boolean => config.get().skippedUpdate === version

export async function check(manual: boolean): Promise<UpdateState> {
  const reason = enabledReason()
  if (reason) {
    set({ status: 'disabled', error: reason }, true)
    return state
  }
  if (state.status === 'checking' || state.status === 'downloading') return state
  if (state.status === 'ready') {
    // Already downloaded; a manual check just shows it again.
    if (manual) emit({ type: 'update-state', state })
    return state
  }
  manualCheck = manual
  set({ status: 'checking', error: undefined, manual }, false)
  try {
    const r = await autoUpdater.checkForUpdates()
    if (!r || !r.isUpdateAvailable) set({ status: 'up-to-date', skipped: false, checkedAt: new Date().toISOString(), manual })
    // Otherwise the update-available handler has set the state (and maybe started the download).
  } catch (e) {
    log.warn('Update check failed', e)
    set({ status: 'error', error: friendlyError(e), checkedAt: new Date().toISOString(), manual })
  }
  return state
}

export async function download(): Promise<void> {
  if (state.status !== 'available') return
  set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: state.size ?? 0, bytesPerSecond: 0 }, error: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    log.warn('Update download failed', e)
    set({ status: 'error', error: friendlyError(e), progress: undefined })
  }
}

/** Remembers a version the user doesn't want; automatic checks stop offering it. */
export function skip(version: string): void {
  config.update((c) => {
    c.skippedUpdate = version
  })
  if (state.version === version && state.status === 'available') set({ status: 'up-to-date', skipped: true })
}

/** Restart and Update: quit through the normal flow (which asks if agents are working), then install. */
export function restartAndInstall(): void {
  if (state.status !== 'ready') return
  restartForUpdate()
}

/** Called at the very end of quitting when the user chose Restart and Update. */
export function installNow(): void {
  if (testFeed()) {
    log.info(`Test mode: would install ${state.version} and restart`)
    app.quit()
    return
  }
  log.info(`Installing ${state.version} and restarting`)
  autoUpdater.quitAndInstall(true, true)
}

export function initUpdater(opts: { restart: () => void }): void {
  restartForUpdate = opts.restart
  autoUpdater.logger = { info: (m: unknown) => log.info(String(m)), warn: (m: unknown) => log.warn(String(m)), error: (m: unknown) => log.error(String(m)), debug: () => undefined }

  const feed = testFeed()
  if (feed) {
    // Tests: a generic feed, with its own download cache so the installed Hive's is never touched.
    const file = join(app.getPath('userData'), 'test-app-update.yml')
    writeFileSync(file, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${testCache()}\n`)
    autoUpdater.updateConfigPath = file
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const isSkipped = skipped(info.version)
    if (isSkipped && !manualCheck) {
      set({ status: 'up-to-date', skipped: true, checkedAt: new Date().toISOString() })
      return
    }
    set({
      status: 'available',
      version: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: notesOf(info),
      releaseDate: info.releaseDate,
      size: info.files?.[0]?.size,
      skipped: isSkipped,
      checkedAt: new Date().toISOString(),
      progress: undefined
    })
    if (config.settings.updates.downloadAutomatically && !isSkipped) void download()
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    set({ status: 'ready', version: info.version, progress: undefined })
    const auto = config.settings.updates.install === 'auto'
    toast('info', `Hive ${info.version} is ready`, auto ? 'It installs when you quit Hive, or restart now.' : 'Restart Hive to install it.', [{ label: 'Restart and Update', command: 'update.install' }])
  })

  applySettings()
  config.onSettingsChanged((s, prev) => {
    if (JSON.stringify(s.updates) === JSON.stringify(prev.updates)) return
    applySettings()
    if (s.updates.checkAutomatically && !prev.updates.checkAutomatically) void check(false)
  })

  const reason = enabledReason()
  if (reason) set({ status: 'disabled', error: reason }, true)
  else if (config.settings.updates.checkAutomatically) setTimeout(() => void check(false), Number(process.env.HIVE_UPDATE_DELAY) || FIRST_CHECK_DELAY)

  noticeUpdated()
}

/** After an update: a notification pointing at the release notes, once. */
function noticeUpdated(): void {
  const current = app.getVersion()
  const last = config.get().lastRunVersion
  if (last !== current) {
    config.update((c) => {
      c.lastRunVersion = current
      if (c.skippedUpdate && c.skippedUpdate === current) c.skippedUpdate = undefined
    })
  }
  if (!last || last === current || !app.isPackaged) return
  setTimeout(() => toast('success', `Hive updated to ${current}`, 'See what changed in this version.', [{ label: "What's New", command: 'update.releaseNotes', args: [current] }]), 4000)
}
