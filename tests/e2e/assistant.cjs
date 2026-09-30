// The Hive Assistant: its home and personas in a workspace, the side panel (remembered per workspace), switching
// persona, Assistant Settings over Settings → Assistant, the Personas view, and one launch (no prompt is sent)
// that runs in the workspace folder, in Auto mode, named "Assistant" in the quit dialog.
// Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistant-profile')
const ws = path.join(lib.WORK, 'assistant-ws')
const ws2 = path.join(lib.WORK, 'assistant-ws2')
const home = path.join(ws, '.hive', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const agentFile = () => JSON.parse(fs.readFileSync(path.join(home, '.hive', 'project.json'), 'utf8')).agents?.[0] ?? {}

;(async () => {
  for (const d of [userData, ws, ws2]) fs.rmSync(d, { recursive: true, force: true })
  for (const p of ['api', 'web']) fs.mkdirSync(path.join(ws, p), { recursive: true })
  fs.mkdirSync(ws2, { recursive: true })
  lib.enableProviders(userData, ['claude-code'])
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47894' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1200)

  // The workspace gets the Assistant's home and Hive's personas; the home is not a project.
  const info = await inv('workspace:get')
  check('the Assistant has its home and one agent', info.assistant?.path.toLowerCase() === home.toLowerCase() && info.assistant.agents.length === 1)
  check('its home is not listed as a project', info.projects.map((p) => p.name).sort().join(',') === 'api,web')
  check("its sessions are kept out of git", fs.readFileSync(path.join(home, '.gitignore'), 'utf8').includes('*'))
  check('Hive\'s four personas are in the workspace', fs.readdirSync(path.join(ws, '.hive', 'personas')).sort().join(',') === 'orchestrator.md,overseer.md,planner.md,reviewer.md')
  check('it defaults to a lighter model and Auto mode', JSON.stringify(info.assistant.config.providers['claude-code']) === JSON.stringify({ model: 'sonnet', effort: 'low', permissionMode: 'auto', extraArgs: '' }))

  // The panel: hidden at first, Ctrl+Alt+I shows it, and each workspace remembers it.
  check('the panel starts hidden, as a strip', (await page.locator('.assistant-panel').count()) === 0 && (await page.locator('.assistant-rail', { hasText: 'Hive Assistant' }).count()) === 1)
  await page.locator('.assistant-rail').click()
  await lib.sleep(600)
  check('clicking the strip shows the panel', (await page.locator('.assistant-panel').count()) === 1 && (await page.locator('.assistant-rail').count()) === 0)
  check('430 px wide by default', Math.round((await page.locator('.assistant-panel').boundingBox()).width) === 430)
  await page.keyboard.press('Control+Alt+I')
  await lib.sleep(400)
  check('Ctrl+Alt+I hides it again', (await page.locator('.assistant-rail').count()) === 1)
  await page.keyboard.press('Control+Alt+I')
  await lib.sleep(600)
  check('and shows it', (await page.locator('.assistant-panel').count()) === 1)
  check('Start is a header button', (await page.locator('.assistant-header button[aria-label="Start"]').count()) === 1)
  // Narrow: Start folds into ⋯.
  const edge = await page.locator('.assistant-panel > .pane-resizer').boundingBox()
  await page.mouse.move(edge.x + 3, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + 60, edge.y + 200, { steps: 5 })
  await page.mouse.move(edge.x + 123, edge.y + 200, { steps: 5 })
  await page.mouse.up()
  await lib.sleep(600)
  await page.locator('.assistant-header button[aria-label="More"]').click()
  await lib.sleep(300)
  check('a narrow panel folds Start into ⋯', (await page.locator('.assistant-header button[aria-label="Start"]').count()) === 0 && (await page.locator('.menu-item', { hasText: /^Start$/ }).count()) === 1)
  await page.keyboard.press('Escape')
  await page.locator('.assistant-panel > .pane-resizer').dblclick()
  await lib.sleep(300)
  check('double-clicking its edge goes back to 430 px', Math.round((await page.locator('.assistant-panel').boundingBox()).width) === 430)
  check('inactive projects fold into one row', (await page.locator('.assistant-project').count()) === 0 && (await page.locator('.assistant-fold', { hasText: '2 inactive projects' }).count()) === 1)
  await page.locator('.assistant-fold').click()
  await lib.sleep(300)
  check('which expands to list them', (await page.locator('.assistant-project.inactive').count()) === 2)
  await inv('project:setActive', path.join(ws, 'api'), true)
  await lib.sleep(800)
  check('an active project is listed above the fold', (await page.locator('.assistant-project:not(.inactive)', { hasText: 'api' }).count()) === 1 && (await page.locator('.assistant-fold', { hasText: '1 inactive project' }).count()) === 1)
  await page.locator('.assistant-fold').click()
  await lib.sleep(300)
  check('and folding hides the rest again', (await page.locator('.assistant-project').count()) === 1)
  check('it offers to start the Assistant', (await page.locator('.assistant-idle', { hasText: 'Overseer' }).count()) === 1)
  await inv('workspace:open', ws2)
  await lib.sleep(1000)
  check('another workspace has its own (hidden) panel', (await page.locator('.assistant-panel').count()) === 0)
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  check('coming back shows it again', (await page.locator('.assistant-panel').count()) === 1)

  // Switching persona (not running): saved for this workspace.
  await page.locator('.assistant-persona').click()
  await lib.sleep(300)
  await page.locator('.context-menu .menu-item, .menu .menu-item', { hasText: 'Planner' }).first().click()
  await lib.sleep(800)
  check('choosing a persona saves it for the workspace', agentFile().persona === 'planner', JSON.stringify(agentFile()))
  check('the header shows it', (await page.locator('.assistant-persona').innerText()).includes('Planner'))

  // Assistant Settings: this workspace's effort, over the default.
  await inv('agents:update', home, 'assistant', { effort: 'medium' })
  await lib.sleep(500)
  check('Assistant Settings saves an override', agentFile().effort === 'medium')
  check('the footer shows it', (await page.locator('.assistant-footer').innerText()).includes('Medium'))
  // Settings → Assistant: a new default model reaches the Assistant.
  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: 'haiku' } } } })
  await lib.sleep(1200)
  check('Settings → Assistant changes its default model', (await inv('workspace:get')).assistant.config.providers['claude-code'].model === 'haiku')
  check('renaming the Assistant is ignored', (await inv('agents:update', home, 'assistant', { name: 'Bob' })).name === 'Assistant')

  // The Personas view: create, delete and restore.
  await inv('personas:create', 'Night Watch')
  check('a new persona is a file', fs.existsSync(path.join(ws, '.hive', 'personas', 'night-watch.md')))
  await inv('personas:delete', 'reviewer')
  const listed = await inv('personas:list')
  check('a deleted bundled persona is offered for restoring', listed.find((p) => p.id === 'reviewer')?.bundled === 'missing')
  await inv('personas:restore', 'reviewer')
  check('and restores', (await inv('personas:list')).find((p) => p.id === 'reviewer')?.bundled === 'same')
  await page.locator('.activity-btn[aria-label="Assistant Personas"]').click()
  await lib.sleep(500)
  check('the Personas view lists them', (await page.locator('.persona-row').count()) === 5)

  // One launch (no prompt): in the workspace folder, in Auto mode, with Hive's reading tools allowed.
  await inv('session:start', home, { agentId: 'assistant' })
  await lib.acceptClaudeTrust(inv, home, 'assistant', 20000)
  const t0 = Date.now()
  let live = null
  while (Date.now() - t0 < 30000 && (live = (await inv('session:live')).find((s) => s.agentId === 'assistant'))?.status !== 'ready') await lib.sleep(400)
  check('the Assistant starts', live?.status === 'ready', live?.status)
  check('it works in the workspace folder', live?.cwd.toLowerCase() === ws.toLowerCase(), live?.cwd)
  check('in Auto mode', live?.permissionMode === 'auto', live?.permissionMode)
  check('its conversation is named for the persona', (live?.sessionName ?? '').startsWith('Assistant · Planner · '), live?.sessionName)
  const log = fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
  const launch = log.split('\n').filter((l) => l.includes('spawn session:') && l.toLowerCase().includes('assistant#assistant')).pop() ?? ''
  check("its persona is appended to Claude Code's system prompt", launch.includes('--append-system-prompt-file'))
  check("Hive's reading tools are allowed", launch.includes('mcp__hive__hive_list_projects') && !launch.includes('mcp__hive__hive_write_shared_note'))
  check('Planner\'s instructions are in the launch', fs.readFileSync(path.join(home, '.hive', 'launch-assistant', 'instructions.md'), 'utf8').includes('heist'))
  check('it is not a project agent', (await inv('workspace:get')).projects.every((p) => p.agents.every((a) => a.id !== 'assistant')))
  // Closing the workspace (Confirm on quit: always) lists it as "Assistant", then stops it.
  await inv('settings:update', { general: { confirmOnQuit: 'always' } })
  const closing = inv('workspace:close')
  await lib.sleep(1000)
  const dialog = await page.locator('.dialog').last().innerText().catch(() => '')
  check('the close dialog names it "Assistant"', /Assistant/.test(dialog) && !/\.hive|assistant ·/i.test(dialog), dialog.replace(/\s+/g, ' ').slice(0, 200))
  await page.locator('.dialog .btn', { hasText: 'Close workspace now' }).click()
  check('closing the workspace stops it', (await closing) === true && !(await inv('session:live')).some((s) => s.agentId === 'assistant'))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
