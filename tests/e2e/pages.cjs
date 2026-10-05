// Agent pages (#134): one layout for the project, and a page holds as many agents as the layout has panes, so pages
// = agents ÷ panes. Automatic until chosen (up to a 3×2 grid, then pages of six). 4 agents in three columns are two
// pages (the 4th alone on page 2); 6 in a grid of four are two; one at a time has no page buttons; switching the layout
// changes the pages at once; the last page's spare panes are empty; up to twelve agents.
// Dev build, throwaway profile and workspace; no sessions are started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'pages-profile')
const ws = path.join(lib.WORK, 'pages-ws')
const proj = path.join(ws, 'crowd')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1600, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('crowd', { exact: true }).first().click()
  await lib.sleep(500)
  // Panes on screen, and the agents in them (an empty pane has no header).
  const panes = () => page.locator('.agent-pane').count()
  const shown = async () => (await page.locator('.pane-header-bar .agent-name').allInnerTexts()).map((t) => t.trim()).join(',')
  const buttons = () => page.locator('.page-switch button').count()
  const active = async () => (await page.locator('.page-switch button.active').innerText().catch(() => '')).trim()
  const add = async (n) => {
    for (let i = 0; i < n; i++) await inv('agents:add', proj, { location: 'project', provider: 'claude-code' })
    await inv('workspace:refresh')
    await lib.sleep(600)
  }
  const cfg = async () => (await inv('workspace:refresh')).projects[0].config
  const choose = async (label) => {
    await page.locator(`.layout-switch button[aria-label="${label}"]`).click()
    await lib.until(async () => (await page.locator(`.layout-switch button.active[aria-label="${label}"]`).count()) === 1, 5000)
    await lib.sleep(300)
  }
  const go = async (n) => {
    await page.locator(`.page-switch button[aria-label="Agent page ${n}"]`).click()
    await lib.until(async () => (await active()) === String(n), 5000)
  }

  // Four agents in three columns: two pages, the fourth alone on page 2 (beside two empty panes).
  await add(4)
  check('four agents: a grid of four, automatically, one page', (await panes()) === 4 && (await buttons()) === 0 && (await cfg()).layout === 'auto')
  await choose('Three columns')
  check('four agents in three columns: two page buttons, at once', (await buttons()) === 2, String(await buttons()))
  check('page 1 shows agents 1–3', (await shown()) === 'Agent 1,Agent 2,Agent 3', await shown())
  check('the strip marks where page 2 starts', (await page.locator('.agent-tab[data-page-start]', { hasText: 'Agent 4' }).count()) === 1)
  await go(2)
  check('page 2 has the fourth agent, its spare panes empty', (await shown()) === 'Agent 4' && (await panes()) === 3, `${await shown()} / ${await panes()}`)
  check('saved as the project layout', (await cfg()).layout === 'columns3', JSON.stringify(await cfg()))
  await page.screenshot({ path: path.join(lib.WORK, 'pages-1-columns3.png') })

  // Six agents in a grid of four: two pages (4 + 2).
  await add(2)
  await choose('Grid of four')
  check('six agents in a grid of four: two pages', (await buttons()) === 2, String(await buttons()))
  await go(1)
  check('page 1: agents 1–4', (await shown()) === 'Agent 1,Agent 2,Agent 3,Agent 4', await shown())
  await go(2)
  check('page 2: agents 5 and 6', (await shown()) === 'Agent 5,Agent 6' && (await panes()) === 4, `${await shown()} / ${await panes()}`)
  // A fresh hover (the tooltip hides on the click that went to page 2).
  await page.mouse.move(0, 0)
  await page.locator('.page-switch button[aria-label="Agent page 2"]').hover()
  const tipText = async () => (await page.locator('.tip').first().textContent({ timeout: 500 }).catch(() => '')) ?? ''
  check('the page button names its agents', !!(await lib.until(async () => (await tipText()).startsWith('Page 2: agents 5–6'), 3000)), await tipText())
  await page.mouse.move(0, 0)
  // One at a time: no page buttons, the focused agent shown; clicking a tab shows that agent.
  await choose('One at a time')
  check('one at a time: no page buttons, one pane', (await buttons()) === 0 && (await panes()) === 1, `${await buttons()} / ${await panes()}`)
  await page.locator('.agent-tab', { hasText: 'Agent 2' }).click()
  await lib.until(async () => (await shown()) === 'Agent 2', 5000)
  check('a tab shows its agent', (await shown()) === 'Agent 2', await shown())
  // The one that shows them all (six: a 3×2 grid) is automatic again.
  await choose('Grid of six')
  check('six agents in the grid of six: one page, saved as automatic', (await buttons()) === 0 && (await panes()) === 6 && (await cfg()).layout === 'auto', JSON.stringify((await cfg()).layout))

  // The seventh (added here) opens page 2 of the automatic grid, with a note about memory.
  await page.locator('.agent-add:not(.split-caret)').click()
  await lib.until(async () => (await active()) === '2', 10000)
  check('the seventh agent opens page 2', (await active()) === '2')
  check('page 2 shows it, its spare panes empty', (await shown()) === 'Agent 7' && (await panes()) === 6, `${await shown()} / ${await panes()}`)
  check('a note on what seven agents cost', (await page.locator('.toast', { hasText: '7 agents in this project' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-2-page2.png') })
  await page.keyboard.press('Control+Alt+PageUp')
  await lib.until(async () => (await active()) === '1', 5000)
  check('Ctrl+Alt+PageUp: page 1, its six', (await active()) === '1' && (await shown()).split(',').length === 6)
  await page.keyboard.press('Control+Alt+PageDown')
  await lib.until(async () => (await active()) === '2', 5000)
  await add(1)
  check('Ctrl+Alt+PageDown: page 2, which grows as agents are added', (await active()) === '2' && (await shown()) === 'Agent 7,Agent 8', await shown())
  // Clicking an agent on the other page goes to that page.
  await page.locator('.agent-tab', { hasText: 'Agent 3' }).click()
  await lib.until(async () => (await active()) === '1', 5000)
  check('clicking an agent on page 1 goes there', (await active()) === '1')

  // Twelve is the most.
  await add(4)
  const n = (await inv('workspace:refresh')).projects[0].agents.length
  check('twelve agents', n === 12, String(n))
  await go(2)
  check('page 2 is a full 3×2 grid too', (await shown()).split(',').length === 6)
  const refused = await inv('agents:add', proj, { location: 'project', provider: 'claude-code' }).then(() => '', (e) => String(e.message ?? e))
  check('a thirteenth is refused', /up to 12 agents/.test(refused), refused)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-3-twelve.png') })

  // Removing the focused agent on page 2 stays on page 2 (the next agent takes focus) until page 2 empties.
  const remove = async (name) => {
    await page.locator('.agent-tab', { hasText: name }).click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Remove Agent…' }).click()
    await page.locator('.dialog-footer button', { hasText: /^Remove$/ }).click()
    // Gone from Hive and from the strip (the dialog closes before the removal has finished).
    await lib.until(async () => !(await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === name) && !(await page.locator('.agent-tab').allInnerTexts()).some((t) => t.trim() === name), 10000)
  }
  await page.locator('.agent-tab', { hasText: 'Agent 9' }).click()
  await lib.sleep(300)
  await remove('Agent 9')
  check('removing an agent on page 2 stays on page 2', (await active()) === '2', await active())
  check('the next agent takes its focus', (await page.locator('.agent-tab.focused, .agent-tab.active', { hasText: 'Agent 10' }).count()) === 1)
  await remove('Agent 12')
  check('removing another agent there stays too', (await active()) === '2', await active())
  const left = (await inv('workspace:refresh')).projects[0].agents
  for (const a of left.slice(7)) await inv('agents:remove', proj, a.id, { deleteWorktree: false })
  await inv('workspace:refresh')
  await lib.sleep(600)
  await page.locator('.agent-tab', { hasText: 'Agent 7' }).click()
  await lib.sleep(300)
  await remove('Agent 7')
  check('removing the only agent on page 2 goes to page 1', (await page.locator('.page-switch').count()) === 0 && (await panes()) >= 1)

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
