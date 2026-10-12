// The developer console's window (#637): hidden (no Help item, no palette entry, the shortcut does nothing, opening is
// refused) until Settings → Advanced → Show developer features is on; then Help → Developer Console opens it as a window
// of its own, whose page calls only the console's channels; picking a source shows a fake Claude Code's launch and hooks
// live, each event's raw payload beside what Hive made of it; event type, provider and search filter the list; pause
// holds it (new events counted) and resume fills it in; clear empties it; the shortcut brings the open window forward;
// it remembers its size; closing it ends capture; and turning the setting off closes it.
// Fake Claude Code; dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'consolewindow-profile')
const ws = path.join(lib.WORK, 'consolewindow-ws')
const claudeHome = path.join(lib.WORK, 'consolewindow-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47872))
// What the prompt says that must never reach the window.
const PRIVATE = 'walrus-lantern-pebble'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const consoles = () => app.windows().filter((w) => w.url().endsWith('#console'))
    const helpItems = async () => {
      await page.locator('.menubar-item', { hasText: 'Help' }).click()
      const items = await page.locator('.menu .menu-item span:nth-child(2)').allTextContents()
      await page.keyboard.press('Escape')
      return items
    }

    // --- Hidden while Show developer features is off.
    check('off: no Developer Console in the Help menu', !(await helpItems()).includes('Developer Console'))
    await page.keyboard.press('Control+Shift+P')
    const paletteInput = page.locator('.palette input')
    await paletteInput.fill('Developer')
    // Developer Tools shows for "Developer": the list has filtered by then.
    const paletteRows = await lib.until(async () => {
      const rows = await page.locator('.palette .palette-item').allTextContents()
      return rows.some((r) => r.includes('Toggle Developer Tools')) ? rows : null
    }, HUNG_MS)
    check('…nor in the command palette', !!paletteRows && !paletteRows.some((r) => r.includes('Developer Console')), JSON.stringify(paletteRows))
    // Escape clears what is typed, then closes it.
    await paletteInput.press('Escape')
    await lib.until(async () => (await paletteInput.inputValue()) === '', HUNG_MS)
    await paletteInput.press('Escape')
    await lib.until(async () => (await page.locator('.palette').count()) === 0, HUNG_MS)
    await page.keyboard.press('Control+Alt+J')
    const refused = await inv('console:open').then(
      () => null,
      (e) => e.message
    )
    check('…opening it is refused, and says where to turn it on', /Show developer features/.test(refused ?? ''), refused ?? 'opened')
    check('…and neither the shortcut nor the call opened a window', consoles().length === 0)

    // --- On in Settings → Advanced.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const toggle = page.getByRole('switch', { name: 'Show developer features' })
    await toggle.click()
    await lib.until(async () => (await inv('settings:get')).advanced?.showDeveloperFeatures === true, HUNG_MS)
    check('Settings → Advanced → Show developer features turns it on', (await toggle.getAttribute('aria-checked')) === 'true')
    check('…and Help lists Developer Console', (await helpItems()).includes('Developer Console'))

    // --- Help → Developer Console opens its own window.
    await page.locator('.menubar-item', { hasText: 'Help' }).click()
    await page.locator('.menu .menu-item', { hasText: 'Developer Console' }).click()
    const dc = await lib.until(() => consoles()[0] ?? null, HUNG_MS)
    check('Help → Developer Console opens a window of its own', !!dc && dc !== page)
    if (!dc) throw new Error('no console window')
    dc.on('pageerror', (e) => check('no console page errors', false, e.message))
    await dc.locator('.dc-source').waitFor({ timeout: HUNG_MS })
    const title = await lib.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).find((x) => x.startsWith('Developer Console — consolewindow-ws')) ?? null), HUNG_MS)
    check('…titled for its workspace', !!title, String(title))
    const outside = await dc.evaluate(() => window.hive.invoke('settings:update', { general: { userName: 'console-page' } }).then(() => 'allowed', (e) => e.message))
    check("…and its page may call only the console's channels", /Not allowed/.test(outside) && (await inv('settings:get')).general.userName !== 'console-page', outside)
    check('…watching nothing until a source is picked', (await dc.locator('.dc-live').textContent()).includes('Not watching') && (await inv('console:sources')).every((s) => !s.capturing))

    // --- The source picker: Hive, the Assistant, and the project's agent.
    const options = await lib.until(async () => {
      const o = await dc.locator('.dc-source option').evaluateAll((els) => els.map((e) => [e.value, e.textContent, e.parentElement.getAttribute('label')]))
      return o.some(([, t]) => t.startsWith('B1')) ? o : null
    }, HUNG_MS)
    check('the picker lists Hive, the Assistant and the project\'s agents', options?.some(([, t, g]) => t.startsWith('Hive') && g === 'Hive') && options.some(([, t]) => t.startsWith('Hive Assistant')) && options.some(([, t, g]) => t.startsWith('B1') && g === 'alpha'), JSON.stringify(options))
    const b1Option = options.find(([, t]) => t.startsWith('B1'))[0]
    await dc.locator('.dc-source').selectOption(b1Option)
    await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.capturing, HUNG_MS)
    check('picking B1 starts its capture, shown live', (await dc.locator('.dc-live').textContent()).includes('Live'))

    // --- B1's launch and hooks arrive, each with what Hive made of it.
    await inv('session:start', alpha, { agentId: b1.id })
    const rows = () => dc.locator('.dc-row').evaluateAll((els) => els.map((e) => ({ kind: e.dataset.kind, name: e.querySelector('.dc-name').textContent, summary: e.querySelector('.dc-summary').textContent })))
    const row = (pred) => lib.until(async () => (await rows()).find(pred), HUNG_MS)
    check('its launch shows', !!(await row((r) => r.kind === 'launch')))
    const start = await row((r) => r.name === 'SessionStart')
    check('SessionStart shows with its summary', !!start && start.summary.startsWith('SessionStart → start'), JSON.stringify(start))
    await dc.locator('.dc-row', { has: dc.locator('.dc-name', { hasText: 'SessionStart' }) }).first().click()
    const detail = dc.locator('.dc-detail')
    await detail.waitFor({ timeout: HUNG_MS })
    const raw = await detail.locator('.dc-raw').textContent()
    const made = await detail.locator('.dc-made').textContent()
    check('a picked event shows its raw payload beside what Hive made of it', raw.includes('hook_event_name') && raw.includes('"SessionStart"') && made.includes('event') && made.includes('"start"'), `${raw.slice(0, 200)} | ${made.slice(0, 200)}`)
    await dc.screenshot({ path: path.join(lib.WORK, 'consolewindow-detail.png') })
    await detail.locator('.icon-btn[aria-label="Close (Esc)"]').click()
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)

    // --- Filters: event type, provider and search.
    await dc.locator('.dc-kind[data-kind="hook"]').click()
    await lib.until(async () => (await rows()).every((r) => r.kind !== 'hook'), HUNG_MS)
    check('turning hooks off hides them', (await rows()).length > 0 && (await rows()).every((r) => r.kind !== 'hook'), JSON.stringify(await rows()))
    await dc.locator('.dc-kind[data-kind="hook"]').click()
    await lib.until(async () => (await rows()).some((r) => r.kind === 'hook'), HUNG_MS)
    const providers = await dc.locator('.dc-provider option').evaluateAll((els) => els.map((e) => e.value))
    check('the provider filter offers the events\' provider', providers.includes('claude-code'), JSON.stringify(providers))
    await dc.locator('.dc-provider').selectOption('claude-code')
    check('…and keeps its events', (await rows()).some((r) => r.name === 'SessionStart'))
    await dc.locator('.dc-provider').selectOption('')
    await dc.locator('.dc-search input').fill('SessionStart')
    await lib.until(async () => (await rows()).every((r) => r.name === 'SessionStart' || r.summary.includes('SessionStart')), HUNG_MS)
    check('search narrows the list to what matches', (await rows()).length >= 1 && (await rows()).every((r) => `${r.name} ${r.summary}`.includes('SessionStart')), JSON.stringify(await rows()))
    await dc.locator('.dc-search input').fill('')

    // --- Pause holds the list, counting what comes; resume fills it in.
    const before = (await rows()).length
    await dc.locator('.dc-pause').click()
    await lib.until(async () => (await dc.locator('.dc-live').textContent()).includes('Paused'), HUNG_MS)
    const key = lib.ptyKey(alpha, b1.id)
    await lib.sendPrompt(inv, key, `edit a.ts ${PRIVATE}`, { submitted: async () => /\(\d+ new\)/.test(await dc.locator('.dc-live').textContent()) })
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)
    const held = await dc.locator('.dc-live').textContent()
    await dc.screenshot({ path: path.join(lib.WORK, 'consolewindow-paused.png') })
    check('paused: the list holds, and the indicator counts what came', /Paused \(\d+ new\)/.test(held) && (await rows()).length === before, `${held}; ${(await rows()).length} vs ${before}`)
    await dc.locator('.dc-pause').click()
    const prompt = await row((r) => r.name === 'UserPromptSubmit')
    check('resume fills in what came while paused', !!prompt && (await rows()).some((r) => r.name === 'Stop') && (await dc.locator('.dc-live').textContent()).includes('Live'))
    check("the prompt's words reach no row", !JSON.stringify(await rows()).includes(PRIVATE))

    // --- Clear empties the list.
    await dc.locator('.dc-clear').click()
    // Only what came before it goes: a status line may arrive just after.
    const cleared = await lib.until(async () => ((await rows()).some((r) => r.name === 'UserPromptSubmit' || r.kind === 'launch') ? null : await rows()), HUNG_MS)
    check('clear empties the list', !!cleared && (await dc.locator('.dc-status').textContent()).includes('(cleared)'), JSON.stringify(cleared))

    // --- Size remembered; the shortcut brings the open window forward rather than opening another.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.setSize(900, 600))
    const saved = await lib.until(async () => {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      return c.consoleWindow?.width === 900 ? c.consoleWindow : null
    }, HUNG_MS)
    check('its size is remembered', saved?.height === 600, JSON.stringify(saved))
    await page.keyboard.press('Control+Alt+J')
    await inv('console:open')
    check('…the shortcut and Help open the same window, not another', consoles().length === 1)

    // --- Closing it ends capture; it opens again at its size.
    await dc.close()
    await lib.until(async () => (await inv('console:sources')).every((s) => !s.capturing && s.events === 0), HUNG_MS)
    check('closing it ends capture and keeps nothing', (await inv('console:sources')).every((s) => !s.capturing && s.events === 0))
    await page.keyboard.press('Control+Alt+J')
    const again = await lib.until(() => consoles()[0] ?? null, HUNG_MS)
    const size = await lib.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.getSize() ?? null), HUNG_MS)
    check('the shortcut opens it again, at its remembered size', !!again && size?.[0] === 900 && size[1] === 600, JSON.stringify(size))

    // --- Turning the setting off closes it and hides it again.
    await inv('settings:update', { advanced: { showDeveloperFeatures: false } })
    await lib.until(() => consoles().length === 0, HUNG_MS)
    check('turning developer features off closes the console', consoles().length === 0)
    check('…and hides it from Help again', !(await helpItems()).includes('Developer Console'))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
    await app.windows()[0]?.screenshot({ path: path.join(lib.WORK, 'consolewindow-failed.png') }).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
