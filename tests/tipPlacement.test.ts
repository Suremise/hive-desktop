// Tooltips go next to their anchor by their measured size (#257): they used to be shifted left as if every tooltip
// were 380 px wide, so a short one near the right edge showed far from its button.
import { describe, expect, it } from 'vitest'
import { placeTip, TIP_GAP, TIP_MARGIN } from '../src/shared/tipPlacement'

const view = { width: 1400, height: 900 }
const box = (left: number, top: number, width = 24, height = 24) => ({ left, top, right: left + width, bottom: top + height })

describe('placeTip', () => {
  it('puts a tooltip below its anchor, left-aligned, when it fits', () => {
    expect(placeTip(box(300, 100), { width: 120, height: 30 }, view)).toEqual({ left: 300, top: 124 + TIP_GAP })
  })

  it("right-aligns a short tooltip at the right edge with its anchor's right edge, not 380 px away", () => {
    const anchor = box(1360, 40) // a ✕ near the right edge
    const p = placeTip(anchor, { width: 50, height: 28 }, view)
    expect(p.left + 50).toBe(anchor.right)
    expect(p.left + 50).toBeLessThanOrEqual(view.width - TIP_MARGIN)
  })

  it('keeps a long tooltip at the right edge inside the window', () => {
    const p = placeTip(box(1380, 40, 12), { width: 360, height: 80 }, view)
    expect(p.left + 360).toBe(view.width - TIP_MARGIN)
  })

  it('goes above its anchor when there is no room below; when neither fits, it is pulled inside the window', () => {
    const anchor = box(600, 870, 40, 22) // the status bar
    expect(placeTip(anchor, { width: 200, height: 40 }, view).top).toBe(870 - TIP_GAP - 40)
    const tall = placeTip(box(600, 400), { width: 200, height: 880 }, view)
    expect(tall.top).toBe(view.height - TIP_MARGIN - 880)
  })

  it('keeps a tooltip at the left edge inside the window', () => {
    expect(placeTip(box(2, 300), { width: 100, height: 30 }, view).left).toBe(TIP_MARGIN)
  })

  it("puts side: 'right' beside its anchor, centred, and flips it left when there's no room", () => {
    const rail = box(4, 200, 34, 34)
    expect(placeTip(rail, { width: 160, height: 30 }, view, 'right')).toEqual({ left: 38 + TIP_GAP, top: 202 })
    const nearRight = box(1300, 200, 34, 34)
    const p = placeTip(nearRight, { width: 160, height: 30 }, view, 'right')
    expect(p.left + 160).toBe(1300 - TIP_GAP)
  })

  it('never puts the top-left corner outside the window, even for a tooltip bigger than it', () => {
    const p = placeTip(box(1390, 890, 5, 5), { width: 2000, height: 2000 }, view)
    expect(p).toEqual({ left: TIP_MARGIN, top: TIP_MARGIN })
  })
})
