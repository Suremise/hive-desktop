// Number settings: a cleared box keeps the saved value (or inherits, in Project Settings), text that isn't a number
// or is out of range shows a message under the box and saves nothing, the Never / No pause checkboxes save 0 and
// bring the last value back, and a failed save shows the saved value again. No CLI needed.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'numbers-profile')
const ws = path.join(lib.WORK, 'numbers-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `numbers-${name}.png`) })

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  lib.enableProviders(userData)

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47898) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const sessions = async () => (await inv('settings:get')).sessions
  const projectCfg = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === proj.toLowerCase()).config

  // Settings → Sessions → Suggest compacting above (200,000 by default; 1,000 to 2,000,000, or Never).
  await page.keyboard.press('Control+,')
  await lib.sleep(800)
  await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
  await lib.sleep(500)
  const row = page.locator('.setting', { hasText: 'Suggest compacting above' })
  const box = row.locator('input[type=number]')
  const never = row.locator('label', { hasText: 'Never' }).locator('input')
  const error = row.locator('.field-error')
  const enter = async (text) => {
    await box.click()
    await box.press('Control+A')
    await box.press('Delete')
    if (text) await page.keyboard.type(text)
    await box.press('Enter')
    await lib.sleep(500)
  }
  check('the 0 sentence is gone from the description', !(await row.innerText()).includes('0 never'))

  await enter('')
  check('cleared box: setting kept', (await sessions()).compactSuggestTokens === 200000)
  check('cleared box: shows the saved value', (await box.inputValue()) === '200000', await box.inputValue())
  check('cleared box: no message', (await error.count()) === 0)

  await enter('500')
  check('out of range: message under the box', (await error.innerText().catch(() => '')) === 'Between 1,000 and 2,000,000.')
  check('out of range: setting kept', (await sessions()).compactSuggestTokens === 200000)
  check('out of range: box shows the saved value', (await box.inputValue()) === '200000')
  await shot(page, '1-range')

  await enter('1e')
  check('not a number: message', (await error.innerText().catch(() => '')).startsWith('Enter a number.'))
  check('not a number: setting kept', (await sessions()).compactSuggestTokens === 200000)

  await enter('150000')
  check('a value in range saves', (await sessions()).compactSuggestTokens === 150000)
  check('…and clears the message', (await error.count()) === 0)

  await never.check()
  await lib.sleep(500)
  check('Never saves 0', (await sessions()).compactSuggestTokens === 0)
  check('…and disables the box', await box.isDisabled())
  await shot(page, '2-never')
  await never.uncheck()
  await lib.sleep(500)
  check('unticking Never brings back the last value', (await sessions()).compactSuggestTokens === 150000)

  await enter('0')
  check('typing 0 is Never', (await sessions()).compactSuggestTokens === 0 && (await never.isChecked()))
  await never.uncheck()
  await lib.sleep(500)

  // A failed save leaves the setting, and the box, as they were.
  await app.evaluate(() => {
    process.env.HIVE_TEST_FAIL_IPC = 'settings:update*1'
  })
  await enter('120000')
  check('failed save: setting kept', (await sessions()).compactSuggestTokens === 150000)
  check('failed save: box shows the saved value', (await box.inputValue()) === '150000', await box.inputValue())
  await app.evaluate(() => {
    delete process.env.HIVE_TEST_FAIL_IPC
  })

  // Saves don't overlap: a number left by clicking Never (its slow save first, then Never's) ends as Never.
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = 'settings:update=2000*1'
  })
  await box.click()
  await box.press('Control+A')
  await page.keyboard.type('120000')
  await never.click()
  check('overlapping saves: Never ticks at once', await never.isChecked())
  await lib.sleep(3000) // A fixed wait on purpose: a stale save landing late is what this checks, so it waits for the saves to finish rather than for the first right value.
  check('overlapping saves: the last choice wins', (await sessions()).compactSuggestTokens === 0, String((await sessions()).compactSuggestTokens))
  check('overlapping saves: Never stays ticked', await never.isChecked())
  await app.evaluate(() => {
    delete process.env.HIVE_TEST_SLOW_IPC
  })
  await never.uncheck()
  await lib.sleep(500)
  check('…unticking brings back the number', (await sessions()).compactSuggestTokens === 120000, String((await sessions()).compactSuggestTokens))
  await enter('150000')

  // The other settings that 0 turns off have their checkbox too.
  await page.locator('.settings-nav .row', { hasText: 'Board' }).first().click()
  await lib.sleep(400)
  const archive = page.locator('.setting', { hasText: 'Archive Done cards after' })
  await archive.locator('label', { hasText: 'Never' }).locator('input').check()
  await lib.sleep(400)
  check('Archive Done cards: Never saves 0', (await inv('settings:get')).board.archiveDoneDays === 0)
  await archive.locator('label', { hasText: 'Never' }).locator('input').uncheck()
  await lib.sleep(400)
  check('…unticking brings back 14', (await inv('settings:get')).board.archiveDoneDays === 14)
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).first().click()
  await lib.sleep(400)
  check('Pause after you type has No pause', (await page.locator('.setting', { hasText: 'Pause after you type' }).locator('label', { hasText: 'No pause' }).count()) === 1)

  // Project Settings: empty inherits, the same messages, and Never for the project.
  await page.getByText('demo', { exact: true }).first().click()
  await lib.sleep(600)
  await page.locator('.tab', { hasText: 'Settings' }).first().click()
  await lib.sleep(600)
  await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
  await lib.sleep(500)
  const prow = page.locator('.setting', { hasText: 'Suggest compacting above' })
  const pbox = prow.locator('input[type=number]')
  const pnever = prow.locator('label', { hasText: 'Never' }).locator('input')
  const penter = async (text) => {
    await pbox.click()
    await pbox.press('Control+A')
    await pbox.press('Delete')
    if (text) await page.keyboard.type(text)
    await pbox.press('Enter')
    await lib.sleep(700)
  }
  check('project: inherits by default', (await projectCfg()).compactSuggestTokens === null)
  check('project: placeholder shows the global value', (await pbox.getAttribute('placeholder')) === 'Inherit (150,000)', await pbox.getAttribute('placeholder'))
  await penter('5000')
  check('project: a value saves', (await projectCfg()).compactSuggestTokens === 5000)
  await penter('10')
  check('project: out of range shows a message', (await prow.locator('.field-error').innerText().catch(() => '')) === 'Between 1,000 and 2,000,000.')
  check('project: out of range keeps the value', (await projectCfg()).compactSuggestTokens === 5000)
  await pnever.check()
  await lib.sleep(700)
  check('project: Never saves 0', (await projectCfg()).compactSuggestTokens === 0)
  await shot(page, '3-project')
  await pnever.uncheck()
  await lib.sleep(700)
  check('project: unticking brings back its value', (await projectCfg()).compactSuggestTokens === 5000)
  await penter('')
  check('project: a cleared box inherits', (await projectCfg()).compactSuggestTokens === null)
  await pnever.check()
  await lib.sleep(700)
  await pnever.uncheck()
  await lib.sleep(700)
  check('project: unticking Never after inheriting brings back its last value', (await projectCfg()).compactSuggestTokens === 5000)

  // The same for the project, whose saves could finish in either order.
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = 'project:updateConfig=2000*1'
  })
  await pbox.click()
  await pbox.press('Control+A')
  await page.keyboard.type('8000')
  await pnever.click()
  await lib.sleep(3000) // A fixed wait on purpose: a stale save landing late is what this checks, so it waits for the saves to finish rather than for the first right value.
  check('project: overlapping saves end as Never', (await projectCfg()).compactSuggestTokens === 0, String((await projectCfg()).compactSuggestTokens))
  check('project: Never stays ticked', await pnever.isChecked())
  await app.evaluate(() => {
    delete process.env.HIVE_TEST_SLOW_IPC
  })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
