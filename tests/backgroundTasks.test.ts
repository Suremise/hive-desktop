import { describe, expect, it } from 'vitest'
import { claudeBackgroundTasks } from '../src/main/providers/claude/background'
import { codexBackgroundTasks } from '../src/main/providers/codex/background'

const line = (o: unknown): string => JSON.stringify(o)
const lines = (...o: unknown[]): string => o.map(line).join('\n') + '\n'
const at = (iso: string): number => Date.parse(iso)

// Shapes as Claude Code 2.1 writes them (from real transcripts).
const notification = (id: string, status: string, extra = ''): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>${status}</status>\n<summary>Background command "Run all e2e suites" completed (exit code 0)</summary>${extra}\n</task-notification>`

describe('Claude Code background tasks', () => {
  it('starts a task from a background Bash result, a command moved to the background, and a Monitor', () => {
    const t = '2026-10-01T03:49:23.000Z'
    const out = claudeBackgroundTasks(
      lines(
        { type: 'user', timestamp: t, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bkqkq2vgh' } },
        { type: 'user', timestamp: t, toolUseResult: { stdout: '', backgroundTaskId: 'bum6823gu', timedOutAfterMs: 120000 } },
        { type: 'user', timestamp: t, toolUseResult: { taskId: 'bi9giyn5m', timeoutMs: 1800000, persistent: false } },
        { type: 'user', timestamp: t, toolUseResult: { taskId: 'bpersist1', timeoutMs: 1800000, persistent: true } }
      )
    )
    expect(out).toEqual([
      { kind: 'start', id: 'bkqkq2vgh', at: at(t) },
      { kind: 'start', id: 'bum6823gu', at: at(t) },
      { kind: 'start', id: 'bi9giyn5m', at: at(t), expiresAt: at(t) + 1800000 },
      { kind: 'start', id: 'bpersist1', at: at(t) }
    ])
  })

  it('ends a task on its notification, wherever it is written, and on TaskStop', () => {
    const t = '2026-10-01T04:06:12.000Z'
    const out = claudeBackgroundTasks(
      lines(
        { type: 'queue-operation', operation: 'enqueue', timestamp: t, content: notification('bkqkq2vgh', 'completed') },
        { type: 'user', timestamp: t, message: { role: 'user', content: notification('bi9giyn5m', 'completed', '\n<event>31 passed</event>') } },
        { type: 'user', timestamp: t, message: { role: 'user', content: [{ type: 'text', text: `Note first.\n\n${notification('bfailed01', 'failed')}` }] } },
        { type: 'user', timestamp: t, toolUseResult: { message: 'Successfully stopped task: bum6823gu (npm run e2e)' } }
      )
    )
    expect(out).toEqual([
      { kind: 'end', id: 'bkqkq2vgh', at: at(t) },
      { kind: 'end', id: 'bi9giyn5m', at: at(t) },
      { kind: 'end', id: 'bfailed01', at: at(t) },
      { kind: 'end', id: 'bum6823gu', at: at(t) }
    ])
  })

  it("doesn't end a Monitor on one of its events", () => {
    expect(claudeBackgroundTasks(lines({ type: 'user', timestamp: '2026-10-01T04:00:00.000Z', message: { role: 'user', content: notification('bi9giyn5m', 'running') } }))).toEqual([])
  })

  it('ignores ordinary lines', () => {
    expect(claudeBackgroundTasks(lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'The tests pass.' }] } }, { type: 'user', toolUseResult: { stdout: 'ok' } }) + 'not json\n')).toEqual([])
  })
})

// Shapes as Codex 0.159 writes them (from real rollouts).
const output = (ts: string, ...chunks: unknown[]): unknown => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed\nWall time 11.2 seconds\nOutput:\n' }, ...chunks.map((c) => ({ type: 'input_text', text: JSON.stringify(c) }))] }
})

describe('Codex background terminals', () => {
  it('starts one when exec_command returns while the command still runs, and ends it when Codex records its end', () => {
    const t1 = '2026-10-01T09:40:52.798Z'
    const t2 = '2026-10-01T09:40:54.590Z'
    const out = codexBackgroundTasks(
      lines(
        output(t1, { chunk_id: 'd2b2a2', wall_time_seconds: 10, session_id: 51250, original_token_count: 0, output: '' }, { chunk_id: '1d9793', wall_time_seconds: 0.07, exit_code: 0, output: 'done' }),
        { timestamp: t2, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', process_id: '51250', command: ['powershell.exe'] } } }
      )
    )
    expect(out).toEqual([
      { kind: 'start', id: '51250', at: at(t1) },
      { kind: 'end', id: '51250', at: at(t2) }
    ])
  })

  it('ends one when write_stdin reports its exit code, and reads the older text form', () => {
    const t = '2026-10-01T09:41:09.000Z'
    expect(codexBackgroundTasks(lines(output(t, { chunk_id: 'x', session_id: 7, exit_code: 1, output: '' })))).toEqual([{ kind: 'end', id: '7', at: at(t) }])
    const older = { timestamp: t, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'Process running with session ID 42\nOutput:\n' } }
    expect(codexBackgroundTasks(lines(older))).toEqual([{ kind: 'start', id: '42', at: at(t) }])
  })

  it('ignores commands that finished within the call', () => {
    expect(codexBackgroundTasks(lines(output('2026-10-01T09:00:00.000Z', { chunk_id: 'a', wall_time_seconds: 0.2, exit_code: 0, output: 'ok' })))).toEqual([])
  })
})
