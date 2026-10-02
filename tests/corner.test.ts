// The tip card and toasts keep out of the way: left of the Assistant's panel while it is open, and above a bar with
// buttons (an ended conversation's Resume and New) in their corner.
import { describe, expect, it } from 'vitest'
import { CORNER_BASE, CORNER_GAP, cornerPlacement } from '../src/shared/corner'

const W = 1500
const H = 900
const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom })

describe('cornerPlacement', () => {
  it('the window corner when nothing is in the way', () => {
    expect(cornerPlacement(W, H, null, [], 320, 160)).toEqual({ right: CORNER_GAP, lift: 0 })
  })

  it('left of the Assistant panel while it is open', () => {
    expect(cornerPlacement(W, H, 1070, [], 320, 160).right).toBe(W - 1070 + CORNER_GAP)
  })

  it('above an ended bar in its corner, just clear of its top', () => {
    // The bottom-right pane's bar, under the card's column (1166–1486).
    const bar = box(760, 1500, 820, 856)
    const { lift } = cornerPlacement(W, H, null, [bar], 320, 160)
    expect(H - CORNER_BASE - lift).toBeLessThan(bar.top)
    expect(lift).toBeLessThan(60)
  })

  it("the Assistant's ended bar no longer matters once it sits left of the panel", () => {
    const assistantBar = box(1071, 1500, 815, 852)
    expect(cornerPlacement(W, H, 1070, [assistantBar], 320, 160).lift).toBe(0)
    // With the panel hidden there is no such bar, and with it open it is beside the card.
    expect(cornerPlacement(W, H, null, [assistantBar], 320, 160).lift).toBeGreaterThan(0)
  })

  it('ignores bars beside it, or far above it (an upper pane in a grid)', () => {
    expect(cornerPlacement(W, H, null, [box(0, 600, 820, 856)], 320, 160).lift).toBe(0)
    expect(cornerPlacement(W, H, null, [box(900, 1500, 400, 436)], 320, 160).lift).toBe(0)
  })

  it('the highest of several bars under it', () => {
    const low = box(1000, 1500, 830, 856)
    const high = box(1000, 1500, 790, 826)
    expect(cornerPlacement(W, H, null, [low, high], 320, 160).lift).toBe(cornerPlacement(W, H, null, [high], 320, 160).lift)
  })
})
