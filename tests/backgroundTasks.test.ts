import { describe, expect, it } from 'vitest'
import { claudeBackgroundTasks } from '../src/main/providers/claude/background'
import { codexBackgroundMemo, codexBackgroundTasks } from '../src/main/providers/codex/background'

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

// Code mode as Codex 0.160 writes it (from real rollouts, 4-5 Oct 2026): an `exec` script calls exec_command and
// prints what the model chose; Codex writes each command that ends within the script before the script's output.
const SLEEP = 'Start-Sleep -Seconds 40; Set-Content -Path bg-done.txt -Value done'
const script = (ts: string, callId: string, input: string): unknown => ({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input } })
const scriptOutput = (ts: string, callId: string, head: string, ...texts: string[]): unknown => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: `${head}\nWall time 10.4 seconds\nOutput:\n` }, ...texts.map((text) => ({ type: 'input_text', text }))] }
})
const commandEnded = (ts: string, pid: string, cmd: string): unknown => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'CommandExecution', id: `exec-${pid}`, process_id: pid, command: ['powershell.exe', '-Command', cmd] } }
})
const execOf = (cmd: string, print: string): string => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}, yield_time_ms:1000});\n${print}\n`

describe('Codex background terminals in code mode', () => {
  const t1 = '2026-10-04T22:56:43.760Z'
  const t2 = '2026-10-04T22:56:54.204Z'
  const t3 = '2026-10-04T22:57:24.284Z'

  it('takes the id a script printed on its own (text(r.session_id)), read by read, and ends it by its process_id', () => {
    const memo = codexBackgroundMemo()
    expect(codexBackgroundTasks(lines(script(t1, 'call_W7', execOf(SLEEP, 'text(r.session_id);'))), memo)).toEqual([])
    expect(codexBackgroundTasks(lines(scriptOutput(t2, 'call_W7', 'Script completed', '96600')), memo)).toEqual([{ kind: 'start', id: '96600', at: at(t2) }])
    expect(codexBackgroundTasks(lines(commandEnded(t3, '96600', SLEEP)), memo)).toEqual([{ kind: 'end', id: '96600', at: at(t3) }])
    expect(memo.known.size + memo.open.size + memo.unnamed.size).toBe(0)
  })

  it('takes the id when the script prints the whole result as JSON', () => {
    const out = codexBackgroundTasks(lines(script(t1, 'c1', execOf(SLEEP, 'text(JSON.stringify(r));')), scriptOutput(t2, 'c1', 'Script completed', JSON.stringify({ chunk_id: 'd2', wall_time_seconds: 1, session_id: 96600, output: '' })), commandEnded(t3, '96600', SLEEP)))
    expect(out).toEqual([
      { kind: 'start', id: '96600', at: at(t2) },
      { kind: 'end', id: '96600', at: at(t3) }
    ])
  })

  it('counts a simple script that printed no id under a stand-in, ended by the same command', () => {
    const memo = codexBackgroundMemo()
    const out = codexBackgroundTasks(lines(script(t1, 'c2', execOf(SLEEP, 'text("started");')), scriptOutput(t2, 'c2', 'Script completed', 'started'), commandEnded(t3, '96600', SLEEP)), memo)
    expect(out).toEqual([
      { kind: 'start', id: 'c2#0', at: at(t2) },
      { kind: 'end', id: '96600', at: at(t3) },
      { kind: 'end', id: 'c2#0', at: at(t3) }
    ])
    expect(memo.unnamed.size).toBe(0)
  })

  it('a loop: takes the ids it printed, and counts nothing when it printed none (no guess from the source)', () => {
    const loop = 'for (const cmd of ["Start-Sleep -Seconds 20", "Start-Sleep -Seconds 25"]) {\n  const r = await tools.exec_command({cmd, yield_time_ms: 500});\n  text(r.session_id);\n}\n'
    expect(codexBackgroundTasks(lines(script(t1, 'c3', loop), scriptOutput(t2, 'c3', 'Script completed', '2648', '72961')))).toEqual([
      { kind: 'start', id: '2648', at: at(t2) },
      { kind: 'start', id: '72961', at: at(t2) }
    ])
    const silent = loop.replace('  text(r.session_id);\n', '')
    expect(codexBackgroundTasks(lines(script(t1, 'c4', silent), scriptOutput(t2, 'c4', 'Script completed')))).toEqual([])
  })

  it('counts nothing for a call that may not have run: a condition, a function, two calls', () => {
    const cases = [
      `if (false) await tools.exec_command({cmd:${JSON.stringify(SLEEP)}, yield_time_ms:1000});`,
      `const go = async () => tools.exec_command({cmd:${JSON.stringify(SLEEP)}});`,
      `try { await tools.exec_command({cmd:${JSON.stringify(SLEEP)}}); } catch {}`,
      `await tools.exec_command({cmd:"npm run build"});\nawait tools.exec_command({cmd:${JSON.stringify(SLEEP)}, yield_time_ms:1000});`
    ]
    for (const [k, input] of cases.entries()) expect(codexBackgroundTasks(lines(script(t1, `s${k}`, input), scriptOutput(t2, `s${k}`, 'Script completed')))).toEqual([])
  })

  it('counts nothing for a call that is only text: in a string, or a comment', () => {
    const cases = ['text("Example: tools.exec_command(");', '// await tools.exec_command({cmd:"npm test"});\ntext("nothing ran");', '/* tools.exec_command({cmd:"x"}) */ text("no");']
    for (const [k, input] of cases.entries()) expect(codexBackgroundTasks(lines(script(t1, `x${k}`, input), scriptOutput(t2, `x${k}`, 'Script completed', 'nothing ran')))).toEqual([])
  })

  it('counts nothing for a call nested in an expression or a block', () => {
    const cases = [`const x = [await tools.exec_command({cmd:${JSON.stringify(SLEEP)}})];`, `{ await tools.exec_command({cmd:${JSON.stringify(SLEEP)}}); }`, `text(await tools.exec_command({cmd:${JSON.stringify(SLEEP)}}).session_id);`]
    for (const [k, input] of cases.entries()) expect(codexBackgroundTasks(lines(script(t1, `n${k}`, input), scriptOutput(t2, `n${k}`, 'Script completed')))).toEqual([])
  })

  it('text(r.session_id ?? r.output) (#178): the id while it runs, nothing once it ended within the script', () => {
    const memo = codexBackgroundMemo()
    const running = codexBackgroundTasks(lines(script(t1, 'q1', execOf(SLEEP, 'text(r.session_id ?? r.output);')), scriptOutput(t2, 'q1', 'Script completed', '7135')), memo)
    expect(running).toEqual([{ kind: 'start', id: '7135', at: at(t2) }])
    const cmd = 'Write-Output 42'
    const finished = codexBackgroundTasks(lines(script(t1, 'q2', execOf(cmd, 'text(r.session_id ?? r.output);')), commandEnded(t1, '777', cmd), scriptOutput(t2, 'q2', 'Script completed', '42')), memo)
    expect(finished).toEqual([{ kind: 'end', id: '777', at: at(t1) }])
    // Silent, with ?? and ?. in it, and still running: a simple script.
    expect(codexBackgroundTasks(lines(script(t1, 'q3', execOf(SLEEP, 'const s = r?.session_id ?? 0;')), scriptOutput(t2, 'q3', 'Script completed')))).toEqual([{ kind: 'start', id: 'q3#0', at: at(t2) }])
  })

  it("counts a script whose command's text holds && or a ? (inside its string) as simple", () => {
    const cmd = 'npm test && echo done?'
    expect(codexBackgroundTasks(lines(script(t1, 'c5', execOf(cmd, '')), scriptOutput(t2, 'c5', 'Script completed')))).toEqual([{ kind: 'start', id: 'c5#0', at: at(t2) }])
  })

  it('starts nothing for a script whose command ended within it, even when what it printed quotes a session_id', () => {
    const cmd = 'Get-Content rollout.jsonl -Tail 30'
    const out = codexBackgroundTasks(lines(script(t1, 'c6', execOf(cmd, 'text(r.output);')), commandEnded(t1, '98433', cmd), scriptOutput(t2, 'c6', 'Script completed', '{"x":{"session_id": 12345}}')))
    expect(out).toEqual([{ kind: 'end', id: '98433', at: at(t1) }])
  })

  it("doesn't read a session_id that isn't a whole number (a conversation id) as one", () => {
    expect(codexBackgroundTasks(lines(scriptOutput(t2, 'c7', 'Script completed', '{"payload":{"session_id":"01a108af-df27"}}')))).toEqual([])
  })

  it('starts nothing for a script that failed or was aborted (a rejected command)', () => {
    const call = 'const r = await tools.exec_command({cmd:"Remove-Item x"}); text(r.output);'
    const failed = codexBackgroundTasks(lines(script(t1, 'c8', call), scriptOutput(t2, 'c8', 'Script failed', 'Script error:\nexec_command failed: Rejected')))
    const aborted = codexBackgroundTasks(lines(script(t1, 'c9', call), { timestamp: t2, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c9', output: 'aborted by user after 3.5s' } }))
    expect([...failed, ...aborted]).toEqual([])
  })

  it('overlapping commands in both forms: an end known by its id ends only that one', () => {
    const memo = codexBackgroundMemo()
    const a = 'Start-Sleep -Seconds 60'
    const b = 'Start-Sleep -Seconds 40'
    const started = codexBackgroundTasks(
      lines(script(t1, 'a', execOf(a, '')), scriptOutput(t1, 'a', 'Script completed'), script(t2, 'b', execOf(b, 'text(JSON.stringify(r));')), scriptOutput(t2, 'b', 'Script completed', JSON.stringify({ session_id: 222, output: '' }))),
      memo
    )
    expect(started).toEqual([
      { kind: 'start', id: 'a#0', at: at(t1) },
      { kind: 'start', id: '222', at: at(t2) }
    ])
    expect(codexBackgroundTasks(lines(commandEnded(t3, '222', b)), memo)).toEqual([{ kind: 'end', id: '222', at: at(t3) }])
    expect(codexBackgroundTasks(lines(commandEnded(t3, '111', a)), memo)).toEqual([
      { kind: 'end', id: '111', at: at(t3) },
      { kind: 'end', id: 'a#0', at: at(t3) }
    ])
  })

  it("an end that can't be told apart leaves a running script unclear (nothing counted), and ends no stand-in", () => {
    const memo = codexBackgroundMemo()
    codexBackgroundTasks(lines(script(t1, 'a', execOf(SLEEP, '')), scriptOutput(t1, 'a', 'Script completed')), memo)
    // A command whose text no script holds (one a script built) ends while another script runs.
    const out = codexBackgroundTasks(lines(script(t2, 'b', execOf('npm test', '')), commandEnded(t2, '77', 'built elsewhere'), scriptOutput(t3, 'b', 'Script completed')), memo)
    expect(out).toEqual([{ kind: 'end', id: '77', at: at(t2) }])
    expect([...memo.unnamed.keys()]).toEqual(['a#0'])
  })
})
