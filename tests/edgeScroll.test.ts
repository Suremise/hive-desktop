// Scrolling a board column while a card is dragged near its edge: nothing in the middle, faster nearer the edge, at
// most EDGE_MAX, never past the ends.
import { describe, expect, it } from 'vitest'
import { clampScroll, EDGE_MAX, EDGE_ZONE, edgeSpeed, frameStep } from '../src/shared/edgeScroll'

describe('edgeSpeed', () => {
  it('nothing in the middle of the area', () => {
    expect(edgeSpeed(500, 100, 900)).toBe(0)
    expect(edgeSpeed(100 + EDGE_ZONE + 1, 100, 900)).toBe(0)
  })

  it('back near the start, on near the end, faster nearer the edge', () => {
    const near = edgeSpeed(105, 100, 900)
    const far = edgeSpeed(140, 100, 900)
    expect(near).toBeLessThan(0)
    expect(far).toBeLessThan(0)
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far))
    expect(edgeSpeed(895, 100, 900)).toBeGreaterThan(edgeSpeed(860, 100, 900))
    expect(edgeSpeed(895, 100, 900)).toBeGreaterThan(0)
  })

  it('at most EDGE_MAX, also past the edge (over a heading)', () => {
    expect(edgeSpeed(100, 100, 900)).toBe(-EDGE_MAX)
    expect(edgeSpeed(60, 100, 900)).toBe(-EDGE_MAX)
    expect(edgeSpeed(950, 100, 900)).toBe(EDGE_MAX)
  })

  it('a short area keeps a middle where nothing scrolls', () => {
    expect(edgeSpeed(130, 100, 160)).toBe(0)
    expect(edgeSpeed(101, 100, 160)).toBeLessThan(0)
  })
})

describe('frameStep', () => {
  it('as fast at 15 frames a second as at 60, with no jump after a pause', () => {
    const second60 = Array.from({ length: 60 }, () => frameStep(EDGE_MAX, 1000 / 60)).reduce((a, b) => a + b, 0)
    const second15 = Array.from({ length: 15 }, () => frameStep(EDGE_MAX, 1000 / 15)).reduce((a, b) => a + b, 0)
    expect(Math.abs(second60 - EDGE_MAX)).toBeLessThan(40)
    expect(Math.abs(second15 - EDGE_MAX)).toBeLessThan(40)
    expect(frameStep(EDGE_MAX, 5000)).toBe(frameStep(EDGE_MAX, 100))
    expect(frameStep(-EDGE_MAX, 16)).toBeLessThan(0)
  })
})

describe('clampScroll', () => {
  it('stops at both ends', () => {
    expect(clampScroll(10, -22, 500)).toBe(0)
    expect(clampScroll(490, 22, 500)).toBe(500)
    expect(clampScroll(200, 22, 500)).toBe(222)
    // Nothing to scroll.
    expect(clampScroll(0, 22, 0)).toBe(0)
  })
})
