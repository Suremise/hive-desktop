// Shared helpers for Hive's end-to-end suites (tests/e2e). They drive the real app with Playwright's
// _electron against a dev build (npx electron-vite build), in throwaway profiles and workspaces under
// WORK, and never touch the real Hive profile, ~/.codex or the clipboard.
//
// Needs: the standalone Claude Code CLI (signed in) and, for the Codex suites, Codex signed in to the test
// home CODEX_HOME. The first Claude Code run in a test folder asks whether to trust it; acceptClaudeTrust
// answers that (it is not a sign-in screen). Suites never automate sign-in screens.
const fs = require('fs')
const path = require('path')
const { execFileSync, execSync } = require('child_process')
const { _electron } = require('playwright-core')

// The run context (runContext.cjs): the environments of everything a suite starts, its folders and the CLI test homes.
const { TEST_ROOT, WORK, CODEX_HOME, hiveEnv, childEnv, baseEnv, isHiveEnv } = require('./runContext.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
/** Electron's executable (the electron package resolves to its path in plain Node). */
const ELECTRON = require('electron')
// WORK: where suites keep their profiles, workspaces and screenshots. Stable, so Claude Code trusts its folders once.
fs.mkdirSync(WORK, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A new folder for a probe of your own (a Playwright script's profile, workspace and screenshots; #304), in
 * hive-test\scratch, named for it and the time: `scratch\<name>-<yyyymmdd-hhmmss>-<random>`. Every run gets a new one,
 * so nothing needs deleting first (never `rm -rf` a computed path: Claude Code asks, and unattended it denies). The
 * clean-up prunes them after a few days (`npm run test:clean`), unless a card that isn't Done cites one.
 */
function probeDir(name = 'probe', root = TEST_ROOT) {
  const base = path.join(root, 'scratch')
  const label = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'probe'
  const d = new Date()
  const two = (n) => String(n).padStart(2, '0')
  // Local time, as the runs' log folders are named.
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, `${label}-${stamp}-`))
}
/**
 * A suite's Agent API port, as a string: the runner's (HIVE_E2E_PORT, one per suite running at the same time, so suites
 * can run side by side), else the suite's own default when it runs alone (node tests/e2e/<suite>.cjs).
 */
const port = (fallback) => process.env.HIVE_E2E_PORT || String(fallback)

/** Waits until fn() returns something truthy (checking every interval ms), up to ms; returns its last value. */
async function until(fn, ms = 10000, interval = 100) {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await sleep(interval)
  return v
}

/** Turns providers on in a test profile's config before Hive starts (fresh profiles start with none). */
function enableProviders(userData, providers = ['claude-code']) {
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, 'config.json')
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // No config yet.
  }
  // A 0.1 config: the migration keeps Claude Code on.
  if ((cfg.version ?? 1) < 2 && fs.existsSync(file)) return
  cfg.version = 2
  cfg.settings = cfg.settings ?? {}
  cfg.settings.providers = cfg.settings.providers ?? {}
  // No online check for a newer CLI at every launch: slow, needs the network, and no suite is about it.
  for (const p of providers) cfg.settings.providers[p] = { checkUpdatesOnLaunch: false, ...cfg.settings.providers[p], enabled: true }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

/**
 * The fake Claude Code (fake-claude/) for a test profile, for a suite about Hive's own behaviour that only needs some
 * session running (#194): turns Claude Code on in userData's config with the fake as its path, makes home a fresh
 * Claude Code config folder in which the fake trusts `trusted` (so it asks nothing), and returns the variables to start
 * Hive with: { CLAUDE_CONFIG_DIR }. A config written before (a 0.1 one, settings of the suite's) is kept.
 */
