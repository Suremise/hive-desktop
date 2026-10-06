// A stand-in for Claude Code in end-to-end tests: Hive launches it through its real Claude Code adapter
// (Settings → Claude Code → path = fake-claude.cmd), so the launch, hooks, status, transcripts and the Agent API
// are tested without signing in or spending tokens. It must run with CLAUDE_CONFIG_DIR pointing at a test folder.
//
// What it does, like Claude Code:
// - `--version` and `auth status --json` answer as a signed-in CLI.
// - In a folder it hasn't been told to trust, it first asks "Do you trust this folder?" with Claude Code's menu, but
//   starting on "Yes, I trust this folder" (Claude Code's starts on "No, exit"), so Enter trusts it; Down/Up move the
//   choice, and Enter on "No, exit" quits (exit 1).
// - It sends SessionStart, then takes prompts: the last command-line argument, or a line typed and sent with
//   Enter (Ctrl+U clears the line), shown on its input line as it is typed. Each prompt sends UserPromptSubmit, is written to the transcript, "works"
//   (1 s, or N seconds for "work N"), and ends with a reply and Stop. "edit <file>" first sends PreToolUse for
//   an Edit of that file and records the tool call. "background N" starts a background command that ends after
//   N seconds; its task notification then starts a turn by itself, as in Claude Code. "pad N" adds N KB to the
//   transcript. "context N": the reply's request reports N input tokens, so the session's context is about N. "ask" first asks for permission (a permission_prompt Notification), then carries on by itself.
//   "shell: <command line>" runs a command in cmd with the session's environment (fake-shell.jsonl records it).
//   "boardmove N COLUMN" moves card N as hive_update_task does (the hive tools' API, token and agent, from
//   --mcp-config) and records the answer in fake-calls.jsonl; "boardreview N ACTION [COLUMN]" reviews it the same way
//   (review: start, passed or failed; a column with the verdict), and "boardcomment N" comments on it. All are written to the transcript as the hive tool
//   call they stand for (mcp__hive__hive_update_task), as Claude Code writes an MCP call. "hive TOOL {json}" calls a
//   hive tool through the real hive MCP server of the launch's --mcp-config (fake-bridge.cjs: logged and measured by
//   Hive's performance metrics as a real call is), written to the transcript as that MCP call and its reply. A line
//   Hive types to wake it ("[Hive] #12 is in Review…", a card watch) is logged in fake-wakes.jsonl and answered with
//   the next line of fake-wakes-<agent>.txt (a test's script of what this agent does next). "skill NAME" reads a skill
//   as Claude Code's Skill tool does: a Skill call in the transcript ("hive:NAME"), answered with the skill's SKILL.md
//   from the launch's plugin folder (an error when it has none).
// - "/compact [focus]" compacts as Claude Code does: PreCompact, a compaction boundary in the transcript after 1 s (N
//   seconds when the focus has "hold N"), then PostCompact. With no messages yet it says "Not enough messages to compact."
//   and sends no hook; with "compactfail" in the focus it fails after PreCompact with "Error during compaction".
// - `--name` and "/rename <name>" set the session's name in the transcript (a custom title), as Claude Code does.
// - Ctrl+C twice, or "/exit", ends it with SessionEnd.
// - With fake-signin.json in CLAUDE_CONFIG_DIR saying { "expired": true } (read each time; one test home, so one sign-in
//   for all its agents, #309), it acts out an expired sign-in as Claude Code 2.1.291 does: `auth status --json` says
//   it isn't logged in, and each prompt's turn ends at once with "Login expired · Please run /login" and a StopFailure
//   hook (error authentication_failed) instead of Stop. "/login" typed in it signs in (the file says expired: false)
//   and carries the failed turn on by itself, as Claude Code did: a tool call (PostToolUse), then the reply and Stop.
// - `--model fail-start` makes it refuse to start, printing an error and exiting with 1, as Claude Code does for an
//   argument it rejects.
// - `-p --input-format stream-json` answers the Agent SDK's initialize control request with Claude Code 2.1.289's
//   recorded reply (tests/fixtures/claude-initialize.json), as Hive asks for its models (#125); FAKE_CLAUDE_MODELS=fail
//   makes it answer with an error instead. With fake-models.json in CLAUDE_CONFIG_DIR ({ "haikuAuto": true | false | null },
//   read each time, #234) it acts out a CLI that says Haiku takes Auto, doesn't (as 2.1.289), or says nothing about Auto
//   (no model has supportsAutoMode): asked for Auto with Haiku, it runs in Auto only when it said Haiku takes it, else
//   in Manual, and reports the mode it really runs in. Without the file it runs in the mode it was asked for.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { spawn } = require('child_process')
const { callHiveTool, parseHiveStep } = require('../fake-bridge.cjs')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)')
  process.exit(0)
}
/** The test home's sign-in has expired (fake-signin.json, #309). */
function signedOut() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-signin.json'), 'utf8')).expired === true
  } catch {
    return false
  }
}
if (args[0] === 'auth') {
  console.log(JSON.stringify(signedOut() ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai' }))
  process.exit(0)
}
/** fake-models.json in the test home ({ haikuAuto }), or null (#234). */
function fakeModels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-models.json'), 'utf8'))
  } catch {
    return null
  }
}
/** The recorded initialize reply, as fake-models.json says: Haiku with or without Auto, or no model saying. */
function withHaikuAuto(reply) {
  const f = fakeModels()
  if (!f || !('haikuAuto' in f)) return reply
  const models = reply.response.response.models.map((m) => {
    const out = { ...m }
    if (f.haikuAuto === null) delete out.supportsAutoMode
    else if (m.value === 'haiku') {
      if (f.haikuAuto) out.supportsAutoMode = true
      else delete out.supportsAutoMode
    }
    return out
  })
  return { ...reply, response: { ...reply.response, response: { ...reply.response.response, models } } }
}

