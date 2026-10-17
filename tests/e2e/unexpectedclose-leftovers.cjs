// What the agents had started, after Hive closed unexpectedly (#987): while an agent runs, the running marker keeps what
// its launch started (its process job's members, each by id and start time). The fake Claude Code's "linger 1" leaves a
// node running, as a test run under hive-progress was left (Darren, 17 Oct). The test copy is ended from outside (by its
// own pid and start time, lib.identify, never by name): the node keeps running, and the next start's "Hive closed
// unexpectedly" notice says one process the agents started is still running, with Stop Them. Nothing is stopped on its
// own; Stop Them ends exactly that node. A kept record whose pid names another process by then (a stranger's, with
// another start time) is never listed, and the stranger is never ended. Fake Claude Code; dev build, throwaway profile
// and workspace, quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
const START_MS = 30000

const base = path.join(lib.WORK, 'unexpectedclose-leftovers')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const ws = path.join(base, 'ws')
const proj = path.join(ws, 'site')
const markerFile = path.join(userData, 'running.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const marker = () => {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return null
  }
}
const pidsIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])

// Playwright loses its connection to a copy ended from outside: not this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target page, context or browser has been closed|has been closed|Target crashed|ECONNRESET|EPIPE/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

const identities = []
let claudeEnv = null

/** Starts a copy of Hive on the profile, with its workspace restored. */
async function start() {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47835), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  identities.push(...lib.identify([app.process().pid]))
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

/** Ends the copy from outside, as a crash or a kill would: its own process (by pid and start time) and what it started. */
async function endFromOutside(app) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = identities.find((i) => i.pid === proc.pid)
  const ended = id ? lib.endTreeExactly(id) : 0
  const exited = await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), HUNG_MS))])
  return ended > 0 && exited
}

/** The notice's text in the window, once it is shown. */
const notice = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => t.includes('Hive closed unexpectedly')) ?? '')

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  const started = Date.now()
  claudeEnv = lib.fakeClaude(userData, home, [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Someone else's process, whose pid a kept record will name with another start time: never listed or ended. It names
  // the suite's folder, so the clean-up below finds it, and ends itself once this suite's process is gone (or after an hour).
  const strangerCode = `const suite = ${process.pid}; setInterval(() => { try { process.kill(suite, 0) } catch { process.exit(0) } }, 1000); setTimeout(() => process.exit(0), 3600000)`
  const stranger = spawn(process.execPath, ['-e', strangerCode, base], { cwd: base, detached: true, stdio: 'ignore', windowsHide: true, env: lib.childEnv() })
  stranger.unref()

  let current = null
  try {
    // --- 1. An agent whose command leaves a node running; the copy ended from outside while the agent runs.
    let node
    {
      current = await start()
      const { app, page, inv } = current
      await lib.openWorkspace(inv, page, ws)
      await lib.waitForProvider(inv)
      const agent = await lib.soloAgent(inv, proj, { name: 'Website' })
      const key = lib.ptyKey(proj, agent.id)
      const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
      await inv('session:start', proj, { agentId: agent.id })
      await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), START_MS)
      const lingerFile = path.join(home, 'fake-linger.jsonl')
      await lib.sendPrompt(inv, key, 'linger 1', { submitted: async () => (await live())?.status === 'working' || pidsIn(lingerFile).length > 0 })
      await lib.until(async () => pidsIn(lingerFile).length === 1 && (await live())?.status === 'finished', START_MS)
      ;[node] = pidsIn(lingerFile)
      check('the agent left a node running, and still runs', !!node && lib.processRunning(node) && !!(await live()), String(node))
      const kept = await lib.until(() => marker()?.processes?.some((l) => l.agentId === agent.id && l.processes.some((p) => p.pid === node && /^\d+$/.test(p.created))), HUNG_MS)
      check("the running marker keeps what the agent's launch started, each process with its start time", !!kept, JSON.stringify(marker()?.processes))
      // The window's workspace is remembered as it opens (config.json), so the next start opens it again.
      await lib.until(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).windows?.some((w) => w.workspace?.toLowerCase() === ws.toLowerCase()), HUNG_MS)
      check('the copy is ended from outside', await endFromOutside(app))
      current = null
    }
    check('the node keeps running after it', lib.processRunning(node))
    // A kept record whose pid names another process now: the stranger's, with another start time.
    const left = marker()
    left.processes.push({ projectPath: proj, agentId: 'gone', agentName: 'Gone', processes: [{ pid: stranger.pid, name: 'node.exe', label: 'node old-server.js', created: '116444736000000000' }] })
    fs.writeFileSync(markerFile, JSON.stringify(left, null, 2))

    // --- 2. The next start: the notice says it still runs, with Stop Them; nothing stops on its own.
    {
      current = await start()
      const { page, inv } = current
      const text = await lib.until(() => notice(page), START_MS)
      check('the notice says Hive closed unexpectedly, and that one process the agents started is still running', /One process the agents started is still running: node [^.]*linger/.test(text), text)
      check("…not the stranger's process, whose pid a record names with another start time", !!text && !/old-server/.test(text), text)
      check('…with Stop Them', /Stop Them/.test(text), text)
      await page.screenshot({ path: path.join(lib.WORK, 'unexpectedclose-leftovers-notice.png') })
      check('Copy Diagnostics says how many the agents had started and how many still run', /the agents had started \d+ process\(es\), 1 still running now/.test(await inv('app:diagnostics')))
      check('nothing is stopped on its own', lib.processRunning(node) && lib.processRunning(stranger.pid))
      await page.locator('.toast', { hasText: 'Hive closed unexpectedly' }).getByRole('button', { name: 'Stop Them' }).click()
      check('Stop Them ends the node', !!(await lib.until(() => !lib.processRunning(node), HUNG_MS)))
      check('…and says so', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'Stopped one process' }).count()) > 0, HUNG_MS)))
      check("the stranger's process still runs", lib.processRunning(stranger.pid))
      const quitting = await lib.quitWatch(current.app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits', await quitting.gone(HUNG_MS))
      current = null
    }
  } catch (e) {
    check('no unexpected error', false, e?.stack ?? String(e))
  } finally {
    if (current) await current.app.close().catch(() => undefined)
    // Anything left of a copy this suite started, by its own pid and start time only, and the processes naming the
    // suite's folder (the node, the stranger), each ended as the process it was.
    for (const id of identities) lib.endTreeExactly(id)
    lib.stopProcessesIn(base, started)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