function fakeClaude(userData, home, trusted = []) {
  enableProviders(userData)
  const file = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  cfg.settings = cfg.settings ?? {}
  cfg.settings.providers = cfg.settings.providers ?? {}
  cfg.settings.providers['claude-code'] = { checkUpdatesOnLaunch: false, ...cfg.settings.providers['claude-code'], executablePath: path.join(__dirname, 'fake-claude', 'fake-claude.cmd') }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'fake-trusted.json'), JSON.stringify(trusted.map((f) => f.toLowerCase())))
  return { CLAUDE_CONFIG_DIR: home }
}

/**
 * Sizes the test window's page area to `size` and pins the page to it. Pinning alone (setViewportSize) leaves
 * the rest of a bigger window blank, which looks like a layout bug when you watch a suite run.
 */
async function fitWindow(app, page, size) {
  await app
    .evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(w, h)
    }, [size.width, size.height])
    .catch(() => {})
  await page.setViewportSize(size).catch(() => {})
}

/**
 * Waits until Hive's window has rendered with its settings loaded, and Hive has finished looking for the providers'
 * CLIs (it does that in the background after start; starting an agent before then fails with "… is required").
 * Instead of a fixed wait after launch.
 */
async function appReady(page, ms = 90000) {
  const ready = () =>
    page
      .evaluate(async () => {
        if (!document.querySelector('.app .workbench')) return false
        const info = await window.hive.invoke('provider:info')
        return Object.values(info).every((p) => !p.checking)
      })
      .catch(() => false)
  const ok = await until(ready, ms)
  if (!ok) throw new Error("Hive's window wasn't ready (rendered, providers found) within " + ms / 1000 + ' s')
}

/** Opens a workspace and waits until the window shows it (its name in the title), instead of a fixed wait. */
async function openWorkspace(inv, page, ws, ms = 20000) {
  await inv('workspace:open', ws)
  const name = path.basename(ws)
  const ok = await until(() => page.evaluate((n) => document.title.includes(n), name).catch(() => false), ms)
  if (!ok) throw new Error(`The window didn't show the workspace ${name} within ${ms / 1000} s`)
}

/** Starts the dev build with a test profile. Returns { app, page, inv } (inv calls an IPC channel). */
async function launch({ userData, env = {}, viewport = { width: 1400, height: 850 } }) {
  // The run context's environment (quiet, tips off, the suite's port) with the profile and the suite's own variables.
  const app = await _electron.launch({ executablePath: ELECTRON, args: [ROOT], cwd: ROOT, env: hiveEnv({ HIVE_USER_DATA: userData, ...env }) })
  const page = await app.firstWindow()
  await fitWindow(app, page, viewport)
  await appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, args]) => window.hive.invoke(c, ...args), [ch, a])
  return { app, page, inv }
}

/**
 * Waits until Hive has finished looking for a provider's CLI (it does so in the background after start): starting
 * an agent before then fails with "Claude Code is required". Throws if it isn't found.
 */
async function waitForProvider(inv, provider = 'claude-code', timeoutMs = 60000) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    const info = (await inv('provider:info').catch(() => ({})))[provider]
    if (info && !info.checking) {
      if (!info.found) throw new Error(`${provider} wasn't found on this machine`)
      return info
    }
    await sleep(250)
  }
  throw new Error(`${provider}: still looking for it after ${timeoutMs / 1000} s`)
}

/** Adds an agent (Claude Code in the project folder unless told otherwise); returns its definition. */
function addAgent(inv, proj, opts = {}) {
  return inv('agents:add', proj, { location: 'project', provider: 'claude-code', ...opts })
}

/** Makes a project's only agent (removing any others first): for suites that reuse a workspace. */
async function soloAgent(inv, proj, opts = {}) {
  await inv('project:updateConfig', proj, { agents: [] })
  return addAgent(inv, proj, opts)
}

/** Terminal key of an agent's session. */
const ptyKey = (proj, agentId) => `session:${proj.toLowerCase()}#${agentId}`

/**
 * Claude Code at its prompt, past its first-run questions: its footer, "? for shortcuts" before 2.1.289 and the mode
 * line since ("⏵⏵ auto mode on (shift+tab to cycle)", "⏸ manual mode on"). The trust and import screens show neither.
 */
