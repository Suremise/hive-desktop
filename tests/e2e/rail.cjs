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
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
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

  // Count badges and status dots stick out of the tiles: fully visible (outline included) inside the scrolling list,
  // and a badge clear of the dot of the tile above, at the zoom levels Hive offers and with a two-digit count.
  await page.evaluate(() => {
    document.querySelectorAll('.rail-project').forEach((t, i) => {
      const b = document.createElement('span')
      b.className = 'project-need-count'
      b.textContent = i === 1 ? '12' : '1'
      t.appendChild(b)
    })
  })
  for (const zoom of [1, 1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await sleep(400)
    const bad = await page.evaluate(() => {
      const list = document.querySelector('.rail-list').getBoundingClientRect()
      const out = (r, pad) => r.top - pad < list.top - 0.5 || r.bottom + pad > list.bottom + 0.5 || r.left - pad < list.left - 0.5 || r.right + pad > list.right + 0.5
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      const tiles = [...document.querySelectorAll('.rail-project')]
      const problems = []
      tiles.forEach((t, i) => {
        const badge = t.querySelector('.project-need-count').getBoundingClientRect()
        const dot = t.querySelector('.dot').getBoundingClientRect()
        // The 2px outline each has, in CSS pixels (zoom scales both alike).
        if (out(badge, 2)) problems.push(`badge ${i} clipped`)
        if (out(dot, 2) && i < 2) problems.push(`dot ${i} clipped`)
        if (i > 0) {
          const above = tiles[i - 1].querySelector('.dot').getBoundingClientRect()
          const grown = { left: above.left - 2, right: above.right + 2, top: above.top - 2, bottom: above.bottom + 2 }
          if (overlap({ left: badge.left - 2, right: badge.right + 2, top: badge.top - 2, bottom: badge.bottom + 2 }, grown)) problems.push(`badge ${i} on dot ${i - 1}`)
        }
      })
      return problems
    })
    check(`badges and dots fully visible and apart at ${zoom * 100}%`, bad.length === 0, JSON.stringify(bad))
    if (zoom === 1.5) await page.screenshot({ path: path.join(scratch, 'rail-badges-150.png'), clip: { x: 0, y: 0, width: 160, height: 320 } })
    if (zoom === 1) await page.screenshot({ path: path.join(scratch, 'rail-badges.png'), clip: { x: 0, y: 0, width: 120, height: 260 } })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await page.evaluate(() => document.querySelectorAll('.rail-project .project-need-count').forEach((b) => b.remove()))
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