if (args.includes('-p') && args.includes('stream-json')) {
  // The initialize request Hive sends to read the models; it stays open, as Claude Code does, until closed.
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (m.type !== 'control_request' || m.request?.subtype !== 'initialize') continue
      const recorded = withHaikuAuto(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'claude-initialize.json'), 'utf8')))
      const reply = process.env.FAKE_CLAUDE_MODELS === 'fail' ? { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'not supported' } } : { ...recorded, response: { ...recorded.response, request_id: m.request_id } }
      process.stdout.write(JSON.stringify(reply) + '\n')
    }
  })
  // Closed by Hive once it has the reply (killing a .cmd launcher leaves this process: its stdin ends).
  process.stdin.on('end', () => process.exit(0))
  return
}

const home = process.env.CLAUDE_CONFIG_DIR
if (!home) {
  console.error('fake-claude needs CLAUDE_CONFIG_DIR (a test folder)')
  process.exit(2)
}

// Options that take a value, so the first task (the last plain argument) can be told apart.
const WITH_VALUE = new Set(['--session-id', '--resume', '--name', '--plugin-dir', '--mcp-config', '--settings', '--append-system-prompt-file', '--allowedTools', '--model', '--effort', '--permission-mode'])
const opts = {}
let firstPrompt = ''
for (let i = 0; i < args.length; i++) {
  if (WITH_VALUE.has(args[i])) opts[args[i]] = args[++i]
  else if (args[i].startsWith('--')) opts[args[i]] = true
  else firstPrompt = args[i]
}
if (opts['--model'] === 'fail-start') {
  console.error("error: option '--model <model>' argument 'fail-start' is invalid.")
  process.exit(1)
}
const sessionId = opts['--resume'] || opts['--session-id'] || randomUUID()
/**
 * The mode it really runs in: the one asked for, unless fake-models.json has it act out Haiku without Auto (#234): then
 * Auto with Haiku runs in Manual ("default", as Claude Code's hooks say), as Claude Code 2.1.286 and 2.1.289 do.
 */
