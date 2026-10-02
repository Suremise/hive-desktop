// A stand-in for Claude Code in end-to-end tests: Hive launches it through its real Claude Code adapter
// (Settings → Claude Code → path = fake-claude.cmd), so the launch, hooks, status, transcripts and the Agent API
// are tested without signing in or spending tokens. It must run with CLAUDE_CONFIG_DIR pointing at a test folder.
//
// What it does, like Claude Code:
// - `--version` and `auth status --json` answer as a signed-in CLI.
// - In a folder it hasn't been told to trust, it first asks "Do you trust this folder?" (Enter trusts it).
// - It sends SessionStart, then takes prompts: the last command-line argument, or a line typed and sent with
//   Enter (Ctrl+U clears the line). Each prompt sends UserPromptSubmit, is written to the transcript, "works"
//   (1 s, or N seconds for "work N"), and ends with a reply and Stop. "edit <file>" first sends PreToolUse for
//   an Edit of that file and records the tool call. "background N" starts a background command that ends after
//   N seconds; its task notification then starts a turn by itself, as in Claude Code. "pad N" adds N KB to the
//   transcript. "ask" first asks for permission (a permission_prompt Notification), then carries on by itself.
// - `--name` and "/rename <name>" set the session's name in the transcript (a custom title), as Claude Code does.
// - Ctrl+C twice, or "/exit", ends it with SessionEnd.
// - `--model fail-start` makes it refuse to start, printing an error and exiting with 1, as Claude Code does for an
//   argument it rejects.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  process.exit(0)
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
// What it was started with, for suites that check the launch: the options and Claude Code's own variables.
const launchEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_CODE_')))
fs.appendFileSync(path.join(home, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), sessionId, opts, env: launchEnv }) + '\n')
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
      body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd, permission_mode: opts['--permission-mode'] || 'default', ...extra })
    })
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

let busy = false
const isBusy = () => busy
async function runPrompt(text) {
  busy = true
  out(`\r\n> ${text}\r\n`)
  write({ type: 'user', message: { role: 'user', content: text } })
  await hook('UserPromptSubmit', { prompt: text })
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
  const background = /\bbackground\s+(\d+)/i.exec(text)
  if (background) await startBackgroundTask(Number(background[1]))
  const secs = Number(/\bwork\s+(\d+)/i.exec(text)?.[1] ?? 1)
  await sleep(secs * 1000)
  await endTurn(`Done: ${text}`)
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

async function endTurn(answer) {
  write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: 'claude-fake', content: [{ type: 'text', text: answer }], usage: { input_tokens: 20, output_tokens: 10 } } })
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

async function quit() {
  await hook('SessionEnd', { reason: 'prompt_input_exit' })
  process.exit(0)
}

// What arrives from the terminal: a line, Enter, Ctrl+U, Ctrl+C.
let line = ''
let onEnter = null
let ctrlC = 0
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')) {
    if (ch === '\x03') {
      if (++ctrlC >= 2) void quit()
      continue
    }
    ctrlC = 0
    if (ch === '\x15') line = ''
    else if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      line = ''
      if (onEnter) {
        const f = onEnter
        onEnter = null
        f()
      } else if (text === '/exit') void quit()
      // /rename: the session's name, as Claude Code keeps it (no hook; Hive sees it in the transcript).
      else if (text.startsWith('/rename ')) {
        write({ type: 'custom-title', customTitle: text.slice(8).trim() })
        promptLine()
      }
      else if (text && !busy) void runPrompt(text)
    } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch >= ' ') line += ch
  }
})

async function main() {
  out('Claude Code (fake, for Hive tests)\r\n')
  const trustFile = path.join(home, 'fake-trusted.json')
  const trusted = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')) : []
  if (!trusted.includes(cwd.toLowerCase())) {
    out(`\r\nDo you trust the files in ${cwd}?\r\n  1. Yes, I trust this folder\r\n  2. No, exit\r\n`)
    await new Promise((r) => (onEnter = r))
    fs.writeFileSync(trustFile, JSON.stringify([...trusted, cwd.toLowerCase()]))
  }
  // --name: Claude Code keeps it as the session's name (a custom title, as /rename does).
  if (opts['--name']) write({ type: 'custom-title', customTitle: opts['--name'] })
  await hook('SessionStart', { source: opts['--resume'] ? 'resume' : 'startup' })
  promptLine()
  if (firstPrompt) await runPrompt(firstPrompt)
}
void main()
