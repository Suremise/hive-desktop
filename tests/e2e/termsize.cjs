// Hidden terminals keep their size (#247): opening Settings (and changing the terminal's font while it's open), another
// project tab, another project and a layout that hides an agent never tell a running session a size the window didn't
// give it. Each fake CLI records every size it is given (fake-sizes.jsonl): none is below 20 × 5, nothing changes while
// its terminal is hidden, coming back gives the same size as before (or one new size after a font change), no
// in-between size while the view settles (a smaller window, 125% zoom), and a terminal that was scrolled to the bottom
// is still at the bottom well after (xterm syncs its scroll position late), while one scrolled up to read stays on its
// line. At the end, at the narrowest window with the Progress panel open, what a terminal shows re-wraps (#896). A
// Claude Code agent and a Codex agent (the fakes).
// Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'termsize-profile')
const ws = path.join(lib.WORK, 'termsize-ws')
const claudeHome = path.join(lib.WORK, 'termsize-claude-home')
const codexHome = path.join(lib.WORK, 'termsize-codex-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const MIN_COLS = 20
const MIN_ROWS = 5
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Every size a fake CLI was given, oldest first: { sessionId, cols, rows, at }. */
function sizes(home) {
  try {
    return fs.readFileSync(path.join(home, 'fake-sizes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47924), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // Low, so a few turns scroll the terminals.
  await lib.fitWindow(app, page, { width: 1300, height: 560 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const claude = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const codex = await lib.addAgent(inv, alpha, { name: 'Checker', provider: 'codex' })
  await page.locator('.layout-switch button[aria-label="Two columns"]').click()
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
  check('both agents start', !!(await lib.until(async () => (await live(claude.id))?.status === 'ready' && (await live(codex.id))?.status === 'ready', 25000)))
  const agents = [
    { name: 'Claude Code', a: claude, home: claudeHome, key: lib.ptyKey(alpha, claude.id) },
    { name: 'Codex', a: codex, home: codexHome, key: lib.ptyKey(alpha, codex.id) }
  ]
  const state = (key) => page.evaluate((k) => window.__hiveTerminalState(k), key)
  // Turns until each terminal has scrolled.
  for (const g of agents) {
    for (let i = 1; i <= 12 && !((await state(g.key))?.baseY > 0); i++) {
      await inv('pty:write', g.key, `turn ${i}`)
      await lib.sleep(100)
      await inv('pty:write', g.key, '\r')
      // The turn starting may be over before it is seen (a fast turn): up to 3 s for it, then the wait for its end.
      await lib.until(async () => (await live(g.a.id))?.status !== 'finished', 3000)
      await lib.until(async () => (await live(g.a.id))?.status === 'finished', 10000)
    }
  }
  const atBottom = (s) => !!s && s.viewportY === s.baseY
  for (const g of agents) {
    const s = await state(g.key)
    check(`${g.name}: its terminal has scrolled and is at the bottom`, atBottom(s) && s.baseY > 0, JSON.stringify(s))
  }
  await lib.sleep(500)

  /** Hides the terminals with `hide`, waits, shows them with `show`: what each CLI was given meanwhile and after. */
  const roundTrip = async (label, hide, show, { whileHidden, sizeChanges = false } = {}) => {
    const before = agents.map((g) => ({ g, n: sizes(g.home).length, last: sizes(g.home).at(-1), term: null }))
    for (const b of before) b.term = await state(b.g.key)
    await hide()
    await lib.sleep(700)
    if (whileHidden) await whileHidden()
    await lib.sleep(900)
    const hidden = agents.map((g, i) => sizes(g.home).slice(before[i].n))
    await show()
    // Shown again: one new size after a font change; otherwise none, which only time can tell (on purpose).
    if (sizeChanges) await lib.until(() => agents.every((g, i) => sizes(g.home).length > before[i].n), 5000)
    // No further size may follow, and past the time Hive holds a terminal at the bottom, it must stay there.
    await lib.sleep(1600) // on purpose
    for (const [i, b] of before.entries()) {
      const g = b.g
      const during = hidden[i]
      check(`${label}: ${g.name} is told nothing while hidden`, during.length === 0, JSON.stringify(during))
      const after = sizes(g.home).slice(b.n)
      const small = after.filter((s) => s.cols < MIN_COLS || s.rows < MIN_ROWS)
      check(`${label}: ${g.name} is never given a size below ${MIN_COLS} × ${MIN_ROWS}`, small.length === 0, JSON.stringify(small))
      const now = sizes(g.home).at(-1)
      const term = await state(g.key)
      if (sizeChanges) check(`${label}: ${g.name} is given one new size, its terminal's`, after.length === 1 && now.cols === term.cols && now.rows === term.rows, JSON.stringify({ after, term }))
      else check(`${label}: ${g.name} keeps its size`, after.length === 0 && term.cols === b.term.cols && term.rows === b.term.rows, JSON.stringify({ after, before: b.term, term }))
      check(`${label}: ${g.name}'s terminal is still at the bottom`, atBottom(term), JSON.stringify(term))
    }
  }

  const settingsBtn = page.locator('.activity-btn[aria-label="Settings"]')
  const projectsBtn = page.locator('.activity-btn[aria-label="Projects"]')
  await roundTrip('Settings', () => settingsBtn.click(), () => projectsBtn.click())
  // The bug's path: the terminal's appearance changes while Settings hides it.
  await roundTrip('Settings, font changed meanwhile', () => settingsBtn.click(), () => projectsBtn.click(), {
    whileHidden: () => inv('settings:update', { appearance: { terminalFontSize: 15 } }),
    sizeChanges: true
  })
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-after-settings.png') })
  // Shown again, xterm can move the view itself a moment later (its scroll position synced from a stale one): Hive puts
  // a terminal that follows its output back at the bottom. The same move, made just after coming back from Settings.
  await settingsBtn.click()
  await lib.sleep(500)
  await projectsBtn.click()
  await lib.sleep(200)
  for (const g of agents) await page.evaluate((k) => window.__hiveTerminalScrollLines(k, -3), g.key)
  await lib.sleep(1600) // on purpose: past the hold, it must still be at the bottom
  for (const g of agents) check(`late scroll after Settings: ${g.name} is put back at the bottom`, atBottom(await state(g.key)), JSON.stringify(await state(g.key)))
  await roundTrip('Files tab', () => page.locator('.tabs .tab', { hasText: 'Files' }).first().click(), () => page.locator('.tabs .tab', { hasText: 'Session' }).first().click())
  await roundTrip('Another project', () => page.getByText('beta', { exact: true }).first().click(), () => page.getByText('alpha', { exact: true }).first().click())
  // One at a time hides the Codex agent; it may be given its new pane's size when shown, never a tiny one.
  const n0 = sizes(codexHome).length
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  await lib.sleep(1000) // on purpose: nothing may happen
  check('One at a time: the hidden Codex agent is told nothing', sizes(codexHome).length === n0, JSON.stringify(sizes(codexHome).slice(n0)))
  await page.locator('.layout-switch button[aria-label="Two columns"]').click()
  await lib.until(async () => (await page.locator('.agent-pane:visible').count()) === 2, 5000)
  await lib.sleep(600)
  for (const g of agents) {
    const small = sizes(g.home).filter((s) => s.cols < MIN_COLS || s.rows < MIN_ROWS)
    check(`whole run: ${g.name} was never given a size below ${MIN_COLS} × ${MIN_ROWS}`, small.length === 0, JSON.stringify(small))
    check(`whole run: ${g.name}'s terminal ends at the bottom`, atBottom(await state(g.key)))
  }

  // A smaller window, where the project header measures itself and shortens a moment after being shown, at 100% and 125%:
  // coming back from Settings settles at once, with no in-between size.
  await lib.fitWindow(app, page, { width: 1000, height: 650 })
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.sleep(1500) // on purpose: the new window size and zoom settle first
    await roundTrip(`Settings at 1000 × 650, ${zoom * 100}%`, () => settingsBtn.click(), () => projectsBtn.click())
  }
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-zoom.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.sleep(1500) // on purpose: settle again

  // Scrolled up to read: Settings and back leaves it on its line; scrolled back down, it follows the output again.
  const writer = agents[0]
  await page.locator(`.terminal-host[data-pty=${JSON.stringify(writer.key)}]`).hover()
  await page.mouse.wheel(0, -120)
  await lib.until(async () => !atBottom(await state(writer.key)), HUNG_MS)
  const reading = await state(writer.key)
  check('reader: Claude Code scrolled up', !atBottom(reading), JSON.stringify(reading))
  await settingsBtn.click()
  await lib.sleep(500)
  await projectsBtn.click()
  await lib.sleep(1600) // on purpose: nothing may move it
  const back = await state(writer.key)
  check('reader: still on the same line after Settings', back.viewportY === reading.viewportY && back.baseY === reading.baseY, JSON.stringify({ reading, back }))
  await page.locator(`.terminal-host[data-pty=${JSON.stringify(writer.key)}]`).hover()
  for (let i = 0; i < 10 && !atBottom(await state(writer.key)); i++) await page.mouse.wheel(0, 120)
  check('reader: scrolled back down to the bottom', !!(await lib.until(async () => atBottom(await state(writer.key)), HUNG_MS)), JSON.stringify(await state(writer.key)))
  await roundTrip('Settings after scrolling back down', () => settingsBtn.click(), () => projectsBtn.click())
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-end.png') })

  // Narrowed, what the terminal shows re-wraps instead of being cut at its edge (#896): Hive's exit line, and a line as
  // wide as the terminal was, written in a wide window. xterm keeps a line's cells past a narrower terminal's edge
  // without drawing them, so only what is drawn counts.
  const fitted = () => page.evaluate(() => window.__hiveTerminalsFitted())
  const drawn = async () => {
    const cols = (await state(writer.key)).cols
    return ((await page.evaluate((k) => window.__hiveTerminalLines(k), writer.key)) ?? []).map((l) => l.slice(0, cols)).join('')
  }
  // One pane: two columns at the narrowest window with the panel open are narrower than Hive fits a terminal to.
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  await lib.fitWindow(app, page, { width: 1400, height: 650 })
  await inv('session:stop', alpha, claude.id)
  check('reflow: Hive writes its exit line', !!(await lib.until(async () => (await drawn()).includes('[process exited with code'), HUNG_MS)), await drawn())
  check('reflow: the terminal is fitted to the wide window', !!(await lib.until(fitted, HUNG_MS)), JSON.stringify(await state(writer.key)))
  const wide = (await state(writer.key)).cols
  const marker = Array.from({ length: wide }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
  await page.evaluate(([k, d]) => window.__hiveTerminalOutput(k, d), [writer.key, `${marker}\r\n`])
  // The narrowest window, with the Progress panel open.
  await lib.fitWindow(app, page, { width: 900, height: 650 })
  if (!(await page.locator('.progress-panel').count())) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'menu-command', command: 'progress.toggle', args: [] }))
  check('reflow: the Progress panel opens', !!(await lib.until(async () => (await page.locator('.progress-panel').count()) > 0, HUNG_MS)))
  check('reflow: the terminal narrows', !!(await lib.until(async () => (await state(writer.key)).cols < wide && (await fitted()), HUNG_MS)), JSON.stringify({ wide, now: await state(writer.key) }))
  check('reflow: the wide line and the exit line are whole after narrowing', !!(await lib.until(async () => { const t = await drawn(); return t.includes(marker) && t.includes('[process exited with code') }, HUNG_MS)), JSON.stringify({ wide, cols: (await state(writer.key)).cols, drawn: await drawn() }))
  await page.screenshot({ path: path.join(lib.WORK, 'termsize-reflow.png') })

  for (const a of [claude, codex]) await inv('session:stop', alpha, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
