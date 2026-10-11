// How Hive puts a prompt into a CLI (#597, SessionManager.sendPrompt): a CLI that reads a bracketed paste as text
// (Claude Code) gets the line as one while its terminal has bracketed paste on, so a busy CLI reading Hive's Ctrl+U,
// the line and its Enter in one go still sends it; a slash command, a CLI without the capability, or one with
// bracketed paste off gets it typed in pieces, as before. The real helpers, on a stand-in live session; the terminal's
// writes are recorded, never sent.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { writes } = vi.hoisted(() => ({ writes: [] as string[] }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void writes.push(data) }))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { TerminalScreen } = await import('../src/main/terminalScreen')

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
    s.live.set(liveKey, { state: { runId: 'r1', status: 'ready' }, adapter, screen, prompts: 0 })
  }
  afterEach(() => {
    s.live.delete(liveKey)
    writes.length = 0
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
    await running(codex, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
    expect(typedText()).toBe('[Hive] #12 is in Review: a comment that is long enough for several pieces')
  })
})
