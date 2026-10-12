import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { HOOK_FIELDS, HOOK_MADE_FIELDS, sessionSourceId, type ConsoleEvent } from '../src/shared/devConsole'
import { DevConsole } from '../src/main/devConsole'
import { compareContract, diagnosticRecording, DIAGNOSTIC_LINES, parseRecording, recordingToFixture, shapeOf, type ConsoleFixture, type RecordingHeader } from '../src/shared/consoleFixtures.mts'

// Developer console recordings as files (#638): a recording written as the recorder writes it (header, events as a
// subscription delivers them, end) stays redacted unless it opted in to text; fixtures are made only from redacted
// recordings, without paths; the contract comparison flags what a CLI changed; Copy Diagnostics takes the newest part.
// Paths are only compared, never touched.
const alpha = join('C:\\', 'work', 'alpha')
const A1 = sessionSourceId(alpha, 'a1')
const HUNG_MS = 10000
const PRIVATE = 'privatecustomer'

const header = (text = false): RecordingHeader => ({
  type: 'recording',
  format: 1,
  hive: '0.7.0',
  startedAt: '2026-10-12T09:00:00.000Z',
  source: { kind: 'session', label: 'alpha · B1', provider: 'claude-code' },
  text,
  clis: [
    { provider: 'claude-code', version: '2.1.296', tested: '2.1.296' },
    { provider: 'codex', version: null, tested: '0.162.1' }
  ]
})

/** A hook as Claude Code sends it, with a prompt, a secret and paths. */
const hook = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: name,
  session_id: '0b5f0c2e-3f7e-4c1a-9c8e-2d1f0a6b7c8d',
  cwd: alpha,
  transcript_path: join(alpha, '.claude', 's.jsonl'),
  prompt: `deploy for ${PRIVATE} with sk-ant-api03-abcdefghijklmnopqrstuv`,
  ...extra
})

/** Records two hooks through a subscription, as consoleRecorder.ts does: the file's text. */
async function record(includeText: boolean): Promise<string> {
  const c = new DevConsole()
  const got: ConsoleEvent[] = []
  c.subscribe('record:1', [A1], { includeText, deliver: (e) => got.push(...e) })
  c.capture([A1], () => ({ kind: 'hook', name: 'UserPromptSubmit', provider: 'claude-code', summary: 'UserPromptSubmit → prompt; working', raw: hook('UserPromptSubmit'), made: { event: { kind: 'prompt' }, status: 'working', actions: [] }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS } }))
  c.capture([A1], () => ({ kind: 'hook', name: 'PreToolUse', provider: 'claude-code', summary: 'PreToolUse (Edit) → toolStart; working', raw: hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(alpha, 'a.ts'), old_string: PRIVATE } }), made: { event: { kind: 'toolStart' }, status: 'working', actions: [] }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS } }))
  c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 'typed', raw: { text: PRIVATE } }))
  await vi.waitFor(() => expect(got).toHaveLength(3), { timeout: HUNG_MS })
  const lines = [header(includeText), ...got.map((e) => ({ type: 'event', ...e })), { type: 'end', at: '2026-10-12T09:01:00.000Z', events: got.length, dropped: 0, reason: 'stopped' }]
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('')
}

describe('recording', () => {
  it('is redacted by default: no prompt, edit or typed text, no token; ids, names and paths kept', async () => {
    const text = await record(false)
    expect(text).not.toContain(PRIVATE)
    expect(text).not.toContain('sk-ant')
    const r = parseRecording(text)
    expect(r.header?.text).toBe(false)
    expect(r.events.map((e) => e.name)).toEqual(['UserPromptSubmit', 'PreToolUse', 'typed'])
    expect((r.events[1].raw as { tool_input: { file_path: string } }).tool_input.file_path).toBe(join(alpha, 'a.ts'))
    expect(r.end?.events).toBe(3)
  })

  it('keeps text only when the recording opted in, tokens still masked', async () => {
    const text = await record(true)
    expect(text).toContain(PRIVATE)
    expect(text).not.toContain('sk-ant-api03')
  })

  it('reads what it can of a recording cut short', () => {
    const r = parseRecording(`${JSON.stringify(header())}\n${JSON.stringify({ type: 'event', seq: 1, at: '', kind: 'hook', name: 'Stop', summary: '' })}\n{"type":"ev`)
    expect(r.events).toHaveLength(1)
    expect(r.end).toBeNull()
    expect(r.bad).toBe(1)
  })
})

describe('recordingToFixture', () => {
  it("keeps the CLI's events and Hive's reading of them, in order, without times, paths or Hive's own work", async () => {
    const f = recordingToFixture(await record(false))
    expect(f).toMatchObject({ format: 1, provider: 'claude-code', cli: '2.1.296', hive: '0.7.0', recordedAt: '2026-10-12T09:00:00.000Z' })
    expect(f.events.map((e) => `${e.kind} ${e.name}`)).toEqual(['hook UserPromptSubmit', 'hook PreToolUse'])
    const text = JSON.stringify(f)
    expect(text).not.toMatch(/work[\\/]+alpha|"seq"|"at"/)
    expect((f.events[1].raw as { cwd: string; tool_input: { file_path: string } }).tool_input.file_path).toBe('<path>')
    expect((f.events[1].made as { event: { kind: string } }).event.kind).toBe('toolStart')
  })

  it('refuses a recording with text, and anything that is not a recording', async () => {
    expect(() => recordingToFixture('')).toThrow(/Not a developer console recording/)
    await expect(record(true).then(recordingToFixture)).rejects.toThrow(/includes prompt and reply text/)
    expect(() => recordingToFixture(`${JSON.stringify(header())}\n`)).toThrow(/no events from a CLI/)
  })
})

