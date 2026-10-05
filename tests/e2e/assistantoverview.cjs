// The Assistant panel's workspace overview (#240): each project's agents are listed under its name, left-aligned with a
// fixed indent, at the panel's narrowest and widest, on the right and on the left (#158), at 100% and 125% zoom, in both
// themes; an agent's long status is cut with an ellipsis inside the panel, and an empty project says "no agents". Dev
// build, throwaway profile and workspace, the fake Claude Code (agents added, never started); quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistantoverview-profile')
const ws = path.join(lib.WORK, 'assistantoverview-ws')
const INDENT = 14
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const p of ['alpha', 'beta']) lib.gitProject(path.join(ws, p))
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'assistantoverview-claude-home'), [ws])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47934), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const alpha = path.join(ws, 'alpha')
  const beta = path.join(ws, 'beta')
  for (const p of [alpha, beta]) await inv('project:setActive', p, true).catch(() => undefined)
  await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer with a rather long name' })
  await inv('workspace:refresh')

  /** The panel at a width and side: set as saved preferences, then the page reloaded to take them. */
  const panelAt = async (width, side) => {
    await inv('ui:setPane', 'assistant', width)
    await inv('settings:update', { assistant: { panelSide: side } })
    await page.reload()
    await lib.appReady(page)
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    await lib.until(async () => (await page.locator('.assistant-project', { hasText: 'alpha' }).count()) === 1, 10000)
  }
  /** Where alpha's name and agents are, and beta's "no agents", relative to the panel. */
  const geometry = () =>
    page.evaluate(() => {
      const panel = document.querySelector('.assistant-panel').getBoundingClientRect()
      const block = [...document.querySelectorAll('.assistant-project')].find((b) => b.querySelector('.assistant-project-name')?.textContent.trim() === 'alpha')
      const name = block.querySelector('.assistant-project-name').getBoundingClientRect()
      const agents = [...block.querySelectorAll('.assistant-agent')].map((a) => a.getBoundingClientRect())
      const empty = [...document.querySelectorAll('.assistant-project')].find((b) => b.textContent.includes('beta'))?.querySelector('.assistant-agents')
      return {
        panel: { left: panel.left, right: panel.right, width: panel.width },
        name: { left: name.left, bottom: name.bottom },
        agents: agents.map((a) => ({ left: a.left, right: a.right, top: a.top })),
        emptyText: empty?.textContent.trim() ?? null,
        // The words themselves (the list's box starts before its padding).
        emptyLeft: empty?.querySelector('.faint')?.getBoundingClientRect().left ?? null
      }
    })
  const layoutOk = (g) =>
    g.agents.length === 2 &&
    g.agents.every((a) => Math.abs(a.left - g.name.left - INDENT) <= 1.5 && a.top >= g.name.bottom - 1 && a.right <= g.panel.right + 0.5) &&
    g.emptyText === 'no agents' &&
    Math.abs(g.emptyLeft - g.name.left - INDENT) <= 1.5

  for (const side of ['right', 'left'])
    for (const width of [300, 900]) {
      await panelAt(width, side)
      const g = await geometry()
      check(`panel on the ${side}, ${width} px: agents under alpha, ${INDENT} px in, inside the panel`, layoutOk(g), JSON.stringify(g))
      if (width === 900) check(`…on the ${side} at its widest, not halfway across: the agents start near the panel's left edge`, g.agents[0].left - g.panel.left < 60, JSON.stringify(g))
      await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, `assistantoverview-${side}-${width}.png`) })
    }
  // Light theme, and 125% zoom (indent in CSS pixels, so 14 at any zoom).
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  check('light theme: the same layout', layoutOk(await geometry()))
  await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'assistantoverview-left-900-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
  await lib.sleep(400)
  check('125%: the same layout', layoutOk(await geometry()), JSON.stringify(await geometry()))
  await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'assistantoverview-125.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
