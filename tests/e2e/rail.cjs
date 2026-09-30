// Compact Projects sidebar: toggle, snap by dragging, persistence, tooltips, context menu.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'rail-profile')
const ws = path.join(scratch, 'rail-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
for (const n of ['hive', 'web-dashboard', 'apiServer', 'notes']) fs.mkdirSync(path.join(ws, n), { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  lib.enableProviders(userData)
  const env = { ...process.env, HIVE_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1300, height: 800 }).catch(() => {})
  await sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws); await sleep(800)
  await inv('project:setActive', path.join(ws, 'hive'), true)
  await inv('project:setActive', path.join(ws, 'web-dashboard'), true); await sleep(800)
  const sbWidth = () => page.locator('.sidebar').first().evaluate((e) => Math.round(e.getBoundingClientRect().width))

  check('starts full', (await sbWidth()) === 280 && (await page.locator('.rail').count()) === 0)
  await page.locator('.pane-header .icon-btn[aria-label^="Compact Sidebar"]').first().click(); await sleep(400)
  check('button compacts', (await sbWidth()) === 48 && (await page.locator('.rail').count()) === 1, `(${await sbWidth()})`)
  const labels = await page.locator('.rail-initials').allTextContents()
  check('initials', JSON.stringify(labels) === JSON.stringify(['Hi', 'WD', 'AS', 'No']), JSON.stringify(labels))
  check('separator between active and other', (await page.locator('.rail-sep').count()) === 1)
  check('saved', (await inv('ui:get')).sidebarCompact === true)

  await page.locator('.rail-project').nth(1).click(); await sleep(500)
  check('click selects project', await page.locator('.rail-project').nth(1).evaluate((e) => e.classList.contains('selected')))
  await page.locator('.rail-project').nth(0).hover(); await sleep(700)
  const tip = await page.locator('.tip').first().textContent().catch(() => '')
  check('tooltip shows name and status', /hive/.test(tip) && /No session/.test(tip), JSON.stringify(tip))
  await page.screenshot({ path: path.join(scratch, 'rail-1-tip.png') })
  await page.mouse.move(700, 400)
  await page.locator('.rail-project').nth(0).click({ button: 'right' }); await sleep(300)
  check('context menu', await page.getByText('Resume Last Session').first().isVisible())
  await page.keyboard.press('Escape'); await sleep(200)

  // Other panels stay full width while compact is on
  await page.locator('.activity-btn[aria-label="Shared Notes"]').click(); await sleep(400)
  check('notes full width', (await sbWidth()) === 280)
  await page.locator('.activity-btn[aria-label="Projects"]').click(); await sleep(400)
  check('back to rail', (await sbWidth()) === 48)

  // Drag out restores; drag in snaps
  const drag = async (dx) => {
    const b = await page.locator('.sidebar-resizer').boundingBox()
    const x = b.x + b.width / 2, y = b.y + 300
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 4 }); await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up(); await sleep(400)
  }
  await drag(250)
  check('drag out expands', (await sbWidth()) === 298 && (await inv('ui:get')).sidebarCompact === false, `(${await sbWidth()})`)
  await drag(-230)
  check('drag in snaps to rail', (await sbWidth()) === 48 && (await inv('ui:get')).sidebarCompact === true, `(${await sbWidth()})`)

  // Keyboard shortcut
  await page.keyboard.press('Control+Alt+B'); await sleep(400)
  check('Ctrl+Alt+B expands to the earlier width', (await sbWidth()) === 298, `(${await sbWidth()})`)
  await page.keyboard.press('Control+Alt+B'); await sleep(400)
  check('Ctrl+Alt+B compacts', (await sbWidth()) === 48)

  // Persists across reload
  await page.reload(); await sleep(2500)
  check('kept after reload', (await sbWidth()) === 48)
  await page.screenshot({ path: path.join(scratch, 'rail-2.png') })
  await page.locator('.rail-btn[aria-label="Expand Sidebar"]').click(); await sleep(400)
  check('expand button', (await sbWidth()) > 200)
  await page.screenshot({ path: path.join(scratch, 'rail-3-full.png') })

  // Light theme look
  await page.keyboard.press('Control+Alt+B'); await sleep(300)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' }); await sleep(300)
  await page.screenshot({ path: path.join(scratch, 'rail-4-light.png') })

  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
