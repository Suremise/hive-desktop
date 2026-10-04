// Quiet test copies (src/main/testQuiet.ts): with HIVE_TEST_QUIET=1 an unpackaged Hive shows windows without taking the
// focus and records Windows notifications instead of showing them; without it, everything is as normal.
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepOffScreen, offScreenOrigin, presentWindow, showOsNotification, testNotifyLog, testQuiet } from '../src/main/testQuiet'

// Two screens side by side: one at the origin, one to its left.
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }, { bounds: { x: -1920, y: 200, width: 1920, height: 1080 } }] }
}))

const saved = { quiet: process.env.HIVE_TEST_QUIET, log: process.env.HIVE_TEST_NOTIFY_LOG }
afterEach(() => {
  for (const [k, v] of [['HIVE_TEST_QUIET', saved.quiet], ['HIVE_TEST_NOTIFY_LOG', saved.log]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const fakeWindow = (minimized = false) => ({ isMinimized: vi.fn(() => minimized), restore: vi.fn(), show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() })

describe('quiet test copies', () => {
  it('only with HIVE_TEST_QUIET=1', () => {
    delete process.env.HIVE_TEST_QUIET
    expect(testQuiet()).toBe(false)
    process.env.HIVE_TEST_QUIET = '0'
    expect(testQuiet()).toBe(false)
    process.env.HIVE_TEST_QUIET = '1'
    expect(testQuiet()).toBe(true)
  })

  it('a window is brought up without the focus when quiet, and shown and focused otherwise', () => {
    process.env.HIVE_TEST_QUIET = '1'
    const quiet = fakeWindow(true)
    presentWindow(quiet as never)
    expect(quiet.restore).toHaveBeenCalled()
    expect(quiet.showInactive).toHaveBeenCalled()
    expect(quiet.show).not.toHaveBeenCalled()
    expect(quiet.focus).not.toHaveBeenCalled()
    delete process.env.HIVE_TEST_QUIET
    const normal = fakeWindow()
    presentWindow(normal as never)
    expect(normal.show).toHaveBeenCalled()
    expect(normal.focus).toHaveBeenCalled()
    expect(normal.showInactive).not.toHaveBeenCalled()
  })

  it('a notification is recorded, and shown only when not quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-quiet-'))
    try {
      const log = join(dir, 'notify.log')
      process.env.HIVE_TEST_NOTIFY_LOG = log
      process.env.HIVE_TEST_QUIET = '1'
      const quiet = { show: vi.fn() }
      expect(showOsNotification(quiet as never, 'One finished', 'alpha')).toBe(false)
      expect(quiet.show).not.toHaveBeenCalled()
      delete process.env.HIVE_TEST_QUIET
      const shown = { show: vi.fn() }
      expect(showOsNotification(shown as never, 'Two finished', 'beta')).toBe(true)
      expect(shown.show).toHaveBeenCalled()
      testNotifyLog({ kind: 'flash', on: true })
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(lines.map(({ at: _at, ...e }) => e)).toEqual([
        { kind: 'notification', title: 'One finished', body: 'alpha' },
        { kind: 'notification', title: 'Two finished', body: 'beta' },
        { kind: 'flash', on: true }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('without a log file set, nothing is written and nothing breaks', () => {
    delete process.env.HIVE_TEST_NOTIFY_LOG
    expect(() => testNotifyLog({ kind: 'chime' })).not.toThrow()
  })

  it('test windows open far left of every screen, even as wide as a screen', () => {
    const at = offScreenOrigin(1400)
    expect(at.y).toBe(0)
    expect(at.x + 1400).toBeLessThan(-1920)
    // Widened to a screen's width where it is: still off every screen.
    expect(at.x + 2560).toBeLessThan(-1920)
  })

  it('a test window moved or resized onto a screen goes straight back off', () => {
    const handlers: Record<string, () => void> = {}
    let bounds = { x: -12000, y: 0, width: 1400, height: 850 }
    const win = { isDestroyed: () => false, getBounds: () => bounds, on: (e: string, f: () => void) => (handlers[e] = f), setPosition: vi.fn((x: number, y: number) => (bounds = { ...bounds, x, y })) }
    keepOffScreen(win as never)
    // Still off screen: left alone.
    handlers.resize()
    expect(win.setPosition).not.toHaveBeenCalled()
    // Made 12000 wide: its right edge reaches the left screen. Moved back off.
    bounds = { ...bounds, width: 12000 }
    handlers.resize()
    expect(win.setPosition).toHaveBeenCalledTimes(1)
    expect(bounds.x + bounds.width).toBeLessThan(-1920)
    // Moved onto the main screen: moved back off.
    bounds = { x: 100, y: 100, width: 1400, height: 850 }
    handlers.move()
    expect(bounds.x + bounds.width).toBeLessThan(-1920)
  })
})
