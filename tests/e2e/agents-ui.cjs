// Screenshots of the agent dialogs and settings. Throwaway profile and git project; no sessions.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path'), { execSync } = require('child_process')
const scratch = lib.WORK, userData = path.join(scratch, 'agentsui-profile')
const root = path.join(scratch, 'agentsui')
for (const d of [userData, root]) fs.rmSync(d, { recursive: true, force: true })
const ws = path.join(root, 'ws'), proj = path.join(ws, 'demo')
fs.mkdirSync(proj, { recursive: true })
const g = (cmd, cwd = proj) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString()
g('init -q -b main'); g('config user.email t@e.com'); g('config user.name T')
fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n'); g('add -A'); g('commit -q -m init')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  lib.enableProviders(userData)
  const env = { ...process.env, HIVE_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(500)
  await inv('project:updateConfig', proj, { worktreeSetup: 'npm install' }); await inv('workspace:refresh'); await sleep(300)

  // A new project starts with no agents; the quick add gives one with the default provider.
  let p0 = (await inv('workspace:refresh')).projects[0]
  check('new project has no agents', p0.agents.length === 0, String(p0.agents.length))
  check('empty Session tab offers Add Agent', (await page.getByText('No agents yet').count()) === 1)
  await page.locator('.agent-add:not(.split-caret)').click(); await sleep(1200)
  p0 = (await inv('workspace:refresh')).projects[0]
  check('quick add: Agent 1, default provider, project folder', p0.agents.length === 1 && p0.agents[0].name === 'Agent 1' && p0.agents[0].provider === 'claude-code' && !p0.agents[0].worktree, JSON.stringify(p0.agents))
  check('one agent: single layout', p0.config.sessionLayout === 'single', p0.config.sessionLayout)
  // One agent or several, each pane has its header (who, controls) and footer (model, mode…).
  check('a single agent has its pane header', (await page.locator('.pane-header-bar', { hasText: 'Agent 1' }).count()) === 1)
  check('…and footer with model and mode', (await page.locator('.pane-footer-bar .mode-badge').count()) === 1)
  check('its session buttons are in its header', (await page.locator('.pane-header-bar button[aria-label="New Session"]').count()) === 1)
  const headerText = await page.locator('.project-header').innerText()
  check('the project header keeps project items only', !/New Session|Archive|Compact/.test(headerText) && (await page.locator('.project-header .mode-badge').count()) === 0, headerText.replace(/\s+/g, ' '))
  check('the status bar has no agent model or mode', (await page.locator('.statusbar .mode-badge, .statusbar .status-item', { hasText: /ctx$|Auto$/ }).count()) === 0)

  // Add Agent dialog (▾), new worktree option
  await page.locator('.agent-add.split-caret').click(); await sleep(800)
  check('dialog open', await page.locator('.dialog', { hasText: 'Add an agent' }).count() === 1)
  await page.locator('.choice', { hasText: 'New worktree' }).click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'ui-1-add.png') })
  await page.locator('.dialog input.input').first().fill('Tester')
  check('branch follows name', (await page.locator('.agent-form.nested input').inputValue()) === 'hive/tester')
  await page.locator('.dialog label', { hasText: 'Start a session now' }).locator('input').uncheck()
  await page.locator('.dialog .btn.primary', { hasText: 'Add Agent' }).click(); await sleep(2500)
  let p = (await inv('workspace:refresh')).projects[0]
  check('agent created from the dialog', p.agents.some((a) => a.name === 'Tester' && a.worktree?.branch === 'hive/tester'))
  check('two agents: the layout switches to two columns', p.config.sessionLayout === 'columns2', p.config.sessionLayout)
  await sleep(500)
  await page.screenshot({ path: path.join(scratch, 'ui-2-strip.png') })

  // Merge dialog
  const t = p.agents.find((a) => a.name === 'Tester')
  fs.writeFileSync(path.join(t.worktree.path, 'b.txt'), 'b\n')
  await page.evaluate(([project, agentId]) => window.__hiveSet?.({ mergeFor: { project, agentId } }), [proj, t.id])
  await page.locator('.agent-tab', { hasText: 'Tester' }).click({ button: 'right' }); await sleep(300)
  await page.locator('.menu-item', { hasText: 'Merge…' }).click(); await sleep(1500)
  await page.screenshot({ path: path.join(scratch, 'ui-3-merge.png') })
  check('merge dialog counts changes', await page.locator('.dialog', { hasText: '1 uncommitted change' }).count() === 1)
  await page.keyboard.press('Escape'); await sleep(300)

  // Project settings → Agents & Worktrees
  await page.locator('.tabs .tab', { hasText: 'Settings' }).click(); await sleep(500)
  await page.locator('.settings-nav .row', { hasText: 'Agents & Worktrees' }).click(); await sleep(500)
  await page.screenshot({ path: path.join(scratch, 'ui-4-projsettings.png') })
  check('project settings lists agents', await page.locator('.agent-list-row').count() === 2)
  await page.locator('.settings-top input').fill('lock'); await sleep(300)
  check('search finds file locks', await page.locator('.setting', { hasText: 'File locks' }).count() === 1)

  // Files tab root selector
  await page.locator('.tabs .tab', { hasText: 'Files' }).click(); await sleep(600)
  await page.locator('.root-select').selectOption(t.id); await sleep(1000)
  check('files shows worktree', await page.getByText('b.txt').count() > 0)
  await page.screenshot({ path: path.join(scratch, 'ui-5-files.png') })

  // Global settings
  await page.evaluate(() => document.querySelector('[aria-label="Settings"]')?.click()); await sleep(600)
  await page.locator('.settings-nav .row', { hasText: 'Agents & Worktrees' }).click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'ui-6-global.png') })
  check('global agents settings', await page.locator('.setting', { hasText: 'Default merge style' }).count() === 1)

  // Discard the worktree agent through the API and check cleanup
  await inv('agents:remove', proj, t.id, { deleteWorktree: true })
  check('worktree deleted', !fs.existsSync(t.worktree.path))
  // Any agent can be removed, the first one too; the layout stays as it was.
  const first = (await inv('workspace:refresh')).projects[0].agents[0]
  await inv('agents:remove', proj, first.id, { deleteWorktree: false })
  const p1 = (await inv('workspace:refresh')).projects[0]
  check('the first agent can be removed', p1.agents.length === 0)
  check('removing keeps the layout', p1.config.sessionLayout === 'columns2', p1.config.sessionLayout)
  console.log(`${pass}/${pass + fail} passed`)
  await app.close()
  for (const d of [userData, root]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(path.join(root + '', '..', 'ws.worktrees'), { recursive: true, force: true })
})().catch((e) => { console.error(e); process.exit(1) })
