// An agent's card in Doing on the agent: the chip in its strip tab, pane header and the Workspace Overview's running
// list, its line in the project's sidebar tooltip; clicking opens the card; leaving Doing removes it. The session
// records the card (sessions.json) and the Sessions tab shows "Worked on #n", unlinked once the card is deleted.
// The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'cardchip-profile')
const ws = path.join(lib.WORK, 'cardchip-ws')
const claudeHome = path.join(lib.WORK, 'cardchip-claude-home')
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

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47896', CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.addAgent(inv, alpha, { name: 'Other' })
  await inv('project:updateConfig', alpha, { layouts: ['columns2'] })
  // A running session with one exchange (so Hive keeps its record).
  await inv('session:start', alpha, { agentId: coder.id })
  await until(async () => ['waiting', 'ready'].includes((await live(coder.id))?.status))
  if ((await live(coder.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, coder.id), '\r')
  await until(async () => (await live(coder.id))?.status === 'ready')
  await inv('pty:write', lib.ptyKey(alpha, coder.id), 'hello')
  await lib.sleep(300)
  await inv('pty:write', lib.ptyKey(alpha, coder.id), '\r')
  check('Coder ran once', !!(await until(async () => (await live(coder.id))?.status === 'finished')))
  const sessionId = (await live(coder.id)).sessionId

  const tab = page.locator('.agent-tab', { hasText: 'Coder' })
  const header = page.locator('.pane-header-bar', { hasText: 'Coder' })
  check('no chip before it has a card', (await tab.locator('.card-chip').count()) === 0 && (await header.locator('.card-chip').count()) === 0)

  // A card in Todo for it shows nothing; in Doing it shows.
  const card = await inv('tasks:create', { title: 'Attention inbox', project: 'alpha', agent: coder.id })
  await lib.sleep(800)
  check('a Todo card shows no chip', (await tab.locator('.card-chip').count()) === 0)
  await inv('tasks:update', card.number, { column: 'doing' })
  check('the strip tab shows #n only', !!(await until(async () => (await tab.locator('.card-chip').count()) === 1, 5000)) && (await tab.locator('.card-chip').innerText()).trim() === `#${card.number}`, await tab.locator('.card-chip').innerText().catch(() => ''))
  check('the pane header shows #n and the title', !!(await until(async () => /Attention inbox/.test(await header.locator('.card-chip').innerText().catch(() => '')), 5000)))
  check('the other agent shows none', (await page.locator('.agent-tab', { hasText: 'Other' }).locator('.card-chip').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-1-pane.png') })

  // A second Doing card: "+1".
  const second = await inv('tasks:create', { title: 'Prompt snippets', project: 'alpha', agent: coder.id, column: 'doing' })
  check('a second Doing card shows +1', !!(await until(async () => /\+1/.test(await tab.locator('.card-chip').innerText().catch(() => '')), 5000)))

  // Clicking opens the card.
  await header.locator('.card-chip').click()
  const dialog = page.locator('.dialog', { hasText: `#${card.number}` })
  check('clicking the chip opens the card', !!(await until(async () => (await dialog.count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-2-dialog.png') })
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, 3000)

  // The session records both cards.
  const recorded = async () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'sessions.json'), 'utf8')).sessions.find((s) => s.id === sessionId)?.cards ?? []
  check('the session records its cards', !!(await until(async () => (await recorded()).length === 2, 8000)), JSON.stringify(await recorded()))

  // The sidebar's tooltip for the project.
  await page.locator('.project-row', { hasText: 'alpha' }).locator('.project-status').hover()
  await lib.sleep(900)
  const tipText = await page.locator('.tip').last().innerText().catch(() => '')
  check("the project's tooltip lists the agent's card", tipText.includes(`Coder: `) && tipText.includes(`#${card.number} Attention inbox +1`), tipText)

  // The Workspace Overview's running list.
  await page.keyboard.press('Control+Shift+O')
  const runningChip = page.locator('.running-row', { hasText: 'Coder' }).locator('.card-chip')
  check('the Workspace Overview shows it on the running agent', !!(await until(async () => (await runningChip.count()) === 1, 8000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-3-overview.png') })
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await page.locator('.project-row', { hasText: 'alpha' }).click()

  // Out of Doing: gone.
  await inv('tasks:update', card.number, { column: 'review' })
  await inv('tasks:update', second.number, { column: 'review' })
  check('moving the cards out of Doing removes the chip', !!(await until(async () => (await tab.locator('.card-chip').count()) === 0 && (await header.locator('.card-chip').count()) === 0, 5000)))

  // The Sessions tab: "Worked on", linked; a deleted card stays, unlinked.
  await inv('tasks:delete', second.number)
  await page.locator('.agent-pane', { has: header }).locator('.pane-footer-bar .session-tag').click()
  const worked = page.locator('.worked-on')
  check('the Sessions tab says what the session worked on', !!(await until(async () => /Worked on #\d+ Attention inbox, #\d+ Prompt snippets/.test(await worked.innerText().catch(() => '')), 8000)), await worked.innerText().catch(() => ''))
  check('a card still there is a link, a deleted one is not', !!(await until(async () => (await worked.locator('a.link').count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-4-sessions.png') })
  await worked.locator('a.link').click()
  check('the link opens the card', !!(await until(async () => (await dialog.count()) === 1, 5000)))

  await inv('session:stop', alpha)
  await lib.sleep(1500)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
