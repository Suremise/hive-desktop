import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { ConsoleRing, EVENT_MAX_BYTES, hiveSourceId, makeEvent, mayRead, parseSourceId, redactPayload, sessionSourceId, type ConsoleEvent } from '../src/shared/devConsole'
import { DevConsole, MAX_SOURCES } from '../src/main/devConsole'
import { hookSummary, transcriptEvent } from '../src/main/devConsoleWords'
import { consoleEventsText, consoleSourcesText } from '../src/shared/toolReplies'

// The developer console's capture (#636): bounded rings, kept only while someone watches, each raw event redacted and
// paired with what Hive made of it; who may read which source. The paths are only compared, never touched.
const ws = join('C:\\', 'work')
const alpha = join(ws, 'alpha')
const beta = join(ws, 'beta')
const other = join('C:\\', 'elsewhere', 'gamma')
const A1 = sessionSourceId(alpha, 'a1')
const A2 = sessionSourceId(alpha, 'a2')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const event = (seq: number, bytes = 10): ConsoleEvent => ({ seq, at: '2026-10-12T00:00:00.000Z', source: A1, kind: 'hook', name: 'Stop', summary: '', bytes })

describe('ConsoleRing', () => {
  it('keeps the newest events within its count', () => {
    const r = new ConsoleRing(3, 1000)
    for (let i = 1; i <= 5; i++) r.push(event(i))
    expect(r.all().map((e) => e.seq)).toEqual([3, 4, 5])
    expect(r.bytes).toBe(30)
  })

  it('keeps the newest events within its bytes, and always the newest one', () => {
    const r = new ConsoleRing(100, 25)
    for (let i = 1; i <= 4; i++) r.push(event(i))
    expect(r.all().map((e) => e.seq)).toEqual([3, 4])
    r.push(event(5, 80))
    expect(r.all().map((e) => e.seq)).toEqual([5])
  })

  it('gives the events after a seq, the newest `limit` of them', () => {
    const r = new ConsoleRing()
    for (let i = 1; i <= 6; i++) r.push(event(i))
    expect(r.since(2).map((e) => e.seq)).toEqual([3, 4, 5, 6])
    expect(r.since(2, 2).map((e) => e.seq)).toEqual([5, 6])
    expect(r.find(4)?.seq).toBe(4)
    expect(r.find(40)).toBeUndefined()
  })
})

describe('redactPayload', () => {
  const hook = {
    hook_event_name: 'UserPromptSubmit',
    session_id: '0b5f0c2e-3f7e-4c1a-9c8e-2d1f0a6b7c8d',
    transcript_path: 'C:\\Users\\me\\.claude\\projects\\x\\0b5f.jsonl',
    cwd: alpha,
    permission_mode: 'default',
    prompt: 'deploy with my key sk-ant-api03-abcdefghijklmnop',
    tool_name: 'Edit',
    tool_input: { file_path: join(alpha, 'src', 'a.ts'), old_string: 'const a = 1', new_string: 'const a = 2', command: 'npm test -- --token abc' },
    usage: { input_tokens: 1200, output_tokens: 30 },
    authorization: 'Bearer abc.def.ghi',
    api_key: 'plain',
    note: 'two words'
  }

  it('keeps identifiers, paths and numbers, and hides text', () => {
    const r = redactPayload(hook) as Record<string, any>
    expect(r.hook_event_name).toBe('UserPromptSubmit')
    expect(r.session_id).toBe(hook.session_id)
    expect(r.transcript_path).toBe(hook.transcript_path)
    expect(r.cwd).toBe(alpha)
    expect(r.tool_name).toBe('Edit')
    expect(r.tool_input.file_path).toBe(hook.tool_input.file_path)
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 30 })
    expect(r.prompt).toBe(`<text: ${hook.prompt.length} chars>`)
    expect(r.tool_input.old_string).toMatch(/^<text: \d+ chars>$/)
    expect(r.tool_input.command).toMatch(/^<text: \d+ chars>$/)
    expect(r.note).toBe('<text: 9 chars>')
  })

  it('masks secrets, whatever their field holds', () => {
    const r = redactPayload(hook) as Record<string, any>
    expect(r.authorization).toBe('<redacted>')
    expect(r.api_key).toBe('<redacted>')
    expect(JSON.stringify(r)).not.toContain('sk-ant')
    // A key kept as an identifier is still masked.
    expect(redactPayload({ model: 'sk-ant-api03-abcdefghijklmnop' })).toEqual({ model: '<redacted>' })
  })

  it('keeps text only when asked, with secrets still masked', () => {
    const r = redactPayload(hook, { includeText: true }) as Record<string, any>
    expect(r.prompt).toContain('deploy with my key')
    expect(r.prompt).not.toContain('sk-ant')
    expect(r.authorization).toBe('<redacted>')
    expect(r.tool_input.command).toContain('npm test')
  })

  it('judges an array by the field that holds it, and bounds lists, fields and depth', () => {
    expect(redactPayload({ prompts: ['fix it now', 'and this'] })).toEqual({ prompts: ['<text: 10 chars>', '<text: 8 chars>'] })
    const long = redactPayload({ list: Array.from({ length: 50 }, (_, i) => i) }) as { list: unknown[] }
    expect(long.list).toHaveLength(41)
    expect(long.list[40]).toBe('<10 more>')
    const wide = redactPayload(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>
    expect(Object.keys(wide)).toHaveLength(61)
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 10; i++) deep = { d: deep }
    expect(JSON.stringify(redactPayload(deep))).toContain('<object>')
  })

  it('never throws on odd values', () => {
    expect(redactPayload({ n: Number.NaN, u: undefined, f: () => 1, big: 10n })).toEqual({ n: 'NaN', f: '<function>', big: '<bigint>' })
  })
})

