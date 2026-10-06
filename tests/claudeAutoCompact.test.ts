// Where Claude Code compacts by itself, as its settings say (#242; code.claude.com/docs/en/model-config): the variable
// over the flag over the settings scopes (highest first, a model's own window first), "auto" for the tuned default,
// auto-compaction turned off, a percentage that only brings it earlier, and what it can't read left as the default.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { autoCompactLine } from '../src/shared/providers'
import { UNREAD_SOURCES, autoCompactOf, cliSettings, effectiveEnv, parseWindow, settingsScopes } from '../src/main/providers/claude/autoCompact'

const user = (json: unknown) => ({ label: "Claude Code's settings.json", json })
const project = (json: unknown) => ({ label: "the project's .claude/settings.json", json })
const local = (json: unknown) => ({ label: "the project's .claude/settings.local.json", json })
const OPUS = ['claude-opus-5-5', 'opus']

describe('Claude Code auto-compaction settings (#242)', () => {
  it('reads windows as the flag and settings give them', () => {
    expect(['200000', '500k', '1M', '200', 'auto', 'AUTO', '50', '5M', 'x', ''].map(parseWindow)).toEqual([200_000, 500_000, 1_000_000, 200_000, 'auto', 'auto', 100_000, 1_000_000, null, null])
    // A setting's number is tokens, clamped to 100K–1M.
    expect([parseWindow(600_000), parseWindow(500), parseWindow(5_000_000), parseWindow(-1), parseWindow(null)]).toEqual([600_000, 100_000, 1_000_000, null, null])
  })

  it('nothing set: the default', () => {
    expect(autoCompactOf([], {}, [user(null), project({ model: 'opus' })], OPUS)).toEqual({ window: null, source: null, estimate: UNREAD_SOURCES })
  })

  it('the variable comes first, a plain count only ("500k" reads as 500, the minimum)', () => {
    const scopes = [user({ autoCompactWindow: 300_000 })]
    expect(autoCompactOf(['--autocompact', '400k'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, scopes, OPUS)).toEqual({ window: 500_000, source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' })
    expect(autoCompactOf([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }, [], OPUS).window).toBe(100_000)
    expect(autoCompactOf([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' }, scopes, OPUS)).toEqual({ window: 300_000, source: "autoCompactWindow in Claude Code's settings.json" })
  })

  it('then the flag (over every settings file); "auto" is the tuned default', () => {
    const scopes = [user({ autoCompactWindow: 300_000 })]
    expect(autoCompactOf(['--model', 'opus', '--autocompact', '400k'], {}, scopes, OPUS)).toEqual({ window: 400_000, source: '--autocompact' })
    expect(autoCompactOf(['--autocompact=1M'], {}, scopes, OPUS).window).toBe(1_000_000)
    expect(autoCompactOf(['--autocompact', 'auto'], {}, scopes, OPUS)).toEqual({ window: null, source: '--autocompact auto' })
  })

  it("then the highest scope with a window, a model's own before the file's top level", () => {
    const perModel = { autoCompactWindow: 250_000, modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', autoCompactWindow: 600_000 }, 'claude-sonnet-4-6': { autoCompactWindow: 'auto' } } }
    expect(autoCompactOf([], {}, [user(perModel)], OPUS)).toEqual({ window: 600_000, source: "modelSettings › claude-opus-5-5 › autoCompactWindow in Claude Code's settings.json" })
    // Another model: the file's top level; a dated id or [1m] is the same model.
    expect(autoCompactOf([], {}, [user(perModel)], ['claude-haiku-4-5']).window).toBe(250_000)
    expect(autoCompactOf([], {}, [user(perModel)], ['claude-opus-5-5[1m]']).window).toBe(600_000)
    expect(autoCompactOf([], {}, [user(perModel)], ['claude-sonnet-4-6'])).toEqual({ window: null, source: `modelSettings › claude-sonnet-4-6 › autoCompactWindow: "auto" in Claude Code's settings.json` })
    // The project's local file over the project's over the user's.
    expect(autoCompactOf([], {}, [local({ autoCompactWindow: 'auto' }), project({ autoCompactWindow: 200_000 }), user(perModel)], OPUS).source).toBe(`autoCompactWindow: "auto" in the project's .claude/settings.local.json`)
    expect(autoCompactOf([], {}, [local(null), project({ autoCompactWindow: 200_000 }), user(perModel)], OPUS).window).toBe(200_000)
    // An odd value is ignored, as if not set.
    expect(autoCompactOf([], {}, [project({ autoCompactWindow: 'big' }), user({ autoCompactWindow: 300_000 })], OPUS).window).toBe(300_000)
  })

  it('turned off in settings: off, unless a higher scope turns it on', () => {
    expect(autoCompactOf([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, [user({ autoCompactEnabled: false })], OPUS)).toEqual({ window: 'off', source: "autoCompactEnabled: false in Claude Code's settings.json" })
    expect(autoCompactOf([], {}, [project({ autoCompactEnabled: true }), user({ autoCompactEnabled: false })], OPUS)).toEqual({ window: null, source: null, estimate: UNREAD_SOURCES })
  })

  it('DISABLE_COMPACT and DISABLE_AUTO_COMPACT turn it off over everything, read as Claude Code reads on/off variables', () => {
    const enabled = [user({ autoCompactEnabled: true, autoCompactWindow: 300_000 })]
    for (const v of ['1', 'true', 'YES', 'on']) {
      expect(autoCompactOf(['--autocompact', '400k'], { DISABLE_AUTO_COMPACT: v, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, enabled, OPUS)).toEqual({ window: 'off', source: 'DISABLE_AUTO_COMPACT' })
      expect(autoCompactOf([], { DISABLE_COMPACT: v }, enabled, OPUS)).toEqual({ window: 'off', source: 'DISABLE_COMPACT' })
    }
    // Off values, or anything else: not disabled by them.
    for (const v of ['0', 'false', 'No', 'off', '', 'maybe']) {
      expect(autoCompactOf([], { DISABLE_AUTO_COMPACT: v, DISABLE_COMPACT: v }, enabled, OPUS)).toEqual({ window: 300_000, source: "autoCompactWindow in Claude Code's settings.json" })
    }
    // DISABLE_AUTO_COMPACT overrides autoCompactEnabled both ways: set off, a settings file turning it off doesn't.
    const disabled = [user({ autoCompactEnabled: false })]
    expect(autoCompactOf([], { DISABLE_AUTO_COMPACT: '0' }, disabled, OPUS)).toEqual({ window: null, source: null, estimate: UNREAD_SOURCES })
    expect(autoCompactOf([], {}, disabled, OPUS).window).toBe('off')
    // DISABLE_COMPACT stops all compaction, whatever DISABLE_AUTO_COMPACT says.
    expect(autoCompactOf([], { DISABLE_COMPACT: '1', DISABLE_AUTO_COMPACT: '0' }, enabled, OPUS)).toEqual({ window: 'off', source: 'DISABLE_COMPACT' })
  })

  it("once the session reports its model, that model's window alone, whatever order the file lists them in", () => {
    const both = { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 600_000 }, 'claude-sonnet-5-5': { autoCompactWindow: 300_000 } } }
    const reversed = { modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: 300_000 }, 'claude-opus-5-5': { autoCompactWindow: 600_000 } } }
    for (const json of [both, reversed]) {
      // Launched on opus (its resolved id first), then it reports Sonnet: Sonnet's window, never Opus's.
      expect(autoCompactOf([], {}, [user(json)], ['claude-opus-5-5', 'opus']).window).toBe(600_000)
      expect(autoCompactOf([], {}, [user(json)], ['claude-sonnet-5-5'])).toEqual({ window: 300_000, source: "modelSettings › claude-sonnet-5-5 › autoCompactWindow in Claude Code's settings.json" })
      // A model the file doesn't name: the file's top level, or the default; not another model's.
      expect(autoCompactOf([], {}, [user(json)], ['claude-haiku-4-5'])).toEqual({ window: null, source: null, estimate: UNREAD_SOURCES })
    }
    // Within one model, its exact name before other spellings of it, whatever the file's order.
    const spellings = { modelSettings: { 'claude-opus-5-5[1m]': { autoCompactWindow: 900_000 }, 'claude-opus-5-5': { autoCompactWindow: 600_000 } } }
    expect(autoCompactOf([], {}, [user(spellings)], ['claude-opus-5-5']).window).toBe(600_000)
    expect(autoCompactOf([], {}, [user(spellings)], ['claude-opus-5-5[1m]']).window).toBe(900_000)
    // The resolved id before the alias.
    const aliasToo = { modelSettings: { opus: { autoCompactWindow: 250_000 }, 'claude-opus-5-5': { autoCompactWindow: 600_000 } } }
    expect(autoCompactOf([], {}, [user(aliasToo)], ['claude-opus-5-5', 'opus']).window).toBe(600_000)
    expect(autoCompactOf([], {}, [user({ modelSettings: { opus: { autoCompactWindow: 250_000 } } })], ['claude-opus-5-5', 'opus']).window).toBe(250_000)
  })

  it('a percentage, 1–100, kept with the window it applies to', () => {
    expect(autoCompactOf([], { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' }, [], OPUS)).toEqual({ window: null, source: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', percent: 50, estimate: UNREAD_SOURCES })
    expect(autoCompactOf(['--autocompact', '400k'], { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' }, [], OPUS)).toEqual({ window: 400_000, source: '--autocompact', percent: 80 })
    expect(autoCompactOf([], { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '150' }, [], OPUS)).toEqual({ window: null, source: null, estimate: UNREAD_SOURCES })
  })

  it("reads the variables from a settings file's env block too, over the launch's, the higher scope winning (#273)", () => {
    // The card's example: the user's settings set the window through env; the launch environment is empty.
    expect(autoCompactOf([], {}, [user({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })], OPUS)).toEqual({ window: 150_000, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW (env in Claude Code's settings.json)" })
    // A settings file's env beats the launch environment; the project's beats the user's.
    expect(autoCompactOf([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }, [project({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 300_000 } }), user({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })], OPUS)).toEqual({ window: 300_000, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW (env in the project's .claude/settings.json)" })
    // Turned off through env, as through the launch's.
    expect(autoCompactOf([], {}, [user({ env: { DISABLE_AUTO_COMPACT: '1' } })], OPUS)).toEqual({ window: 'off', source: "DISABLE_AUTO_COMPACT (env in Claude Code's settings.json)" })
    // A launch variable no settings file sets keeps its plain name.
    expect(autoCompactOf([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }, [user({ env: { OTHER: 'x' } })], OPUS)).toEqual({ window: 400_000, source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' })
    expect(effectiveEnv({ A: 'launch', B: 'launch' }, [{ label: 'high', json: { env: { A: 'high' } } }, { label: 'low', json: { env: { A: 'low', B: 'low', C: { no: 1 } } } }])).toEqual({ env: { A: 'high', B: 'low' }, from: { A: 'high', B: 'low' } })
  })

  it('says a default is an estimate: what Hive cannot read could change it', () => {
    const d = autoCompactOf([], {}, [], OPUS)
    expect(d.estimate).toBe(UNREAD_SOURCES)
    expect(autoCompactLine('claude-code', 200_000, d)).toMatch(/its default for this window \(an estimate: managed policies Hive can't read, such as Windows registry policies/)
    // A value a setting gives is no estimate.
    expect(autoCompactOf(['--autocompact', '300000'], {}, [], OPUS).estimate).toBeUndefined()
  })

  const dir = mkdtempSync(join(tmpdir(), 'hive-autocompact-'))
  it("reads the command line's settings: the last --settings, a file or inline JSON, above the folder's (#273)", () => {
    const cwd = join(dir, 'cli')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'mine.json'), JSON.stringify({ autoCompactWindow: 250_000 }))
    expect(cliSettings(['--settings', 'mine.json'], cwd)).toEqual({ label: '--settings mine.json', json: { autoCompactWindow: 250_000 } })
    expect(cliSettings(['--settings={"env":{"X":"1"}}'], cwd)).toEqual({ label: '--settings', json: { env: { X: '1' } } })
    // Claude Code reads only the last.
    expect(cliSettings(['--settings', 'mine.json', '--settings', '{"autoCompactWindow":600000}'], cwd)?.json).toEqual({ autoCompactWindow: 600_000 })
    expect(cliSettings(['--settings', '{ broken'], cwd)).toEqual({ label: '--settings', json: null })
    expect(cliSettings(['--verbose'], cwd)).toBeNull()
    const scopes = settingsScopes(cwd, join(dir, 'nohome'), ['--settings', 'mine.json'])
    expect(scopes.map((s) => s.label)).toEqual(['managed settings', '--settings mine.json', "the project's .claude/settings.local.json", "the project's .claude/settings.json", "Claude Code's settings.json"])
    expect(autoCompactOf(['--settings', 'mine.json'], {}, scopes.slice(1), OPUS)).toEqual({ window: 250_000, source: 'autoCompactWindow in --settings mine.json' })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('reads the folder\'s and the config folder\'s settings files, missing or broken ones as unset', () => {
    const cwd = join(dir, 'proj')
    const home = join(dir, 'home')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json')
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 450_000 }))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoCompactEnabled: false }))
    const scopes = settingsScopes(cwd, home)
    expect(scopes.map((s) => s.label)).toEqual(['managed settings', "the project's .claude/settings.local.json", "the project's .claude/settings.json", "Claude Code's settings.json"])
    expect(scopes[1].json).toBeNull()
    // The user's file turns it off; the project's window doesn't turn it back on.
    expect(autoCompactOf([], {}, scopes.slice(1), OPUS)).toEqual({ window: 'off', source: "autoCompactEnabled: false in Claude Code's settings.json" })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoCompactWindow: 300_000 }))
    expect(autoCompactOf([], {}, settingsScopes(cwd, home).slice(1), OPUS)).toEqual({ window: 450_000, source: "autoCompactWindow in the project's .claude/settings.json" })
  })
})
