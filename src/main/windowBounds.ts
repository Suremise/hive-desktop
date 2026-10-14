import type { WindowState } from '../shared/types'

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Saved window bounds made to fit the display they open on (#812): no wider or taller than its work area (but never
 * under the window's minimum size), and moved in so all of it is on that display. Bounds saved on a larger display, or
 * at another scale, otherwise open running off its edge, laid out for their full size: the project's tabs keep their
 * labels and are cut off at the display's edge until the window is resized. Without a position (no display had it),
 * only the size is fitted: the window is centred.
 */
export function fitToWorkArea(b: WindowState, area: Area, min: { width: number; height: number }): WindowState {
  const width = Math.max(min.width, Math.min(b.width, area.width))
  const height = Math.max(min.height, Math.min(b.height, area.height))
  if (b.x === undefined || b.y === undefined) return { ...b, width, height }
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))
  return { ...b, width, height, x: clamp(b.x, area.x, area.x + area.width - width), y: clamp(b.y, area.y, area.y + area.height - height) }
}