const CLAUDE_AT_PROMPT = /for shortcuts|\? for|shift\+tab to cycle|\bmode on\b/i

/**
 * Answers Claude Code's "trust this folder" question in an agent's terminal, if it asks: true when it answered, false
 * as soon as the session is past it (Claude Code's prompt on screen, or Hive has the session ready: a trusted folder
 * asks nothing, #188), or at the timeout. Never answers anything else (a sign-in screen least of all).
 */
async function acceptClaudeTrust(inv, proj, agentId, timeoutMs = 15000) {
  const key = ptyKey(proj, agentId)
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    // Terminal UIs draw spaces as cursor moves: control sequences become spaces before matching.
    const text = plainText(await inv('pty:buffer', key).catch(() => ''))
    if (/trust this folder/i.test(text)) return chooseTrust(inv, key, Math.max(3000, timeoutMs - (Date.now() - t)))
    if (CLAUDE_AT_PROMPT.test(text)) return false
    const live = (await inv('session:live').catch(() => [])).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agentId)
    if (live?.status === 'ready') return false
    await sleep(500)
  }
  return false
}

/** The trust question's choice the terminal shows selected last ('No, exit' or 'Yes, …'), or null. */
function trustChoice(text) {
  const marks = [...plainText(text).matchAll(/[>❯›]\s*(?:\d\.\s*)?(No, exit|Yes, I trust this folder)/g)]
  return marks.length ? marks.at(-1)[1] : null
}

/**
 * Says yes to Claude Code's trust question. Its menu starts on "No, exit", and Enter on that quits Claude Code (exit 1).
 * A key sent while it is still drawing the menu is dropped on a busy machine (#218: Down lost, Enter chose No), so
 * Enter is pressed only once the terminal shows "Yes" selected, Down sent again until it does; never on "No". true when
 * it answered yes.
 */
async function chooseTrust(inv, key, timeoutMs = 20000) {
  const t = Date.now()
  const choice = async () => trustChoice(await inv('pty:buffer', key).catch(() => ''))
  while (Date.now() - t < timeoutMs) {
    // Still "Yes" a moment later: a Down still on its way would have moved it back by then.
    if ((await choice()) === 'Yes, I trust this folder' && (await sleep(400), (await choice()) === 'Yes, I trust this folder')) {
      await inv('pty:write', key, '\r')
      return true
    }
    await inv('pty:write', key, '\x1b[B')
    await until(async () => (await choice()) === 'Yes, I trust this folder', 2000, 150)
  }
  return false
}

/**
 * Runs fn holding a lock beside file (`<file>.lock`, a folder: creating one is atomic), for a change that reads the file
 * and writes it back: runners in different worktrees share the Codex test home (e2e lanes don't split it: it holds the
 * one sign-in), and two changes at once would otherwise lose one. A lock older than staleMs was left by a crash.
 *
 * On Windows the lock folder can't always be made or removed the moment another runner lets go of it: while something
 * still has it open (another runner looking at its age, a virus scan), creating it says EPERM, EACCES or EBUSY rather
 * than EEXIST, and removing it fails the same way. Both mean busy, not broken (#181): taking the lock waits as for
 * EEXIST (a real permission problem still ends at timeoutMs, naming the error), and letting go tries again for a moment
 * rather than failing a runner whose change is already written.
 */
