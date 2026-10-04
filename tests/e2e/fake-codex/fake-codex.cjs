// A stand-in for Codex in end-to-end tests: Hive launches it through its real Codex adapter (Settings → Codex →
// path = fake-codex.cmd), so who is asked (an approval, a question, the auto-reviewer) is tested without signing
// in or spending tokens. It sends the hooks, in the order, and sets the terminal title the way Codex 0.160.0 did
// (tests/hookStatus.test.ts has the sequences):
// - `--version`, `login status` and the app server (hooks/list) answer as a signed-in Codex.
// - It titles its terminal "<project>", and "[ ! ] Action Required | <project>" (blinking with "[ . ]") while a
//   person must act: one title for everything asked. It sends SessionStart with the first prompt, as Codex does.
// - Prompts, typed and sent with Enter:
//   "review allow" / "review deny": a command its auto-reviewer approves (it runs) or denies (it doesn't, and
//   another command runs next). PermissionRequest comes either way; nobody is asked. "review long": a long
//   PowerShell command (an environment variable, a path) under review for 4 s, then approved.
//   "approve": the request is put to you: "y" approves it (another command ends beside it first), Esc rejects
//   it (the turn is interrupted).
//   "question": an async question (request_user_input_async): it works on meanwhile; "a" answers it, which it
//   waits for at the end of the turn. "late question": its hooks reach Hive after its title.
//   Steps combine with " then " ("question then review deny").
//   The scenarios' steps, as the fake Claude Code takes them: "skill NAME" (a shell read of its SKILL.md),
//   "boardmove", "boardreview", "boardcomment" and "hive TOOL {json}" (through the launch's real hive MCP server),
//   "work N". Anything else: a short turn.
// - Ctrl+C twice ends it with SessionEnd.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { callHiveTool, fromCodexTable, parseHiveStep } = require('../fake-bridge.cjs')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION || '0.160.0'}`)
  process.exit(0)
}
if (args[0] === 'login') {
  console.log('Logged in using ChatGPT')
  process.exit(0)
}
if (args[0] === 'app-server') {
  // Hive asks how this version names and hashes its hooks: none.
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
      if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [] } }) + '\n')
    }
  })
  return
}

// Each launch is recorded in fake-launches.jsonl in CODEX_HOME: its folder and arguments (for what Hive tells it).
if (process.env.CODEX_HOME) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), args }) + '\n')

const hookUrl = /(http:\/\/127\.0\.0\.1:\d+\/hook\?run=[\w-]+)/.exec(args.find((a) => a.startsWith('hooks.Stop=')) ?? '')?.[1]
const token = process.env.HIVE_HOOK_TOKEN || ''
const project = path.basename(process.cwd())
// "resume <id>" carries on that conversation, as Codex does; otherwise a new one.
const resuming = args[0] === 'resume' && /^[0-9a-f-]{36}$/i.test(args[1] ?? '')
const sessionId = resuming ? args[1] : randomUUID()

/**
 * Its rollout, as Codex keeps one: CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, its first line the
 * session_meta (id, cwd). Written with the first prompt (when Codex starts recording); a resumed one is appended to.
 */
function rolloutPath() {
  const root = path.join(process.env.CODEX_HOME || '.', 'sessions')
  const find = (dir, depth) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const f = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) {
        const hit = find(f, depth + 1)
        if (hit) return hit
      } else if (e.name.endsWith(`-${sessionId}.jsonl`)) return f
    }
    return null
  }
  const existing = find(root, 0)
  if (existing) return existing
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const dir = path.join(root, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id: sessionId, cwd: process.cwd(), timestamp: now.toISOString() } }) + '\n')
  return file
}
let rollout = null
let started = false

const out = (s) => process.stdout.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const setTitle = (t) => out(`\x1b]0;${t}\x07`)

async function hook(event, extra = {}) {
  if (!hookUrl) return
  await fetch(hookUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: rollout, cwd: process.cwd(), model: 'gpt-fake', permission_mode: 'default', turn_id: 't', ...extra })
  }).catch(() => undefined)
}

