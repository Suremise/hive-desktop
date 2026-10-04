// Shared helpers for Hive's end-to-end suites (tests/e2e). They drive the real app with Playwright's
// _electron against a dev build (npx electron-vite build), in throwaway profiles and workspaces under
// WORK, and never touch the real Hive profile, ~/.codex or the clipboard.
//
// Needs: the standalone Claude Code CLI (signed in) and, for the Codex suites, Codex signed in to the test
// home CODEX_HOME. The first Claude Code run in a test folder asks whether to trust it; acceptClaudeTrust
// answers that (it is not a sign-in screen). Suites never automate sign-in screens.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..', '..')
/** Electron's executable (the electron package resolves to its path in plain Node). */
const ELECTRON = require('electron')
const LOCAL = process.env.LOCALAPPDATA || os.tmpdir()
/** Where suites keep their profiles, workspaces and screenshots. Stable, so Claude Code trusts its folders once. */
const WORK = process.env.HIVE_E2E_DIR || path.join(LOCAL, 'hive-test', 'e2e')
/** The Codex home the Codex suites use (signed in once by hand: see tests/e2e/README.md). */
const CODEX_HOME = process.env.HIVE_TEST_CODEX_HOME || path.join(LOCAL, 'hive-test', 'codex')
fs.mkdirSync(WORK, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  const e = { ...process.env, HIVE_USER_DATA: userData, ...env }
  delete e.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: ELECTRON, args: [ROOT], cwd: ROOT, env: e })
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

/** Answers Claude Code's "trust this folder" question in an agent's terminal, if it asks. */
async function acceptClaudeTrust(inv, proj, agentId, timeoutMs = 15000) {
  const key = ptyKey(proj, agentId)
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    // Terminal UIs draw spaces as cursor moves: control sequences become spaces before matching.
    const text = String(await inv('pty:buffer', key).catch(() => ''))
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
      .replace(/\x1b\][^\x07]*\x07/g, ' ')
      .replace(/\s+/g, ' ')
    if (/trust this folder/i.test(text)) {
      await inv('pty:write', key, '\x1b[B')
      await sleep(300)
      await inv('pty:write', key, '\r')
      return true
    }
    if (/for shortcuts|\? for/i.test(text)) return false
    await sleep(500)
  }
  return false
}

/** Trusts a folder in the test Codex home (and makes sure its non-admin sandbox is set). */
function trustForCodex(folder) {
  const cfg = path.join(CODEX_HOME, 'config.toml')
  let t = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : ''
  if (!t.includes(folder)) t += `\n[projects.'${folder}']\ntrust_level = "trusted"\n`
  if (!/^\[windows\]/m.test(t)) t += `\n[windows]\nsandbox = "unelevated"\n`
  fs.writeFileSync(cfg, t)
}

/** A git repository with one commit. */
function gitProject(dir, files = { 'a.ts': 'export const a = 1\n' }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'init')
}

/**
 * The hook URL and token of a running Codex launch, read from its command line (Hive no longer writes the
 * token to its log). For tests that call the hook server the way Codex does.
 */
function codexHook(runId) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' })
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

module.exports = { ROOT, ELECTRON, WORK, CODEX_HOME, sleep, port, until, appReady, openWorkspace, hadEstimate, fitWindow, enableProviders, launch, waitForProvider, addAgent, soloAgent, ptyKey, acceptClaudeTrust, trustForCodex, gitProject, codexSignedIn, codexHook, samplePng }
