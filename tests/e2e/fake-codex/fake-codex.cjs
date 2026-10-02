// A stand-in for Codex in end-to-end tests: Hive launches it through its real Codex adapter (Settings → Codex →
// path = fake-codex.cmd), so who is asked (an approval, a question, the auto-reviewer) is tested without signing
// in or spending tokens. It sends the hooks, in the order, and sets the terminal title the way Codex 0.160.0 did
// (tests/hookStatus.test.ts has the sequences):
// - `--version`, `login status` and the app server (hooks/list) answer as a signed-in Codex.
// - It titles its terminal "<project>", and "[ ! ] Action Required | <project>" (blinking with "[ . ]") while a
//   person must act: one title for everything asked. It sends SessionStart with the first prompt, as Codex does.
// - Prompts, typed and sent with Enter:
//   "review allow" / "review deny": a command its auto-reviewer approves (it runs) or denies (it doesn't, and
//   another command runs next). PermissionRequest comes either way; nobody is asked.
//   "approve": the request is put to you: "y" approves it (another command ends beside it first), Esc rejects
//   it (the turn is interrupted).
//   "question": an async question (request_user_input_async): it works on meanwhile; "a" answers it, which it
//   waits for at the end of the turn. "late question": its hooks reach Hive after its title.
//   Steps combine with " then " ("question then review deny").
//   Anything else: a short turn.
// - Ctrl+C twice ends it with SessionEnd.
const path = require('path')
const { randomUUID } = require('crypto')

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

const hookUrl = /(http:\/\/127\.0\.0\.1:\d+\/hook\?run=[\w-]+)/.exec(args.find((a) => a.startsWith('hooks.Stop=')) ?? '')?.[1]
const token = process.env.HIVE_HOOK_TOKEN || ''
const project = path.basename(process.cwd())
const sessionId = randomUUID()
let started = false

const out = (s) => process.stdout.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const setTitle = (t) => out(`\x1b]0;${t}\x07`)

async function hook(event, extra = {}) {
  if (!hookUrl) return
  await fetch(hookUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: null, cwd: process.cwd(), model: 'gpt-fake', permission_mode: 'default', turn_id: 't', ...extra })
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

/** A permission request its auto-reviewer answers: nobody is asked, and the title doesn't change. */
async function review(allow) {
  await hook('PreToolUse', CURL)
  await hook('PermissionRequest', CURL_REQUEST)
  out('  Reviewing the request…\r\n')
  await sleep(1500)
  if (allow) return hook('PostToolUse', CURL)
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

/** A prompt: its steps, separated by " then " ("question then review allow"). */
async function runPrompt(text) {
  busy = true
  out(`\r\n› ${text}\r\n`)
  if (!started) {
    started = true
    await hook('SessionStart', { source: 'startup' })
  }
  await hook('UserPromptSubmit', { prompt: text })
  let questions = 0
  for (const step of text.split(' then ')) {
    if (step === 'review allow' || step === 'review deny') await review(step === 'review allow')
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
    } else await sleep(500)
  }
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
