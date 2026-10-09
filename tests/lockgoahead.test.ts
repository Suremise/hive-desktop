// "Ask me" file locks for a CLI without its own approval (Codex): the user's Allow reaches the agent whenever it is
// clicked. Clicked while the blocked agent is still in its turn (the toast shows as the hook denies the edit), the
// go-ahead is typed when that turn ends and the edit is allowed in the next one (#201). Like every prompt Hive types on
// its own, it waits while the user may be writing in the agent's terminal, and never adds to or sends their input. An
// edit that went ahead meanwhile needs none, and an interrupt drops it.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const base = tempDir('hive-goahead-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { config } = await import('../src/main/config')
const { codex } = await import('../src/main/providers/codex/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'locks')
const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string>; key: (p: string, a: string) => string }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Long enough for a prompt to be typed and sent (Enter goes in some 450 ms after the first piece). */
const typingTime = () => wait(1500)
/** Settings → Assistant → Pause after you type, for these tests (seconds). */
const PAUSE = 2

let n = 0
/**
 * Running Codex agents (no process), each set with files of its own: `holder` has claimed one, `other` a second, and
 * `editor` is in a turn.
 */
function agents() {
  n++
  const file = `notes${n}.txt`
  const second = `other${n}.txt`
  for (const f of [file, second]) writeFileSync(join(p, f), 'hi\n')
  const agent = (agentId: string) => {
    const state = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `session-${agentId}`, status: 'working', startedAt: '', launchSignature: '', unseen: false }
    s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
    s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
    return state
  }
  const holder = agent(`h${n}`)
  const other = agent(`o${n}`)
  const editor = agent(`e${n}`)
  const patch = (...files: string[]) => ({ hook_event_name: 'PreToolUse', cwd: p, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n+x\n`).join('')}*** End Patch` } })
  const editBy = (st: typeof holder, ...files: string[]) => run(() => sessions.preToolUse(st.runId, { ...patch(...files), session_id: st.sessionId }))
  const hookOf = (st: typeof holder, event: string) => run(() => sessions.handleHook(st.runId, { hook_event_name: event, session_id: st.sessionId, cwd: p }))
  const typed = () => pty.typed.filter((t) => t.key === s.key(p, editor.agentId)).map((t) => t.data)
  return {
    file,
    second,
    editor,
    /** holder claims the file (and other the second one). */
    claim: async () => {
      expect(await editBy(holder, file)).toBeNull()
      expect(await editBy(other, second)).toBeNull()
    },
    /** editor tries an edit (of its file by default): null when it may, the hook's refusal when not. */
    edit: (...files: string[]) => editBy(editor, ...(files.length ? files : [file])),
    hook: (event: string) => hookOf(editor, event),
    holderHook: (event: string) => hookOf(holder, event),
    allow: () => run(() => sessions.allowLockedEdit(p, editor.agentId, join(p, file))),
    /** The user typing in editor's terminal. */
    userTypes: (text: string) => sessions.noteUserInput(s.key(p, editor.agentId), text),
    typed,
    /** The go-ahead for the file typed (in pieces, as Hive types) and sent. */
    goAhead: () => typed().join('').includes(`allowed you to edit ${file}`) && typed().at(-1) === '\r'
  }
}

describe('Allow on an "Ask me" lock', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, fileLocks: 'ask', agents: [] }))
    config.settings.assistant.typingPause = PAUSE
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

  it('clicked once the blocked turn has ended: the go-ahead is typed at once', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    a.editor.status = 'finished'
    await a.allow()
    await vi.waitFor(() => expect(a.goAhead()).toBe(true))
  })

  it('clicked while the blocked agent is still in its turn: nothing is typed then; at its end, the go-ahead, and the edit is allowed', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    expect(a.typed()).toEqual([])
    await a.hook('Stop')
    expect(a.editor.status).toBe('finished')
    await vi.waitFor(() => expect(a.goAhead()).toBe(true))
    // The next turn's retry goes through: the turn's end released the allowance the click gave, and it was given again.
    a.editor.status = 'working'
    expect(await a.edit()).toBeNull()
    // Typed once only: the next turn's end has nothing more to say.
    pty.typed.length = 0
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('allowed and tried again in the same turn: no go-ahead when the turn ends', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    expect(await a.edit()).toBeNull()
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('the holder finished before the retry, which then went ahead: no go-ahead when the turn ends', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.holderHook('Stop')
    expect(await a.edit()).toBeNull()
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('an edit refused for another of its files: the allowed file still gets its go-ahead, and only it', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    // The retry also edits the second file, which other holds and nobody allowed: the whole edit is refused.
    expect(await a.edit(a.file, a.second)).not.toBeNull()
    await a.hook('Stop')
    await vi.waitFor(() => expect(a.goAhead()).toBe(true))
    expect(a.typed().join('')).not.toContain(a.second)
  })

  it('the agent starts another turn before the go-ahead is typed: it is not sent, and the edit is still allowed in that turn', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    // A wake (or the user's prompt, sent with Enter) went first: the agent is working as Hive clears the input.
    pty.onWrite = (d) => {
      if (d === '\x15') a.editor.status = 'working'
    }
    await a.hook('Stop')
    await typingTime()
    expect(a.typed().includes('\r')).toBe(false)
    expect(await a.edit()).toBeNull()
  })

  it('the user types in the terminal while the go-ahead is typed: it is not sent, their input is left alone, and it goes once they pause', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    let typedBy: number | null = null
    pty.onWrite = (d) => {
      if (typedBy === null && d.includes('allowed')) {
        typedBy = pty.typed.length
        a.userTypes('My next task')
      }
    }
    await a.hook('Stop')
    // Within the pause: long enough for Enter to have gone in (some 450 ms after the first piece).
    await wait(1000)
    expect(typedBy).not.toBeNull()
    // Nothing sent, and nothing cleared after their keystroke: what they typed stays where they typed it.
    expect(a.typed().includes('\r')).toBe(false)
    expect(pty.typed.slice(typedBy!).some((t) => t.data === '\x15')).toBe(false)
    pty.onWrite = () => undefined
    await vi.waitFor(() => expect(a.goAhead()).toBe(true), { timeout: (PAUSE + 3) * 1000 })
  })

  it('a draft in the terminal when the turn ends: nothing is typed until the user pauses', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    a.userTypes('half a thought')
    await a.hook('Stop')
    await wait(PAUSE * 500)
    expect(a.typed()).toEqual([])
    await vi.waitFor(() => expect(a.goAhead()).toBe(true), { timeout: (PAUSE + 3) * 1000 })
  })

  it('interrupted while the go-ahead is being typed: it stops before Enter, and is not tried again', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.hook('Stop')
    // Delivery has begun (the input cleared): the user interrupts, and the agent is ready again.
    await vi.waitFor(() => expect(a.typed()).toContain('\x15'))
    await a.hook('Interrupt')
    expect(a.editor.status).toBe('ready')
    await typingTime()
    expect(a.typed().includes('\r')).toBe(false)
    // Not later either: once the typing pause would have ended, nothing more has been typed.
    const so = a.typed().length
    await wait(PAUSE * 1000 + 500)
    expect(a.typed().length).toBe(so)
  })

  it('interrupted after the click (the user stopped it): no go-ahead, then or after a later turn', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.hook('Interrupt')
    a.editor.status = 'working'
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })
})
