// The Assistant panel's workspace section (#979): one line per project, its name, a state mark (#973) for each agent
// running or not running but stalled or waiting on the board, in the project's order, and how many run; "no agents
// running" and "no agents" for the rest. Each line stays one line inside the panel at its narrowest and widest, on the
// right and on the left (#158), in both themes and at 125% zoom, a long project name cut with "…". A mark's tooltip
// names the agent, its status and its provider; the section's toggle shows names beside the marks (remembered across a
// reload); clicking a mark focuses that agent, switching project. Dev build, throwaway profile and workspace, the fake
// Claude Code (two agents started); quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'assistantoverview-profile')
const ws = path.join(lib.WORK, 'assistantoverview-ws')
const claudeHome = path.join(lib.WORK, 'assistantoverview-claude-home')
const LONG = 'a-long-project-name-that-takes-most-of-the-panel'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  const alpha = path.join(ws, 'alpha')
  const beta = path.join(ws, 'beta')
  const long = path.join(ws, LONG)
  for (const p of [alpha, beta, long]) lib.gitProject(p)
  const claude = lib.fakeClaude(userData, claudeHome, [ws, alpha, beta, long])
  // Closing quits without asking, though agents run.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47934), ...claude, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    for (const p of [alpha, beta, long]) await inv('project:setActive', p, true)
    await lib.waitForProvider(inv)
    // alpha: Coder idle, Worker working, Parked not running with a card in Doing (stalled), Off not running (no mark).
    const a = {}
    for (const n of ['Coder', 'Worker', 'Parked', 'Off']) a[n] = await lib.addAgent(inv, alpha, { name: n })
    await lib.addAgent(inv, beta, { name: 'Resting' })
    for (const n of ['Coder', 'Worker']) await inv('session:start', alpha, { agentId: a[n].id })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    check('two agents start', !!(await lib.until(async () => (await live(a.Coder.id))?.status === 'ready' && (await live(a.Worker.id))?.status === 'ready', 45000)))
    check('Worker works', (await lib.sendPrompt(inv, lib.ptyKey(alpha, a.Worker.id), 'work 600', { submitted: async () => (await live(a.Worker.id))?.status === 'working' })) > 0)
    await inv('tasks:create', { title: 'Parked work', project: 'alpha', column: 'doing', agent: a.Parked.id })
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')

    const row = (name) => page.locator(`.assistant-project[data-project="${name}"]`)
    const marks = () => row('alpha').evaluate((r) => [...r.querySelectorAll('.assistant-agent')].map((m) => `${m.dataset.agent}:${m.dataset.state}`))
    const want = [`${a.Coder.id}:idle`, `${a.Worker.id}:working`, `${a.Parked.id}:stalled`]
    check('alpha: a mark for Coder (idle), Worker (working) and Parked (stalled), in the project’s order; none for Off', !!(await lib.until(async () => JSON.stringify(await marks()) === JSON.stringify(want), HUNG_MS)), JSON.stringify(await marks()))
    check('…each drawn by its shape (the state mark)', (await row('alpha').locator('.assistant-agent .state-mark.idle, .assistant-agent .state-mark.working, .assistant-agent .state-mark.stalled').count()) === 3)
    check('…and how many run', (await row('alpha').locator('.assistant-project-count').innerText()).trim() === '2 running')
    check('beta: “no agents running”', (await row('beta').locator('.assistant-marks').innerText()).trim() === 'no agents running')
    check(`${LONG}: “no agents”`, (await row(LONG).locator('.assistant-marks').innerText()).trim() === 'no agents')

    /** The panel at a width and side: set as saved preferences, then the page reloaded to take them. */
    const panelAt = async (width, side) => {
      await inv('ui:setPane', 'assistant', width)
      await inv('settings:update', { assistant: { panelSide: side } })
      await page.reload()
      await lib.appReady(page)
      if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
      await lib.until(async () => (await row('alpha').locator('.assistant-agent').count()) === 3, HUNG_MS)
    }
    /** Every project line: one line (its parts side by side), inside the panel; a long name cut with an ellipsis. */
    const geometry = () =>
      page.evaluate(() => {
        const panel = document.querySelector('.assistant-panel').getBoundingClientRect()
        return [...document.querySelectorAll('.assistant-project')].map((r) => {
          const box = r.getBoundingClientRect()
          const name = r.querySelector('.assistant-project-name')
          const parts = [...r.querySelectorAll('.assistant-project-name, .assistant-agent, .assistant-marks > .faint, .assistant-project-count')].map((x) => x.getBoundingClientRect())
          return {
            project: r.dataset.project,
            height: Math.round(box.height),
            oneLine: parts.every((p) => p.top >= box.top - 0.5 && p.bottom <= box.bottom + 0.5) && box.height <= 28,
            inside: parts.every((p) => p.left >= panel.left - 0.5 && p.right <= panel.right + 0.5),
            cut: name.scrollWidth > name.clientWidth,
            ellipsis: getComputedStyle(name).textOverflow === 'ellipsis'
          }
        })
      })
    const layoutOk = (g) => g.length === 3 && g.every((r) => r.oneLine && r.inside && r.ellipsis)
    for (const side of ['right', 'left'])
      for (const width of [300, 900]) {
        await panelAt(width, side)
        const g = await geometry()
        check(`panel on the ${side}, ${width} px: each project on one line, inside the panel`, layoutOk(g), JSON.stringify(g))
        if (width === 300) check('…narrowest: the long project name is cut with “…”', g.find((r) => r.project === LONG)?.cut === true, JSON.stringify(g))
      }
    await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'assistantoverview-left-900.png') })
    await panelAt(430, 'right')
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      check(`${theme} theme: the same layout`, layoutOk(await geometry()), JSON.stringify(await geometry()))
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
    await lib.until(async () => (await page.evaluate(() => window.devicePixelRatio)) >= 1.24, HUNG_MS)
    check('125%: the same layout', layoutOk(await geometry()), JSON.stringify(await geometry()))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    await lib.until(async () => (await page.evaluate(() => window.devicePixelRatio)) < 1.24, HUNG_MS)

    // A mark's tooltip: the agent, its status and its provider.
    const worker = row('alpha').locator(`.assistant-agent[data-agent="${a.Worker.id}"]`)
    const tip = await lib.hoverTip(page, worker, (t) => /Claude Code/.test(t), HUNG_MS)
    check('a mark’s tooltip names the agent, its status and its provider', /Worker: Working/.test(tip ?? '') && /Claude Code/.test(tip ?? ''), tip)
    check('…and screen readers get its name and status', ((await worker.getAttribute('aria-label')) ?? '').startsWith('Worker: Working'), await worker.getAttribute('aria-label'))
    await page.mouse.move(700, 600)
    await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'assistantoverview-marks.png') })

    // Names beside the marks: off by default, the toggle shows them, remembered across a reload.
    const toggle = page.locator('.assistant-names')
    check('names are on hover only by default', (await row('alpha').locator('.assistant-agent-name').count()) === 0 && (await toggle.getAttribute('aria-pressed')) === 'false')
    await toggle.click()
    check('the toggle shows each agent’s name beside its mark', !!(await lib.until(async () => JSON.stringify(await row('alpha').locator('.assistant-agent-name').allInnerTexts()) === JSON.stringify(['Coder', 'Worker', 'Parked']), HUNG_MS)))
    check('…on one line still', layoutOk(await geometry()), JSON.stringify(await geometry()))
    await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'assistantoverview-names.png') })
    await page.reload()
    await lib.appReady(page)
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    check('…remembered across a reload', !!(await lib.until(async () => (await row('alpha').locator('.assistant-agent-name').count()) === 3, HUNG_MS)))
    await page.locator('.assistant-names').click()
    check('…and the toggle hides them again', !!(await lib.until(async () => (await row('alpha').locator('.assistant-agent-name').count()) === 0, HUNG_MS)))

    // Clicking a mark focuses its agent, switching project.
    // beta first (its name in the section opens it), so the click must switch project.
    await row('beta').locator('.assistant-project-name').click()
    check('a project’s name opens it', !!(await lib.until(async () => (await page.locator('.pane-header-bar .agent-name', { hasText: 'Resting' }).count()) === 1, HUNG_MS)))
    await row('alpha').locator(`.assistant-agent[data-agent="${a.Parked.id}"]`).click()
    check('…clicking Parked’s mark opens alpha with Parked focused', !!(await lib.until(async () => (await page.locator('.pane-header-bar.focused .agent-name', { hasText: 'Parked' }).count()) === 1, HUNG_MS)), await page.locator('.pane-header-bar.focused').innerText().catch(() => 'none focused'))
  } finally {
    await app.close()
  }
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
