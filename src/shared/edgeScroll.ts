/**
 * Scrolling while something is dragged near the edge of a scrolling area (the board's columns while a card is
 * dragged): how fast. Nothing in the middle; within EDGE_ZONE of an edge, faster the nearer it gets, up to EDGE_MAX at
 * the edge and beyond it (over a column's heading, above its cards). In pixels a second, so it scrolls as fast however
 * often the window draws (a window in the background draws less often).
 */
export const EDGE_ZONE = 56
export const EDGE_MAX = 1200
const EDGE_MIN = 120
/** The longest frame counted: after a pause (the window was hidden), no jump. */
const MAX_FRAME_MS = 100

/** Pixels a second to scroll for a pointer at `pos` over an area from `start` to `end`: negative back, positive on. */
export function edgeSpeed(pos: number, start: number, end: number, zone = EDGE_ZONE, max = EDGE_MAX): number {
  // A short area: its zones would meet in the middle.
  const z = Math.max(8, Math.min(zone, (end - start) / 3))
  const ramp = (d: number): number => Math.round(EDGE_MIN + (max - EDGE_MIN) * Math.min(1, Math.max(0, 1 - d / z)))
  if (pos - start < z) return -ramp(pos - start)
  if (end - pos < z) return ramp(end - pos)
  return 0
}

/** How far to scroll in a frame of `ms` at `speed` pixels a second. */
export function frameStep(speed: number, ms: number): number {
  return Math.round((speed * Math.min(Math.max(ms, 0), MAX_FRAME_MS)) / 1000)
}

/** `from` moved by `by`, kept within 0 and `limit` (the area's scroll range). */
export function clampScroll(from: number, by: number, limit: number): number {
  return Math.max(0, Math.min(Math.max(0, limit), from + by))
}
