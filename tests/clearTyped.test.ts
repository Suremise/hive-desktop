// Clearing a line Hive typed (#530, SessionManager.clearTyped): only Hive's own line still waiting to be taken, never a
// prompt the user has typed into since, however long ago (the typing pause, even at 0, doesn't make a draft Hive's).
// The real helpers, on a stand-in live session; the terminal's writes are recorded, never sent.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { writes } = vi.hoisted(() => ({ writes: [] as string[] }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void writes.push(data) }))
const { sessions } = await import('../src/main/sessions')
const { config } = await import('../src/main/config')

describe("clearing Hive's line (#530 round 3 finding)", () => {
  const p = 'C:/hive-test/clear-typed'
  const id = 'b1'
  const s = sessions as unknown as { key: (p: string, id: string) => string; live: Map<string, unknown> }
  const key = s.key(p, id)
  const liveKey = `${p.toLowerCase()}#${id}`
  /** A launch with Hive's line typed at `at`, its first Enter lost (the CLI's prompt count unchanged). */
  const withLine = (at: number) => {
    const live = { state: { runId: 'r1', status: 'ready' }, prompts: 0, typed: { at, prompts: 0 } }
    s.live.set(liveKey, live)
    return live
  }
  afterEach(() => {
    vi.restoreAllMocks()
    s.live.delete(liveKey)
    writes.length = 0
  })

  it("clears Hive's own waiting line, with nobody having typed there since", () => {
    const t = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(t)
    const live = withLine(t - 1000)
    expect(sessions.userTypedOverLine(p, id)).toBe(false)
    expect(sessions.clearTyped(p, id, 'r1')).toBe(true)
    expect(writes).toEqual(['\x15'])
    expect(live.typed).toBeUndefined()
    // Nothing of Hive's waits now: nothing more to clear.
    expect(sessions.clearTyped(p, id, 'r1')).toBe(false)
    expect(writes).toHaveLength(1)
  })

  for (const pause of [15, 0]) {
    it(`never clears a draft the user typed after it, once the typing pause (${pause} s) has passed`, () => {
      const was = config.settings.assistant
      config.settings.assistant = { ...was, typingPause: pause, enterEndsPause: true } as typeof was
      try {
        const t = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(t)
        withLine(t - 1000)
        sessions.noteUserInput(key, 'my unsent draft')
        now.mockReturnValue(t + 20_000)
        expect(sessions.userMayBeTyping(p, id)).toBe(false)
        expect(sessions.userTypedOverLine(p, id)).toBe(true)
        expect(sessions.clearTyped(p, id, 'r1')).toBe(false)
        expect(writes).toEqual([])
      } finally {
        config.settings.assistant = was
      }
    })
  }

  it('nor a line its CLI has taken since, another launch, or one busy', () => {
    const t = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(t)
    const live = withLine(t - 1000)
    live.prompts = 1
    expect(sessions.clearTyped(p, id, 'r1')).toBe(false)
    live.prompts = 0
    expect(sessions.clearTyped(p, id, 'r2')).toBe(false)
    live.state.status = 'working'
    expect(sessions.clearTyped(p, id, 'r1')).toBe(false)
    expect(writes).toEqual([])
  })
})
