// A project's tab strip at every width: all twelve tabs labelled while they fit; icons with the active tab's label when
// they don't (switching back only with a little room to spare, so it doesn't flicker); icons only, scrolling with the
// active tab in view, when even that doesn't fit. No tab is ever cut off unless the strip scrolls, at the window's
// minimum width too; icon-only tabs keep their name (tooltip and accessible label) and order, and dragging files over
// the Session tab still switches to it. Light and dark screenshots. The agent runs the fake Claude Code (fake-claude/).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'tabstrip-profile')
const ws = path.join(lib.WORK, 'tabstrip-ws')
const claudeHome = path.join(lib.WORK, 'tabstrip-claude-home')
const alpha = path.join(ws, 'alpha')
const LABELS = ['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Images', 'Changes', 'Memory', 'Skills', 'MCP', 'Settings']
const SPARE = 12
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

  const HEIGHT = 800
  let viewport = 1500
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47914), CLAUDE_CONFIG_DIR: claudeHome }, viewport: { width: viewport, height: HEIGHT } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const strip = page.locator('.tabs')
  await strip.waitFor()

  /** The strip's fit, width, and everything wrong with it for that fit. */
  const inspect = () =>
    strip.evaluate((s, labels) => {
      const box = s.getBoundingClientRect()
      const tabs = [...s.querySelectorAll('.tab')]
      const bad = []
      const fit = s.dataset.fit
      const active = s.querySelector('.tab.active')
      const shown = (t) => t.querySelector('.tab-label').getBoundingClientRect().width > 2
      if (tabs.length !== labels.length) bad.push(`${tabs.length} tabs`)
      tabs.forEach((t, i) => {
        // Same order, and each keeps its name for screen readers whether or not it shows.
        if (t.querySelector('.tab-label')?.textContent !== labels[i]) bad.push(`tab ${i} is ${t.textContent}`)
        if (t.getBoundingClientRect().height !== tabs[0].getBoundingClientRect().height) bad.push(`${labels[i]} has another height`)
        const iconOnly = t.classList.contains('icon-only')
        const want = fit === 'all-icons' || (fit === 'icons' && t !== active)
        if (iconOnly !== want || shown(t) === iconOnly) bad.push(`${labels[i]}: ${iconOnly ? 'icon' : 'label'} (${shown(t) ? 'shown' : 'hidden'}) in ${fit}`)
      })
      const scrolls = s.scrollWidth > s.clientWidth
      if (fit !== 'all-icons') {
        if (scrolls) bad.push(`scrolls in ${fit}: ${s.scrollWidth} > ${s.clientWidth}`)
        for (const t of tabs) {
          const r = t.getBoundingClientRect()
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) bad.push(`${t.textContent} cut off`)
        }
      }
      // The active tab is always wholly in view.
      const a = active.getBoundingClientRect()
      if (a.left < box.left - 0.5 || a.right > box.right + 0.5) bad.push('the active tab is out of view')
      const measured = [...document.querySelectorAll('.tabs-measure .tab-m')].map((m) => m.getBoundingClientRect().width)
      const sum = (sizes) => Math.ceil(sizes.reduce((x, y) => x + y, 0))
      return { fit, width: s.clientWidth, scrolls, bad, active: active.textContent.trim(), labelsNeed: sum(measured.filter((_, i) => i % 2 === 0)), iconsNeed: sum(measured.filter((_, i) => i % 2 === 1)) }
    }, LABELS)
  /** Sizes the page so the strip is `target` CSS pixels wide (Playwright's viewport, which can go below the window's minimum). */
  const widthTo = async (target) => {
    for (let i = 0; i < 8; i++) {
      const w = (await inspect()).width
      if (w === target) return true
      viewport = Math.max(200, viewport + target - w)
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      await lib.sleep(120)
    }
    return (await inspect()).width === target
  }
  const expectFit = async (what, fit) => {
    await lib.sleep(150)
    const r = await inspect()
    check(`${what}: ${fit}, nothing cut off`, r.fit === fit && !r.bad.length, `${r.fit} at ${r.width}px; ${r.bad.join('; ')}`)
    return r
  }
  const shot = (file) => page.screenshot({ path: path.join(lib.WORK, file), clip: { x: 0, y: 0, width: viewport, height: 140 } })

  // --- Wide: every tab labelled.
  const wide = await expectFit('1500 px window', 'labels')
  await shot('tabstrip-1-labels.png')
  const { labelsNeed } = wide

  // --- The switching point, both ways: labels at exactly their width, icons one pixel under, and back only with room to spare.
  check(`strip sized to ${labelsNeed}px`, await widthTo(labelsNeed))
  await expectFit(`exactly the labels' width (${labelsNeed}px)`, 'labels')
  check(`strip sized to ${labelsNeed - 1}px`, await widthTo(labelsNeed - 1))
  await expectFit('one pixel short', 'icons')
  check('the active tab (Session) keeps its label', (await inspect()).active === 'Session')
  await widthTo(labelsNeed)
  await expectFit('back to the labels\' width: no flicker, still', 'icons')
  await widthTo(labelsNeed + SPARE - 1)
  await expectFit('still short of the spare room', 'icons')
  await widthTo(labelsNeed + SPARE)
  await expectFit('with room to spare', 'labels')

  // --- Icons, another tab active: it takes the label, Session gives it up; its tooltip names it with its shortcut.
  await widthTo(Math.round(labelsNeed * 0.75))
  await expectFit('three quarters of the labels\' width', 'icons')
  await page.locator('.tabs .tab', { hasText: 'Performance' }).click()
  const perf = await expectFit('Performance active', 'icons')
  check('Performance has the label now', perf.active === 'Performance', perf.active)
  await shot('tabstrip-2-icons-dark.png')
  await page.locator('.tabs .tab', { hasText: 'Changes' }).hover()
  const tip = page.locator('.tip')
  check('an icon-only tab\'s tooltip names it', !!(await lib.until(async () => ((await tip.textContent().catch(() => '')) ?? '').startsWith('Changes'), 3000)), await tip.textContent().catch(() => ''))
  await page.mouse.move(5, 500)
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await shot('tabstrip-3-icons-light.png')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- Icons only: the active label doesn't fit either; then not even the icons, so it scrolls with the active tab in view.
  const { iconsNeed } = await inspect()
  await widthTo(iconsNeed + 20)
  await expectFit(`${iconsNeed + 20}px: room for the icons but not Performance's label`, 'all-icons')
  await page.locator('.tabs .tab', { hasText: 'Settings' }).click()
  await widthTo(Math.round(iconsNeed * 0.6))
  const narrow = await expectFit('too narrow even for the icons, Settings active', 'all-icons')
  check('the strip scrolls', narrow.scrolls)
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().evaluate((t) => t.click())
  await expectFit('Session active (clicked off screen)', 'all-icons')
  check('Session is scrolled into view', (await inspect()).active === 'Session' && !(await inspect()).bad.length)
  await shot('tabstrip-4-scrolls.png')

  // --- Wider again: labels back.
  viewport = 1500
  await page.setViewportSize({ width: viewport, height: HEIGHT })
  await expectFit('1500 px again', 'labels')

  // --- The window at its minimum width, sidebar shown: all twelve tabs on screen, with no scrolling.
  const [minW] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
  check('the window has a minimum width', minW > 0, String(minW))
  viewport = minW
  await lib.fitWindow(app, page, { width: minW, height: HEIGHT })
  const atMin = await expectFit(`the window's minimum width (${minW}px)`, 'icons')
  check('no tab is off screen at the minimum width', !atMin.scrolls)
  await shot('tabstrip-5-minimum.png')
  // Hiding the sidebar there gives the strip more room, and the labels if they fit in it.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+B')
  await lib.until(async () => (await inspect()).width > atMin.width, 3000)
  const noSidebar = await inspect()
  await expectFit(`sidebar hidden at the minimum width (${noSidebar.width}px)`, noSidebar.width >= labelsNeed ? 'labels' : 'icons')
  await page.keyboard.press('Control+B')
  await lib.until(async () => (await inspect()).width === atMin.width, 3000)
  await expectFit('sidebar shown again', 'icons')

  // --- Dragging files over the (icon-only) Session tab switches to it while an agent runs.
  await lib.addAgent(inv, alpha, { name: 'One' })
  await inv('session:start', alpha, {})
  check('the agent starts', !!(await lib.until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.status === 'ready'), 20000)))
  await page.locator('.tabs .tab', { hasText: 'Files' }).click()
  await expectFit('Files active', 'icons')
  await page.locator('.tabs .tab').first().evaluate((t) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'drop.txt', { type: 'text/plain' }))
    t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  check('dragging files over the icon-only Session tab switches to it', !!(await lib.until(async () => (await inspect()).active === 'Session', 3000)), (await inspect()).active)

  await inv('session:stop', alpha).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
