// In-app banners (#157): a waiting agent's banner stays until it is answered; main tells every window once the agent
// no longer asks (src/main/notices.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emit, onHiveEvent } from '../src/main/events'
import { routeAppNotice, setFocusedHive, startNoticeResolver } from '../src/main/notices'
import { config } from '../src/main/config'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { HiveEvent, LiveSessionState } from '../src/shared/types'

const state = (agentId: string, status: LiveSessionState['status'], question?: string): LiveSessionState =>
  ({ projectPath: 'C:\\Work\\Alpha', agentId, status, ...(question ? { question } : {}) }) as LiveSessionState

describe('closing waiting banners', () => {
  it('once an agent stops asking, or its session ends, every window hears it; never for one that was not asking', () => {
    const stop = startNoticeResolver()
    const resolved: string[] = []
    const off = onHiveEvent((e: HiveEvent) => {
      if (e.type === 'notice-resolved') resolved.push(e.agentId)
    })
    try {
      emit({ type: 'session-status', state: state('a1', 'working') })
      emit({ type: 'session-status', state: state('a1', 'finished') })
      expect(resolved).toEqual([])
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      expect(resolved).toEqual([])
      // Answered: it works again.
      emit({ type: 'session-status', state: state('a1', 'working') })
      expect(resolved).toEqual(['a1'])
      // A question while it works counts as asking; answered, it resolves.
      emit({ type: 'session-status', state: state('a2', 'working', 'Which branch?') })
      emit({ type: 'session-status', state: state('a2', 'working') })
      expect(resolved).toEqual(['a1', 'a2'])
      // Waiting, then the session ends.
      emit({ type: 'session-status', state: state('a3', 'waiting') })
      emit({ type: 'session-exit', projectPath: 'C:\\Work\\Alpha', agentId: 'a3', sessionId: 's', exitCode: 0 })
      expect(resolved).toEqual(['a1', 'a2', 'a3'])
      emit({ type: 'session-exit', projectPath: 'C:\\Work\\Alpha', agentId: 'a3', sessionId: 's', exitCode: 0 })
      expect(resolved).toEqual(['a1', 'a2', 'a3'])
    } finally {
      off()
      stop()
    }
  })
})

// "Hive has closed" (index.ts quitNow) and plan usage go through routeAppNotice: as agent notices, by noticeRoute.
describe('an app-wide notice (Hive closing, plan usage)', () => {
  afterEach(() => {
    setFocusedHive(() => null)
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
  })
  const sentTo: unknown[] = []
  const win = { isDestroyed: () => false, webContents: { send: (_c: string, e: unknown) => sentTo.push(e) } }
  const tell = () => {
    sentTo.length = 0
    const showWindows = vi.fn()
    const route = routeAppNotice('Hive has closed', '2 sessions were stopped.', showWindows)
    const banners = sentTo.filter((e) => (e as { type: string }).type === 'notice') as { notice: { kind: string; title: string; projectPath: string | null } }[]
    return { route, windows: showWindows.mock.calls.length, banners: banners.map((b) => [b.notice.kind, b.notice.title, b.notice.projectPath]) }
  }
  const focus = () => setFocusedHive(() => ({ win: win as never, workspacePath: 'C:\\Work\\A', projectPath: null }))

  it('Hive in the background: a Windows notification', () => {
    expect(tell()).toEqual({ route: 'windows', windows: 1, banners: [] })
  })
  it('a Hive window focused (Show in Hive, the default): a banner in it, no Windows notification', () => {
    focus()
    expect(tell()).toEqual({ route: 'banner', windows: 0, banners: [['notice', 'Hive has closed', null]] })
  })
  it('focused and Show nothing: nothing at all', () => {
    focus()
    config.settings.notifications.whileFocused = 'nothing'
    expect(tell()).toEqual({ route: 'none', windows: 0, banners: [] })
  })
  it('focused and set to Windows notifications: a Windows notification', () => {
    focus()
    config.settings.notifications.whileFocused = 'windows'
    expect(tell()).toEqual({ route: 'windows', windows: 1, banners: [] })
  })
  it('notifications off: nothing, focused or not', () => {
    config.settings.notifications.desktopNotifications = false
    expect(tell()).toEqual({ route: 'none', windows: 0, banners: [] })
    focus()
    expect(tell()).toEqual({ route: 'none', windows: 0, banners: [] })
  })
})
