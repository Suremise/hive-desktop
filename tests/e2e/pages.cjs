// Agent pages: up to twelve agents, six to a page. Page 1 fills up automatically (to a 3×2 grid), the seventh
// agent opens page 2, each page keeps its own layout, and a full project refuses a thirteenth.
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
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47897' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1600, height: 900 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(800)
  await page.getByText('crowd', { exact: true }).first().click()
  await lib.sleep(500)
  const panes = () => page.locator('.agent-pane').count()
  const add = async (n) => {
    for (let i = 0; i < n; i++) await inv('agents:add', proj, { location: 'project', provider: 'claude-code' })
    await inv('workspace:refresh')
    await lib.sleep(600)
  }
  const cfg = async () => (await inv('workspace:refresh')).projects[0].config

  // Page 1 fills up automatically: five or six agents are a 3×2 grid.
  await add(6)
  check('six agents: a 3×2 grid', (await panes()) === 6, String(await panes()))
  check('one page: no page buttons', (await page.locator('.page-switch').count()) === 0)

  // The seventh (added here) opens page 2, on its own, with a note about memory.
  await page.locator('.agent-add:not(.split-caret)').click()
  await lib.sleep(1500)
  check('the seventh agent opens page 2', (await page.locator('.page-switch button.active').innerText()).trim() === '2')
  check('page 2 shows it alone', (await panes()) === 1 && (await page.locator('.pane-header-bar', { hasText: 'Agent 7' }).count()) === 1)
  check('a note on what seven agents cost', (await page.locator('.toast', { hasText: '7 agents in this project' }).count()) === 1)
  check('the strip marks where page 2 starts', (await page.locator('.agent-tab[data-page-start]', { hasText: 'Agent 7' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-1-page2.png') })

  // Page 1 again (its button), then one at a time there ("fullscreen"); page 2 stays automatic.
  await page.locator('.page-switch button[aria-label="Agent page 1"]').click()
  await lib.sleep(500)
  check('page 1 still shows its six', (await panes()) === 6)
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  await lib.sleep(800)
  check('page 1 one at a time', (await panes()) === 1 && JSON.stringify((await cfg()).layouts) === '["single"]', JSON.stringify((await cfg()).layouts))
  await page.keyboard.press('Control+Alt+PageDown')
  await lib.sleep(500)
  await add(1)
  check('Ctrl+Alt+PageDown: page 2, which grows as agents are added', (await page.locator('.page-switch button.active').innerText()).trim() === '2' && (await panes()) === 2, String(await panes()))
  await page.keyboard.press('Control+Alt+PageUp')
  await lib.sleep(500)
  check('page 1 kept its own layout', (await panes()) === 1)
  // Clicking an agent on the other page goes to that page.
  await page.locator('.agent-tab', { hasText: 'Agent 8' }).click()
  await lib.sleep(500)
  check('clicking an agent on page 2 goes there', (await page.locator('.page-switch button.active').innerText()).trim() === '2')

  // Twelve is the most.
  await add(4)
  const n = (await inv('workspace:refresh')).projects[0].agents.length
  check('twelve agents', n === 12, String(n))
  check('page 2 is a 3×2 grid too', (await panes()) === 6)
  const refused = await inv('agents:add', proj, { location: 'project', provider: 'claude-code' }).then(() => '', (e) => String(e.message ?? e))
  check('a thirteenth is refused', /up to 12 agents/.test(refused), refused)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-2-twelve.png') })

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
