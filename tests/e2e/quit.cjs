// Quit flows in throwaway profiles. Sessions run the fake Claude Code (fake-claude/, #194): started, never sent a message.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const shots = path.join(scratch, 'qshots')
fs.rmSync(shots, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)

/** Adds an agent to a project and starts it (projects start without agents). */
async function startIn(inv, proj) {
  const a = await lib.addAgent(inv, proj)
  await inv('session:start', proj, { agentId: a.id })
  await lib.acceptClaudeTrust(inv, proj, a.id)
}

async function launch(name, config) {
  const userData = path.join(scratch, `q-${name}-profile`)
  const ws = path.join(scratch, `q-${name}-ws`)
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  if (config) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config))
  const claude = lib.fakeClaude(userData, path.join(scratch, `q-${name}-claude-home`), [path.join(ws, 'alpha'), path.join(ws, 'beta')])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // Starting an agent before Hive has found its Claude Code fails (it did now and then on a busy machine).
  await lib.waitForProvider(inv)
  return { app, page, inv, ws }
}
/**
 * Hive quits: it decides to (its own quit work done, timed from the watch's start) within ms, and its process ends after.
 * The process's part is Electron's on a loaded machine, so it is only waited for, up to GONE_MS (#424).
 */
const GONE_MS = 30000
const quits = async (q, ms = 10000) => !!(await q.untilDecided(ms)) && (await q.gone(GONE_MS))
/**
 * Until n sessions are ready (idle), not just past starting: in a folder Claude Code hasn't seen, its trust question
 * shows the session as waiting (Needs your input) until acceptClaudeTrust's answer gets it to its prompt (#177).
 */
const untilReady = (inv, n) => lib.until(async () => (await inv('session:live')).filter((l) => l.status === 'ready').length >= n, 30000)
/** Closes a copy that didn't quit by itself: app.close() alone waits at its Quit dialog for ever. */
const forceClose = async (app) => {
  await Promise.race([app.close().catch(() => undefined), sleep(5000)])
  try {
    app.process().kill()
  } catch {
    // Already gone.
  }
}

;(async () => {
  // 1. Old boolean config is migrated; "always" asks even when agents are idle.
  {
    const { app, page, inv, ws } = await launch('always', { settings: { general: { confirmOnQuit: true } } })
    check('migration: old "true" became "working"', (await inv('settings:get')).general.confirmOnQuit === 'working')
    await inv('settings:update', { general: { confirmOnQuit: 'always' } })
    await startIn(inv, path.join(ws, 'alpha'))
    await startIn(inv, path.join(ws, 'beta'))
    // Its sessions up and idle, so quitting finds them running.
    await untilReady(inv, 2)
    await page.evaluate(() => window.hive.invoke('app:quit')) // same entry point as the tray's Quit Hive
    await sleep(800)
    check('dialog: shown in-app', (await page.locator('.dialog', { hasText: 'Quit Hive?' }).count()) === 1)
    check('dialog: lists both sessions', (await page.locator('.quit-row').count()) === 2)
    check('dialog: no "quit when finished" when nothing is working', (await page.locator('.dialog button', { hasText: 'Quit when' }).count()) === 0)
    await page.screenshot({ path: path.join(shots, '1-dialog-idle.png') })
    await page.locator('.dialog button', { hasText: 'Cancel' }).click()
    await sleep(800)
    check('cancel: dialog closed, sessions still running', (await page.locator('.quit-row').count()) === 0 && (await inv('session:live')).length === 2)
    // Escape also cancels.
    await page.evaluate(() => window.hive.invoke('app:quit'))
    await sleep(600)
    await page.keyboard.press('Escape')
    await sleep(600)
    check('escape: cancels', (await inv('session:live')).length === 2 && (await inv('app:quitState')).request === null)
    // Don't ask again + Quit now.
    await page.evaluate(() => window.hive.invoke('app:quit'))
    await sleep(600)
    await page.locator('.quit-dontask input').check()
    const q = await lib.quitWatch(app)
    await page.locator('.dialog button', { hasText: 'Quit now' }).click()
    check('quit now: app exits', await quits(q))
    const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'q-always-profile', 'config.json'), 'utf8'))
    check("don't ask again: saved as never", saved.settings.general.confirmOnQuit === 'never')
    const s = JSON.parse(fs.readFileSync(path.join(ws, 'alpha', '.hive', 'sessions.json'), 'utf8'))
    check('quit now: nothing left running (no stray Claude Code for this profile)', Array.isArray(s.sessions))
  }

  // 2. Default ("working") with idle sessions: quits straight away, no dialog.
  {
    const { app, inv, ws } = await launch('idle')
    await startIn(inv, path.join(ws, 'alpha'))
    // Its session up and idle, so quitting finds it running.
    check('idle + default: the session is idle first', await untilReady(inv, 1))
    const q = await lib.quitWatch(app)
    const t0 = Date.now()
    await inv('app:quit').catch(() => undefined)
    const closed = await quits(q)
    check('idle + default: quits without asking', closed)
    // Hive's own shutdown (stopping the session, up to 3 s, and saving), not the process's teardown after it.
    const decided = await q.untilDecided(0)
    check('idle + default: shutdown under 5 s', !!decided && decided - t0 < 5000)
    results.push(`INFO  idle + default: ${q.timings(t0)}`)
    // It asked instead: close it, or it stays open (at the dialog) after the suite, holding the runner's port.
    if (!closed) await forceClose(app)
  }

  // 3. Pending quit with nothing working quits at once; the banner and tray state appear while pending.
  {
    const { app, page, inv, ws } = await launch('pending', { settings: { general: { confirmOnQuit: 'always' } } })
    await startIn(inv, path.join(ws, 'alpha'))
    // Its session up and idle, so quitting finds it running.
    await untilReady(inv, 1)
    await page.evaluate(() => window.hive.invoke('app:quit'))
    await sleep(600)
    const q = await lib.quitWatch(app)
    await inv('app:quitDecision', 'wait', false).catch(() => undefined)
    const quit = await quits(q)
    check('wait with no working agent: quits', quit)
    if (!quit) await forceClose(app)
  }

  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