function withFileLock(file, fn, { staleMs = 30_000, timeoutMs = 120_000 } = {}) {
  const lock = `${file}.lock`
  const start = Date.now()
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if (!LOCK_BUSY.has(e.code)) throw e
      if (Date.now() - start > timeoutMs) throw new Error(`${lock} is still held (${e.code})`, { cause: e })
      let age
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs
      } catch {
        // EEXIST and now gone: just released, try again at once. Refused (in use) and its age unreadable: wait as
        // for a held lock, so a lasting refusal is a slow poll until the timeout, never a busy loop (review #181).
        if (e.code !== 'EEXIST') pause(25)
        continue
      }
      if (age > staleMs) removeLock(lock, pause)
      else pause(25)
    }
  }
  try {
    return fn()
  } finally {
    removeLock(lock, pause)
  }
}
/** What creating or removing a lock folder says while another process still has it open (Windows), or while it exists. */
const LOCK_BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
/** Removes a lock folder, trying again for up to a second while Windows says it is in use; gone already is fine. */
function removeLock(lock, pause) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(lock, { recursive: true, force: true })
      return
    } catch (e) {
      if (!LOCK_BUSY.has(e.code) || attempt >= 40) throw e
      pause(25)
    }
  }
}

/**
 * Trusts a folder in the test Codex home (and makes sure its non-admin sandbox is set). Under withFileLock: suites of
 * runners in different lanes trust their own folders in the same config.toml.
 */
function trustForCodex(folder, home = CODEX_HOME) {
  fs.mkdirSync(home, { recursive: true })
  const cfg = path.join(home, 'config.toml')
  withFileLock(cfg, () => {
    const before = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : ''
    let t = before
    if (!t.includes(`[projects.'${folder}']`)) t += `\n[projects.'${folder}']\ntrust_level = "trusted"\n`
    if (!/^\[windows\]/m.test(t)) t += `\n[windows]\nsandbox = "unelevated"\n`
    if (t !== before) fs.writeFileSync(cfg, t)
  })
}

/**
 * Failures that come from the machine, not from Hive: the CLI's usage or rate limit, its sign-in, the network to its
 * API. Matched in the CLI's own output (terminal text, a session's status message), conservatively: anything not
 * clearly one of these stays a FAIL. Hook errors (127.0.0.1) are Hive's, never the environment's.
 */
const ENVIRONMENT = [
  { why: 'usage or rate limit', re: /(?:usage|5-hour|weekly|session|opus|sonnet) limit reached|hit your (?:usage )?limit|rate_limit_error|rate limit(?:ed| exceeded)|too many requests|API Error: 429/i },
  { why: 'the API is overloaded', re: /overloaded_error|API Error: 529/i },
  { why: 'not signed in', re: /select login method|please run \/login|not logged in|invalid api key|oauth token (?:has )?expired|authentication_error|sign in with chatgpt|run `?codex login/i },
  { why: 'network', re: /API Error: (?:Connection error|Request timed out)|unable to connect to (?:the )?(?:Anthropic )?API|stream disconnected before completion|error sending request for url \(https:\/\/[\w.]*(?:openai|chatgpt)|ENOTFOUND [\w.]*(?:anthropic|openai|chatgpt)/i }
]
/** Terminal text as plain words: control sequences become spaces, runs of space one. */
const plainText = (s) =>
  String(s ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b\][^\x07]*\x07/g, ' ')
    .replace(/\s+/g, ' ')

/** Every environment failure in this CLI output, in order: [{ why, at }] ("usage or rate limit: …", with what it said). */
function environmentProblems(text) {
  const t = plainText(text)
  const found = []
  for (const { why, re } of ENVIRONMENT)
    for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
      const from = Math.max(0, m.index - 20)
      found.push({ why: `${why}: …${t.slice(from, m.index + m[0].length + 40).trim()}…`, at: m.index })
    }
  return found.sort((a, b) => a.at - b.at)
}

/** Why this CLI output shows a failure of the environment, or null (the first one). */
const environmentProblem = (text) => environmentProblems(text)[0]?.why ?? null

// Every Hive a suite starts, whether through launch() or Playwright's _electron.launch directly (most suites do that):
// require('playwright-core') is one module, so suites get this _electron. cliStep reads their sessions. Each must have
// the run context's environment (hiveEnv): without one, Playwright would pass on the suite's own.
const apps = new Set()
const launchElectron = _electron.launch.bind(_electron)
_electron.launch = async (...args) => {
  if (!isHiveEnv(args[0]?.env)) throw new Error("Start a test Hive with lib.hiveEnv({ HIVE_USER_DATA, … }) as its env (tests/e2e/runContext.cjs), never the suite's own environment")
  const app = await launchElectron(...args)
  apps.add(app)
  app.on('close', () => apps.delete(app))
  return app
}

/** The environment failures in each session of the running test Hives: Map<pty key, problems> (terminal and status). */
async function sessionProblems() {
  const out = new Map()
  for (const app of apps)
    for (const page of app.windows()) {
      const texts = await page
        .evaluate(async () => {
          const ws = await window.hive.invoke('workspace:get')
          const hosts = ws ? [...ws.projects, ...(ws.assistant ? [ws.assistant] : [])] : []
          const found = []
          for (const h of hosts)
            for (const a of h.agents ?? []) {
              const key = `session:${h.path.toLowerCase()}#${a.id}`
              found.push([key, `${await window.hive.invoke('pty:buffer', key).catch(() => '')}\n${a.live?.statusMessage ?? ''}`])
            }
          return found
        })
        .catch(() => [])
      for (const [key, text] of texts) out.set(key, environmentProblems(text))
    }
  return out
}

