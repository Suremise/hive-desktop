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
  const lost = unsaved ? ` Unsaved changes to ${unsaved === 1 ? 'one file' : `${unsaved} files`} were lost.` : ''
  return `Your agents kept running.${lost}`
}

const STILL_RUNNING = 'Your agents are still running: reloading the window reconnects to them.'

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
          emitTo(win, { type: 'toast', toast: { id: randomUUID(), level: 'warning', title: "Hive's window stopped and was reloaded", message: reloadedMessage(unsaved), timestamp: new Date().toISOString() } })
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
        const choice = await ask({ type: 'error', title: APP_NAME, message: "Hive's window stopped working.", detail: STILL_RUNNING, buttons: ['Reload', 'Open Logs', 'Quit Hive'], defaultId: 0, cancelId: 0 })
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
      void ask({ type: 'warning', title: APP_NAME, message: "Hive's window isn't responding.", detail: `${STILL_RUNNING} Wait for it, or reload it.`, buttons: ['Wait', 'Reload'], defaultId: 0, cancelId: 0 }, prompt.signal)
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
