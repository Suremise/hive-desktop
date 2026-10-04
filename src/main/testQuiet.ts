import { appendFileSync } from 'fs'
import { app, screen, type BrowserWindow } from 'electron'

/**
 * Copies of Hive started by the e2e suites (HIVE_TEST_QUIET=1, set by tests/e2e/run.mjs; unpackaged builds only, never
 * on in normal use) don't interrupt the person at the desk: their windows open off screen and never take focus, and
 * Windows notifications, taskbar flashes and the chime don't happen. What would have happened is appended to
 * HIVE_TEST_NOTIFY_LOG (one JSON line each), so suites can check it.
 */
export function testQuiet(): boolean {
  return !app.isPackaged && process.env.HIVE_TEST_QUIET === '1'
}

/** How far left of every screen a quiet test window's right edge is: well beyond any width a suite gives it. */
const OFF_SCREEN_GAP = 8000

/**
 * Where a quiet test copy opens a window: far left of every screen, so it never covers the user's windows, even when a
 * suite makes it as wide as a screen. It still renders (main turns off Chromium's occlusion tracking for test copies),
 * and the suites drive it through the page.
 */
export function offScreenOrigin(width: number): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  return { x: Math.min(...displays.map((d) => d.bounds.x)) - width - OFF_SCREEN_GAP, y: Math.min(...displays.map((d) => d.bounds.y)) }
}

/** Whether any part of these bounds is on a screen. */
function onAnyScreen(b: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some(({ bounds: d }) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y)
}

/** A quiet test copy's window goes straight back off screen whenever a suite moves or resizes part of it onto one. */
export function keepOffScreen(win: BrowserWindow): void {
  const check = (): void => {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    if (!onAnyScreen(b)) return
    const at = offScreenOrigin(b.width)
    win.setPosition(at.x, at.y)
  }
  win.on('move', check)
  win.on('resize', check)
}

/** One line to HIVE_TEST_NOTIFY_LOG, if set (unpackaged builds only). */
export function testNotifyLog(entry: { kind: 'notification' | 'flash' | 'chime'; title?: string; body?: string; projectPath?: string; on?: boolean }): void {
  const file = !app.isPackaged ? process.env.HIVE_TEST_NOTIFY_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    // A test log that can't be written mustn't break Hive.
  }
}

/**
 * Shows a Windows notification, or in a quiet test copy only records it. Returns whether it was shown (so a caller
 * keeps a reference only to one that was).
 */
export function showOsNotification(note: Electron.Notification, title: string, body: string): boolean {
  testNotifyLog({ kind: 'notification', title, body })
  if (testQuiet()) return false
  note.show()
  return true
}

/** Brings a window up for the user: restored, shown and focused; in a quiet test copy, shown without taking focus. */
export function presentWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (testQuiet()) {
    win.showInactive()
    return
  }
  win.show()
  win.focus()
}
