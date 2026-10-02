import type { BrowserWindow } from 'electron'
import { titleBarOverlayColors } from '../shared/titleBar'
import { TITLE_BAR_OVERLAY } from './windows'

/**
 * Each window's native buttons: its theme's colours, and how many backdrops its page has up (dialogs, nested or not,
 * the command palette), each of which dims them like the rest of the window. The theme comes from main (settings)
 * and the page (a system theme change); the backdrops only from the page, and a page that reloads has none.
 */
const state = new WeakMap<BrowserWindow, { color: string; symbolColor: string; backdrops: number }>()

function apply(win: BrowserWindow): void {
  const s = state.get(win)
  if (!s || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay({ ...titleBarOverlayColors(s, s.backdrops), height: TITLE_BAR_OVERLAY })
  } catch {
    // Not supported on this platform (only Windows and Linux have the overlay): nothing to dim.
  }
}

/** A new window, with its theme's colours; its page dims them while backdrops are up, until it reloads. */
export function trackTitleBar(win: BrowserWindow, colors: { color: string; symbolColor: string }): void {
  state.set(win, { ...colors, backdrops: 0 })
  win.webContents.on('did-start-loading', () => setTitleBarBackdrops(win, 0))
}

/** The theme's colours for the window's buttons (kept dimmed while a backdrop is up). */
export function setTitleBarColors(win: BrowserWindow, colors: { color: string; symbolColor: string }): void {
  const s = state.get(win)
  state.set(win, { ...colors, backdrops: s?.backdrops ?? 0 })
  apply(win)
}

/** The backdrops the window's page has up now (0: none). */
export function setTitleBarBackdrops(win: BrowserWindow, backdrops: number): void {
  const s = state.get(win)
  const n = Math.max(0, Math.floor(Number(backdrops) || 0))
  if (!s || s.backdrops === n) return
  s.backdrops = n
  apply(win)
}