function runMode() {
  const asked = opts['--permission-mode'] || 'default'
  const f = fakeModels()
  if (!f || !('haikuAuto' in f) || asked !== 'auto' || !/haiku/i.test(opts['--model'] || '')) return asked
  return f.haikuAuto === true ? 'auto' : 'default'
}
// What it was started with, for suites that check the launch: the options, Claude Code's own variables and the
// Agent API token Hive gave it.
const launchEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_CODE_') || k.startsWith('HIVE_API_TOKEN')))
fs.appendFileSync(path.join(home, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), sessionId, opts, env: launchEnv }) + '\n')
/**
 * The terminal's size, recorded in fake-sizes.jsonl in its home at the start and at each change (#247): what Hive tells
 * the CLI. Polled as well as on 'resize', which a ConPTY child doesn't always get.
 */
function recordSizes(dir, id) {
  if (!dir || !process.stdout.isTTY) return
  let last = ''
  const note = () => {
    const s = []
    if (process.stdout._handle?.getWindowSize?.(s) !== 0 || s.length < 2) return
    const [cols, rows] = s
    if (`${cols}x${rows}` === last) return
    last = `${cols}x${rows}`
    fs.appendFileSync(path.join(dir, 'fake-sizes.jsonl'), JSON.stringify({ sessionId: id, cols, rows, at: Date.now() }) + '\n')
  }
  note()
  process.stdout.on('resize', note)
  setInterval(note, 50).unref()
}
recordSizes(home, sessionId)
const settings = opts['--settings'] ? JSON.parse(fs.readFileSync(opts['--settings'], 'utf8')) : {}
const hookUrl = settings.hooks?.Stop?.[0]?.hooks?.[0]?.url
const token = process.env.HIVE_HOOK_TOKEN || ''
const cwd = process.cwd()
const transcript = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
fs.mkdirSync(path.dirname(transcript), { recursive: true })

const out = (s) => process.stdout.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const write = (entry) => fs.appendFileSync(transcript, JSON.stringify({ sessionId, cwd, timestamp: now(), ...entry }) + '\n')

async function hook(event, extra = {}) {
  if (!hookUrl) return null
  try {
    const res = await fetch(hookUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd, permission_mode: runMode(), ...extra })
    })
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/**
 * A wake from Hive (a line starting "[Hive]", typed when a watched card changed): recorded in fake-wakes.jsonl (agent,
 * line, time), and answered with the next line of fake-wakes-<agent>.txt in its home, which a test writes: the steps
 * this agent takes next (a builder's fix, a reviewer's verdict). Null for any other prompt, or with no script line left.
 */
function shell(cmd) {
  return new Promise((resolve) => {
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd: process.cwd(), env: process.env, windowsVerbatimArguments: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => {
      if (home) fs.appendFileSync(path.join(home, 'fake-shell.jsonl'), JSON.stringify({ agent: process.env.HIVE_AGENT || 'agent', cmd, code, stdout, stderr }) + '\n')
      resolve()
    })
  })
}

function wakeScript(text) {
  if (!text.startsWith('[Hive]') || !home) return null
  const agent = String(process.env.HIVE_AGENT || 'agent').replace(/[^\w-]/g, '_')
  fs.appendFileSync(path.join(home, 'fake-wakes.jsonl'), JSON.stringify({ agent, text, at: new Date().toISOString() }) + '\n')
  const file = path.join(home, `fake-wakes-${agent}.txt`)
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const next = lines.shift()
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''))
  return next ?? null
}

