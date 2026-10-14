// A window restored from saved bounds fits the display it opens on (#812): saved on a larger display, it opened running
// off this one's edge, its project tabs laid out for the full width and cut off until the window was resized.
import { describe, expect, it } from 'vitest'
import { fitToWorkArea } from '../src/main/windowBounds'

const MIN = { width: 900, height: 560 }
// A 1920 x 1080 laptop display to the right of a larger one, its taskbar at the bottom.
const LAPTOP = { x: 2560, y: 0, width: 1920, height: 1032 }

describe('fitToWorkArea', () => {
  it('leaves bounds that already fit alone', () => {
    const b = { x: 2600, y: 40, width: 1400, height: 900, maximized: false }
    expect(fitToWorkArea(b, LAPTOP, MIN)).toEqual(b)
  })

  it('shrinks bounds saved on a larger display, keeping them on this one', () => {
    expect(fitToWorkArea({ x: 2560, y: 0, width: 2400, height: 1300, maximized: false }, LAPTOP, MIN)).toEqual({ x: 2560, y: 0, width: 1920, height: 1032, maximized: false })
  })

  it('moves a window that runs off the right or bottom edge back onto the display', () => {
    expect(fitToWorkArea({ x: 4000, y: 700, width: 1400, height: 800, maximized: false }, LAPTOP, MIN)).toEqual({ x: 3080, y: 232, width: 1400, height: 800, maximized: false })
  })

  it('moves a window that starts a little before the display onto it', () => {
    expect(fitToWorkArea({ x: 2530, y: -20, width: 1400, height: 800, maximized: false }, LAPTOP, MIN)).toEqual({ x: 2560, y: 0, width: 1400, height: 800, maximized: false })
  })

  it('fits only the size when there is no position (the window is centred)', () => {
    expect(fitToWorkArea({ width: 2400, height: 1300, maximized: true }, LAPTOP, MIN)).toEqual({ width: 1920, height: 1032, maximized: true })
  })

  it('never goes under the window minimum, on a display smaller than it', () => {
    const tiny = { x: 0, y: 0, width: 800, height: 500 }
    expect(fitToWorkArea({ x: 0, y: 0, width: 1400, height: 900, maximized: false }, tiny, MIN)).toEqual({ x: 0, y: 0, width: 900, height: 560, maximized: false })
  })
})
