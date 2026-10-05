// Model picker, effort and plan usage. Throwaway profile (seeded with a plan usage report) and a
// trusted throwaway workspace; starts one real session but never sends it a prompt or touches the clipboard.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'plan-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const ws = path.join(scratch, 'plan-ws')
const shots = path.join(scratch, 'pshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true }); fs.mkdirSync(shots, { recursive: true }); fs.mkdirSync(userData, { recursive: true })
const inTwoHours = new Date(Date.now() + 2 * 3600e3 + 14 * 60e3).toISOString()
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ version: 1, planUsage: { fiveHour: { usedPercent: 86, resetsAt: inTwoHours }, sevenDay: { usedPercent: 40, resetsAt: null }, updatedAt: new Date().toISOString() } }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` (${extra})` : ''}`)
;(async () => {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: process.env.HIVE_EXE || lib.ELECTRON, args: process.env.HIVE_EXE ? [] : [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const proj = path.join(ws, 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)

  // Plan usage in the status bar from the stored report.
  const plan = page.locator('.statusbar .status-item', { hasText: '5h' })
  check('status bar shows plan usage', (await plan.textContent()).replace(/\s+/g, '').includes('5h86%·Week40%'), await plan.textContent())
  check('86% is highlighted', (await plan.getAttribute('class')).includes('caution'))
  // Waits for the tooltip itself: a fixed pause missed it when the machine was busy.
  await plan.hover()
  const tipEl = page.locator('.tip', { hasText: 'resets' }).last()
  await tipEl.waitFor({ timeout: 5000 }).catch(() => undefined)
  const tip = await tipEl.textContent().catch(() => '')
  check('tooltip shows reset time', /resets in 2 h 1[34] min/.test(tip), tip)
  await page.screenshot({ path: path.join(shots, '1-statusbar.png') })

  // Overview cards.
  await page.locator('.tab', { hasText: 'Overview' }).click(); await sleep(500)
  check('overview plan cards', (await page.locator('.card', { hasText: '5-hour limit' }).count()) === 1 && (await page.locator('.card', { hasText: 'Weekly limit' }).count()) === 1)
  check('meter coloured at 86%', (await page.locator('.card', { hasText: '5-hour limit' }).locator('.meter.caution').count()) === 1)
  await page.screenshot({ path: path.join(shots, '2-overview.png') })

  // Global model picker.
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await sleep(600)
  await page.locator('.settings-nav').getByText('Claude Code').click()
  await sleep(400)
  await page.getByText('Default model', { exact: true }).first().scrollIntoViewIfNeeded()
  const picker = page.locator('.setting', { hasText: 'Default model' }).locator('.model-picker').first()
  const groups = await picker.locator('optgroup').evaluateAll((els) => els.map((e) => e.label))
  const savedModel = () => inv('settings:get').then((s) => s.providers['claude-code'].defaultModel)
  // The models Claude Code reports for this version and account (#125), else Hive's fallback list.
  const catalog = (await inv('provider:info'))['claude-code']?.catalog
  const offered = (await picker.locator('select option').evaluateAll((os) => os.map((o) => o.value))).filter((v) => v && v !== 'custom')
  let first = 'claude-opus-5-5'
  if (catalog?.models.length) {
    const reported = catalog.models.filter((m) => !m.unavailable).map((m) => m.value)
    check(`the picker lists the models Claude Code ${catalog.version} reports`, groups[0] === 'Claude Code models' && JSON.stringify(offered.slice(0, reported.length)) === JSON.stringify(reported), JSON.stringify({ groups, offered, reported }))
    first = reported[0]
    await picker.locator('select').selectOption(reported.at(-1))
    check('another reported model saved as chosen', !!(await lib.until(async () => (await savedModel()) === reported.at(-1), 5000)), await savedModel())
  } else {
    check('latest and pinned groups, older hidden', JSON.stringify(groups) === JSON.stringify(['Latest (follows new releases)', 'Pinned versions']), JSON.stringify(groups))
    await picker.getByText('Show older versions').click()
    check('older versions shown on request', !!(await lib.until(async () => (await picker.locator('optgroup').count()) === 3, 5000)))
    await picker.locator('select').selectOption('claude-opus-4-5')
    check('an older version saved as chosen', !!(await lib.until(async () => (await savedModel()) === 'claude-opus-4-5', 5000)), await savedModel())
  }
  // No 1M choice (SPEC §9): current models have the 1M window without asking; Opus 4.6 / Sonnet 4.6 reach it only
  // through a [1m] model ID typed as a custom model, which the placeholder says.
  check('no 1M-context choice in the picker', (await picker.locator('input[type=checkbox]').count()) === 0)
  await picker.locator('select').selectOption(first)
  check(`${first} saved as chosen`, !!(await lib.until(async () => (await savedModel()) === first, 5000)), await savedModel())
  await picker.locator('select').selectOption('custom'); await sleep(200)
  check('the custom model box says how to ask for 1M ([1m])', /\[1m\]/.test((await picker.locator('input.input').getAttribute('placeholder')) ?? ''))
  await picker.locator('input.input').fill('claude-sonnet-9-9'); await picker.locator('input.input').press('Enter'); await sleep(400)
  check('custom model ID saved', (await inv('settings:get')).providers['claude-code'].defaultModel === 'claude-sonnet-9-9')
  await picker.locator('select').selectOption(first); await sleep(400)
  await page.screenshot({ path: path.join(shots, '3-settings.png') })
  await inv('settings:update', { providers: { 'claude-code': { defaultModel: '', defaultEffort: 'high' } } })

  // Project picker and effort in the header.
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await sleep(300)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Settings' }).click(); await sleep(500)
  await page.locator('.settings-nav .row', { hasText: 'Claude Code' }).click(); await sleep(300)
  const pp = page.locator('.setting', { hasText: 'Model' }).locator('.model-picker').first()
  check('project picker offers Inherit', (await pp.locator('option').first().textContent()).startsWith('Inherit'))
  await page.screenshot({ path: path.join(shots, '4-project-settings.png') })

  // Real session: the status line reaches Hive and prints nothing.
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  await page.locator('.tab', { hasText: 'Session' }).first().click(); await sleep(800)
  // The model's name: Claude Code's default model, by its name once Claude Code has said which it is (#125).
  const chip = await page.locator('.pane-footer-bar .pane-foot-item', { hasText: /default/ }).first().textContent().catch(() => '')
  check('the agent footer shows the configured effort', chip.includes('· High'), chip)
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  let live = null
  for (let i = 0; i < 40 && !live?.effort; i++) {
    await sleep(500)
    live = (await inv('session:live'))[0]
  }
  check('status line reports effort and model', !!live?.effort && !!live?.modelName, JSON.stringify({ effort: live?.effort, modelName: live?.modelName, costUsd: live?.costUsd }))
  await page.locator('.tab', { hasText: 'Session' }).first().click(); await lib.until(async () => (await page.locator('.tab.active', { hasText: 'Session' }).count()) === 1, 10000)
  const raw = await inv('pty:buffer', lib.ptyKey(proj, agent.id))
  check('no status line text in the terminal', !raw.includes('{}') && !/unauthorized|not found/i.test(raw))
  await page.screenshot({ path: path.join(shots, '5-session.png') })
  const usage = await inv('app:planUsage')
  console.log('plan usage after the session started:', JSON.stringify(usage))
  await inv('session:stop', proj); await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  console.log(results.join('\n'))
  await app.close()
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
})().catch(async (e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
