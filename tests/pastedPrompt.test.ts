// How Hive puts a prompt into a CLI (#597, SessionManager.sendPrompt): a CLI that reads a bracketed paste as text
// (Claude Code) gets the line as one while its terminal has bracketed paste on, so a busy CLI reading Hive's Ctrl+U,
// the line and its Enter in one go still sends it; a slash command, a CLI without the capability, or one with
// bracketed paste off gets it typed in pieces, as before. The real helpers, on a stand-in live session; the terminal's
// writes are recorded, never sent.
import { afterEach, describe, expect, it, vi } from 'vitest'

// The CLI's echo (#600): with `echo.to` set, what Hive types is drawn on that screen, as a CLI reading its input draws it.
const { writes, echo } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } } }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void (writes.push(data), echo.to?.write(data)) }))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { TerminalScreen } = await import('../src/main/terminalScreen')
const { advanced } = await import('../src/main/advanced')
const { drawnWaitId } = await import('../src/shared/advanced')

describe('a prompt Hive puts into a CLI (#597)', () => {
  const p = 'C:/hive-test/pasted-prompt'
  const id = 'b1'
  const s = sessions as unknown as { live: Map<string, unknown> }
  const liveKey = `${p.toLowerCase()}#${id}`
  const screens: InstanceType<typeof TerminalScreen>[] = []
  /** An idle launch of `adapter` whose screen has had `output` (the CLI's own) drawn on it. */
  const running = async (adapter: unknown, output: string) => {
    const screen = new TerminalScreen(60, 20)
    screens.push(screen)
    await new Promise<void>((r) => screen.write(output, r))
    s.live.set(liveKey, { state: { runId: 'r1', status: 'ready', projectPath: p, agentId: id, agentName: 'B1' }, adapter, screen, prompts: 0 })
    return screen
  }
  afterEach(() => {
    s.live.delete(liveKey)
    writes.length = 0
    echo.to = null
    vi.useRealTimers()
    // A test that failed while Hive was typing mustn't leave the next one refused as busy.
    ;(sessions as unknown as { delivering: Set<string> }).delivering.clear()
    for (const x of screens.splice(0)) x.dispose()
  })
  const typedText = (): string => writes.slice(1, -1).join('')

  it('Claude Code with bracketed paste on gets the line as one paste, between Ctrl+U and Enter', async () => {
    await running(claudeCode, '\x1b[?2004h> ')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review:\n  a comment')
    expect(writes).toEqual(['\x15', '\x1b[200~[Hive] #12 is in Review: a comment\x1b[201~', '\r'])
  })

  it("the line's control characters are left out of the paste: nothing in it can end it or press a key", async () => {
    await running(claudeCode, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, 'a comment \x1b[201~\x03 quoting keys\x7f\x9b')
    expect(writes).toEqual(['\x15', '\x1b[200~a comment [201~ quoting keys\x1b[201~', '\r'])
  })

  it('a slash command is typed: pasted, it would be sent as a message', async () => {
    await running(claudeCode, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '/rename the work')
    expect(writes.length).toBeGreaterThan(3)
    expect(typedText()).toBe('/rename the work')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
  })

  it('typed in pieces when the CLI has bracketed paste off (turned off again too)', async () => {
    await running(claudeCode, '\x1b[?2004h\x1b[?2004l')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.length).toBeGreaterThan(3)
    expect(typedText()).toBe('[Hive] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('typed in pieces into a CLI without the capability, even with bracketed paste on (Codex)', async () => {
    echo.to = await running(codex, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
    expect(typedText()).toBe('[Hive] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('Copilot with bracketed paste on gets the line as one paste too (#600)', async () => {
    await running(copilot, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it.')
    expect(writes).toEqual(['\x15', '\x1b[200~[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it.\x1b[201~', '\r'])
  })

  describe("Codex: Enter once the line is drawn (#600: a busy Codex drops an Enter it reads with the line)", () => {
    const line = '[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it.'

    it('no Enter while the line isn’t drawn; Enter once it is', async () => {
      const screen = await running(codex, '\x1b[?2004h› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      // Typed (Ctrl+U, the pieces, the pause after them), and a second more: Codex, paused, has drawn nothing.
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes.slice(1).join('')).toBe(line)
      expect(writes).not.toContain('\r')
      // It reads its input again and draws the line: Enter follows.
      screen.write(line)
      await vi.advanceTimersByTimeAsync(100)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it("an earlier doorbell with the same end on screen doesn't count as drawn", async () => {
      const screen = await running(codex, '› [Hive] New in your inbox: 1 message (m3). Call hive_inbox to read it.\r\n› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes).not.toContain('\r')
      screen.write(line)
      await vi.advanceTimersByTimeAsync(100)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it('not drawn within 5 s, Enter anyway (as before #600)', async () => {
      await running(codex, '› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      await vi.advanceTimersByTimeAsync(4000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(2000)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it('drawn as it is typed (an idle Codex), Enter goes at once, long before the wait would end', async () => {
      echo.to = await running(codex, '› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      // Typing takes about half a second of the clock (Ctrl+U, the pieces, the pause after them); the wait would be 5 s.
      await vi.advanceTimersByTimeAsync(1000)
      expect(writes.at(-1)).toBe('\r')
      await sent
    })

    it('every CLI Hive waits for to draw a line has that wait in Settings → Advanced', async () => {
      const { PROVIDERS } = await import('../src/shared/providers')
      const { advancedDef } = await import('../src/shared/advanced')
      const waiting = PROVIDERS.filter((d) => d.capabilities.enterOnceDrawn)
      expect(waiting.map((d) => d.id)).toEqual(['codex'])
      for (const d of waiting) expect(advancedDef(drawnWaitId(d.id))?.kind, d.id).toBe('number')
    })

    it("the wait is Settings → Advanced's (Codex → Typed line: wait to be drawn)", async () => {
      const number = advanced.number.bind(advanced)
      const spy = vi.spyOn(advanced, 'number').mockImplementation((key: string) => (key === drawnWaitId('codex') ? 12 : number(key)))
      try {
        await running(codex, '› ')
        vi.useFakeTimers()
        const sent = sessions.sendPrompt(p, id, line)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(3000)
        await sent
        expect(writes.at(-1)).toBe('\r')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
