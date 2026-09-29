import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getVersion: () => '0.0.0' },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))

const { config } = await import('../src/main/config')
const { reportPlanUsage } = await import('../src/main/planUsage')

const usage = (five: number, week = 10) => ({
  fiveHour: { usedPercent: five, resetsAt: '2026-09-30T00:00:00.000Z' },
  sevenDay: { usedPercent: week, resetsAt: '2026-10-05T00:00:00.000Z' },
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
      reportPlanUsage(usage(12.2))
      vi.advanceTimersByTime(300)
    }
    expect(saves.length).toBe(1) // the first report
    expect(config.get().planUsage?.fiveHour?.usedPercent).toBe(12.2)
    // Values changing every second for three minutes: still no more than one save a minute.
    for (let s = 0; s < 180; s++) {
      reportPlanUsage(usage(13 + s / 10))
      vi.advanceTimersByTime(1000)
    }
    vi.advanceTimersByTime(60_000)
    for (let i = 1; i < saves.length; i++) expect(saves[i] - saves[i - 1]).toBeGreaterThanOrEqual(60_000)
    expect(saves.length).toBeLessThanOrEqual(5)
    // The latest report is always in memory, for the status bar and for the save on quit.
    expect(config.get().planUsage?.fiveHour?.usedPercent).toBeCloseTo(30.9)
    update.mockRestore()
  })
})
