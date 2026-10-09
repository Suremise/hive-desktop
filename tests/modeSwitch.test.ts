// A running Codex agent's preset switched through its /permissions menu (#363): each key goes in only while the session
// is still the one switched, isn't asking the user anything and isn't busy. One that stops (the session stopped or
// replaced while the keys wait, a question, busy for 30 seconds) types nothing more and reports the switch as not made,
// the mode as it was. Codex's screens are 0.161's, captured from its rendered terminal.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// What Hive types into agents' terminals, recorded instead (no process runs); onWrite acts as each piece goes in.
const pty = vi.hoisted(() => ({ typed: [] as { key: string; data: string }[], onWrite: (_data: string): void => undefined }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (key: string, data: string) => {
    pty.typed.push({ key, data })
    pty.onWrite(data)
  }
}))

const base = tempDir('hive-modeswitch-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { codex } = await import('../src/main/providers/codex/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'switching')
const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
/** A screen, a line per row, however git checked the fixture out (CRLF on Windows). */
const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', `codex-${name}.txt`), 'utf8').replace(/\r\n/g, '\n')
const HELD_WORKING = screen('0.161-held-working')
const MENU = screen('0.161-permissions-readonly')
/** Codex free, its input empty (the held screen with the input cleared). */
const IDLE = screen('0.161-held-idle').replace('› /permissions\n', '› Ask Codex to do anything\n')
if (IDLE === screen('0.161-held-idle')) throw new Error("the held-idle fixture's input line has changed")

let n = 0
/** A running Codex agent in Read Only (no process) whose screen is `shown`, new enough to have no transcript yet. */
function agent(shown: string) {
  const agentId = `a${++n}`
  const id = `${p.toLowerCase()}#${agentId}`
  const view = { text: shown }
  const state: Record<string, unknown> = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, status: 'ready', startedAt: '', launchSignature: '', unseen: false, permissionMode: 'read-only' }
  const live = { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, screen: { text: () => view.text } }
  s.live.set(id, live)
  s.runs.set(state.runId as string, id)
  const typed = () => pty.typed.map((t) => t.data)
  const keysSoFar = () => typed().length
  return { agentId, id, view, state, live, typed, keysSoFar, switchTo: (mode: string) => run(() => sessions.setPermissionMode(p, agentId, mode as never)) }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("switching a running Codex agent's preset through its menu (#363)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    pty.typed.length = 0
    pty.onWrite = () => undefined
  })
  afterEach(() => vi.useRealTimers())

  it('switches when Codex is free: Ctrl+U, /permissions, Enter, then the preset picked from its menu', async () => {
    const a = agent(IDLE)
    pty.onWrite = (d) => {
      if (d === '\r') a.view.text = MENU
    }
    expect(await a.switchTo('ask')).toEqual({ ok: true })
    expect(a.typed()).toEqual(['\x15', '/permissions', '\r', '1'])
    expect(a.state.permissionMode).toBe('ask')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it('stopped while its keys wait for Codex to be free: nothing typed, not switched, its mode as it was', async () => {
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await wait(500)
    expect(a.keysSoFar()).toBe(0)
    s.live.delete(a.id)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/its session ended/)
    expect(a.typed()).toEqual([])
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it('replaced by a restart while its keys wait: nothing typed into the new session, whose mode is its own', async () => {
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await wait(500)
    const restarted = { ...a.live, state: { ...a.state, runId: 'run-restarted', permissionMode: 'approve-for-me', status: 'ready' }, screen: { text: () => IDLE } }
    s.live.set(a.id, restarted)
    const r = await result
    expect(r.ok).toBe(false)
    expect(a.typed()).toEqual([])
    expect(restarted.state.permissionMode).toBe('approve-for-me')
    expect(a.state.permissionMode).toBe('read-only')
  })

  it('asking the user something while its keys wait: nothing more typed, not switched', async () => {
    const a = agent(IDLE)
    // The command goes in; then Codex holds it busy, and asks a question.
    pty.onWrite = (d) => {
      if (d === '/permissions') a.view.text = HELD_WORKING
    }
    const result = a.switchTo('ask')
    await wait(800)
    expect(a.typed()).toEqual(['\x15', '/permissions'])
    a.state.status = 'waiting'
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/is asking you something/)
    expect(a.typed()).toEqual(['\x15', '/permissions'])
    expect(a.state.permissionMode).toBe('read-only')
  })

  it('busy for longer than 30 seconds: stops, types nothing, not switched', async () => {
    vi.useFakeTimers()
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(a.keysSoFar()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/stayed busy for 30 seconds/)
    expect(a.typed()).toEqual([])
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })
})
