// An agent whose CLI exits before its session starts shows why: a red bar under its terminal with the CLI's error,
// a hint, Retry and Agent Settings…, a red tab and "Failed to start" in its header, and a toast when its pane
// isn't on screen. Retry starts it again once fixed; a stop or a normal end shows no failure. The agent runs the
// fake Claude Code (fake-claude/), made to fail with `--model fail-start`. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'startfail-profile')
const ws = path.join(lib.WORK, 'startfail-ws')
const claudeHome = path.join(lib.WORK, 'startfail-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Starter', model: 'fail-start' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const header = page.locator('.pane-header-bar', { hasText: 'Starter' })
  const pane = page.locator('.agent-pane', { has: header })
  const bar = pane.locator('.start-failed')
  const tab = page.locator('.agent-tab', { hasText: 'Starter' })
  const text = (l) => l.innerText().catch(() => '')

  // --- It fails at start, on screen.
  await inv('session:start', alpha, { agentId: agent.id })
  check('the failure shows under the terminal', !!(await until(async () => (await bar.count()) === 1)))
  const said = await text(bar)
  check("it gives the CLI's error", /Couldn't start: error: option '--model <model>' argument 'fail-start' is invalid\./.test(said), said)
  check('with a hint for the fix', /choose another in Agent Settings/.test(said), said)
  check('with Retry and Agent Settings…', (await bar.getByRole('button', { name: 'Retry' }).count()) === 1 && (await bar.getByRole('button', { name: 'Agent Settings…' }).count()) === 1)
  check('the header says Failed to start, in red', /Failed to start/.test(await text(header.locator('.pane-status.failed'))) && (await header.locator('.dot.error').count()) === 1)
  check('the tab is red', (await tab.locator('.dot.error').count()) === 1)
  check('no toast while its pane is on screen', (await page.locator('.toast', { hasText: "couldn't start" }).count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-1-bar.png') })

  // --- Agent Settings… opens the agent's settings.
  await bar.getByRole('button', { name: 'Agent Settings…' }).click()
  check('Agent Settings… opens them', !!(await until(async () => (await page.getByRole('dialog', { name: 'Starter settings' }).count()) === 1, 5000)))
  await page.keyboard.press('Escape')
  await lib.sleep(300)

  // --- ✕ puts back the usual "Session ended" bar.
  await bar.getByRole('button', { name: /Dismiss/ }).click()
  check('✕ dismisses it', !!(await until(async () => (await bar.count()) === 0 && (await pane.locator('.session-ended').count()) === 1, 5000)))
  check('and the header and tab go back to not running', /Not running/.test(await text(header.locator('.pane-status'))) && (await tab.locator('.dot.error').count()) === 0)

  // --- Off screen: a toast with Show.
  await page.locator('.tab', { hasText: 'Files' }).click()
  await inv('session:start', alpha, { agentId: agent.id })
  const toast = page.locator('.toast', { hasText: "Starter couldn't start" })
  check('off screen, a toast says so', !!(await until(async () => (await toast.count()) === 1)))
  check('the toast has the hint and Show', /choose another in Agent Settings/.test(await text(toast)) && (await toast.getByRole('button', { name: 'Show' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-2-toast.png') })
  await toast.getByRole('button', { name: 'Show' }).click()
  check('Show opens the agent with the failure', !!(await until(async () => (await bar.count()) === 1, 5000)))

  // --- Fixed, Retry starts it, and the failure goes.
  await inv('agents:update', alpha, agent.id, { model: '' })
  await lib.sleep(300)
  await bar.getByRole('button', { name: 'Retry' }).click()
  check('Retry starts it again', !!(await until(async () => (await live())?.status === 'ready', 15000)))
  check('the failure is gone once it starts', (await bar.count()) === 0 && !/Failed to start/.test(await text(header)) && (await tab.locator('.dot.error').count()) === 0)

  // --- A stop isn't a failed start.
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 8000)
  await lib.sleep(800)
  check('a stop shows no failure', (await bar.count()) === 0 && (await pane.locator('.session-ended').count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'startfail-3-stopped.png') })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
