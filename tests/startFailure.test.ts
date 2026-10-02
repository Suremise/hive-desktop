// A failed start's reason: the CLI's last error lines read out of raw terminal output, and each adapter's hint.
import { describe, expect, it } from 'vitest'
import { lastErrorLines, terminalLines } from '../src/shared/startFailure'

describe('the reason a CLI gave', () => {
  it('reads terminal output as plain lines: escapes gone, redrawn lines as their last text, frames dropped', () => {
    const out = '\x1b]0;claude\x07\x1b[2J\x1b[H╭──────╮\r\n│ hi │\r\nLoading…\rLoaded\r\n\x1b[31merror:\x1b[0m\x1b[1Cunknown option \x1b[1m\'--nope\'\x1b[0m\r\n\r\n'
    expect(terminalLines(out)).toEqual(['│ hi │', 'Loaded', "error: unknown option '--nope'"])
  })

  it('starts at the first line naming an error, at most three lines', () => {
    const out = ['Starting…', 'Reading config', 'Error loading config.toml:', 'invalid type: string "x", expected a boolean', 'in `features.web_search`', 'at line 4', 'bye'].join('\r\n')
    expect(lastErrorLines(out)).toBe('Error loading config.toml:\ninvalid type: string "x", expected a boolean\nin `features.web_search`')
  })

  it('takes the last lines when none names an error, and shortens a long one', () => {
    expect(lastErrorLines('one\ntwo\nthree\nfour')).toBe('two\nthree\nfour')
    const long = lastErrorLines(`error: ${'x'.repeat(500)}`)
    expect(long.length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
    expect(lastErrorLines('\x1b[2J\x1b[H')).toBe('')
  })
})

describe("the adapters' hints", () => {
  it('Claude Code: arguments, models, sign-in and a broken install', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    expect(claudeCode.startHint("error: unknown option '--nope'")?.fix).toBe('agent-settings')
    expect(claudeCode.startHint("error: option '--effort <level>' argument 'max2' is invalid. Allowed choices are low, medium, high.")?.hint).toMatch(/Extra arguments/)
    expect(claudeCode.startHint('Error: model "opus-9" not found')?.hint).toMatch(/model/)
    expect(claudeCode.startHint('Invalid API key · Please run /login')?.fix).toBe('terminal')
    expect(claudeCode.startHint("Error: Cannot find module 'C:\\x\\cli.js'")?.fix).toBe('agent-setup')
    expect(claudeCode.startHint('Goodbye!')).toBeNull()
  })

  it('Codex: its settings, models, sign-in and setup', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    expect(codex.startHint('Error loading config.toml: unknown variant `hgih`')?.hint).toMatch(/config\.toml/)
    expect(codex.startHint("error: unexpected argument '--nope' found")?.fix).toBe('agent-settings')
    expect(codex.startHint('The model `gpt-9` does not exist')?.hint).toMatch(/model/)
    expect(codex.startHint('Not logged in. Run codex login')?.fix).toBe('agent-setup')
    expect(codex.startHint('Bye')).toBeNull()
  })
})
