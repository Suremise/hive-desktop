// A running session's name in its agent's footer, which shows just its icon with the name in its tooltip and
// accessible name: the start time (yyyy-mm-dd hh:mm) until it has a name, renames from the footer and with /rename
// (the latest wins), a /rename made before a resume carried over, and the item staying an icon in a narrow pane. The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'sessionname-profile')
const ws = path.join(lib.WORK, 'sessionname-ws')
const claudeHome = path.join(lib.WORK, 'sessionname-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47898), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const key = lib.ptyKey(alpha, agent.id)
  /** Types a line in the agent's terminal; a prompt waits for its turn to end. */
  const type = async (text, prompt = true) => {
    await inv('pty:write', key, text)
    await lib.sleep(300)
    await inv('pty:write', key, '\r')
    if (!prompt) return
    await until(async () => (await live())?.status === 'finished', 15000)
  }
  const records = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'sessions.json'), 'utf8')).sessions
  const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  const st = await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 15000)))
  const header = page.locator('.pane-header-bar', { hasText: 'Writer' })
  const footer = page.locator('.agent-pane', { has: header }).locator('.pane-footer-bar')
  const tag = footer.locator('.session-tag')
  // The item is just its icon: its name is in its accessible name ("Session: <name>").
  const text = async () => ((await tag.count()) ? ((await tag.getAttribute('aria-label')) ?? '').replace(/^Session: /, '') : '')
  check('the name is in the footer, not the header', !!(await until(async () => (await tag.count()) === 1, 8000)) && (await header.locator('.session-tag').count()) === 0)
  // Hive's automatic name is "alpha · <date>": the footer shows only the start time.
  const auto = records().find((r) => r.id === st.sessionId)?.name ?? ''
  check('Hive named it automatically and passed that to Claude Code', auto.startsWith('alpha · ') && launches().at(-1).opts['--name'] === auto, auto)
  check('until it has a name, it is named by when it started, as yyyy-mm-dd hh:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await text()), await text())
  check('the footer shows just its icon', (await tag.innerText()).trim() === '' && (await tag.locator('.codicon').count()) === 1, await tag.innerText())
  await tag.hover()
  const tagTip = await until(async () => ((await page.locator('.tip').count()) ? await page.locator('.tip').innerText() : ''), 5000)
  check('its tooltip has the name and when it started, in the same format', tagTip.includes(await text()) && /Running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(tagTip), tagTip)
  await page.mouse.move(5, 5)
  // Settings → General → Date format and Time format: the automatic name follows them, here and in the Sessions tab;
  // Hive's own record of the name doesn't change.
  await inv('settings:update', { general: { dateFormat: 'dmy', timeFormat: '12h' } })
  const dmy = /^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/
  check('dd/mm/yyyy, 12-hour: the name follows', !!(await until(async () => dmy.test(await text()), 5000)), await text())
  const asShown = await text()
  await tag.click()
  const startRow = page.locator('.session-row.selected')
  check('…in the Sessions tab too', !!(await until(async () => (await startRow.innerText().catch(() => '')).includes(asShown), 8000)), await startRow.innerText().catch(() => ''))
  await startRow.locator('.session-row-when').hover()
  const whenTip = await until(async () => ((await page.locator('.tip').count()) ? await page.locator('.tip').innerText() : ''), 5000)
  check('…where "how long ago" has the date on hover, in the same format', /^Last active \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/.test(whenTip.trim()), whenTip)
  await page.mouse.move(5, 5)
  check("…and Hive's record of the name is unchanged", records().find((r) => r.id === st.sessionId)?.name === auto)
  // Exported, the title and timestamps follow the format too (the save dialog answered in main, to a test path).
  const exportFile = path.join(lib.WORK, 'sessionname-export.md')
  fs.rmSync(exportFile, { force: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, exportFile)
  await inv('transcript:export', alpha, st.sessionId, asShown)
  const md = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, 'utf8') : ''
  // (Each message's time is checked in core.test.ts: this session has none yet.)
  check('…in an export: its title and "exported from Hive"', md.startsWith(`# ${asShown}`) && /exported from Hive \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)/.test(md), md.slice(0, 300))
  // The Overview's session details: when it started and was last active.
  await page.keyboard.press('Alt+2')
  const startedCell = page.locator('tr', { has: page.locator('td', { hasText: /^Started$/ }) }).locator('td').nth(1)
  check("…in the Overview's session details", !!(await until(async () => dmy.test((await startedCell.innerText().catch(() => '')).trim()), 8000)), await startedCell.innerText().catch(() => ''))
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.sleep(400)
  await inv('settings:update', { general: { dateFormat: 'ymd', timeFormat: '24h' } })
  check('back to yyyy-mm-dd, 24-hour', !!(await until(async () => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await text()), 5000)), await text())
  await type('turn 1')
  const ctx = footer.locator('.pane-foot-item', { hasText: 'ctx' })
  check('it sits right, before the context', !!(await until(async () => (await ctx.count()) === 1, 8000)) && (await tag.boundingBox()).x < (await ctx.boundingBox()).x && (await tag.boundingBox()).x > (await footer.boundingBox()).width / 3)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-1-start.png') })

  // Right-click → Rename… in the footer.
  await tag.click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Rename…' }).click()
  const dialog = page.locator('[role=dialog]', { hasText: 'Rename session' })
  // The dialog fills in the current name just after it opens: typing before that would add to it.
  await until(async () => (await dialog.count()) === 1 && (await dialog.locator('input').inputValue()) !== '', 3000)
  await dialog.locator('input').fill('Docs pass')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  check('renamed from the footer', !!(await until(async () => (await text()) === 'Docs pass', 5000)), await text())
  const rec = () => records().find((r) => r.id === st.sessionId)
  check('Hive keeps the name, and what Claude Code called it then', rec().name === 'Docs pass' && rec().titleAtRename === auto, JSON.stringify(rec()))

  // /rename in Claude Code after it: the newer name wins.
  await type('/rename Guide only', false)
  check('a /rename after it wins', !!(await until(async () => (await text()) === 'Guide only', 10000)), await text())
  // The Sessions tab shows the same name.
  await tag.click()
  const row = page.locator('.session-row.selected')
  check('the Sessions tab shows it too', !!(await until(async () => /Guide only/.test(await row.innerText().catch(() => '')), 8000)), await row.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-2-sessions.png') })
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.sleep(500)

  // Renamed in Hive again: Hive's is the newer.
  await inv('session:rename', alpha, st.sessionId, 'Final docs')
  check('a Hive rename after that wins again', !!(await until(async () => (await text()) === 'Final docs', 5000)), await text())

  // A /rename, then the session stops and is resumed: Hive takes the name rather than passing its own back.
  await type('/rename Release notes', false)
  check('the /rename shows', !!(await until(async () => (await text()) === 'Release notes', 10000)), await text())
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)
  await inv('session:start', alpha, { agentId: agent.id, resumeId: st.sessionId })
  await until(async () => (await live())?.status === 'ready', 15000)
  check('resumed with the CLI name passed back', launches().at(-1).opts['--name'] === 'Release notes', launches().at(-1).opts['--name'])
  check('Hive keeps it as the session name', rec().name === 'Release notes', rec().name)
  check('and the footer still shows it', !!(await until(async () => (await text()) === 'Release notes', 8000)), await text())

  // Narrow, with a long name: still just the icon; the context stays whole.
  await inv('session:rename', alpha, st.sessionId, 'A rather long session name that cannot possibly fit in a narrow pane')
  await until(async () => /rather long/.test(await text()), 5000)
  await lib.fitWindow(app, page, { width: 760, height: 700 })
  await lib.sleep(800)
  const fits = (loc) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  check('a long name: still just the icon', (await tag.innerText()).trim() === '' && (await tag.boundingBox())?.width < 30, String((await tag.boundingBox())?.width))
  check('the context stays whole', await fits(ctx))
  check('the icon stays', (await tag.locator('.codicon').first().boundingBox())?.width > 0)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-3-narrow.png') })

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
