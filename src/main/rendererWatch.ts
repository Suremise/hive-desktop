import { msg, tr } from '../shared/i18n'
import { dialog, type MessageBoxOptions, type RenderProcessGoneDetails } from 'electron'
import { randomUUID } from 'crypto'
import { emitTo } from './events'
import { createLogger } from './logger'
import type { HiveWindow } from './windows'
import { APP_NAME } from '../shared/appName'

const log = createLogger('window')

/** A second crash within this long doesn't reload again: it asks, so a page that crashes on load can't loop. */
export const CRASH_LOOP_MS = 60_000
/** How long a window may hang before Hive offers to reload it. */
const HANG_MS = 4000

/** What to do about a window's renderer that has gone: reload it, or ask (it crashed again soon after a reload). */
export function crashResponse(lastCrashAt: number | null, now: number): 'reload' | 'ask' {
  return lastCrashAt !== null && now - lastCrashAt < CRASH_LOOP_MS ? 'ask' : 'reload'
}

/** The note shown once a crashed window has reloaded. */
export function reloadedMessage(unsaved: number): string {
  return unsaved
    ? tr(msg({ id: 'main.window.reloadedLost', defaultMessage: '{n, plural, one {Your agents kept running. Unsaved changes to one file were lost.} other {Your agents kept running. Unsaved changes to # files were lost.}}', description: "The notice after Hive's window crashed and was reloaded, when files had unsaved edits. {n} is how many." }), { n: unsaved })
    : tr(msg({ id: 'main.window.reloaded', defaultMessage: 'Your agents kept running.', description: "The notice after Hive's window crashed and was reloaded." }))
}

const stillRunning = (): string => tr(msg({ id: 'main.window.stillRunning', defaultMessage: 'Your agents are still running: reloading the window reconnects to them.', description: "Hive's question when its window stopped or isn't responding." }))

/**
 * Keeps a window usable when its page crashes or hangs. Agents run in the main process, so they're
 * unaffected; only the page is reloaded (its terminals reattach, as after View → Reload), and the window
 * keeps its workspace. Each window is watched on its own.
 */
export function watchRenderer(entry: HiveWindow, opts: { quitting: () => boolean; openLogs: () => void; quit: () => void }): void {
  const win = entry.win
  let lastCrashAt: number | null = null
  // A reload Hive asked for after a hang crashes the page first: not a crash to report.
  let expectGone = false
  let hangTimer: NodeJS.Timeout | null = null
  let hangPrompt: AbortController | null = null

  const ask = (options: MessageBoxOptions, signal?: AbortSignal): Promise<number> =>
    dialog.showMessageBox(win, { ...options, ...(signal ? { signal } : {}), noLink: true }).then((r) => r.response)

  const reload = (afterCrash: boolean): void => {
    if (win.isDestroyed()) return
    const unsaved = entry.unsaved.length
    entry.unsaved = []
    if (afterCrash) {
      win.webContents.once('did-finish-load', () => {
        // Give the page a moment to subscribe to events.
        setTimeout(() => {
          if (win.isDestroyed()) return
          emitTo(win, { type: 'toast', toast: { id: randomUUID(), level: 'warning', title: tr(msg({ id: 'main.window.reloadedTitle', defaultMessage: "Hive's window stopped and was reloaded", description: "A notice's title after Hive's window crashed and was reloaded." })), message: reloadedMessage(unsaved), timestamp: new Date().toISOString() } })
        }, 1500)
      })
    }
    win.webContents.reload()
  }

  win.webContents.on('render-process-gone', (_e, details: RenderProcessGoneDetails) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || opts.quitting()) return
    clearHang()
    if (expectGone) {
      expectGone = false
      // The reload asked for with the crash can land before it, and go with the old page.
      if (win.webContents.isCrashed()) reload(false)
      return
    }
    log.error(`The window's page stopped (${details.reason}, exit code ${details.exitCode})`)
    const now = Date.now()
    const response = crashResponse(lastCrashAt, now)
    lastCrashAt = now
    if (response === 'reload') return reload(true)
    void (async () => {
      for (;;) {
        const choice = await ask({
          type: 'error',
          title: APP_NAME,
          message: tr(msg({ id: 'main.window.stopped', defaultMessage: "Hive's window stopped working.", description: "Hive's question when its window crashed again soon after a reload." })),
          detail: stillRunning(),
          buttons: [tr(msg({ id: 'main.window.reload', defaultMessage: 'Reload', description: "Button: reloads Hive's window." })), tr(msg({ id: 'main.window.openLogs', defaultMessage: 'Open Logs', description: "Button: opens the folder of Hive's log files." })), tr(msg({ id: 'main.window.quit', defaultMessage: 'Quit Hive', description: 'Button: quits Hive.' }))],
          defaultId: 0,
          cancelId: 0
        })
        if (choice === 1) {
          opts.openLogs()
          continue
        }
        if (choice === 2) return opts.quit()
        return reload(true)
      }
    })()
  })

  const clearHang = (): void => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
    hangPrompt?.abort()
    hangPrompt = null
  }

  win.on('unresponsive', () => {
    if (hangTimer || hangPrompt || win.isDestroyed()) return
    hangTimer = setTimeout(() => {
      hangTimer = null
      if (win.isDestroyed() || opts.quitting()) return
      log.warn("The window's page isn't responding")
      const prompt = new AbortController()
      hangPrompt = prompt
      void ask(
        {
          type: 'warning',
          title: APP_NAME,
          message: tr(msg({ id: 'main.window.unresponsive', defaultMessage: "Hive's window isn't responding.", description: "Hive's question when its window has stopped responding." })),
          detail: tr(msg({ id: 'main.window.unresponsiveDetail', defaultMessage: '{stillRunning} Wait for it, or reload it.', description: "Hive's question when its window isn't responding. {stillRunning} says the agents are still running." }), { stillRunning: stillRunning() }),
          buttons: [tr(msg({ id: 'main.window.wait', defaultMessage: 'Wait', description: "Button: waits for Hive's window to respond." })), tr(msg({ id: 'main.window.reload', defaultMessage: 'Reload', description: "Button: reloads Hive's window." }))],
          defaultId: 0,
          cancelId: 0
        },
        prompt.signal
      )
        .then((choice) => {
          if (prompt.signal.aborted || hangPrompt !== prompt) return
          hangPrompt = null
          if (choice !== 1 || win.isDestroyed()) return
          log.warn('Reloading the window after it stopped responding')
          // A hung page can't reload itself: end it first (Electron's way), then load it again.
          expectGone = true
          win.webContents.forcefullyCrashRenderer()
          reload(false)
        })
        .catch(() => undefined)
    }, HANG_MS)
  })

  // It recovered: no need to ask any more.
  win.on('responsive', () => clearHang())
}
