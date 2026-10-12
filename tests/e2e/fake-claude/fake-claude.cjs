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
//   "holduntil NAME": the turn doesn't end until the test makes a file NAME in its home (CLAUDE_CONFIG_DIR).
//   "shell: <command line>" runs a command in cmd with the session's environment (fake-shell.jsonl records it).
//   "linger N" leaves N processes running after it ends, as an agent's preview server or tail -f does (#507): each a
//   detached, hidden node started by a short-lived detached one that has exited by then (linger.cjs; their pids in
//   fake-linger.jsonl in its home; each ends by itself after two minutes, in case). With fake-linger-at-start.txt (N) in
//   its home, it leaves N the moment it starts, before anything else. "progress-linger" leaves a command running
//   through the session's hive-progress shim, as a Codex agent once did (#542): cmd → hive-progress → a lingering node
//   (linger.cjs; its pid in fake-progress-linger.jsonl in its home), and ends its turn without waiting for it.
//   "boardmove N COLUMN" moves card N as hive_update_task does (the hive tools' API, token and agent, from
//   --mcp-config) and records the answer in fake-calls.jsonl; "boardreview N ACTION [COLUMN]" reviews it the same way
//   (review: start, passed or failed; a column with the verdict), and "boardcomment N" comments on it. All are written to the transcript as the hive tool
//   call they stand for (mcp__hive__hive_update_task), as Claude Code writes an MCP call. "hive TOOL {json}" calls a
//   hive tool through the real hive MCP server of the launch's --mcp-config (fake-bridge.cjs: logged and measured by
//   Hive's performance metrics as a real call is), written to the transcript as that MCP call and its reply. A line
//   Hive types to wake it ("[Hive] #12 is in Review…", a card watch) is logged in fake-wakes.jsonl and answered with
//   the next line of fake-wakes-<agent>.txt (a test's script of what this agent does next); with a number N in
//   fake-drop-enters-<agent>.txt, it drops the next N Enters after such a line, which stays typed (#376). It turns on
//   bracketed paste, as Claude Code does. While fake-slow-input-<agent>.txt is in its home it reads no input, as a busy
//   Claude Code (#597; fake-slow-input-<agent>.paused says it has stopped): what arrived meanwhile comes in one read,
//   taken as Claude Code 2.1.296 takes one that isn't a bracketed paste: a paste, in which a Ctrl+U or an Enter is
//   kept as text (not sent), and after which the next Enter is lost too. "skill NAME" reads a skill
//   as Claude Code's Skill tool does: a Skill call in the transcript ("hive:NAME"), answered with the skill's SKILL.md
//   from the launch's plugin folder (an error when it has none).
// - "/compact [focus]" compacts as Claude Code does: PreCompact, a compaction boundary in the transcript after 1 s (N
//   seconds when the focus has "hold N"), then PostCompact. With no messages yet it says "Not enough messages to compact."
//   and sends no hook; with "compactfail" in the focus it fails after PreCompact with "Error during compaction".
// - Idle, as Claude Code 2.1.296 is (#612): with fake-idle-notify.txt (N) in its home, N ms after a turn ends with no
//   input since, it sends the Notification "Claude is waiting for your input" (idle_prompt) once, as Claude Code does a
//   minute after a turn. A prompt with "loststop" ends its turn without a Stop reaching Hive, as one of HB3's did. When
//   the test makes fake-idle-compact-<agent> in its home, it compacts while idle as Claude Code does before the prompt
//   cache expires: PreCompact (auto), a compaction boundary, and once the test makes fake-idle-compact-done-<agent>,
//   SessionStart (compact), PostCompact (auto) and "Compacted while idle, before the prompt cache expired";
//   fake-recap-<agent> makes it write a recap (an away_summary), which sends no hook of Hive's. Each file is taken
//   (removed) when acted on.
// - Turns, as Claude Code 2.1.296 has them (#648): each prompt (and each turn it begins by itself) has its own id, which
//   its hooks carry (prompt_id); its screen shows a spinner with "esc to interrupt" while it works and "✻ Worked for Ns ·
//   done H:MM" above its input once done. "latetool": a Read whose PostToolUse reaches Hive after the turn's Stop.
//   "stopcontinue": after its Stop, once the test makes fake-continue-<agent>, it goes on as when another Stop hook
//   blocks: a tool call in the same turn (held until fake-continue-done-<agent>), then Stop with stop_hook_active.
// - `--name` and "/rename <name>" set the session's name in the transcript (a custom title), as Claude Code does.
// - Its system prompt (the --append-system-prompt-file's text) is recorded on a conversation's first request and that
//   record used on every later one and every resume, as Claude Code does since 2.1.267, until it compacts;
//   `--system-prompt-snapshot off` uses the file's text each time instead (#334). A prompt with "whatmode" says the
//   mode its system prompt is in ("# Your mode: <name>", the Hive Assistant's) at the end of its reply. With
//   fake-resume-draw.json ({ "ms": N }) in CLAUDE_CONFIG_DIR, a resumed session loses each Enter for its first N ms,
//   keeping what was typed, as Claude Code can while it draws a long conversation.
// - Ctrl+C twice, or "/exit", ends it with SessionEnd.
// - With fake-signin.json in CLAUDE_CONFIG_DIR saying { "expired": true } (read each time; one test home, so one sign-in
//   for all its agents, #309), it acts out an expired sign-in as Claude Code 2.1.291 does: `auth status --json` says
//   it isn't logged in (indented JSON, exit 1, as 2.1.296 does), and each prompt's turn ends at once with "Login expired · Please run /login" and a StopFailure
//   hook (error authentication_failed) instead of Stop. "/login" typed in it signs in (the file says expired: false)
//   and carries the failed turn on by itself, as Claude Code did: a tool call (PostToolUse), then the reply and Stop.
//   With "atLaunch": true as well, it stops before its session starts, as Claude Code 2.1.296 did with an OAuth session
//   it couldn't refresh: "Failed to authenticate: OAuth session expired and could not be refreshed", exit 1 (#577).
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
/** The expired sign-in stops it at launch (fake-signin.json { "expired": true, "atLaunch": true }, #577). */
function expiredAtLaunch() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-signin.json'), 'utf8'))
    return s.expired === true && s.atLaunch === true
  } catch {
    return false
  }
}
// As Claude Code prints it: indented JSON, and exit 1 when it isn't logged in (#577).
if (args[0] === 'auth') {
  const out = signedOut()
  console.log(JSON.stringify(out ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai' }, null, 2))
  process.stdout.write('', () => process.exit(out ? 1 : 0))
  return
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
const WITH_VALUE = new Set(['--session-id', '--resume', '--name', '--plugin-dir', '--mcp-config', '--settings', '--append-system-prompt-file', '--allowedTools', '--model', '--effort', '--permission-mode', '--system-prompt-snapshot'])
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
 * With fake-resume-draw.json in its home ({ "ms": N }, read at launch), a resumed session loses each Enter for its
 * first N ms, keeping what was typed, as Claude Code can while it draws a long conversation (#334).
 */
const drawingUntil = (() => {
  const file = home && path.join(home, 'fake-resume-draw.json')
  if (!opts['--resume'] || !file || !fs.existsSync(file)) return 0
  return Date.now() + Number(JSON.parse(fs.readFileSync(file, 'utf8')).ms ?? 0)
})()
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
fs.appendFileSync(path.join(home, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), sessionId, pid: process.pid, parent: process.ppid, opts, env: launchEnv }) + '\n')
// How it ended, in fake-exits.jsonl in its home (#551): its own exit with the code, or an error it didn't catch (then
// exit 1, as Node would). A launch with no line there was ended by Ctrl+C, its console closing or a kill.
const exitLog = (entry) => {
  try {
    fs.appendFileSync(path.join(home, 'fake-exits.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sessionId, ...entry }) + '\n')
  } catch {
    // Its home gone: nothing to tell.
  }
}
process.on('exit', (code) => exitLog({ code }))
for (const event of ['uncaughtException', 'unhandledRejection'])
  process.on(event, (e) => {
    exitLog({ [event]: String(e?.stack ?? e) })
    process.stderr.write(`${e?.stack ?? e}\n`)
    process.exit(1)
  })
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
// HTTP hooks send the launch's token from the environment; command hooks (SessionStart) and the status line run
// Hive's curl command, which reads the header from the launch's auth file (#345).
const token = process.env.HIVE_HOOK_TOKEN || ''
const authFile = /-H "@([^"]+)"/.exec(settings.statusLine?.command ?? '')?.[1]
const commandAuth = () => {
  try {
    return fs.readFileSync(authFile, 'utf8').replace(/^Authorization:\s*/i, '').trim()
  } catch {
    return ''
  }
}
const cwd = process.cwd()
const transcript = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
fs.mkdirSync(path.dirname(transcript), { recursive: true })

/** Writes to its screen; counts the writes, so a busy line can be taken back only if nothing came after it. */
let writes = 0
const out = (s) => {
  writes++
  return process.stdout.write(s)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const write = (entry) => fs.appendFileSync(transcript, JSON.stringify({ sessionId, cwd, timestamp: now(), ...entry }) + '\n')

/** The turn under way: each prompt's own id, which its hooks carry (prompt_id), as Claude Code 2.1.296's do (#648). */
let promptId = null

async function hook(event, extra = {}) {
  if (!hookUrl) return null
  try {
    const res = await fetch(hookUrl, {
      method: 'POST',
      headers: { Authorization: event === 'SessionStart' ? commandAuth() : `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd, permission_mode: runMode(), ...(promptId && event !== 'SessionStart' ? { prompt_id: promptId } : {}), ...extra })
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

/** The system prompt a request sends: the conversation's recorded one, recorded now if it has none (#334). */
function systemPrompt() {
  const file = opts['--append-system-prompt-file']
  const current = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (opts['--system-prompt-snapshot'] === 'off' || !home) return current
  const record = path.join(home, 'fake-prompts', `${sessionId}.txt`)
  if (fs.existsSync(record)) return fs.readFileSync(record, 'utf8')
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.writeFileSync(record, current)
  return current
}

let busy = false
const isBusy = () => busy
/** The prompt whose turn the expired sign-in stopped: "/login" carries it on. */
let refused = null
async function runPrompt(text) {
  busy = true
  promptId = randomUUID()
  turnStarted = Date.now()
  out(`\r\n> ${text}\r\n`)
  // Its spinner above its input while it works, as Claude Code 2.1.296 draws them, taken back when the turn ends.
  out(BUSY)
  busyDrawn = writes
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
  const prompt = systemPrompt()
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
  // "askafter N": the permission prompt N seconds into the turn (it starts working first).
  const askAfter = /\baskafter\s+(\d+)/i.exec(text)
  if (askAfter) setTimeout(() => void hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), Number(askAfter[1]) * 1000)
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
  const linger = /(?<!-)\blinger\s+(\d+)/i.exec(text)
  if (linger) leaveRunning(Number(linger[1]))
  if (/\bprogress-linger\b/i.test(text)) leaveProgressRunning()
  const secs = Number(/\bwork\s+(\d+)/i.exec(text)?.[1] ?? 1)
  await sleep(secs * 1000)
  // "holduntil NAME": the turn goes on until the test makes NAME in its home, so it ends after what the test waits for
  // (two minutes at most, in case the test died).
  const release = /\bholduntil\s+([\w.-]+)/i.exec(text)
  if (release) {
    const go = path.join(process.env.CLAUDE_CONFIG_DIR || '', release[1])
    for (const end = Date.now() + 120_000; !fs.existsSync(go) && Date.now() < end; ) await sleep(100)
  }
  const mode = /\bwhatmode\b/i.test(text) ? ` (system prompt mode: ${/^# Your mode: (.+)$/m.exec(prompt)?.[1]?.trim() ?? 'none'})` : ''
  // "latetool": a Read whose PostToolUse reaches Hive only after the turn's Stop (#648).
  const late = /\blatetool\b/i.test(text) ? { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_use_id: `toolu_${randomUUID().slice(0, 8)}` } : null
  if (late) await hook('PreToolUse', late)
  await endTurn(`Done: ${text}${mode}`, Number(/\bcontext\s+(\d+)/i.exec(text)?.[1] ?? 20), /\bloststop\b/i.test(text), { late, carryOn: /\bstopcontinue\b/i.test(text) })
  // "window N": the status line reports a context window of N tokens, as Claude Code's does.
  const contextWindow = /\bwindow\s+(\d+)/i.exec(text)
  if (contextWindow && hookUrl) {
    await fetch(`${hookUrl}&statusline`, {
      method: 'POST',
      headers: { Authorization: commandAuth(), 'Content-Type': 'application/json' },
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
  // Where Hive's hive server logs the calls it runs (tests only), this call is logged too, as the server would; `direct`:
  // no hive server ran it, so none reports it to Hive's metrics.
  try {
    const env = JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.hive.env
    if (env.HIVE_TEST_MCP_LOG) fs.appendFileSync(env.HIVE_TEST_MCP_LOG, JSON.stringify({ at: new Date().toISOString(), tool: 'hive_update_task', role: env.HIVE_ROLE === 'assistant' ? 'assistant' : 'agent', project: env.HIVE_PROJECT, agent: env.HIVE_AGENT_ID ?? null, ok: record.status === 200, args: JSON.stringify({ number: n, ...change }), direct: true }) + '\n')
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

/**
 * A turn's end: the reply, Stop (unless lost), and the line Claude Code 2.1.296 shows above its input once a turn is
 * done ("✻ Worked for 1s · done 16:52"). `late`: a tool call whose PostToolUse comes only after the Stop. `carryOn`:
 * another Stop hook (the user's) makes it go on (#648): once the test makes fake-continue-<agent> in its home, a tool
 * call in the same turn (held until fake-continue-done-<agent>), then Stop again with stop_hook_active.
 */
async function endTurn(answer, inputTokens = 20, lostStop = false, { late = null, carryOn = false } = {}) {
  write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: 'claude-fake', content: [{ type: 'text', text: answer }], usage: { input_tokens: inputTokens, output_tokens: 10 } } })
  // The spinner and input drawn while it worked go, as Claude Code redraws them (when nothing was written since).
  if (busyDrawn === writes) out(`\x1b[${BUSY_LINES}A\r\x1b[J`)
  out(`\r\n${answer}\r\n`)
  // "loststop": the turn ends, but its Stop never reaches Hive (#612).
  if (!lostStop) await hook('Stop', { last_assistant_message: answer, stop_hook_active: false })
  if (late) await hook('PostToolUse', late)
  if (carryOn) {
    for (const end = Date.now() + 120_000; !take('fake-continue') && Date.now() < end; ) await sleep(100)
    const call = { tool_name: 'Bash', tool_input: { command: 'echo again' }, tool_use_id: `toolu_${randomUUID().slice(0, 8)}` }
    await hook('PreToolUse', call)
    for (const end = Date.now() + 120_000; !take('fake-continue-done') && Date.now() < end; ) await sleep(100)
    await hook('PostToolUse', call)
    out('\r\nCarried on past the Stop.\r\n')
    await hook('Stop', { last_assistant_message: 'Carried on past the Stop.', stop_hook_active: true })
  }
  const d = new Date()
  out(`✻ Worked for ${Math.max(0, Math.round((Date.now() - turnStarted) / 1000))}s · done ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}\r\n`)
  busy = false
  promptLine()
  idleNotice()
}

/** When the turn under way began (its "Worked for" line). */
let turnStarted = Date.now()

/** Turns ended, and when input last came: the idle notification goes once per turn, and only with no input since. */
let turnsEnded = 0
let lastInput = 0
/** Claude Code's "Claude is waiting for your input" (idle_prompt), N ms after a turn ends: fake-idle-notify.txt (N). */
function idleNotice() {
  const file = path.join(home, 'fake-idle-notify.txt')
  if (!fs.existsSync(file)) return
  const turn = ++turnsEnded
  const since = Date.now()
  setTimeout(() => {
    if (turn === turnsEnded && !busy && lastInput <= since) void hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
  }, Number(fs.readFileSync(file, 'utf8')) || 0)
}

/** Takes a file the test made in its home for this agent (NAME-<agent>): true once, when it was there. */
function take(name) {
  try {
    fs.rmSync(path.join(home, `${name}-${String(process.env.HIVE_AGENT || 'agent').replace(/[^\w-]/g, '_')}`))
    return true
  } catch {
    return false
  }
}

/** What Claude Code does by itself while idle (#612): a compaction before the prompt cache expires, and a recap. */
async function whileIdle() {
  if (busy) return
  if (take('fake-recap')) {
    write({ type: 'system', subtype: 'away_summary', content: 'The fake did its turns. (disable recaps in /config)', isMeta: false })
    out('\r\n※ recap: the fake did its turns.\r\n')
  }
  if (!take('fake-idle-compact')) return
  busy = true
  await hook('PreCompact', { trigger: 'auto', custom_instructions: null })
  out('\r\nCompacting conversation…\r\n')
  write({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 30, postTokens: 10 } })
  // Until the test has seen it under way (two minutes at most, in case the test died).
  for (const end = Date.now() + 120_000; !take('fake-idle-compact-done') && Date.now() < end; ) await sleep(100)
  await hook('SessionStart', { source: 'compact' })
  await hook('PostCompact', { trigger: 'auto' })
  write({ type: 'system', subtype: 'informational', content: 'Compacted while idle, before the prompt cache expired', level: 'notice', isMeta: false })
  out('\r\nCompacted while idle, before the prompt cache expired\r\n')
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
    // A turn of its own, with no prompt.
    promptId = randomUUID()
    turnStarted = Date.now()
    write({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>` } })
    await sleep(1500)
    await endTurn(`The background task ${task} has finished.`)
  }, secs * 1000)
}

// Its input and its footer, as Claude Code 2.1.296 marks them (no taller than the fake's prompt before #648).
const promptLine = () => out('\r\n❯ \r\n  ? for shortcuts\r\n')
/** While it works: its spinner, then its input and footer below (BUSY_LINES lines down from where it starts). */
const BUSY = '\r\n✻ Brewing… (esc to interrupt)\r\n❯ \r\n  ? for shortcuts\r\n'
const BUSY_LINES = 4
/** The write after which the busy lines were drawn (taken back at the turn's end only if nothing came since). */
let busyDrawn = -1

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
    // The next request records the system prompt afresh.
    if (home) fs.rmSync(path.join(home, 'fake-prompts', `${sessionId}.txt`), { force: true })
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

/**
 * Whether to drop this Enter: fake-drop-enters-<agent>.txt in its home holds how many Enters after a line from Hive to
 * drop (a test writes it); each drop counts it down.
 */
function dropEnter() {
  if (!home) return false
  const agent = String(process.env.HIVE_AGENT || 'agent').replace(/[^\w-]/g, '_')
  const file = path.join(home, `fake-drop-enters-${agent}.txt`)
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim())
    if (!(n > 0)) return false
    fs.writeFileSync(file, String(n - 1))
    return true
  } catch {
    return false
  }
}

/**
 * fake-slow-input-<agent>.txt in its home: while it is there, no input is read (#597), as a busy Claude Code doesn't;
 * fake-slow-input-<agent>.paused says the reading has stopped. Once it goes, the next read is what came meanwhile.
 */
let slowRead = false
let lostEnters = 0
if (home && process.stdin.isTTY) {
  const agent = String(process.env.HIVE_AGENT || 'agent').replace(/[^\w-]/g, '_')
  const knob = path.join(home, `fake-slow-input-${agent}.txt`)
  const paused = path.join(home, `fake-slow-input-${agent}.paused`)
  setInterval(() => {
    const slow = fs.existsSync(knob)
    if (slow && !process.stdin.isPaused()) {
      process.stdin.pause()
      fs.writeFileSync(paused, '')
    } else if (!slow && fs.existsSync(paused)) {
      fs.rmSync(paused, { force: true })
      slowRead = true
      process.stdin.resume()
    }
  }, 100) // kept, not unref'd: with its input paused, it is what keeps the fake running
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
  lastInput = Date.now()
  // Down or Up in the trust menu moves its choice (two choices).
  if (trustMenu)
    for (const _ of data.matchAll(/\x1b\[[AB]/g)) {
      trustMenu.on = trustMenu.on === 'No' ? 'Yes' : 'No'
      drawTrust()
    }
  const chars = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  // The read after a slow spell (#597): several characters, not a bracketed paste, are a paste, as in Claude Code.
  const pasted = slowRead && chars.length > 1 && !data.includes('\x1b[200~')
  slowRead = false
  if (pasted && /[\x15\r]/.test(chars)) lostEnters++
  for (const ch of chars) {
    // A Ctrl+U or an Enter in a paste is text: nothing is cleared or sent.
    if (pasted && (ch === '\x15' || ch === '\r')) continue
    if (ch === '\x03') {
      if (++ctrlC >= 2) void quit()
      continue
    }
    ctrlC = 0
    // What is typed shows on its input line, as in Claude Code (a pasted image's path too, #195).
    if (ch === '\x15') {
      if (line) out('\r\x1b[K')
      line = ''
    } else if ((ch === '\r' || ch === '\n') && !onEnter && Date.now() < drawingUntil) {
      // Still drawing the resumed conversation: the Enter is lost, what was typed stays on the line (#334).
      continue
    } else if (ch === '\r' || ch === '\n') {
      // A CLI that doesn't take the Enter after a line Hive typed (#376: Codex once left a wake in its prompt): the line
      // stays, as typed, for the next Enter.
      if (line.startsWith('[Hive]') && dropEnter()) continue
      // The Enter after such a paste is lost too (#597).
      if (lostEnters > 0 && line) {
        lostEnters--
        continue
      }
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

/** "linger N": N processes left running after it ends (linger.cjs), started through one that exits at once. */
function leaveRunning(n) {
  for (let i = 0; i < n; i++) spawn(process.execPath, [path.join(__dirname, 'linger.cjs'), 'starter', path.join(home, 'fake-linger.jsonl'), process.env.HIVE_AGENT || 'agent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** "progress-linger": a command left running through the session's hive-progress shim (on its PATH), not waited for (#542). */
function leaveProgressRunning() {
  const q = (x) => `"${x}"`
  const command = ['hive-progress', '--title', q('Left running'), '--', q(process.execPath), q(path.join(__dirname, 'linger.cjs')), 'linger', q(path.join(home, 'fake-progress-linger.jsonl')), process.env.HIVE_AGENT || 'agent'].join(' ')
  spawn('cmd.exe', ['/d', '/s', '/c', q(command)], { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
}

async function main() {
  // fake-linger-at-start.txt (N) in its home: N lingering processes the moment it starts, before anything else (#507).
  const atStart = path.join(home, 'fake-linger-at-start.txt')
  if (fs.existsSync(atStart)) leaveRunning(Number(fs.readFileSync(atStart, 'utf8')) || 1)
  // Bracketed paste on, as Claude Code turns it on.
  out('\x1b[?2004hClaude Code (fake, for Hive tests)\r\n')
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
  // An OAuth session that expired and can't be refreshed: Claude Code says so and exits with 1 before its session
  // starts (#577, as 2.1.296 did).
  if (expiredAtLaunch()) {
    out('Failed to authenticate: OAuth session expired and could not be refreshed\r\n')
    process.stdout.write('', () => process.exit(1))
    return
  }
  // --name: Claude Code keeps it as the session's name (a custom title, as /rename does).
  if (opts['--name']) write({ type: 'custom-title', customTitle: opts['--name'] })
  await hook('SessionStart', { source: opts['--resume'] ? 'resume' : 'startup' })
  promptLine()
  setInterval(() => void whileIdle(), 200)
  if (firstPrompt) await runPrompt(firstPrompt)
}
void main()
