// When a provider task types keys into a CLI (Codex's sandbox setup, #235): once the screen shows it has loaded, and
// its title has shown no spinner for a moment. Codex 0.160.0 draws its prompt while it is still loading, then writes
// the folder over "loading" in place; output can end anywhere, inside a word or an escape sequence.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Hive's terminals, recorded instead (no process runs).
const pty = vi.hoisted(() => ({ onData: null as ((d: string) => void) | null, open: new Set<string>(), typed: [] as { at: number; keys: string }[] }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  spawnPty: (key: string, opts: { onData: (d: string) => void }) => {
    pty.open.add(key)
    pty.onData = opts.onData
  },
  hasPty: (key: string) => pty.open.has(key),
  killPty: (key: string) => void pty.open.delete(key),
  writePty: (_key: string, keys: string) => void pty.typed.push({ at: Date.now(), keys })
}))

const { CODEX_LOADED } = await import('../src/main/providers/codex/adapter')
const { KeyGate } = await import('../src/main/taskKeys')
const { providerService } = await import('../src/main/providerService')
const { TerminalScreen } = await import('../src/main/terminalScreen')

const { stream } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex-startup-0.160.0.json'), 'utf8')) as { stream: string }
const BUSY = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/
/** Where Codex writes the folder over "loading" (in place: the cursor moves back to it). */
const folder = stream.indexOf('\x1b[3;6H~')
const loading = stream.indexOf('loading')
const version = stream.indexOf('(v0.160.0)')
/** The first spinner frame in its title, and its end (the plain title the fixture ends with). */
const spinner = stream.indexOf('\x1b]0;⠹')
const spinnerEnd = stream.lastIndexOf('\x1b]0;hive-codex-setup\x07')
// The terminal parses what it is given asynchronously, and the gate sets `ready` when it has parsed the screen. The wait is
// for that: every write the terminals have been given has been parsed (its callback ran), or its screen was disposed (no
// callback comes). A fixed delay raced the parser: about 15 ms a write on an idle machine, and not much less than 20 ms
// on a loaded one (#335).
type Pending = { screen: InstanceType<typeof TerminalScreen>; done: Promise<void>; settle: () => void }
const pending = new Set<Pending>()
const write = TerminalScreen.prototype.write
const dispose = TerminalScreen.prototype.dispose
vi.spyOn(TerminalScreen.prototype, 'write').mockImplementation(function (this: InstanceType<typeof TerminalScreen>, data: string, parsedCallback?: () => void) {
  let resolve: () => void = () => undefined
  const done = new Promise<void>((r) => (resolve = r))
  const entry: Pending = {
    screen: this,
    done,
    settle: () => {
      pending.delete(entry)
      resolve()
    }
  }
  pending.add(entry)
  write.call(this, data, () => {
    parsedCallback?.()
    entry.settle()
  })
  // A screen that is already gone takes nothing, and no callback is coming.
  if (!(this as unknown as { term: unknown }).term) entry.settle()
})
vi.spyOn(TerminalScreen.prototype, 'dispose').mockImplementation(function (this: InstanceType<typeof TerminalScreen>) {
  dispose.call(this)
  for (const e of [...pending]) if (e.screen === this) e.settle()
})
afterAll(() => vi.restoreAllMocks())
/** Resolves once everything the terminals were given so far has been parsed (or its screen disposed). */
const parsed = (): Promise<void> => Promise.all([...pending].map((e) => e.done)).then(() => undefined)

