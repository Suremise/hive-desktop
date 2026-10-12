import { describe, expect, it } from 'vitest'
import { claudeSafeguards } from '../src/main/providers/claude/safeguards'
import { codexSafeguards } from '../src/main/providers/codex/safeguards'
import { claudeCode } from '../src/main/providers/claude/adapter'
import type { Ask } from '../src/main/providers/types'
import { SAFEGUARD_DEFAULTS, noteSafeguard, safeguardCodes, safeguardPattern, safeguardText, type SafeguardEvent, type SafeguardNote } from '../src/shared/safeguards'

const lines = (...o: unknown[]): string => o.map((x) => JSON.stringify(x)).join('\n') + '\n'
const at = (iso: string): number => Date.parse(iso)

// Shapes as Claude Code 2.1.296 wrote them when Opus 5.5's safeguards stopped one of HB3's responses (11 Oct), with the
// content cut down: a tool call, the stopped response, the note, the notice for the model, and the turn carrying on.
const T0 = '2026-10-11T14:11:32.862Z'
const T1 = '2026-10-11T14:12:12.921Z'
const T2 = '2026-10-11T14:12:58.912Z'
const T3 = '2026-10-11T14:30:00.000Z'
const assistant = (ts: string, model: string, content: unknown[], extra: object = {}): object => ({ type: 'assistant', timestamp: ts, requestedModel: model, message: { model, role: 'assistant', content }, ...extra })
const toolUse = (name: string): object => ({ type: 'tool_use', id: `toolu_${name}`, name, input: { command: 'secret input' } })
const NOTE = { type: 'system', subtype: 'informational', content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted", isMeta: false, timestamp: T1, level: 'notice' }
const NOTICE = {
  type: 'user',
  isMeta: true,
  turnCompanion: true,
  timestamp: T1,
  refusedMessageId: 'msg_011Cfvauyd3uQPdZm46RmgmS',
  message: { role: 'user', content: 'Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.' }
}

describe('Claude Code safeguards', () => {
  it('reads a stop once from its note and notice, with the model and the names of the last tool calls', () => {
    const memo = {}
    const out = claudeSafeguards(
      lines(
        assistant(T0, 'claude-opus-5-5', [toolUse('Read')]),
        assistant(T0, 'claude-opus-5-5', [toolUse('Bash'), toolUse('Edit')]),
        { type: 'user', timestamp: T0, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Bash', content: 'ok' }] } },
        assistant(T1, 'claude-opus-5-5', [{ type: 'thinking', thinking: '' }]),
        NOTE,
        NOTICE,
        assistant(T2, 'claude-opus-5-5', [toolUse('Bash')])
      ),
      memo
    )
    expect(out).toEqual([{ kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: ['Read', 'Bash', 'Edit'] }])
    // Only names: nothing of a call's input or the stopped content.
    expect(JSON.stringify(out)).not.toMatch(/secret|withheld/)
  })

  it('reads the notice alone (a reworded note) and the note alone (no notice)', () => {
    expect(claudeSafeguards(lines({ ...NOTE, content: 'Something new happened · carrying on' }, NOTICE), {})).toEqual([{ kind: 'stop', at: at(T1), tools: [] }])
    expect(claudeSafeguards(lines(NOTE), {})).toEqual([{ kind: 'stop', at: at(T1), tools: [] }])
  })

  it('counts two stops minutes apart, and one stop split across two reads once', () => {
    const memo = {}
    expect(claudeSafeguards(lines(NOTE), memo)).toHaveLength(1)
    expect(claudeSafeguards(lines(NOTICE), memo)).toHaveLength(0)
    expect(claudeSafeguards(lines({ ...NOTE, timestamp: T3 }), memo)).toHaveLength(1)
  })

  it('flags a model change after a stop, not before one, nor a subagent, synthetic or API error message', () => {
    const memo = {}
    const before = claudeSafeguards(lines(assistant(T0, 'claude-sonnet-5-5', []), assistant(T0, 'claude-opus-5-5', [toolUse('Bash')])), memo)
    expect(before).toEqual([])
    const out = claudeSafeguards(
      lines(
        NOTE,
        assistant(T2, 'claude-haiku-4-5-20251001', [], { isSidechain: true }),
        assistant(T2, '<synthetic>', []),
        assistant(T2, 'claude-sonnet-5-5', [], { isApiErrorMessage: true }),
        assistant(T3, 'claude-opus-4-8', [toolUse('Grep')]),
        assistant(T3, 'claude-opus-4-8', [])
      ),
      memo
    )
    expect(out).toEqual([
      { kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: ['Bash'] },
      { kind: 'switch', at: at(T3), from: 'claude-opus-5-5', to: 'claude-opus-4-8' }
    ])
  })

  it("never counts the person's own words about a stop: a prompt, or /feedback", () => {
    const out = claudeSafeguards(
      lines(
        { type: 'user', timestamp: T1, message: { role: 'user', content: 'Your response was stopped by a safety classifier, carry on' } },
        { type: 'system', subtype: 'local_command', timestamp: T1, content: '<command-name>/feedback</command-name>\n<command-args>False positive: Opus 5.5 cyber safeguard stopped a response</command-args>' },
        { type: 'system', subtype: 'informational', timestamp: T1, content: '<local-command-stdout>the safeguards stopped nothing</local-command-stdout>' }
      ),
      {}
    )
    expect(out).toEqual([])
  })

  it('takes the note pattern from an override, and keeps the default when the override does not compile', () => {
    expect(claudeSafeguards(lines({ ...NOTE, content: 'Guardrails halted the reply' }), {}, { claudeNote: 'guardrails halted' })).toHaveLength(1)
    expect(claudeSafeguards(lines(NOTE), {}, { claudeNote: '(' })).toHaveLength(1)
  })

  it('skips lines it cannot parse', () => {
    expect(claudeSafeguards('{"type":"system", broken\n\n' + lines(NOTE), {})).toHaveLength(1)
  })
})

describe('Codex safeguards', () => {
  const rec = (ts: string, type: string, payload: object): object => ({ timestamp: ts, type, payload })
  it('reads a reroute as a stop on the model it left and a flagged switch, and the next turn on its own model as the switch back', () => {
    const memo = {}
    const out = codexSafeguards(
      lines(
        rec(T0, 'turn_context', { model: 'gpt-5.3-codex' }),
        rec(T0, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"secret"}', call_id: 'c1' }),
        rec(T0, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'secret', call_id: 'c2' }),
        rec(T1, 'event_msg', { type: 'model_reroute', from_model: 'gpt-5.3-codex', to_model: 'gpt-5.2', reason: 'high_risk_cyber_activity' }),
        rec(T3, 'turn_context', { model: 'gpt-5.3-codex' })
      ),
      memo
    )
    expect(out).toEqual([
      { kind: 'stop', at: at(T1), model: 'gpt-5.3-codex', tools: ['Shell', 'Edit'] },
      { kind: 'switch', at: at(T1), from: 'gpt-5.3-codex', to: 'gpt-5.2', flagged: true },
      { kind: 'switch', at: at(T3), from: 'gpt-5.2', to: 'gpt-5.3-codex' }
    ])
  })

  it('reads a turn its policy stopped once, from the error and the turn end; another error is not one', () => {
    const out = codexSafeguards(
      lines(
        rec(T0, 'turn_context', { model: 'gpt-5.3-codex' }),
        rec(T1, 'event_msg', { type: 'error', message: 'This request was flagged', codex_error_info: 'cyber_policy' }),
        rec(T1, 'event_msg', { type: 'task_complete', error: { message: 'flagged', codex_error_info: 'cyber_policy' } }),
        rec(T3, 'event_msg', { type: 'error', message: 'Rate limited', codex_error_info: 'usage_limit_exceeded' }),
        rec(T3, 'event_msg', { type: 'model_reroute', from_model: 'a', to_model: 'b', reason: 'something_else' })
      ),
      {}
    )
    expect(out).toEqual([{ kind: 'stop', at: at(T1), model: 'gpt-5.3-codex', tools: [] }])
  })

  it('takes its codes from an override', () => {
    expect(codexSafeguards(lines(rec(T1, 'event_msg', { type: 'error', codex_error_info: { new_policy: {} } })), {}, { codexStop: ['new_policy'] })).toHaveLength(1)
  })
})

describe('the named defaults', () => {
  it('are data in one place, each pattern compiling', () => {
    for (const [name, v] of Object.entries(SAFEGUARD_DEFAULTS)) {
      if (typeof v === 'string') expect(() => new RegExp(v), name).not.toThrow()
      else expect(v.length, name).toBeGreaterThan(0)
    }
    expect(safeguardPattern('claudePrompt').test('Opus 5.5 safeguards flagged this. Switch to Opus 4.8?')).toBe(true)
    expect(safeguardCodes('codexStop', { codexStop: [] })).toEqual(SAFEGUARD_DEFAULTS.codexStop)
  })
})

describe('the note', () => {
  const stop = (iso: string, model?: string): SafeguardEvent => ({ kind: 'stop', at: at(iso), ...(model ? { model } : {}), tools: ['Bash', 'Edit'] })
  const sw = (iso: string, from: string, to: string, flagged?: boolean): SafeguardEvent => ({ kind: 'switch', at: at(iso), from, to, ...(flagged ? { flagged } : {}) })

  it('counts stops, keeps a switch (unseen) until the model changes back, and ignores a switch with no stop', () => {
    expect(noteSafeguard(undefined, sw(T0, 'a', 'b'))).toBeNull()
    let n = noteSafeguard(undefined, stop(T1, 'claude-opus-5-5'))!
    expect(n).toEqual({ at: new Date(at(T1)).toISOString(), model: 'claude-opus-5-5', tools: ['Bash', 'Edit'], stops: 1 })
    n = noteSafeguard(n, sw(T2, 'claude-opus-5-5', 'claude-opus-4-8'))!
    expect(n.switched).toEqual({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', at: new Date(at(T2)).toISOString() })
    expect(n.unseen).toBe(true)
    expect(noteSafeguard(n, sw(T2, 'claude-opus-5-5', 'claude-opus-4-8'))).toBeNull()
    n = noteSafeguard(n, stop(T3, 'claude-opus-4-8'))!
    expect(n.stops).toBe(2)
    expect(n.switched?.to).toBe('claude-opus-4-8')
    const back = noteSafeguard(n, sw(T3, 'claude-opus-4-8', 'claude-opus-5-5'))!
    expect(back.switched).toBeUndefined()
    expect(back.unseen).toBeUndefined()
    expect(back.stops).toBe(2)
  })

  it('notes a flagged switch with no stop before it', () => {
    expect(noteSafeguard(undefined, sw(T1, 'gpt-5.3-codex', 'gpt-5.2', true))).toMatchObject({ stops: 0, switched: { from: 'gpt-5.3-codex', to: 'gpt-5.2' } })
  })

  it('says what happened, the model now, and the tool names, never content', () => {
    const n: SafeguardNote = { at: T1, model: 'claude-opus-5-5', tools: ['Bash', 'Edit'], stops: 2, switched: { from: 'claude-opus-5-5', to: 'claude-opus-4-8', at: T2 }, idle: true }
    const text = safeguardText(n, (m) => m.replace('claude-', ''))
    expect(text).toMatch(/^A safety classifier stopped a response on opus-5-5 at \d\d:\d\d \(2 this session\)\. It now runs on opus-4-8 instead of opus-5-5 \(since \d\d:\d\d\)\. Idle after the stop: give it a nudge\. Before it, its last tool calls: Bash, Edit\.$/)
    expect(safeguardText({ ...n, idle: false, prompt: true })).toContain('Its CLI asks what to do about it.')
  })
})

describe('usage', () => {
  it("counts a session's stops by model (what Performance sums per agent and model)", async () => {
    const { parseTranscript } = await import('../src/main/providers/claude/usage')
    const { parseRollout } = await import('../src/main/providers/codex/rollout')
    const claude = parseTranscript(lines(assistant(T0, 'claude-opus-5-5', [toolUse('Bash')]), NOTE, NOTICE, assistant(T3, 'claude-opus-4-8', []), { ...NOTE, timestamp: T3 }), 's1')
    expect(claude.safeguards).toEqual({ 'claude-opus-5-5': 1, 'claude-opus-4-8': 1 })
    expect(parseTranscript(lines(assistant(T0, 'claude-opus-5-5', [])), 's2').safeguards).toBeUndefined()
    const codex = parseRollout(lines({ timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }, { timestamp: T1, type: 'event_msg', payload: { type: 'error', codex_error_info: 'cyber_policy' } }), 's3')
    expect(codex.safeguards).toEqual({ 'gpt-5.3-codex': 1 })
  })
})

describe('one stop seen twice', () => {
  it('counts a stop once when its prompt and its transcript entry arrive apart, taking the tools and model the second adds', () => {
    const first = noteSafeguard(undefined, { kind: 'stop', at: at(T1), tools: [] })!
    const again = noteSafeguard(first, { kind: 'stop', at: at(T1) - 2000, model: 'claude-opus-5-5', tools: ['Bash'] })!
    expect([again.stops, again.model, again.tools]).toEqual([1, 'claude-opus-5-5', ['Bash']])
    expect(noteSafeguard(again, { kind: 'stop', at: at(T1) + 1000, tools: [] })).toBeNull()
    expect(noteSafeguard(again, { kind: 'stop', at: at(T3), tools: [] })!.stops).toBe(2)
  })

  it('a prompt still waiting stays through a new stop', () => {
    const waiting: SafeguardNote = { at: new Date(at(T1)).toISOString(), tools: [], stops: 1, prompt: true }
    expect(noteSafeguard(waiting, { kind: 'stop', at: at(T3), tools: ['Read'] })).toMatchObject({ stops: 2, prompt: true, tools: ['Read'] })
  })
})

describe("Claude Code's prompt about a stop, told by its screen", () => {
  const ask = (message: string): Ask => ({ kind: 'permission', blocking: true, message })
  const dialog = [" Opus 5.5's safeguards stopped this response.", ' Switch this conversation to Opus 4.8?', ' ❯ 1. Stay on Opus 5.5', '   2. Switch to Opus 4.8']
  const screen = (...rows: string[]): string => rows.join('\n')
  const rows = (text: string, n: number): string[] => Array<string>(n).fill(text)

  it('is a permission prompt naming no tool while its screen shows the safeguard dialog, near its input or on a cleared screen', () => {
    expect(claudeCode.safeguardAsk!(ask('Claude needs your permission'), screen(...rows('older output', 40), ...dialog, ''))).toBe(true)
    // Cleared for the dialog: it is at the top, blank rows below.
    expect(claudeCode.safeguardAsk!(ask('Claude needs your permission'), screen(...dialog, ...rows('', 30)))).toBe(true)
  })

  it("is no tool's permission prompt, nor a dialog scrolled away", () => {
    expect(claudeCode.safeguardAsk!(ask('Claude needs your permission to use Bash'), screen(...dialog))).toBe(false)
    expect(claudeCode.safeguardAsk!(ask('Claude needs your permission'), screen(...dialog, ...rows('later output', 30), '❯ '))).toBe(false)
  })
})