/**
 * Whether a failed CLI step (cliStep) failed because of the environment, decided only from what is known for sure:
 * { skip: why } or { note: why } (a new environment failure, but the failure can't be put down to it) or null. Only a
 * failed check in the step counts, the waits the suite marked as the CLI's: an exception (a bug, a rejected IPC call, a
 * file error) is never the environment's, so a step that threw is a note at most and the exception stays a failure.
 * The suite's checks must report to lib (checked), none may have failed before the step, and a new environment failure
 * must have appeared during the step in its own session (session: its pty key; else any): more of them at the end
 * than at the start, so one the CLI recovered from earlier doesn't count.
 */
function stepVerdict({ name, session = null, before, after, stepFailed, error, failedBefore, wired }) {
  if (!stepFailed && !error) return null
  let fresh = null
  for (const [key, problems] of after) {
    if (session && key !== session.toLowerCase()) continue
    const had = before.get(key)?.length ?? 0
    if (problems.length > had) fresh = { key, why: problems[had].why }
  }
  if (!fresh) return null
  const where = `in "${name}", ${fresh.key}`
  const why = error ? `the step threw (${error?.name ?? 'Error'}: ${error?.message ?? error})` : !wired ? "the suite's checks don't report to lib.checked" : failedBefore ? `${failedBefore} check(s) failed before it` : null
  if (why) return { note: `${fresh.why} (${where}; not a skip: ${why})` }
  return { skip: `environment: ${fresh.why} (${where})` }
}

/** The suite's checks, as far as they report them (checked): failures outside a CLI step, and the step running. */
const checks = { wired: false, failed: 0, step: null }

/** A suite's check reports its result here, so a CLI step knows whether it failed and whether anything failed before. */
function checked(ok) {
  checks.wired = true
  if (ok) return
  if (checks.step) checks.step.failed++
  else checks.failed++
}

/**
 * Runs a step that depends on the real CLI answering (a turn, a start), in a real-CLI suite. If a check in it failed
 * (it didn't throw) and a new environment failure appeared in its session meanwhile (stepVerdict), the suite stops
 * there as skipped: `SKIPPED environment: <why>` and the number of its failed checks (`SKIPPED-FAILS n`), which the
 * runner (suiteOutcome) accepts only if no other FAIL line was printed. Anything else carries on as usual: an
 * exception is thrown on, and a failure before the step, or with no new environment failure in its session, stays a
 * FAIL. So waits on the CLI in a step end in a check, not a throw. opts.session: the step's pty key.
 */
