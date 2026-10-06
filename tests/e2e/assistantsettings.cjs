// The Hive Assistant changes Hive's settings (#186). With Settings → Assistant → Control → Change settings on, its
// hive_update_setting changes a setting as Settings would: Settings shows the new value (modified), its panel lists the
// change with old → new and a Revert button, and Revert puts the old value back (listed too, the change marked reverted).
// A project's setting changes in Project Settings. Its own Control and other sensitive settings are refused and listed as
// not done; with Change settings turned off while it runs, a change is refused at once. Change settings is a switch
// under Control, off by default. The Assistant runs the fake Claude Code (fake-claude/), whose "hive TOOL {json}" calls a
// tool through the real hive MCP server. Screenshots in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistantsettings-profile')
const ws = path.join(lib.WORK, 'assistantsettings-ws')
const claudeHome = path.join(lib.WORK, 'assistantsettings-claude-home')
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
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47912), CLAUDE_CONFIG_DIR: claudeHome })
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
  const settings = async () => inv('settings:get')
  /** Has the Assistant run one prompt (fake commands), and waits for its turn to end. */
  const say = async (text) => {
    await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 20000)
    await inv('pty:write', key, text)
    await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
    await inv('pty:write', key, '\r')
    await lib.until(async () => (await live())?.status === 'working', 5000)
    return !!(await lib.until(async () => (await live())?.status === 'finished', 30000))
  }

  // --- Change settings: under Control, off by default.
  check('Change settings is off by default', (await settings()).assistant.changeSettings === false)
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).click()
  const row = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Change settings' }) })
  check('Settings → Assistant shows Change settings, after Control', (await row.count()) === 1 && (await page.locator('.settings-content .setting .s-title').allInnerTexts()).findIndex((t) => t.startsWith('Change settings')) === (await page.locator('.settings-content .setting .s-title').allInnerTexts()).findIndex((t) => t.startsWith('Control')) + 1)
  await row.locator('.switch, [role="switch"], input[type="checkbox"]').first().click()
  check('…and turns on', !!(await lib.until(async () => (await settings()).assistant.changeSettings === true, 5000)))
  await page.keyboard.press('Escape')

  // --- The Assistant, started with it on.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const panel = page.locator('.assistant-panel')
  await lib.until(async () => (await panel.locator('.assistant-header').count()) === 1, 5000)
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await lib.until(async () => (await live())?.status === 'ready', 20000)))

  // --- A change: Settings shows it, the panel lists it with Revert.
  check('it changes a setting', await say('skill tune-settings then hive hive_update_setting {"id":"sessions.transcriptWarnMB","value":50}'))
  check('…which is now 50 MB', (await settings()).sessions.transcriptWarnMB === 50, String((await settings()).sessions.transcriptWarnMB))
  const action = panel.locator('.assistant-action', { hasText: 'Warn when a transcript is over' }).first()
  check('its panel lists the change, old → new', /Changed Settings → Sessions → Warn when a transcript is over: 20 → 50/.test((await action.innerText().catch(() => '')) || ''), await action.innerText().catch(() => ''))
  const revert = action.getByRole('button', { name: /^Revert Settings → Sessions → Warn when a transcript is over to 20/ })
  check('…with a Revert button', (await revert.count()) === 1)
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
  const warn = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Warn when a transcript is over' }) })
  check('Settings → Sessions shows 50, modified', (await warn.locator('input[type=number]').inputValue()) === '50' && (await warn.locator('.modified').count()) === 1)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300) // on purpose: the theme's colours settle
    await page.screenshot({ path: path.join(lib.WORK, `assistantsettings-changed-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- Revert: back to 20, listed, and the change marked reverted.
  await revert.click()
  check('Revert puts it back to 20 MB', !!(await lib.until(async () => (await settings()).sessions.transcriptWarnMB === 20, 5000)))
  check('…which Settings shows', !!(await lib.until(async () => (await warn.locator('input[type=number]').inputValue()) === '20', 3000)))
  check('…and the panel lists, the change marked reverted', !!(await lib.until(async () => (await panel.locator('.assistant-action', { hasText: 'You reverted Settings → Sessions → Warn when a transcript is over: 50 → 20' }).count()) === 1 && (await action.locator('text=reverted').count()) === 1, 3000)))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantsettings-reverted.png') })

  // --- A project's setting: Project Settings has it.
  check("it changes a project's setting", await say('hive hive_update_setting {"id":"project.compactSuggestTokens","value":300000,"project":"alpha"}'))
  const alphaCfg = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase()).config
  check("alpha's Suggest compacting above is 300000", (await alphaCfg()).compactSuggestTokens === 300000, String((await alphaCfg()).compactSuggestTokens))

  // --- Races with the user's own edits (#186 review): a project config write held just before its file is replaced,
  // so another change waits for the lock behind it.
  const projectFile = path.join(alpha, '.hive', 'project.json')
  const holdNextWrite = () =>
    app.evaluate((_, target) => {
      const f = process.mainModule.require('original-fs/promises')
      const original = global.__hiveTestRename ?? (global.__hiveTestRename = f.rename)
      global.__hiveTestGate = { entered: false }
      f.rename = async (...args) => {
        if (!global.__hiveTestGate.entered && String(args[1]).toLowerCase() === target.toLowerCase()) {
          global.__hiveTestGate.entered = true
          await new Promise((resolve) => (global.__hiveTestGate.release = resolve))
          f.rename = original
        }
        return original(...args)
      }
    }, projectFile)
  const held = () => lib.until(() => app.evaluate(() => global.__hiveTestGate.entered), 5000)
  const release = () => app.evaluate(() => global.__hiveTestGate.release())
  // Started in the page and left there (nothing returned to wait on: the write is held on purpose).
  const userWrite = (value) =>
    page.evaluate(([p, v]) => {
      window.__userWrite = window.hive.invoke('project:updateConfig', p, { compactSuggestTokens: v }).then(() => 'saved', (e) => e.message)
    }, [alpha, value])

  // Change settings turned off while the Assistant's change waits for the lock: it is refused when its turn comes.
  await inv('settings:update', { assistant: { changeSettings: true } })
  await holdNextWrite()
  await userWrite(400000)
  check("the user's write holds the project's lock", !!(await held()))
  const queued = say('hive hive_update_setting {"id":"project.compactSuggestTokens","value":500000,"project":"alpha"}')
  await lib.sleep(1500) // on purpose: the Assistant's call reaches the lock and waits behind the user's write
  await inv('settings:update', { assistant: { changeSettings: false } })
  await release()
  await queued
  check("the user's write is saved", (await page.evaluate(() => window.__userWrite)) === 'saved')
  check('the queued change, its permission withdrawn meanwhile, changed nothing', (await alphaCfg()).compactSuggestTokens === 400000, String((await alphaCfg()).compactSuggestTokens))
  check('…listed as not done: Change settings was turned off', (await panel.locator('.assistant-action.failed', { hasText: 'Change Project Settings → Sessions → Suggest compacting above in alpha' }).count()) >= 1)

  // The Assistant restarted while its change waits for the lock: the new session doesn't carry out the old one's change.
  await inv('settings:update', { assistant: { changeSettings: true } })
  await holdNextWrite()
  await userWrite(410000)
  await held()
  const refusedBefore = (await inv('assistant:actions')).filter((a) => !a.ok).length
  // Typed, not said: its turn never ends (the session is stopped under it).
  await inv('pty:write', key, 'hive hive_update_setting {"id":"project.compactSuggestTokens","value":500000,"project":"alpha"}')
  await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
  await inv('pty:write', key, '\r')
  await lib.sleep(1500) // on purpose: the Assistant's call reaches the lock and waits behind the user's write
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await inv('session:start', home, { agentId: 'assistant' })
  check('the Assistant starts again', !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 20000)))
  await release()
  check("the old session's change is refused when its turn comes", !!(await lib.until(async () => (await inv('assistant:actions')).filter((a) => !a.ok).length > refusedBefore, 10000)))
  check("…and the user's write stays", (await alphaCfg()).compactSuggestTokens === 410000, String((await alphaCfg()).compactSuggestTokens))
  check('…listed as not done: its session ended', /session that asked for this ended/.test((await inv('assistant:actions')).filter((a) => !a.ok).at(-1)?.error ?? ''), JSON.stringify((await inv('assistant:actions')).at(-1)))

  // Revert while the user's newer edit holds the lock: it sees that edit and refuses, keeping it.
  await inv('settings:update', { assistant: { changeSettings: true } })
  check('it changes the project setting again', await say('hive hive_update_setting {"id":"project.compactSuggestTokens","value":300000,"project":"alpha"}'))
  const latest = (await inv('assistant:actions')).filter((a) => a.setting?.id === 'project.compactSuggestTokens').at(-1)
  check('…410000 → 300000, listed for Revert', latest?.setting?.oldText === '410000' && latest?.setting?.newText === '300000', JSON.stringify(latest?.setting))
  await holdNextWrite()
  await userWrite(450000)
  await held()
  await page.evaluate((id) => {
    window.__revert = window.hive.invoke('assistant:revertSetting', id).then(() => 'reverted', (e) => e.message)
  }, latest.id)
  await lib.sleep(500) // on purpose: the Revert waits for the lock behind the user's write
  await release()
  const reverted = await page.evaluate(() => window.__revert)
  check('Revert after a newer edit is refused, saying it changed since', /has changed since/.test(reverted), reverted)
  check("…and the user's newer edit stays", (await alphaCfg()).compactSuggestTokens === 450000, String((await alphaCfg()).compactSuggestTokens))

  // --- A table: the board's column colours, changed and reverted.
  check('it changes a column colour', await say('hive hive_update_setting {"id":"board.colors","value":{"doing":"#ff0000"}}'))
  check('…Doing is red, the others as they were', (await settings()).board.colors.doing === '#ff0000' && (await settings()).board.colors.todo !== '#ff0000')
  const colours = panel.locator('.assistant-action', { hasText: 'Column colours' }).first()
  check('…listed as the colour it changed, not the table\'s size', /Column colours: doing: #[0-9a-f]{6} → doing: #ff0000/.test(await colours.innerText()), await colours.innerText())
  await colours.getByRole('button', { name: /^Revert / }).click()
  check('…and Revert puts the colours back', !!(await lib.until(async () => (await settings()).board.colors.doing !== '#ff0000', 5000)))

  // --- A fallback list: a label-only change is listed by that entry, old and new (#317).
  await inv('settings:setProviderFallback', 'claude-code', 'models', [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }])
  check('it renames a fallback model', await say('hive hive_update_setting {"id":"claude-code.modelFallback","value":[{"value":"opus","label":"Opus (big)"},{"value":"sonnet","label":"Sonnet"}]}'))
  const renamed = panel.locator('.assistant-action', { hasText: 'Models (fallback)' }).first()
  check('…listed as the label that changed', /opus: Opus → opus: Opus \(big\)/.test(await renamed.innerText()), await renamed.innerText())

  // --- A provider's prices: null puts back Hive's, a shipped model removed from the table too (#315); Revert removes it again.
  const removedNow = async () => JSON.stringify((await settings()).providers['claude-code'].pricesRemoved ?? [])
  await inv('settings:setProviderPrices', 'claude-code', {}, ['claude-opus-4-8'])
  check('it resets the API prices', await say('hive hive_update_setting {"id":"claude-code.prices","value":null}'))
  check("…and the removed model has Hive's price again", (await removedNow()) === '[]', await removedNow())
  const reset = panel.locator('.assistant-action', { hasText: 'API prices' }).first()
  check('…listed as the model put back', /claude-opus-4-8: removed → claude-opus-4-8: Hive's price/.test(await reset.innerText()), await reset.innerText())
  await reset.getByRole('button', { name: /^Revert / }).click()
  check('…and Revert removes it again', !!(await lib.until(async () => (await removedNow()) === '["claude-opus-4-8"]', 5000)), await removedNow())

  // --- Refused: its own Control, and what Hive runs.
  check('it tries to raise its own Control', await say('hive hive_update_setting {"id":"assistant.control","value":"look"}'))
  check('…which stays as it was', (await settings()).assistant.control === 'projects')
  check('…listed as not done', (await panel.locator('.assistant-action.failed', { hasText: 'Change Settings → Assistant → Control' }).count()) === 1)
  check('it tries to change a CLI path', await say('hive hive_update_setting {"id":"claude-code.executablePath","value":"C:\\\\evil.exe"}'))
  check("…which stays as it was", (await settings()).providers['claude-code'].executablePath.endsWith('fake-claude.cmd'))

  // --- Turned off while it runs: refused at once.
  await inv('settings:update', { assistant: { changeSettings: false } })
  check('with Change settings off, it tries again', await say('hive hive_update_setting {"id":"sessions.transcriptWarnMB","value":60}'))
  check('…and nothing changes', (await settings()).sessions.transcriptWarnMB === 20)
  check('…listed as not done, saying why', (await panel.locator('.assistant-action.failed', { hasText: 'Change Settings → Sessions → Warn when a transcript is over' }).count()) >= 1)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