describe('makeEvent', () => {
  it('counts its size, and cuts payloads too large to their outline', () => {
    const small = makeEvent(1, 'at', A1, { kind: 'hook', name: 'Stop', summary: 'Stop → stop; finished', raw: { a: 1 } })
    // UTF-8 bytes, the arrow's three included.
    expect(small.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...small, bytes: 0 })))
    expect(makeEvent(1, 'at', A1, { kind: 'hook', name: '𝄞é', summary: '' }).bytes).toBe(Buffer.byteLength(JSON.stringify({ seq: 1, at: 'at', source: A1, kind: 'hook', name: '𝄞é', summary: '', bytes: 0 })))
    const raw = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, Array.from({ length: 40 }, () => 'ab-'.repeat(33))]))
    const big = makeEvent(2, 'at', A1, { kind: 'transcript', name: 'transcript', summary: 's', raw })
    expect(big.truncated).toBe(true)
    expect(big.bytes).toBeLessThan(EVENT_MAX_BYTES)
    expect((big.raw as Record<string, unknown>).fields).toHaveLength(50)
  })

  it('masks a secret even in its summary', () => {
    expect(makeEvent(1, 'at', A1, { kind: 'api', name: 'x', summary: 'Bearer abcdefgh' }).summary).toBe('Bearer <redacted>')
  })
})