async function cliStep(name, opts, fn) {
  if (typeof opts === 'function') [fn, opts] = [opts, {}]
  const before = await sessionProblems()
  const step = { failed: 0 }
  checks.step = step
  let error = null
  let value
  try {
    value = await fn()
  } catch (e) {
    error = e
  }
  checks.step = null
  if (step.failed || error) {
    const v = stepVerdict({ name, session: opts.session, before, after: await sessionProblems(), stepFailed: step.failed, error, failedBefore: checks.failed, wired: checks.wired })
    if (v?.skip) {
      console.log(`SKIPPED ${v.skip}`)
      console.log(`SKIPPED-FAILS ${step.failed}`)
      // Its test Hives close first, so nothing it started is left running.
      await Promise.race([Promise.all([...apps].map((a) => a.close().catch(() => undefined))), sleep(10000)])
      process.exit(0)
    }
    if (v?.note) console.log(`ENVIRONMENT ${v.note}`)
  }
  checks.failed += step.failed
  if (error) throw error
  return value
}

/**
 * Types a prompt into a CLI's terminal (pty key) and presses Enter until it is submitted: submitted() turns true (the
 * session working, say) within waitMs. Under load a CLI can take the prompt, written at once, as a paste and the Enter
 * right after it as a new line in it, or drop what was typed while it was still drawing (#190): if the text is in the
 * terminal, Enter is pressed again; if not, it is typed again over a cleared line (Ctrl+U). Up to `tries` times; returns
 * the attempt that worked (1 = the first), or 0.
 */
async function sendPrompt(inv, key, text, { submitted, tries = 3, waitMs = 20000 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const typed = attempt > 1 && plainText(await inv('pty:buffer', key).catch(() => '')).includes(text.slice(0, 30))
    if (attempt === 1) await inv('pty:write', key, text)
    else if (!typed) await inv('pty:write', key, `\x15${text}`)
    await sleep(400)
    await inv('pty:write', key, '\r')
    if (await until(submitted, waitMs, 500)) return attempt
  }
  return 0
}

/** Skips the whole suite with a reason (the run record shows it): for a suite that can't run on this machine. */
function skip(reason) {
  console.log(`SKIPPED ${reason}`)
  process.exit(0)
}

/**
 * What git says when another git process holds the repository's lock (index.lock, or a ref's): "File exists", or on
 * a busy Windows "Permission denied" while the holder's lock is still being deleted (a scanner has it open, #298).
 */
const GIT_LOCKED = /Unable to create '[^']+\.lock': (File exists|Permission denied)|Another git process seems to be running/i

/**
 * Runs git in a test repository (cmd: a command line after `git`, or its arguments) and returns its output, waiting out
 * the Hive under test's own git (#199): Hive refreshes branch status and the Changes tab with `git status`, which holds
 * the repository's index.lock for a moment, so a suite's git command that writes at that moment fails with "Unable to
 * create '…/index.lock': File exists" (or "Permission denied" while that lock is still being deleted on a busy
 * machine, #298). That alone is tried again every 100 ms for up to timeoutMs; any other failure throws at once.
 * opts: execSync's (input, env…).
 */
function git(cwd, cmd, { timeoutMs = 15_000, ...opts } = {}) {
  const start = Date.now()
  let tries = 0
  for (;;) {
    try {
      const o = { cwd, encoding: 'utf8', stdio: 'pipe', ...opts }
      const out = Array.isArray(cmd) ? execFileSync('git', cmd, { env: baseEnv(), ...o }) : execSync(`git ${cmd}`, { env: baseEnv(), ...o })
      // Said in the suite's log, so a run shows how often the race happens.
      if (tries) console.log(`(git ${Array.isArray(cmd) ? cmd.join(' ') : cmd}: waited ${Date.now() - start} ms for another git's lock)`)
      return out
    } catch (e) {
      if (!GIT_LOCKED.test(`${e.stderr ?? ''}\n${e.message ?? ''}`) || Date.now() - start > timeoutMs) throw e
      tries++
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

/** A git repository with one commit. */
function gitProject(dir, files = { 'a.ts': 'export const a = 1\n' }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  const run = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: baseEnv() })
  run('init', '-q')
  run('add', '.')
  run('commit', '-qm', 'init')
}

/**
 * The hook URL and token of a running Codex launch, read from its command line (Hive no longer writes the
 * token to its log). For tests that call the hook server the way Codex does.
 */
function codexHook(runId) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', env: baseEnv() })
  const line = out.split(/\r?\n/).find((l) => l.includes(`run=${runId}`))
  if (!line) return null
  const token = /Bearer ([0-9a-f]{16,})/.exec(line)?.[1]
  const url = /(http:\/\/127\.0\.0\.1:\d+\/hook)/.exec(line)?.[1]
  return token && url ? { token, url } : null
}