let busy = false
const isBusy = () => busy
/** The prompt whose turn the expired sign-in stopped: "/login" carries it on. */
let refused = null
async function runPrompt(text) {
  busy = true
  out(`\r\n> ${text}\r\n`)
  write({ type: 'user', message: { role: 'user', content: text } })
  await hook('UserPromptSubmit', { prompt: text })
  if (signedOut()) {
    const said = 'Login expired · Please run /login'
    refused = text
    write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: '<synthetic>', content: [{ type: 'text', text: said }] }, isApiErrorMessage: true })
    out(`\r\n● ${said}\r\n`)
    await hook('StopFailure', { error: 'authentication_failed', last_assistant_message: said })
    busy = false
    promptLine()
    return
  }
  // A line Hive typed to wake it (a card watch): logged, and answered with the next line of its wake script.
  const woken = wakeScript(text)
  if (woken !== null) text = woken
  const edit = /\bedit\s+(\S+)/i.exec(text)
  if (edit) {
    const file = path.resolve(cwd, edit[1])
    const id = `toolu_${randomUUID().slice(0, 8)}`
    const reply = await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_use_id: id })
    write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }], usage: { input_tokens: 10, output_tokens: 5 } } })
    const denied = reply?.hookSpecificOutput?.permissionDecision === 'deny'
    write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? 'Blocked by a hook' : 'The file has been updated.', is_error: denied }] } })
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: id })
  }
  if (/\bask\b/i.test(text)) await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  // "pad N": N KB more transcript, as a long conversation has.
  const pad = /\bpad\s+(\d+)/i.exec(text)
  if (pad) write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pad', content: 'x'.repeat(Number(pad[1]) * 1024) }] } })
  // Steps joined by "then" run in order ("work N" in a step waits N seconds before the next).
  const steps = text.split(/\s+then\s+/i)
  for (const [i, step] of steps.entries()) {
    for (const m of step.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) readSkill(m[1])
    const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(step)
    if (move) await boardPatch(Number(move[1]), { column: move[2].toLowerCase() })
    const review = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(step)
    if (review) await boardPatch(Number(review[1]), { review: review[2].toLowerCase(), ...(review[3] ? { column: review[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) })
    const comment = /\bboardcomment\s+(\d+)/i.exec(step)
    if (comment) await boardPatch(Number(comment[1]), { comment: 'Fake: done, see the files.' })
    const call = parseHiveStep(step)
    if (call) await hiveCall(call.tool, call.args)
    // "shell: <command line>": runs it in cmd with the session's environment (PATH, HIVE_*), as an agent's shell
    // would; the agent, command, exit code and output go to fake-shell.jsonl in its home.
    const sh = /\bshell:\s*(.+)$/i.exec(step)
    if (sh) await shell(sh[1].trim())
    const pause = /\bwork\s+(\d+)/i.exec(step)
    if (pause && i < steps.length - 1) await sleep(Number(pause[1]) * 1000)
  }
  const background = /\bbackground\s+(\d+)/i.exec(text)
  if (background) await startBackgroundTask(Number(background[1]))
  const secs = Number(/\bwork\s+(\d+)/i.exec(text)?.[1] ?? 1)
  await sleep(secs * 1000)
  await endTurn(`Done: ${text}`, Number(/\bcontext\s+(\d+)/i.exec(text)?.[1] ?? 20))
  // "window N": the status line reports a context window of N tokens, as Claude Code's does.
  const contextWindow = /\bwindow\s+(\d+)/i.exec(text)
  if (contextWindow && hookUrl) {
    await fetch(`${hookUrl}&statusline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, context_window: { context_window_size: Number(contextWindow[1]) } })
    }).catch(() => undefined)
  }
}

/** Reads a Hive skill as Claude Code's Skill tool does, recording the call and its answer in the transcript. */
function readSkill(name) {
  const id = `toolu_skill_${randomUUID().slice(0, 8)}`
  const file = path.join(opts['--plugin-dir'] ?? '', 'skills', name, 'SKILL.md')
  const text = opts['--plugin-dir'] && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: `hive:${name}` } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text ?? `Unknown skill: hive:${name}`, is_error: text === null }] } })
}

/** Calls a hive tool through the launch's own hive MCP server; the call and its reply go in the transcript. */
async function hiveCall(tool, input) {
  const id = `toolu_hive_${randomUUID().slice(0, 8)}`
  write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: `mcp__hive__${tool}`, input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  let r
  try {
    r = await callHiveTool(JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.hive, tool, input)
  } catch (e) {
    r = { text: String(e), isError: true }
  }
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.text, is_error: r.isError }] } })
}

/** Changes card n as hive_update_task does: the hive tools' API, with this agent's token; the call is in the transcript. */
async function boardPatch(n, change) {
  const id = `toolu_board_${randomUUID().slice(0, 8)}`
  write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'mcp__hive__hive_update_task', input: { number: n, ...change } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  let record
  try {
    const env = JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.hive.env
    const apiToken = JSON.parse(fs.readFileSync(env.HIVE_API_TOKEN_FILE, 'utf8')).token
    const res = await fetch(`${env.HIVE_API_URL}/v1/tasks/${n}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', 'X-Hive-Workspace': encodeURIComponent(env.HIVE_WORKSPACE) },
      body: JSON.stringify({ ...change, reply: 'short' })
    })
    record = { n, ...change, status: res.status, body: await res.json().catch(() => null) }
  } catch (e) {
    record = { n, ...change, error: String(e) }
  }
  fs.appendFileSync(path.join(home, 'fake-calls.jsonl'), JSON.stringify(record) + '\n')
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(record.body ?? record.error ?? null), is_error: record.status !== 200 }] } })
  // Where Hive's hive server logs the calls it runs (tests only), this call is logged too, as the server would.
  try {
    const env = JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.hive.env
    if (env.HIVE_TEST_MCP_LOG) fs.appendFileSync(env.HIVE_TEST_MCP_LOG, JSON.stringify({ at: new Date().toISOString(), tool: 'hive_update_task', role: env.HIVE_ROLE === 'assistant' ? 'assistant' : 'agent', project: env.HIVE_PROJECT, agent: env.HIVE_AGENT_ID ?? null, ok: record.status === 200, args: JSON.stringify({ number: n, ...change }) }) + '\n')
  } catch {
    // No log.
  }
}