describe('DevConsole', () => {
  it('captures nothing, and builds nothing, while nobody watches', () => {
    const c = new DevConsole()
    const build = vi.fn(() => ({ kind: 'hook' as const, name: 'Stop', summary: 's' }))
    c.capture([A1], build)
    expect(build).not.toHaveBeenCalled()
    expect(c.stats()).toEqual({ sources: 0, events: 0, bytes: 0, subscribers: 0 })
  })

  it('captures a watched source from its first subscriber to its last', () => {
    const c = new DevConsole()
    c.subscribe('w1', [A1])
    c.subscribe('w2', [A1, A2])
    c.capture([A1, A2, null], () => ({ kind: 'hook', name: 'Stop', summary: 's', raw: { prompt: 'secret words' } }))
    expect(c.events(A1)).toHaveLength(1)
    expect(c.events(A2)).toHaveLength(1)
    expect(c.events(A1)[0].raw).toEqual({ prompt: '<text: 12 chars>' })
    c.unsubscribe('w2')
    expect(c.capturing(A1)).toBe(true)
    expect(c.capturing(A2)).toBe(false)
    c.unsubscribe('w1')
    expect(c.stats()).toEqual({ sources: 0, events: 0, bytes: 0, subscribers: 0 })
  })

  it('changes a subscription in place: new sources start, dropped ones stop', () => {
    const c = new DevConsole()
    c.subscribe('w', [A1])
    c.subscribe('w', [A2])
    expect(c.capturing(A1)).toBe(false)
    expect(c.capturing(A2)).toBe(true)
    c.watch('w', [A1])
    expect(c.sourcesOf('w').sort()).toEqual([A1, A2].sort())
    c.unsubscribe('w', [A2])
    expect(c.sourcesOf('w')).toEqual([A1])
  })

  it('bounds the sources one subscriber holds', () => {
    const c = new DevConsole()
    c.subscribe('w', Array.from({ length: MAX_SOURCES + 5 }, (_, i) => sessionSourceId(alpha, `a${i}`)))
    expect(c.sourcesOf('w')).toHaveLength(MAX_SOURCES)
  })

  it('a lease ends on its own once its time has passed, unless renewed', () => {
    let now = 1_000_000
    const c = new DevConsole(() => now)
    c.subscribe('reader', [A1], { leaseMs: 60_000 })
    now += 50_000
    expect(c.renew('reader')).toBe(true)
    now += 50_000
    expect(c.sourcesOf('reader')).toEqual([A1])
    now += 20_000
    expect(c.sourcesOf('reader')).toEqual([])
    expect(c.capturing(A1)).toBe(false)
    expect(c.renew('reader')).toBe(false)
    c.unsubscribe('nobody')
  })

  it("ending the readers' captures leaves a window's", () => {
    const c = new DevConsole()
    c.subscribe('window:1', [A1])
    c.subscribe('agent:x', [A1, A2], { leaseMs: 60_000 })
    c.endReaders()
    expect(c.sourcesOf('agent:x')).toEqual([])
    expect(c.capturing(A1)).toBe(true)
    expect(c.capturing(A2)).toBe(false)
  })

  it("sends live events to a subscriber that takes them, with text only to one that opted in", async () => {
    const c = new DevConsole()
    const plain: ConsoleEvent[] = []
    const text: ConsoleEvent[] = []
    c.subscribe('agent', [A1], { deliver: (e) => plain.push(...e) })
    c.subscribe('recording', [A1], { deliver: (e) => text.push(...e), includeText: true })
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'hello there' } }))
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'and more' } }))
    await vi.waitFor(() => expect(plain).toHaveLength(2), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(text).toHaveLength(2), { timeout: HUNG_MS })
    expect(plain.map((e) => (e.raw as { text: string }).text)).toEqual(['<text: 11 chars>', '<text: 8 chars>'])
    expect(text.map((e) => (e.raw as { text: string }).text)).toEqual(['hello there', 'and more'])
    // What a reader reads is always the redacted copy.
    expect(c.events(A1).map((e) => (e.raw as { text: string }).text)).toEqual(['<text: 11 chars>', '<text: 8 chars>'])
    // Once the recording ends, no event keeps text for anyone.
    c.unsubscribe('recording')
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'later' } }))
    await vi.waitFor(() => expect(plain).toHaveLength(3), { timeout: HUNG_MS })
    expect((plain[2].raw as { text: string }).text).toBe('<text: 5 chars>')
  })

  it("a capture point that throws keeps nothing and doesn't fail its caller", () => {
    const c = new DevConsole()
    c.subscribe('w', [A1])
    expect(() =>
      c.capture([A1], () => {
        throw new Error('boom')
      })
    ).not.toThrow()
    c.capture([A1], () => null)
    expect(c.events(A1)).toHaveLength(0)
  })

  it('numbers events across sources, so since works after a ring is made again', () => {
    const c = new DevConsole()
    c.subscribe('w', [A1, A2])
    c.capture([A1], () => ({ kind: 'hook', name: 'a', summary: 's' }))
    c.capture([A2], () => ({ kind: 'hook', name: 'b', summary: 's' }))
    c.unsubscribe('w')
    c.subscribe('w', [A1])
    c.capture([A1], () => ({ kind: 'hook', name: 'c', summary: 's' }))
    expect(c.events(A1)[0].seq).toBe(3)
  })
})