const codexSignedIn = () => fs.existsSync(path.join(CODEX_HOME, 'auth.json'))

/** A real PNG (a w×h gradient) for image previews, pastes and drops. */
function samplePng(w = 64, h = 40) {
  const zlib = require('zlib')
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 245
      raw[o + 1] = Math.round((x / w) * 158)
      raw[o + 2] = Math.round((y / h) * 255)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Whether a progress run was given an estimate. Not whether time is left: Hive counts the estimate down as the run goes
 * (timeLeft), so a run that outlasts it ends with 0, while one never given an estimate keeps null.
 */
function hadEstimate(run) {
  return typeof run?.estimateMs === 'number'
}

/**
 * Haiku asked for Auto (#129, #234): what the installed Claude Code says about Haiku and Auto (its catalog), the mode
 * it then showed itself (modeObserved: its footer, a hook; never the mode asked for at launch) and the mode Hive shows.
 * Waits up to timeoutMs for the CLI to show a mode. The caller checks: observed in expected, and shown === observed.
 */
async function haikuAutoMode(inv, host, agentId = 'assistant', timeoutMs = 15000) {
  const info = (await inv('provider:info'))['claude-code']
  const autoOffered = info?.catalog?.models.find((m) => m.value === 'haiku')?.supportsAuto
  const expected = autoOffered === true ? ['auto'] : autoOffered === false ? ['manual'] : ['auto', 'manual']
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === agentId)
  await until(async () => expected.includes((await live())?.modeObserved), timeoutMs)
  const s = await live()
  return { version: info?.version ?? null, autoOffered, expected, observed: s?.modeObserved, shown: s?.permissionMode }
}

/**
 * Settings → Assistant's warning about Auto with Haiku (#129): there exactly when the CLI says Auto isn't offered
 * (saying the session runs in Manual), none when it says it is, the shipped guess ("may not offer") when it doesn't say.
 * Opens Settings → Assistant (Ctrl+,). Returns [ok, what it found].
 */
async function haikuAutoCaveat(page, autoOffered) {
  await page.keyboard.press('Control+,')
  await sleep(500)
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).first().click()
  await sleep(500)
  const caveat = await page.locator('.mode-caveat', { hasText: 'Auto with Haiku' }).allInnerTexts()
  const ok = autoOffered === true ? !caveat.length : autoOffered === false ? caveat.length === 1 && /doesn't offer Auto with Haiku.*runs in Manual/.test(caveat[0]) : caveat.length === 1 && /may not offer Auto with Haiku/.test(caveat[0])
  return [ok, JSON.stringify(caveat)]
}

module.exports = { ROOT, ELECTRON, WORK, CODEX_HOME, probeDir, hiveEnv, childEnv, baseEnv, git, GIT_LOCKED, plainText, trustChoice, haikuAutoMode, haikuAutoCaveat, sleep, port, until, appReady, openWorkspace, hadEstimate, fitWindow, enableProviders, fakeClaude, launch, waitForProvider, addAgent, soloAgent, ptyKey, acceptClaudeTrust, withFileLock, trustForCodex, gitProject, codexSignedIn, codexHook, samplePng, environmentProblem, environmentProblems, stepVerdict, checked, cliStep, sendPrompt, skip }
