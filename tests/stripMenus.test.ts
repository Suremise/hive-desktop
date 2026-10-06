import { describe, expect, it } from 'vitest'
import { onStripMenu, requestStripMenu, takeStripMenu } from '../src/renderer/src/stripMenus'

describe('strip menus asked for by the palette (#286)', () => {
  it('goes to the strip of its project and menu, once', () => {
    let heard = 0
    const off = onStripMenu(() => heard++)
    requestStripMenu('C:/ws/alpha', 'loadTemplate')
    expect(heard).toBe(1)
    expect(takeStripMenu('C:/ws/beta', 'loadTemplate')).toBe(false)
    expect(takeStripMenu('C:/ws/alpha', 'addFromTemplate')).toBe(false)
    expect(takeStripMenu('C:/ws/alpha', 'loadTemplate')).toBe(true)
    expect(takeStripMenu('C:/ws/alpha', 'loadTemplate')).toBe(false)
    off()
    requestStripMenu('C:/ws/alpha', 'addFromTemplate')
    expect(heard).toBe(1)
    // A strip that shows later still finds it.
    expect(takeStripMenu('C:/ws/alpha', 'addFromTemplate')).toBe(true)
  })
})