/** "/login": signs the test home in again, and carries on the turn the expired sign-in stopped, by itself. */
async function login() {
  fs.writeFileSync(path.join(home, 'fake-signin.json'), JSON.stringify({ expired: false }))
  out('\r\nLogin successful\r\n')
  const text = refused
  refused = null
  if (!text) return promptLine()
  busy = true
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo carried on' } })
  await sleep(1000)
  await endTurn(`Done: ${text}`)
}

async function endTurn(answer, inputTokens = 20) {
  write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: 'claude-fake', content: [{ type: 'text', text: answer }], usage: { input_tokens: inputTokens, output_tokens: 10 } } })
  out(`\r\n${answer}\r\n`)
  await hook('Stop', { last_assistant_message: answer })
  busy = false
  promptLine()
}

/**
 * A Bash command run in the background for `secs` seconds, recorded the way Claude Code records one. When it
 * ends, the task notification starts a new turn by itself (no UserPromptSubmit), which replies and stops.
 */
async function startBackgroundTask(secs) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  const task = `b${randomUUID().slice(0, 8)}`
  const input = { command: `sleep ${secs}`, description: 'Run the tests', run_in_background: true }
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id })
  write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Bash', input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}.` }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task } })
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id })
  setTimeout(async () => {
    // A turn in progress finishes first, as Claude Code takes the notification after it.
    for (let i = 0; i < 600 && isBusy(); i++) await sleep(200)
    busy = true
    write({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>` } })
    await sleep(1500)
    await endTurn(`The background task ${task} has finished.`)
  }, secs * 1000)
}

const promptLine = () => out('\r\n> \r\n  ? for shortcuts\r\n')

/** "/compact [focus]", as Claude Code runs it. */
async function compact(focus) {
  const messages = fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes('"type":"user"')
  if (!messages) {
    out('\r\nNot enough messages to compact.\r\n')
    promptLine()
    return
  }
  busy = true
  await hook('PreCompact', { trigger: 'manual', custom_instructions: focus })
  out('\r\nCompacting conversation…\r\n')
  await sleep(Number(/\bhold\s+(\d+)/i.exec(focus)?.[1] ?? 1) * 1000)
  if (/\bcompactfail\b/i.test(focus)) {
    out('\r\nError during compaction: Error: API Error: 500\r\n')
  } else {
    write({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 30, postTokens: 10 } })
    out('\r\nConversation compacted.\r\n')
    await hook('PostCompact', { trigger: 'manual' })
  }
  busy = false
  promptLine()
}

async function quit() {
  await hook('SessionEnd', { reason: 'prompt_input_exit' })
  process.exit(0)
}

// What arrives from the terminal: a line, Enter, Ctrl+U, Ctrl+C.
let line = ''
let onEnter = null
/** The trust question while it is asked: { on: 'No' | 'Yes' }, the choice its menu shows. */
let trustMenu = null
function drawTrust() {
  out(`\r\nQuick safety check: Do you trust the files in ${cwd}?\r\n ${trustMenu.on === 'No' ? '>' : ' '} No, exit\r\n ${trustMenu.on === 'Yes' ? '>' : ' '} Yes, I trust this folder\r\n Enter to confirm · Esc to cancel\r\n`)
}
let ctrlC = 0
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  // Down or Up in the trust menu moves its choice (two choices).
  if (trustMenu)
    for (const _ of data.matchAll(/\x1b\[[AB]/g)) {
      trustMenu.on = trustMenu.on === 'No' ? 'Yes' : 'No'
      drawTrust()
    }
  for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')) {
    if (ch === '\x03') {
      if (++ctrlC >= 2) void quit()
      continue
    }
    ctrlC = 0
    // What is typed shows on its input line, as in Claude Code (a pasted image's path too, #195).
    if (ch === '\x15') {
      if (line) out('\r\x1b[K')
      line = ''
    } else if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      if (line) out('\r\n')
      line = ''
      if (onEnter) {
        const f = onEnter
        onEnter = null
        f()
      } else if (text === '/exit') void quit()
      // /rename: the session's name, as Claude Code keeps it (no hook; Hive sees it in the transcript).
      else if ((text === '/compact' || text.startsWith('/compact ')) && !busy) void compact(text.slice(8).trim())
      else if (text === '/login' && !busy) void login()
      else if (text.startsWith('/rename ')) {
        write({ type: 'custom-title', customTitle: text.slice(8).trim() })
        promptLine()
      }
      else if (text && !busy) void runPrompt(text)
    } else if (ch === '\x7f' || ch === '\b') {
      if (line) out('\b \b')
      line = line.slice(0, -1)
    } else if (ch >= ' ') {
      line += ch
      out(ch)
    }
  }
})

async function main() {
  out('Claude Code (fake, for Hive tests)\r\n')
  const trustFile = path.join(home, 'fake-trusted.json')
  const trusted = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')) : []
  if (!trusted.includes(cwd.toLowerCase())) {
    // Claude Code's menu, but starting on "Yes" (Claude Code's starts on "No, exit"), so the suites' bare Enter trusts:
    // Down and Up move it, and Enter on "No, exit" quits (exit 1).
    trustMenu = { on: 'Yes' }
    drawTrust()
    const yes = await new Promise((r) => (onEnter = () => r(trustMenu.on === 'Yes')))
    trustMenu = null
    if (!yes) process.exit(1)
    fs.writeFileSync(trustFile, JSON.stringify([...trusted, cwd.toLowerCase()]))
  }
  // --name: Claude Code keeps it as the session's name (a custom title, as /rename does).
  if (opts['--name']) write({ type: 'custom-title', customTitle: opts['--name'] })
  await hook('SessionStart', { source: opts['--resume'] ? 'resume' : 'startup' })
  promptLine()
  if (firstPrompt) await runPrompt(firstPrompt)
}
void main()
