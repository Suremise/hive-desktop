// The Hive Assistant's working modes (#259). Switching mode from the panel's header while it runs keeps the
// conversation: Hive types "[Hive] Mode: <name> (chosen by the user). <summary> Your tools and permissions are
// unchanged." into it (no restart, the same session), and saves the mode for the workspace. While it is working, the
// message waits until it has finished. Restart in This Mode… (asking first) resumes the same conversation with the
// mode's full instructions. The menu screenshotted in both themes. The Assistant runs the fake Claude Code
// (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistantmode-profile')
const ws = path.join(lib.WORK, 'assistantmode-ws')
const claudeHome = path.join(lib.WORK, 'assistantmode-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(path.join(ws, 'alpha'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47910), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const key = lib.ptyKey(home, 'assistant')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const agentFile = () => JSON.parse(fs.readFileSync(path.join(home, '.hive', 'project.json'), 'utf8')).agents?.[0] ?? {}
  const buffer = async () => (await inv('pty:buffer', key)) ?? ''
  const panel = page.locator('.assistant-panel')
  const modeMenu = async () => {
    await panel.locator('.assistant-persona').click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 3000)
  }
  const pick = async (label) => {
    await modeMenu()
    await page.locator('.menu .menu-item', { hasText: label }).first().click()
  }

  // --- The Assistant runs, in Coordinator mode (the default).
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.until(async () => (await panel.locator('.assistant-header').count()) === 1, 5000)
  check('the header shows Coordinator, the default mode', !!(await lib.until(async () => (await panel.locator('.assistant-persona').innerText()).includes('Coordinator'), 5000)), await panel.locator('.assistant-persona').innerText())
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await lib.until(async () => (await live())?.status === 'ready', 20000)))
  const session = (await live()).sessionId
  const told = fs.readFileSync(path.join(home, '.hive', 'launch-assistant', 'instructions.md'), 'utf8')
  check('its instructions are the mode, and say it may suggest another', told.includes('# Your mode: Coordinator') && /suggest switching in one short line; never switch or insist/.test(told), told.slice(-400))

  // --- The menu: the four modes, switching keeps the conversation.
  await modeMenu()
  const items = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('the menu says switching keeps the conversation, and lists the four modes', (await page.locator('.menu', { hasText: 'Mode (switches now, keeping the conversation)' }).count()) === 1 && ['Coordinator', 'Planner', 'QA triager', 'Release manager'].every((m) => items.some((t) => t.includes(m))), JSON.stringify(items))
  check('…with Restart in This Mode… and Manage Modes…', items.some((t) => t.startsWith('Restart in This Mode')) && items.some((t) => t.startsWith('Manage Modes')), JSON.stringify(items))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300) // on purpose: the theme's colours settle
    await page.screenshot({ path: path.join(lib.WORK, `assistantmode-menu-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.keyboard.press('Escape')

  // --- Idle: told at once, in the same conversation.
  await pick('Planner')
  check('switching to Planner tells it at once, in its conversation', !!(await lib.until(async () => (await buffer()).includes('[Hive] Mode: Planner (chosen by the user). Lead with the open design questions'), 10000)), (await buffer()).slice(-400))
  check('…ending with Hive\'s own sentence', !!(await lib.until(async () => (await buffer()).includes('Your tools and permissions are unchanged.'), 10000)), JSON.stringify((await buffer()).slice(-600)))
  check('…without a restart: the same session', (await live())?.sessionId === session, `${session} → ${(await live())?.sessionId}`)
  check('…saved for the workspace, and the header shows it', agentFile().persona === 'planner' && (await panel.locator('.assistant-persona').innerText()).includes('Planner'), JSON.stringify(agentFile()))
  await lib.until(async () => (await live())?.status === 'finished', 15000)

  // --- Working: told once it has finished.
  await inv('pty:write', key, 'work 6')
  await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
  await inv('pty:write', key, '\r')
  check('it works on something', !!(await lib.until(async () => (await live())?.status === 'working', 5000)))
  await pick('QA triager')
  await lib.sleep(1000) // on purpose: nothing is typed into a working Assistant
  check('switching while it works types nothing yet', !(await buffer()).includes('[Hive] Mode: QA triager'))
  check('…and is saved at once', agentFile().persona === 'qa-triager', JSON.stringify(agentFile()))
  check('…then told once it has finished', !!(await lib.until(async () => (await buffer()).includes('[Hive] Mode: QA triager (chosen by the user). Take a report'), 20000)))
  check('…still the same session', (await live())?.sessionId === session)
  await lib.until(async () => (await live())?.status === 'finished', 15000)

  // --- Restart in This Mode: the same conversation, resumed with the mode's full instructions.
  await modeMenu()
  await page.locator('.menu .menu-item', { hasText: 'Restart in This Mode' }).click()
  const ask = page.locator('.dialog', { hasText: 'Restart in QA triager mode?' })
  check('Restart in This Mode asks first, saying it re-caches the conversation', !!(await lib.until(async () => (await ask.count()) === 1, 5000)) && /cached again/.test(await ask.innerText()))
  await ask.getByRole('button', { name: 'Restart', exact: true }).click()
  check('…and resumes the same conversation', !!(await lib.until(async () => (await live())?.status === 'ready' && (await live())?.sessionId === session, 30000)), `${session} → ${(await live())?.sessionId}`)
  const retold = fs.readFileSync(path.join(home, '.hive', 'launch-assistant', 'instructions.md'), 'utf8')
  check('…with the QA triager mode in its instructions', retold.includes('# Your mode: QA triager'))

  // --- Not running: saved, told nothing (its next launch is in the mode).
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await pick('Release manager')
  check('switching while it is stopped saves the mode for its next launch', !!(await lib.until(async () => agentFile().persona === 'release-manager', 5000)), JSON.stringify(agentFile()))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