/** How many things a person is asked now: one title for them all, "[ ! ] Action Required" blinking as Codex's does. */
let asking = 0
let blink = null
function asked(delta) {
  asking += delta
  clearInterval(blink)
  if (asking <= 0) return setTitle(project)
  let on = true
  setTitle(`[ ! ] Action Required | ${project}`)
  blink = setInterval(() => {
    on = !on
    setTitle(`[ ${on ? '!' : '.'} ] Action Required | ${project}`)
  }, 500)
}

/** The next key typed (one of `keys`). */
let onKey = null
const key = (keys) => new Promise((r) => (onKey = (k) => keys.includes(k) && (onKey = null, r(k), true)))

const CURL = { tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
// Codex adds a description to the request's input.
const CURL_REQUEST = { ...CURL, tool_input: { ...CURL.tool_input, description: 'Check the network' } }
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
let busy = false

/** A long command, the kind that used to fill an agent's header while under review. */
const LONG = bash("$env:HIVE_E2E_DIR = 'C:\\Users\\someone\\AppData\\Local\\hive-test\\e2e'; npm.cmd run e2e -- icons bell resumeall --reporter verbose")

/** A permission request its auto-reviewer answers: nobody is asked, and the title doesn't change. */
async function review(allow, call = CURL, ms = 1500) {
  await hook('PreToolUse', call)
  await hook('PermissionRequest', call === CURL ? CURL_REQUEST : call)
  out('  Reviewing the request…\r\n')
  await sleep(ms)
  if (allow) return hook('PostToolUse', call)
  out('  Rejected by the auto-reviewer.\r\n')
  await hook('PreToolUse', bash('ls'))
  await hook('PostToolUse', bash('ls'))
}

/** A permission request put to you: true when approved ("y"), false when rejected (Esc). */
async function approve() {
  await hook('PreToolUse', CURL)
  await hook('PermissionRequest', CURL_REQUEST)
  out('  Would you like to run the following command?\r\n  $ curl.exe https://example.com\r\n  1. Yes, proceed (y)   3. No (esc)\r\n')
  asked(1)
  const k = await key(['y', '\x1b'])
  asked(-1)
  if (k === '\x1b') return false
  // Another command, run beside it, ends first.
  await hook('PreToolUse', bash('ls'))
  await hook('PostToolUse', bash('ls'))
  await hook('PostToolUse', CURL)
  return true
}

/** An async question: it returns at once, and Codex works on. `late`: its hooks reach Hive after the title. */
async function question(late) {
  const input = { questions: [{ title: 'Which colour?', options: ['Red', 'Blue'] }] }
  if (late) asked(1)
  if (late) await sleep(400)
  await hook('PreToolUse', { tool_name: 'request_user_input_async', tool_input: input })
  await hook('PostToolUse', { tool_name: 'request_user_input_async', tool_input: input })
  out('  Which colour? • Red • Blue\r\n  ? 1 question  (a to answer)\r\n')
  if (!late) asked(1)
}

/** One rollout entry, as Codex writes it. */
const record = (payload) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload }) + '\n')

/** The launch's hive MCP server (its -c mcp_servers.hive table), or null. */
function hiveServer() {
  const arg = args.find((a) => a.startsWith('mcp_servers.hive='))
  try {
    return arg ? fromCodexTable(arg.slice('mcp_servers.hive='.length)) : null
  } catch {
    return null
  }
}

/** A hive tool call through the launch's own hive MCP server, recorded as Codex records an MCP call and its output. */
async function hiveCall(tool, input) {
  const id = `call_${randomUUID().slice(0, 8)}`
  record({ type: 'function_call', name: `mcp__hive__${tool}`, arguments: JSON.stringify(input), call_id: id })
  const server = hiveServer()
  const r = server ? await callHiveTool(server, tool, input) : { text: 'error: no hive server', isError: true }
  record({ type: 'function_call_output', call_id: id, output: r.isError && !/^error/i.test(r.text) ? `error: ${r.text}` : r.text })
}

/** Reads a skill as Codex does: its SKILL.md from the folder Hive delivered it to, with a shell command. */
function readSkill(name) {
  const dir = path.join(process.cwd(), '.agents', 'skills')
  const folder = [name, `hive-${name}`].map((d) => path.join(dir, d, 'SKILL.md')).find((f) => fs.existsSync(f)) ?? path.join(dir, name, 'SKILL.md')
  const id = `call_${randomUUID().slice(0, 8)}`
  record({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['powershell', '-Command', `Get-Content -Raw '${folder}'`] }), call_id: id })
  const text = fs.existsSync(folder) ? fs.readFileSync(folder, 'utf8') : null
  record({ type: 'function_call_output', call_id: id, output: text ?? 'Process exited with code 1: no such file' })
}