describe('compareContract', () => {
  const fixture = (events: ConsoleFixture['events']): ConsoleFixture => ({ format: 1, provider: 'claude-code', cli: '2.1.296', hive: '0.7.0', recordedAt: '', events })
  const pre = (raw: Record<string, unknown>, kind = 'toolStart'): ConsoleFixture['events'][number] => ({ kind: 'hook', name: 'PreToolUse', raw, made: { event: { kind }, status: 'working' } })
  const base = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), { kind: 'hook', name: 'Stop', raw: { hook_event_name: 'Stop' }, made: { event: { kind: 'stop' } } }, { kind: 'terminal', name: 'ready', made: { status: 'ready' } }])

  it('finds nothing when the CLI sends the same', () => {
    expect(compareContract(base, base)).toEqual([])
  })

  it('flags a hook no longer sent, a field gone (a likely rename) or retyped, and a new reading as changes', () => {
    const live = fixture([pre({ hook_event_name: 'PreToolUse', toolName: 'Edit', tool_input: { file_path: 3 } }, 'ignore'), { kind: 'terminal', name: 'ready', made: { status: 'ready' } }])
    expect(compareContract(base, live)).toEqual([
      { level: 'change', event: 'hook PreToolUse', what: 'field tool_name is gone (renamed to toolName?)' },
      { level: 'new', event: 'hook PreToolUse', what: 'field toolName is new' },
      { level: 'change', event: 'hook PreToolUse', what: 'field tool_input.file_path was string, now number' },
      { level: 'change', event: 'hook PreToolUse', what: 'Hive reads it as ignore now, not toolStart' },
      { level: 'change', event: 'hook Stop', what: 'no longer arrives' }
    ])
  })

  it('only flags what is new: a new hook, a new field, a value where there was none; markers that vary with timing are not required', () => {
    const live = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' }, effort: 'high' }), { kind: 'hook', name: 'Stop', raw: { hook_event_name: 'Stop' }, made: { event: { kind: 'stop' } } }, { kind: 'hook', name: 'Notification', raw: { hook_event_name: 'Notification' } }])
    expect(compareContract(base, live)).toEqual([
      { level: 'new', event: 'hook PreToolUse', what: 'field effort is new' },
      { level: 'new', event: 'hook Notification', what: 'arrives now, and is not in the fixture' }
    ])
    const wasNull = fixture([pre({ hook_event_name: 'PreToolUse', model: null })])
    expect(compareContract(wasNull, fixture([pre({ hook_event_name: 'PreToolUse', model: 'opus' })]))).toEqual([])
  })

  it("doesn't hold a transcript read's records or a terminal marker's reading to the fixture: they vary with timing", () => {
    const read = (newest: unknown[]): ConsoleFixture['events'][number] => ({ kind: 'transcript', name: 'transcript', raw: { records: newest.length, newest } })
    expect(compareContract(fixture([read([{ type: 'user', data: { text: '<text: 3 chars>' } }])]), fixture([read([{ type: 'session.usage_record', data: { usage: { inputTokens: 1 } } }])]))).toEqual([])
  })

  it("merges a field's types over a list's items", () => {
    expect(Object.fromEntries([...shapeOf([{ a: [{ b: 1 }, { b: 'x' }] }])].map(([k, v]) => [k, [...v]]))).toEqual({ a: ['array'], 'a[]': ['object'], 'a[].b': ['number', 'string'] })
  })
})

describe('diagnosticRecording', () => {
  it("takes a redacted recording's newest events, every string redacted again", async () => {
    const part = diagnosticRecording(await record(false), (s) => s.split(alpha).join('<folder>').replace('alpha · B1', '<agent>'))
    expect(part?.lines).toHaveLength(3)
    expect(part?.summary).toMatch(/^session source \(claude-code\), started 2026-10-12T09:00:00.000Z, Hive 0.7.0; 3 events, ended \(stopped\); CLIs: claude-code 2.1.296 \(tested with 2.1.296\); redacted; the newest 3$/)
    expect(part?.lines.join('\n')).not.toContain(alpha.replace(/\\/g, '\\\\'))
    expect(part?.lines.join('\n')).toContain('<folder>')
  })

  it('never takes a recording with text, and keeps to its bound', async () => {
    expect(diagnosticRecording(await record(true), (s) => s)).toBeNull()
    const many = [header(), ...Array.from({ length: DIAGNOSTIC_LINES + 50 }, (_, i) => ({ type: 'event', seq: i + 1, at: '', kind: 'hook', name: 'Stop', summary: '' }))].map((l) => JSON.stringify(l)).join('\n')
    const part = diagnosticRecording(many, (s) => s)
    expect(part?.lines).toHaveLength(DIAGNOSTIC_LINES)
    expect(JSON.parse(part!.lines.at(-1)!).seq).toBe(DIAGNOSTIC_LINES + 50)
  })
})
