// Dragging agents swaps panes (#135), with Playwright's mouse as a person drags: a pane dropped on another pane swaps
// the two (running or stopped), in a fresh window and after clicking agents into panes (what failed before, when a
// stored pane arrangement won over the order); the strip inserts like browser tabs; holding a dragged agent over a
// page button switches to that page, to drop it on a pane there (the swap crosses pages); a drop on a page button
// moves it to that page's last place; a drop on an empty pane moves it there. After every step the panes show the
// agents in their saved order. Four agents in three columns (pages abc | d); one runs the fake Claude Code
// (fake-claude/) and keeps its session throughout. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'swap-profile')
const ws = path.join(lib.WORK, 'swap-ws')
const claudeHome = path.join(lib.WORK, 'swap-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47885), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const saved = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8')).agents.map((a) => a.name)
  const paneNames = async () => (await page.locator('.pane-header-bar .agent-name').allInnerTexts()).map((t) => t.trim())
  const activePage = async () => Number((await page.locator('.page-switch button.active').innerText().catch(() => '1')).trim())
  // The panes show the saved order: the page on screen holds agents (page − 1)·3 … +3.
  const matches = async () => {
    const order = saved()
    const p = await activePage()
    return JSON.stringify(await paneNames()) === JSON.stringify(order.slice((p - 1) * 3, p * 3))
  }
  const settle = async (want) => lib.until(async () => saved().join(',') === want && (await matches()), 8000)
  const at = async (loc) => {
    const b = await loc.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  // A native drag with the mouse: press, a small first move (so the drag starts), over each stop in turn (holding
  // there `hold` ms), and release.
  const drag = async (from, stops, hold = 150) => {
    const a = await at(from)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(a.x + 8, a.y, { steps: 3 })
    await lib.sleep(150)
    for (const s of stops) {
      const b = typeof s === 'function' ? await at(await s()) : await at(s)
      await page.mouse.move(b.x, b.y, { steps: 8 })
      await lib.sleep(hold)
      await page.mouse.move(b.x + 1, b.y, { steps: 2 })
      await lib.sleep(typeof s === 'function' ? 100 : hold)
    }
    await page.mouse.up()
    await lib.sleep(400)
  }
  const header = (n) => page.locator('.pane-header-bar', { hasText: n }).locator('.agent-name')
  const pane = (n) => page.locator('.agent-pane', { has: page.locator('.pane-header-bar', { hasText: n }) })
  const tab = (n) => page.locator('.agent-tab', { hasText: n })

  await page.getByText('alpha', { exact: true }).first().click()
  const agents = []
  for (const name of ['One', 'Two', 'Three', 'Four']) agents.push(await lib.addAgent(inv, alpha, { name }))
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  await inv('workspace:refresh')
  const one = agents[0]
  await inv('session:start', alpha, { agentId: one.id })
  await lib.until(async () => (await live(one.id))?.status === 'ready', 15000)
  const session = (await live(one.id)).sessionId
  check('four agents in three columns: One, Two, Three on page 1', !!(await settle('One,Two,Three,Four')), JSON.stringify(await paneNames()))

  // --- A fresh window: One (running) dropped on Three's pane (stopped): they swap.
  await drag(header('One'), [pane('Three')])
  check('a pane dropped on another swaps them (running and stopped)', !!(await settle('Three,Two,One,Four')), `${saved()} / ${await paneNames()}`)
  check('the running agent kept its session', (await live(one.id))?.sessionId === session)
  check('the drag has ended: no drop targets left', (await page.locator('.pane-drop').count()) === 0)

  // --- After clicking agents into panes (the case that failed): click them, then drag Two's tab onto One's pane.
  for (const n of ['Four', 'Two', 'One']) {
    await tab(n).click()
    await lib.sleep(250)
  }
  await drag(tab('Two'), [pane('One')])
  check('after clicking agents: a tab dropped on a pane swaps them too', !!(await settle('Three,One,Two,Four')), `${saved()} / ${await paneNames()}`)

  // --- No drop target on its own pane; a drop there does nothing.
  await drag(header('Three'), [pane('Three')])
  check('dropping an agent on its own pane does nothing', !!(await settle('Three,One,Two,Four')), saved().join(','))

  // --- The strip inserts, like browser tabs: Four's tab dropped on Three's left half goes first.
  const three = await tab('Three').boundingBox()
  const a = await at(tab('Four'))
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(a.x + 8, a.y, { steps: 3 })
  await lib.sleep(150)
  await page.mouse.move(three.x + 4, three.y + three.height / 2, { steps: 10 })
  await lib.sleep(150)
  await page.mouse.up()
  check('the strip inserts: Four before Three, the panes follow', !!(await settle('Four,Three,One,Two')), `${saved()} / ${await paneNames()}`)

  // --- Hold over a page button to switch, then drop on a pane there: the swap crosses pages. From page 2 (Two), its
  // own pane header dragged (it leaves the screen when page 1 shows), held over "1", dropped on Three's pane.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await activePage()) === 2, 5000)
  check('page 2 shows Two', JSON.stringify(await paneNames()) === '["Two"]', JSON.stringify(await paneNames()))
  await drag(header('Two'), [page.locator('.page-switch button[aria-label="Agent page 1"]'), () => pane('Three')], 900)
  check('holding over page 1 showed it, and the drop swapped across pages', !!(await settle('Four,Two,One,Three')), `${saved()} / ${await paneNames()} / page ${await activePage()}`)
  check('the drag has ended after its source left the screen', !!(await lib.until(async () => (await page.locator('.pane-drop').count()) === 0, 3000)))

  // --- Escape after the hover switched pages (the dragged pane has left the screen), released without moving: the drag
  // ends at once, nothing moves, nothing restarts.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await activePage()) === 2, 5000)
  const before = saved().join(',')
  const s = await at(header('Three'))
  await page.mouse.move(s.x, s.y)
  await page.mouse.down()
  await page.mouse.move(s.x + 8, s.y, { steps: 3 })
  await lib.sleep(150)
  const p1 = await at(page.locator('.page-switch button[aria-label="Agent page 1"]'))
  await page.mouse.move(p1.x, p1.y, { steps: 8 })
  await lib.sleep(150)
  await page.mouse.move(p1.x + 1, p1.y, { steps: 2 })
  check('held over page 1, it shows (the dragged pane is gone)', !!(await lib.until(async () => (await activePage()) === 1, 3000)) && (await page.locator('.pane-drop').count()) === 3)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await lib.sleep(400)
  check('Escape ends the drag at once: no drop targets or drag marks left', (await page.locator('.pane-drop').count()) === 0 && (await page.locator('.agent-tab.dragging, .page-switch button.drop-target').count()) === 0, `${await page.locator('.pane-drop').count()} drop targets`)
  check('…and nothing moved', saved().join(',') === before && (await matches()), `${saved()} vs ${before}`)
  check('…and One still runs its session', (await live(one.id))?.sessionId === session)
  // A drop outside any target (the project header) cancels too.
  await drag(tab('One'), [page.locator('.project-header h1')])
  check('a drop outside the targets moves nothing and leaves no drop targets', saved().join(',') === before && (await page.locator('.pane-drop').count()) === 0, `${saved()} / ${await page.locator('.pane-drop').count()}`)

  // --- A drop on a page button: to that page's last place (Four, from page 1, to page 2's end).
  await drag(tab('Four'), [page.locator('.page-switch button[aria-label="Agent page 2"]')])
  check("a drop on a page button moves the agent to that page's last place", !!(await lib.until(async () => saved().join(',') === 'Two,One,Three,Four', 8000)), saved().join(','))
  check('the panes still follow the order', !!(await lib.until(matches, 5000)), `${saved()} / ${await paneNames()}`)

  // --- A drop on an empty pane (page 2 has one agent and two spare panes): the agent moves there, the end.
  await page.locator('.page-switch button[aria-label="Agent page 2"]').click()
  await lib.until(async () => (await activePage()) === 2, 5000)
  await drag(tab('Two'), [page.locator('.agent-pane:not(:has(.pane-header-bar))').last()])
  check('a drop on an empty pane moves the agent there', !!(await settle('One,Three,Four,Two')), `${saved()} / ${await paneNames()}`)
  await page.screenshot({ path: path.join(lib.WORK, 'swap-done.png') })
  check('One still runs its own session', (await live(one.id))?.sessionId === session)

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
