// Where a hover tooltip goes (ui.tsx's Tooltip), from its anchor's box and the tooltip's measured size: next to the
// anchor, inside the window.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Space kept between a tooltip and the window's edge, and between it and its anchor. */
export const TIP_MARGIN = 8
export const TIP_GAP = 8

/**
 * The tooltip's top-left corner. Below the anchor (above when it doesn't fit below), left-aligned with it, or
 * right-aligned with it when that doesn't fit; `side: 'right'` beside it, flipping to its left when there's no room.
 * Always at least TIP_MARGIN inside the window (a tooltip larger than the window keeps its top-left inside).
 */
export function placeTip(anchor: Box, tip: { width: number; height: number }, view: { width: number; height: number }, side?: 'right'): { left: number; top: number } {
  const clamp = (v: number, size: number, limit: number): number => Math.round(Math.max(TIP_MARGIN, Math.min(v, limit - TIP_MARGIN - size)))
  const fitsX = (x: number): boolean => x >= TIP_MARGIN && x + tip.width <= view.width - TIP_MARGIN
  const fitsY = (y: number): boolean => y >= TIP_MARGIN && y + tip.height <= view.height - TIP_MARGIN
  if (side === 'right') {
    const right = anchor.right + TIP_GAP
    const left = anchor.left - TIP_GAP - tip.width
    const x = fitsX(right) || !fitsX(left) ? right : left
    return { left: clamp(x, tip.width, view.width), top: clamp((anchor.top + anchor.bottom) / 2 - tip.height / 2, tip.height, view.height) }
  }
  const below = anchor.bottom + TIP_GAP
  const above = anchor.top - TIP_GAP - tip.height
  const y = fitsY(below) || !fitsY(above) ? below : above
  const x = fitsX(anchor.left) ? anchor.left : anchor.right - tip.width
  return { left: clamp(x, tip.width, view.width), top: clamp(y, tip.height, view.height) }
}
