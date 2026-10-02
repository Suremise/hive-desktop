import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { chimeAllowed, FINISH_GROUP_MAX_MS, FINISH_GROUP_MS, FinishBatcher, finishedNotice, notificationAllowed, type Finish } from '../src/shared/bursts'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'

const finish = (project: string, agent: string): Finish => ({ projectPath: `C:\\ws\\${project}`, project, agent, title: `${project} · ${agent} finished`, body: `${agent} is done.` })

describe('chimes', () => {
  it('at most one every 2 seconds', () => {
    expect(chimeAllowed(null, 1000)).toBe(true)
    expect(chimeAllowed(1000, 2500)).toBe(false)
    expect(chimeAllowed(1000, 3000)).toBe(true)
  })
})

describe('finished notifications', () => {
  it('one alone reads as before', () => {
    expect(finishedNotice([finish('hive', 'Claude')])).toEqual({ title: 'hive · Claude finished', body: 'Claude is done.' })
  })

  it('several in one project are named; across projects, counted per project', () => {
    expect(finishedNotice([finish('hive', 'Claude'), finish('hive', 'Codex'), finish('hive', 'Agent 3')])).toEqual({ title: '3 agents finished in hive', body: 'Claude, Codex, Agent 3' })
    expect(finishedNotice([finish('hive', 'Claude'), finish('web', 'One'), finish('hive', 'Codex')])).toEqual({ title: '3 agents finished', body: 'hive (2), web (1)' })
  })

  describe('grouping', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('finishes within a few seconds of each other go together, once they stop coming', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      b.add(finish('hive', 'A'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      b.add(finish('hive', 'B'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      expect(sent).toEqual([])
      vi.advanceTimersByTime(500)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B']])
      // A later one is a new group.
      b.add(finish('web', 'C'))
      vi.advanceTimersByTime(FINISH_GROUP_MS)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B'], ['C']])
    })

    it('a steady stream is told at least every 10 seconds', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      for (let i = 0; i < 8; i++) {
        b.add(finish('hive', `Agent ${i}`))
        vi.advanceTimersByTime(2000)
      }
      expect(sent.length).toBeGreaterThanOrEqual(1)
      expect(sent[0].length).toBe(FINISH_GROUP_MAX_MS / 2000)
    })
  })
})

describe('whether a notification may be shown', () => {
  const on = { ...DEFAULT_SETTINGS.notifications }
  it('follows the settings, and only-when-unfocused the window', () => {
    for (const kind of ['finished', 'waiting', 'notice'] as const) {
      expect(notificationAllowed(on, kind, false), kind).toBe(true)
      expect(notificationAllowed(on, kind, true), kind).toBe(false)
      expect(notificationAllowed({ ...on, onlyWhenUnfocused: false }, kind, true), kind).toBe(true)
      expect(notificationAllowed({ ...on, desktopNotifications: false }, kind, false), kind).toBe(false)
    }
    expect(notificationAllowed({ ...on, notifyOnFinished: false }, 'finished', false)).toBe(false)
    expect(notificationAllowed({ ...on, notifyOnFinished: false }, 'waiting', false)).toBe(true)
    expect(notificationAllowed({ ...on, notifyOnWaiting: false }, 'waiting', false)).toBe(false)
    expect(notificationAllowed({ ...on, notifyOnWaiting: false }, 'notice', false)).toBe(true)
  })
})

// SessionManager's own path (notify → the finish group → the Windows notification), with Electron's Notification
// recording what it would show and each project's window a stand-in whose focus the test sets.
describe('a group of finishes, when it is shown', () => {
  const ws = mkdtempSync(join(tmpdir(), 'hive-bursts-'))
  const alpha = join(ws, 'alpha')
  const beta = join(ws, 'beta')
  let focused: Set<string>
  let windows: Map<string, { focus: ReturnType<typeof vi.fn> }>
  let shown: { title?: string; body?: string; click: () => void }[]

  beforeEach(async () => {
    vi.useFakeTimers()
    const electron = await import('electron')
    const { config } = await import('../src/main/config')
    const { sessions } = await import('../src/main/sessions')
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const w = createWorkspaceService()
    w.path = ws
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
    focused = new Set()
    windows = new Map()
    shown = []
    vi.spyOn(electron.Notification, 'isSupported').mockReturnValue(true)
    const clicks = new WeakMap<object, () => void>()
    vi.spyOn(electron.Notification.prototype, 'on').mockImplementation(function (this: object, _ev: unknown, fn: unknown) {
      clicks.set(this, fn as () => void)
      return this as never
    } as never)
    vi.spyOn(electron.Notification.prototype, 'show').mockImplementation(function (this: { options?: { title?: string; body?: string } }) {
      shown.push({ ...this.options, click: () => clicks.get(this)?.() })
    })
    // One window per project, visible; focused while the test says so.
    sessions.setWindowProvider((p) => {
      if (!p) return null
      const key = p.toLowerCase()
      if (!windows.has(key)) windows.set(key, { focus: vi.fn() })
      const fake = { isVisible: () => true, isFocused: () => focused.has(key), isMinimized: () => false, isDestroyed: () => false, show: () => undefined, restore: () => undefined, focus: windows.get(key)!.focus, webContents: { send: () => undefined } }
      return fake as unknown as BrowserWindow
    })
    return async () => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      sessions.setWindowProvider(() => null)
      Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
      await disposeWorkspaceService(w)
    }
  })

  const finished = async (project: string, agent: string): Promise<void> => {
    const { sessions } = await import('../src/main/sessions')
    const name = project === alpha ? 'alpha' : 'beta'
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(project, `${name} · ${agent} finished`, `${agent} is done.`, 'finished', agent)
  }
  const settings = async () => (await import('../src/main/config')).config.settings.notifications
  const titles = () => shown.map((s) => s.title)

  it('agents finishing together: one notification naming them', async () => {
    await finished(alpha, 'One')
    await finished(alpha, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(shown.map((s) => [s.title, s.body])).toEqual([['2 agents finished in alpha', 'One, Two']])
  })

  it('desktop notifications, or finished ones, turned off meanwhile: nothing is shown', async () => {
    for (const off of ['desktopNotifications', 'notifyOnFinished'] as const) {
      await finished(alpha, 'One')
      ;(await settings())[off] = false
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(titles(), off).toEqual([])
      ;(await settings())[off] = true
    }
  })

  it('only when unfocused: the window focused meanwhile shows nothing; turned off meanwhile, it shows', async () => {
    await finished(alpha, 'One')
    focused.add(alpha.toLowerCase())
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual([])
    ;(await settings()).onlyWhenUnfocused = false
    await finished(alpha, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['alpha · Two finished'])
  })

  it("finishes in two windows, one focused meanwhile: only the other's, counted and opened from what is left", async () => {
    await finished(alpha, 'One')
    await finished(beta, 'Two')
    await finished(beta, 'Three')
    focused.add(alpha.toLowerCase())
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(shown.map((s) => [s.title, s.body])).toEqual([['2 agents finished in beta', 'Two, Three']])
    shown[0].click()
    expect(windows.get(beta.toLowerCase())?.focus).toHaveBeenCalled()
    expect(windows.get(alpha.toLowerCase())?.focus).not.toHaveBeenCalled()
  })

  it('waiting for input: shown at once and on its own, while a group of finishes is collected', async () => {
    const { sessions } = await import('../src/main/sessions')
    await finished(alpha, 'One')
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input'])
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
    // The same settings apply: its window focused, or waiting notifications off, it isn't shown.
    focused.add(beta.toLowerCase())
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    focused.clear()
    ;(await settings()).notifyOnWaiting = false
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
  })
})