describe('KeyGate', () => {
  it('the fixture is what it says: the prompt drawn while loading, then the folder over "loading"', () => {
    expect([version, loading, folder, spinner, spinnerEnd].every((i) => i > 0)).toBe(true)
    expect(version < loading && loading < folder && folder < spinner && spinner < spinnerEnd).toBe(true)
    expect(stream.slice(0, folder)).toContain('Ask Codex to do anything')
  })

  it('not ready while Codex loads, wherever its output is split; ready once the folder is written over "loading"', async () => {
    // Every split in and around the header's version and "loading", and in and after the folder's escape sequence.
    const splits = [...Array.from({ length: loading + 9 - version }, (_, i) => version + i), ...Array.from({ length: 16 }, (_, i) => folder - 2 + i), spinner, spinnerEnd]
    for (const k of splits) {
      const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32 })
      gate.feed(stream.slice(0, k))
      await parsed()
      // The folder starts with "~", the 8th character of "\x1b[3;6H~".
      expect({ k, ready: gate.ready }).toEqual({ k, ready: k > folder + 6 })
      gate.feed(stream.slice(k))
      await parsed()
      expect({ k, ready: gate.ready }).toEqual({ k, ready: true })
      gate.dispose()
    }
  })

  it('in one-character pieces too', async () => {
    const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32 })
    for (const c of stream.slice(0, folder + 6)) gate.feed(c)
    await parsed()
    expect(gate.ready).toBe(false)
    for (const c of stream.slice(folder + 6)) gate.feed(c)
    await parsed()
    expect(gate.ready).toBe(true)
  })

  it('idle only from when it is ready, and not while its title shows a spinner', async () => {
    let now = 0
    const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32, clock: () => now })
    now = 80
    gate.feed(stream.slice(0, folder))
    await parsed()
    now = 1100
    expect(gate.idleFor()).toBe(0)
    // Loaded late, its spinner with it (a loaded machine).
    now = 1600
    gate.feed(stream.slice(folder, spinner + 30))
    await parsed()
    expect(gate.ready && gate.busy).toBe(true)
    now = 2600
    expect(gate.idleFor()).toBe(0)
    now = 2700
    gate.feed(stream.slice(spinner + 30))
    now = 3200
    expect(gate.busy).toBe(false)
    expect(gate.idleFor()).toBe(500)
  })
})

describe('runTask: the setup keys go in once Codex has loaded and is idle', () => {
  afterEach(() => {
    vi.useRealTimers()
    pty.open.clear()
    pty.typed.length = 0
  })

  it('none while it loads, however long; then, after its startup spinner, each key in turn', async () => {
    vi.useFakeTimers({ now: 0 })
    const keys = [{ keys: '\x15', waitMs: 150 }, { keys: '/permissions', waitMs: 200 }, { keys: '\r', waitMs: 900 }, { keys: '2', waitMs: 300 }]
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys, ready: CODEX_LOADED, busyTitle: BUSY })
    // Its prompt drawn while loading, the output ending in the middle of "loading".
    pty.onData!(stream.slice(0, loading + 1))
    pty.onData!(stream.slice(loading + 1, folder))
    await vi.advanceTimersByTimeAsync(5000)
    expect(pty.typed).toEqual([])
    // Loaded (the folder over "loading"), and its spinner starts.
    pty.onData!(stream.slice(folder, spinner + 30))
    await vi.advanceTimersByTimeAsync(3000)
    expect(pty.typed).toEqual([])
    // The spinner ends: after a second of idle, the keys go in, one after another.
    const idleAt = Date.now()
    pty.onData!(stream.slice(spinner + 30))
    await vi.advanceTimersByTimeAsync(4000)
    expect(pty.typed.map((t) => t.keys)).toEqual(keys.map((k) => k.keys))
    expect(pty.typed[0].at - idleAt).toBeGreaterThanOrEqual(1000)
  })

  // Codex 0.161 reordered /permissions (#396): the setup task reads the menu Codex draws for "Ask for approval".
  const menu = (codexVersion: string) => readFileSync(join(__dirname, 'fixtures', `codex-${codexVersion}-permissions-readonly.txt`), 'utf8').split('\n').slice(-12).join('\r\n')
  for (const [codexVersion, want] of [['0.161', '1'], ['0.160', '2']]) {
    it(`picks "Ask for approval" from the menu on the screen (Codex ${codexVersion}'s order: ${want})`, async () => {
      vi.useFakeTimers({ now: 0 })
      const { codex } = await import('../src/main/providers/codex/adapter')
      const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
      run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: CODEX_LOADED, busyTitle: BUSY })
      pty.onData!(stream)
      await vi.advanceTimersByTimeAsync(3000)
      // The menu is open; the number isn't typed until it shows.
      expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r'])
      pty.onData!(`\r\n${menu(codexVersion)}`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r', want])
    })
  }

  it('types nothing more when the menu never shows the preset, and says so', async () => {
    vi.useFakeTimers({ now: 0 })
    const { codex } = await import('../src/main/providers/codex/adapter')
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: CODEX_LOADED, busyTitle: BUSY })
    pty.onData!(stream)
    pty.onData!('\r\n  1. Approve for me   Only ask for actions detected as potentially unsafe')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r'])
  })
})
