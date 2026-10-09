import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempRoot } from './tempDir'

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' },
  // eslint-disable-next-line typescript/no-extraneous-class
  // Windows notifications, recorded (supported only where a test says so).
  Notification: class {
    static isSupported(): boolean {
      return (globalThis as { __osSupported?: boolean }).__osSupported === true
    }
    constructor(readonly options: { title: string }) {}
    on(): this {
      return this
    }
    show(): void {
      ;((globalThis as { __osShown?: string[] }).__osShown ??= []).push(this.options.title)
    }
  }
}))

const { config } = await import('../src/main/config')
const { reportPlanUsage } = await import('../src/main/planUsage')
const { onHiveEvent } = await import('../src/main/events')
const { setFocusedHive } = await import('../src/main/notices')
const { DEFAULT_SETTINGS } = await import('../src/shared/defaults')

const usage = (five: number, week = 10) => ({
  provider: 'claude-code',
  plan: null,
  limits: [
    { id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: five, resetsAt: '2026-09-30T00:00:00.000Z' },
    { id: 'seven_day', label: 'weekly', windowMinutes: 10080, usedPercent: week, resetsAt: '2026-10-05T00:00:00.000Z' }
  ],
  updatedAt: new Date().toISOString()
})

describe('reportPlanUsage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves only when a shown value changes, and at most once a minute', () => {
    const saves: number[] = []
    const update = vi.spyOn(config, 'update').mockImplementation(() => void saves.push(Date.now()))
    // Reports several times a second for a minute, as while agents work: same values, new report times.
    for (let i = 0; i < 200; i++) {
      reportPlanUsage('claude-code', usage(12.2))
      vi.advanceTimersByTime(300)
    }
    expect(saves.length).toBe(1) // the first report
    expect(config.get().planUsage['claude-code']?.limits[0].usedPercent).toBe(12.2)
    // Values changing every second for three minutes: still no more than one save a minute.
    for (let s = 0; s < 180; s++) {
      reportPlanUsage('claude-code', usage(13 + s / 10))
      vi.advanceTimersByTime(1000)
    }
    vi.advanceTimersByTime(60_000)
    for (let i = 1; i < saves.length; i++) expect(saves[i] - saves[i - 1]).toBeGreaterThanOrEqual(60_000)
    expect(saves.length).toBeLessThanOrEqual(5)
    // The latest report is always in memory, for the status bar and for the save on quit.
    expect(config.get().planUsage['claude-code']?.limits[0].usedPercent).toBeCloseTo(30.9)
    update.mockRestore()
  })
})

// A warning is kept in the Notifications panel and told as other notices are (#157): never an unconditional toast.
describe('a plan usage warning', () => {
  const g = globalThis as { __osSupported?: boolean; __osShown?: string[] }
  const seen: { type: string; toast?: { quiet?: boolean; title: string }; notice?: { title: string } }[] = []
  let off: () => void
  beforeEach(() => {
    g.__osSupported = true
    g.__osShown = []
    seen.length = 0
    off = onHiveEvent((e) => void seen.push(e as never))
    vi.spyOn(config, 'update').mockImplementation((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get()))
    config.get().planWarnings = {}
  })
  afterEach(() => {
    off()
    vi.restoreAllMocks()
    setFocusedHive(() => null)
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
    g.__osSupported = false
  })
  const win = { isDestroyed: () => false, webContents: { send: () => undefined } }
  const focus = () => setFocusedHive(() => ({ win: win as never, workspacePath: 'C:\\Work\\A', projectPath: 'C:\\Work\\A\\alpha' }))
  const warn = () => {
    reportPlanUsage('claude-code', usage(96))
    const toasts = seen.filter((e) => e.type === 'toast').map((e) => e.toast!)
    return {
      kept: toasts.length === 1 && toasts[0].quiet === true && /96% of your Claude Code 5-hour limit/.test(toasts[0].title),
      visibleToasts: toasts.filter((t) => !t.quiet).length,
      banners: seen.filter((e) => e.type === 'notice').length,
      windows: g.__osShown!.length
    }
  }

  it('Hive in the background: a Windows notification, kept in the panel, no toast', () => {
    expect(warn()).toEqual({ kept: true, visibleToasts: 0, banners: 0, windows: 1 })
  })
  it('a Hive window focused: a banner in it, kept in the panel, no toast, no Windows notification', () => {
    focus()
    expect(warn()).toEqual({ kept: true, visibleToasts: 0, banners: 1, windows: 0 })
  })
  it('focused and Show nothing: only kept in the panel', () => {
    focus()
    config.settings.notifications.whileFocused = 'nothing'
    expect(warn()).toEqual({ kept: true, visibleToasts: 0, banners: 0, windows: 0 })
  })
  it('notifications off: only kept in the panel, focused or not', () => {
    config.settings.notifications.desktopNotifications = false
    expect(warn()).toEqual({ kept: true, visibleToasts: 0, banners: 0, windows: 0 })
  })
})