/**
 * The scenario steps the fake Claude Code takes too (tests/scenarios): "skill NAME", "boardmove N COLUMN", "boardreview N
 * ACTION [COLUMN]", "boardcomment N", "hive TOOL {json}" and "work N". Board changes go through the real hive MCP
 * server (hive_update_task), as a model's would. Whether the step was one of these.
 */
async function scripted(step) {
  let any = false
  for (const m of step.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) {
    readSkill(m[1])
    any = true
  }
  const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(step)
  if (move) await hiveCall('hive_update_task', { number: Number(move[1]), column: move[2].toLowerCase() })
  const rev = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(todo|doing|review|done)\b)?/i.exec(step)
  if (rev) await hiveCall('hive_update_task', { number: Number(rev[1]), review: rev[2].toLowerCase(), ...(rev[3] ? { column: rev[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) })
  const comment = /\bboardcomment\s+(\d+)/i.exec(step)
  if (comment) await hiveCall('hive_update_task', { number: Number(comment[1]), comment: 'Fake: done, see the files.' })
  const call = parseHiveStep(step)
  if (call) await hiveCall(call.tool, call.args)
  const pause = /\bwork\s+(\d+)/i.exec(step)
  if (pause) await sleep(Number(pause[1]) * 1000)
  return any || !!(move || rev || comment || call || pause)
}

/** A prompt: its steps, separated by " then " ("question then review allow"). */
async function runPrompt(text) {
  busy = true
  out(`\r\n› ${text}\r\n`)
  if (!started) {
    started = true
    rollout = rolloutPath()
    await hook('SessionStart', { source: resuming ? 'resume' : 'startup' })
  }
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n')
  await hook('UserPromptSubmit', { prompt: text })
  let questions = 0
  let scriptedSteps = false
  for (const step of text.split(' then ')) {
    if (step === 'review allow' || step === 'review deny') await review(step === 'review allow')
    else if (step === 'review long') await review(true, LONG, 4000)
    else if (step === 'question' || step === 'late question') {
      await question(step === 'late question')
      questions++
    } else if (step === 'approve') {
      if (!(await approve())) {
        // Rejected: the turn is interrupted (a question stays).
        await hook('Interrupt')
        busy = false
        return promptLine()
      }
    } else if (await scripted(step)) scriptedSteps = true
    else await sleep(500)
  }
  // Scripted steps take a second at least, as the fake Claude Code's turns do: a turn that ends at once can be over
  // before anyone sees it working.
  if (scriptedSteps && !/\bwork\s+\d+/i.test(text)) await sleep(1000)
  // It waits for the answers, working meanwhile ("a" answers one: the answer comes as a prompt).
  for (; questions > 0; questions--) {
    await hook('PreToolUse', bash('Start-Sleep 30'))
    await key(['a'])
    asked(-1)
    await hook('UserPromptSubmit', { prompt: '<send_user_message_question_reply>Red' })
    await hook('PostToolUse', bash('Start-Sleep 30'))
  }
  out(`\r\nDone: ${text}\r\n`)
  await hook('Stop', { last_assistant_message: `Done: ${text}` })
  busy = false
  promptLine()
}

const promptLine = () => out('\r\n› Ask Codex to do anything\r\n')

let line = ''
let ctrlC = 0
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  // A lone Esc is a key; other escape sequences (focus reports) aren't.
  const keys = data === '\x1b' ? ['\x1b'] : [...data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')]
  for (const ch of keys) {
    if (onKey?.(ch)) continue
    if (ch === '\x03') {
      if (++ctrlC >= 2) void hook('SessionEnd').then(() => process.exit(0))
      continue
    }
    ctrlC = 0
    if (ch === '\x15') line = ''
    else if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      line = ''
      if (text && !busy) void runPrompt(text)
    } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch >= ' ' && !busy) line += ch
  }
})

out('OpenAI Codex (fake, for Hive tests)\r\n')
setTitle(project)
promptLine()
