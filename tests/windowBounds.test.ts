// A window restored from saved bounds fits the display it opens on (#812): saved on a larger display, it opened running
// off this one's edge, its project tabs laid out for the full width and cut off until the window was resized.
import { describe, expect, it } from 'vitest'
import { fitToWorkArea, placeOnDisplay } from '../src/main/windowBounds'

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

// The developer console's window opens the same way (#862): placeOnDisplay picks the display, fitToWorkArea fits it.
describe('placeOnDisplay', () => {
  const BIG = { x: 0, y: 0, width: 2560, height: 1400 }
  // A stand-in for Electron's screen: the larger display (primary) with the laptop to its right.
  const displays = {
    getAllDisplays: () => [{ workArea: BIG }, { workArea: LAPTOP }],
    getDisplayNearestPoint: (p: { x: number; y: number }) => ({ workArea: p.x >= LAPTOP.x ? LAPTOP : BIG }),
    getPrimaryDisplay: () => ({ workArea: BIG })
  }
  const CONSOLE = { width: 560, height: 320 }

  it('fits bounds to the display their corner is on', () => {
    expect(placeOnDisplay({ x: 3000, y: 100, width: 2400, height: 1300, maximized: false }, CONSOLE, displays)).toEqual({ x: 2560, y: 0, width: 1920, height: 1032, maximized: false })
  })

  it('takes a corner up to 50 px before a display as on it', () => {
    expect(placeOnDisplay({ x: -30, y: -40, width: 1100, height: 720, maximized: false }, CONSOLE, displays)).toEqual({ x: 0, y: 0, width: 1100, height: 720, maximized: false })
  })

  it('fits bounds on no display to the primary one, with no position (centred)', () => {
    expect(placeOnDisplay({ x: 9000, y: 9000, width: 3000, height: 1600, maximized: false }, CONSOLE, displays)).toEqual({ width: 2560, height: 1400, maximized: false })
    expect(placeOnDisplay({ width: 1100, height: 720, maximized: false }, CONSOLE, displays)).toEqual({ width: 1100, height: 720, maximized: false })
  })
})