describe('mayRead', () => {
  const wsOf = (p: string): string | null => (p.toLowerCase().startsWith(ws.toLowerCase()) ? ws : p.toLowerCase().startsWith(join('C:\\', 'elsewhere').toLowerCase()) ? join('C:\\', 'elsewhere') : null)
  const assistantHome = sessionSourceId(join(ws, '.hive', 'assistant'), 'assistant')

  it('a project agent reads its own session only', () => {
    const me = { kind: 'agent' as const, projectPath: alpha, agentId: 'a1' }
    expect(mayRead(me, A1, wsOf)).toBe(true)
    // By any spelling of its own folder.
    expect(mayRead({ ...me, projectPath: alpha.toUpperCase() + '\\' }, A1, wsOf)).toBe(true)
    expect(mayRead(me, A2, wsOf)).toBe(false)
    expect(mayRead(me, sessionSourceId(beta, 'a1'), wsOf)).toBe(false)
    expect(mayRead(me, assistantHome, wsOf)).toBe(false)
    expect(mayRead(me, hiveSourceId(ws), wsOf)).toBe(false)
  })

  it("the Assistant reads its workspace's sessions, its own and Hive's events there, and nothing elsewhere", () => {
    const assistant = { kind: 'assistant' as const, workspace: ws.toLowerCase() }
    expect(mayRead(assistant, A1, wsOf)).toBe(true)
    expect(mayRead(assistant, sessionSourceId(beta, 'b1'), wsOf)).toBe(true)
    expect(mayRead(assistant, assistantHome, wsOf)).toBe(true)
    expect(mayRead(assistant, hiveSourceId(ws), wsOf)).toBe(true)
    expect(mayRead(assistant, sessionSourceId(other, 'g1'), wsOf)).toBe(false)
    expect(mayRead(assistant, hiveSourceId(join('C:\\', 'elsewhere')), wsOf)).toBe(false)
    // A folder in no open workspace.
    expect(mayRead(assistant, sessionSourceId(join('D:\\', 'loose'), 'x'), wsOf)).toBe(false)
  })

  it('a malformed source is nobody\'s', () => {
    for (const bad of ['', 'session:', 'session:c:\\work\\alpha', 'session:c:\\work\\alpha#', 'hive:', 'other:x']) {
      expect(parseSourceId(bad)).toBeNull()
      expect(mayRead({ kind: 'all' }, bad, wsOf)).toBe(false)
    }
    expect(mayRead({ kind: 'all' }, A1, wsOf)).toBe(true)
  })
})

describe('summaries', () => {
  it('a hook: what came in, what Hive took it for, and what it did, in its own words', () => {
    expect(hookSummary('PreToolUse', 'Edit', 'toolStart', 'working', [], true)).toBe('PreToolUse (Edit) → toolStart; working; replied')
    expect(hookSummary('Stop', undefined, 'stop', 'finished', ['notifyFinished', 'turnEnded'], false)).toBe('Stop → stop; finished; notifyFinished, turnEnded')
    // A tool name that isn't an identifier is not quoted.
    expect(hookSummary('PreToolUse', 'rm -rf my secrets', 'toolStart', 'working', [], false)).toBe('PreToolUse (<text: 17 chars>) → toolStart; working')
  })

  it("a transcript read: its newest records next to what Hive read from them", () => {
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: 'event', n: i })).join('\n') + '\nnot json\n'
    const e = transcriptEvent('codex', lines, { modelId: 'gpt-5', planUsage: { provider: 'codex', plan: null, updatedAt: 'x', limits: [{ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: 41.6, resetsAt: null }] } })
    const raw = e.raw as { records: number; newest: unknown[] }
    expect(raw.records).toBe(13)
    expect(raw.newest).toHaveLength(10)
    expect(raw.newest[9]).toEqual({ unparsed: 8 })
    expect(e.summary).toBe('transcript +13 records → model gpt-5 · five_hour 42%')
  })
})

describe('replies', () => {
  const source = { label: 'alpha · B1', kind: 'session', project: 'alpha', agent: 'B1', provider: 'claude-code', capturing: true, events: 2, reading: true }

  it('lists the sources with how to name each', () => {
    const text = consoleSourcesText([source, { label: 'Hive', kind: 'hive', capturing: false, events: 0, reading: false }])
    expect(text).toBe('alpha · B1 (claude-code): you capture it, 2 events [agent=B1 project=alpha]\nHive: not captured [source=hive]')
    expect(consoleSourcesText([])).toBe('No developer console sources you can read.')
  })

  it('a read: a line per event and how to carry on', () => {
    const events = [{ seq: 7, at: '2026-10-12T01:02:03.000Z', kind: 'hook', name: 'Stop', summary: 'Stop → stop; finished' }]
    const text = consoleEventsText({ source, started: false, leaseEnds: '2026-10-12T01:32:03.000Z', events, older: 4, newest: 7 })
    expect(text).toBe('alpha · B1: capturing until 01:32 UTC (each read renews it).\n#7 01:02:03 hook Stop → stop; finished\n4 earlier not shown.\nNext: since=7. seq=[n] gives an event\'s raw payload and what Hive made of it.')
    expect(consoleEventsText({ source, started: true, leaseEnds: '2026-10-12T01:32:03.000Z', events: [], newest: 0 })).toContain('No events yet: capture starts now')
    expect(consoleEventsText({ source, started: false, leaseEnds: '2026-10-12T01:32:03.000Z', events: [], missing: [3] })).toContain('Not in its buffer now: #3.')
  })
})
