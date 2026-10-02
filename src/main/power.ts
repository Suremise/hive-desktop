import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from 'electron'
import { agentsWorking, shouldKeepAwake } from '../shared/keepAwake'
import { config } from './config'
import { emit, onHiveEvent } from './events'
import { createLogger } from './logger'
import { sessions } from './sessions'
import { openWorkspaces } from './workspace'

const log = createLogger('power')

let blocker: number | null = null
/** Agents working while the PC is kept awake (0: it isn't). */
let keptFor = 0

/** How many working agents are keeping the PC awake now (0 when nothing is). */
export function keepAwakeCount(): number {
  return keptFor
}

/** Holds or releases Windows' sleep blocker to match the agents and the setting (Settings → General). */
function update(): void {
  const working = agentsWorking(sessions.liveStates())
  const hold = shouldKeepAwake(working, config.settings.general.keepAwake, powerMonitor.isOnBatteryPower())
  if (hold && blocker === null) {
    // The app keeps running; the screen may still turn off and lock.
    blocker = powerSaveBlocker.start('prevent-app-suspension')
    log.info(`Keeping the PC awake while ${working} agent(s) work`)
  } else if (!hold && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
    log.info('No longer keeping the PC awake')
  }
  const count = hold ? working : 0
  if (count !== keptFor) {
    keptFor = count
    emit({ type: 'keep-awake', working: count })
  }
}

/** Windows is shutting down, restarting or signing out: back up the transcripts in the time it gives (it isn't held up). */
function sessionEnding(): void {
  log.info('Windows is ending the session: backing up transcripts')
  void sessions.backupAll(3000)
}

function watchWindow(win: BrowserWindow): void {
  win.on('query-session-end', sessionEnding)
}

export function startPowerWatch(): void {
  onHiveEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit') update()
  })
  config.onSettingsChanged((s, prev) => {
    if (s.general.keepAwake !== prev.general.keepAwake) update()
  })
  powerMonitor.on('on-ac', update)
  powerMonitor.on('on-battery', update)
  // Linux and macOS; Windows tells each window (query-session-end).
  powerMonitor.on('shutdown', sessionEnding)
  for (const w of BrowserWindow.getAllWindows()) watchWindow(w)
  app.on('browser-window-created', (_e, w) => watchWindow(w))
  powerMonitor.on('resume', () => {
    log.info('The PC woke up: refreshing agents and plan usage')
    sessions.refreshAfterResume()
    for (const w of openWorkspaces()) w.scheduleRefresh()
    update()
  })
  update()
}
