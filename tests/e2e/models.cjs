// Models and capabilities from the CLIs (#125): the fake Claude Code answers the initialize request and the fake Codex
// `debug models`, each with the recorded reply of the real CLI (tests/fixtures), and the pickers show exactly those
// models; effort pickers offer the selected model's own levels (a choice it doesn't take stays, marked); the footer
// shows a model's default effort ("Medium (default)"); with the CLI unavailable, the fallback lists in Settings apply,
// and editing them and Reset to defaults work; prices can be added, removed and reset. Dev build, throwaway profile,
// workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'models-profile')
const ws = path.join(lib.WORK, 'models-ws')
const claudeHome = path.join(lib.WORK, 'models-claude-home')
const codexHome = path.join(lib.WORK, 'models-codex-home')
const alpha = path.join(ws, 'alpha')
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8'))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = FAKE_CLAUDE
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47930), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const info = async (p) => (await inv('provider:info'))[p]
  const update = (patch) => inv('settings:update', patch)

  // --- What the CLIs said.
  await lib.waitForProvider(inv, 'claude-code')
  await lib.waitForProvider(inv, 'codex')
  const reported = fixture('claude-initialize.json').response.response.models.filter((m) => m.value !== 'default')
  const claude = await info('claude-code')
  check('Claude Code: its models are the ones it reported (fake 2.1.999, the recorded 2.1.289 reply)', claude.catalog?.source === 'cli' && claude.catalog.version === '2.1.999' && JSON.stringify(claude.catalog.models.map((m) => m.value)) === JSON.stringify(reported.map((m) => m.value)), JSON.stringify(claude.catalog))
  check("…and its default model is the one it runs when none is passed", claude.defaultModel === 'claude-opus-5-5', claude.defaultModel)
  const codex = await info('codex')
  check('Codex: its models include gpt-6.1-sol, without the hidden ones', codex.catalog?.models.some((m) => m.value === 'gpt-6.1-sol') && !codex.catalog.models.some((m) => m.value === 'gpt-reserve'), JSON.stringify(codex.catalog?.models.map((m) => m.value)))

  // --- Settings → Claude Code: the pickers.
  await page.keyboard.press('Control+,')
  const openSection = async (name) => {
    await page.locator('.settings-nav .row', { hasText: name }).first().click()
    await lib.sleep(400)
  }
  await openSection('Claude Code')
  const modelSelect = page.locator('.model-picker select').first()
  const options = async (sel) => sel.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled })))
  const offered = (await options(modelSelect)).map((o) => o.value).filter((v) => v && v !== 'custom')
  check('the Claude Code model picker lists exactly the reported models, Fable included', JSON.stringify(offered) === JSON.stringify(reported.map((m) => m.value)) && offered.includes('fable'), JSON.stringify(offered))
  check('Settings says where the models come from', (await page.locator('.fallback-source', { hasText: 'Models now: From Claude Code 2.1.999' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'models-claude-settings.png') })

  const effortSelect = page.locator('select.effort-picker').first()
  const effortValues = async () => (await options(effortSelect)).map((o) => o.value).filter(Boolean)
  await update({ providers: { 'claude-code': { defaultModel: 'claude-opus-4-6' } } })
  await lib.sleep(300)
  check("with Opus 4.6, the effort picker offers its levels (no Extra high)", JSON.stringify(await effortValues()) === JSON.stringify(['low', 'medium', 'high', 'max']), JSON.stringify(await effortValues()))
  await update({ providers: { 'claude-code': { defaultModel: 'haiku' } } })
  await lib.sleep(300)
  check('with Haiku, none: it has no effort setting, and says so', (await effortValues()).length === 0 && (await page.locator('.effort-caveat', { hasText: 'Haiku 4.5 has no effort setting' }).count()) === 1, JSON.stringify(await effortValues()))
  // A choice the model doesn't take stays chosen, marked, never changed behind the user's back.
  await update({ providers: { 'claude-code': { defaultModel: 'claude-opus-4-6', defaultEffort: 'xhigh' } } })
  await lib.sleep(300)
  const unsupported = (await options(effortSelect)).find((o) => o.value === 'xhigh')
  check("an effort the model doesn't take stays, marked as such", (await effortSelect.inputValue()) === 'xhigh' && /not offered with Opus 4\.6/.test(unsupported?.label ?? '') && (await page.locator('.effort-caveat', { hasText: "doesn't offer Extra high with Opus 4.6" }).count()) === 1, JSON.stringify(unsupported))
  await page.screenshot({ path: path.join(lib.WORK, 'models-effort-unsupported.png') })
  // Both themes: the warning and the lists in light too.
  const light = async (file) => {
    await update({ appearance: { theme: 'light' } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, file) })
    await update({ appearance: { theme: 'dark' } })
    await lib.sleep(200)
  }
  await light('models-effort-unsupported-light.png')
  await update({ providers: { 'claude-code': { defaultModel: '', defaultEffort: '' } } })

  // --- Settings → Codex.
  await openSection('Codex')
  const codexOffered = (await options(page.locator('.model-picker select').first())).map((o) => o.value)
  check('the Codex model picker includes gpt-6.1-sol', codexOffered.includes('gpt-6.1-sol') && !codexOffered.includes('gpt-reserve'), JSON.stringify(codexOffered))
  await update({ providers: { codex: { defaultModel: 'gpt-5.5' } } })
  await lib.sleep(300)
  check('with GPT-5.5, the Codex effort picker stops at Extra high', JSON.stringify(await effortValues()) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), JSON.stringify(await effortValues()))
  await update({ providers: { codex: { defaultModel: '' } } })

  // --- The footer: a model's default effort when nothing is set or reported.
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.addAgent(inv, alpha, { name: 'Sol', provider: 'codex', model: 'gpt-6-sol', permissionMode: 'approve-for-me' })
  const footer = page.locator('.pane-footer-bar').first()
  const shown = await lib.until(async () => /Medium \(default\)/.test((await footer.innerText().catch(() => '')) + (await footer.locator('[title]').evaluateAll((es) => es.map((e) => e.getAttribute('title')).join(' ')).catch(() => ''))), 8000)
  check("the footer shows the model's default effort: Medium (default)", !!shown, await footer.innerText().catch(() => ''))

  // --- Without the CLI: the fallback lists, as edited, and Reset to defaults.
  await page.keyboard.press('Control+,')
  await openSection('Claude Code')
  const modelsRow = page.locator('.fallback-table', { has: page.locator('.fallback-source', { hasText: 'Models now' }) })
  // While the CLI answers and the list is Hive's own, it is folded.
  check("the models fallback is folded while the CLI's answer is in use", (await modelsRow.locator('.fallback-toggle', { hasText: /Show the list \(\d+ models\)/ }).count()) === 1 && (await modelsRow.locator('.fallback-list').count()) === 0)
  await modelsRow.locator('.fallback-toggle').click()
  await modelsRow.getByLabel("New model id").fill('claude-test-9')
  await modelsRow.getByRole('button', { name: 'Add' }).click()
  await lib.until(async () => ((await update({})).providers['claude-code'].modelFallback ?? []).some((m) => m.value === 'claude-test-9'), 3000)
  const edited = (await update({})).providers['claude-code'].modelFallback ?? []
  check('adding a model stores the list as yours (the shipped ones and yours)', edited.at(-1)?.value === 'claude-test-9' && edited.some((m) => m.value === 'opus'), JSON.stringify(edited.map((m) => m.value)))
  // The CLI can't be asked: one that gives its version but answers nothing else (a missing path would have Hive look
  // for the machine's own Claude Code, which a test never uses).
  const broken = path.join(lib.WORK, 'models-broken-claude', 'claude.cmd')
  fs.mkdirSync(path.dirname(broken), { recursive: true })
  fs.writeFileSync(broken, ['@echo off', 'if "%1"=="--version" (', '  echo 2.1.998 ^(Claude Code^)', '  exit /b 0', ')', 'exit /b 1', ''].join('\r\n'))
  await update({ providers: { 'claude-code': { executablePath: broken } } })
  await inv('provider:refresh', 'claude-code')
  await lib.until(async () => { const i = await info('claude-code'); return !i.checking && i.version === '2.1.998' && !i.catalog }, 20000)
  check('the broken CLI is the one Hive uses, and it gave no models', (await info('claude-code')).version === '2.1.998' && !(await info('claude-code')).catalog, JSON.stringify((await info('claude-code')).version))
  const fallbackOffered = (await options(page.locator('.model-picker select').first())).map((o) => o.value)
  check('without the CLI, the picker offers your fallback list', fallbackOffered.includes('claude-test-9') && !fallbackOffered.includes('claude-sonnet-5'), JSON.stringify(fallbackOffered))
  check('…and Settings says so', (await page.locator('.fallback-source', { hasText: "Fallback (Claude Code couldn't be asked), as you edited it" }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'models-fallback.png') })
  await modelsRow.locator('.fallback-source').scrollIntoViewIfNeeded()
  await light('models-fallback-light.png')
  await modelsRow.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !(await update({})).providers['claude-code'].modelFallback, 3000)
  const shipped = await page.locator('.model-picker select').first().locator('optgroup').evaluateAll((gs) => gs.map((g) => g.label))
  check("Reset to defaults: Hive's own list again", !(await update({})).providers['claude-code'].modelFallback && shipped[0] === 'Latest (follows new releases)', JSON.stringify(shipped))
  // The effort fallback: renamed levels name the pickers' options.
  const effortsRow = page.locator('.fallback-table', { has: page.locator('.fallback-source', { hasText: /levels|per-model/ }) })
  if (await effortsRow.locator('.fallback-toggle').count()) await effortsRow.locator('.fallback-toggle').click()
  await effortsRow.getByLabel('Name 1').fill('Quick')
  await effortsRow.getByLabel('Name 1').blur()
  await lib.until(async () => ((await update({})).providers['claude-code'].effortFallback ?? [])[0]?.label === 'Quick', 3000)
  check('a renamed effort level names the effort picker option', (await options(effortSelect)).some((o) => o.value === 'low' && o.label === 'Quick'), JSON.stringify(await options(effortSelect)))
  await effortsRow.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !(await update({})).providers['claude-code'].effortFallback, 3000)
  check('…and Reset to defaults names it Low again', (await options(effortSelect)).some((o) => o.value === 'low' && o.label === 'Low'))

  // --- Prices: add, remove, reset.
  const prices = page.locator('.fallback-table', { has: page.locator('.price-table') })
  check('the price table says when its prices were checked', (await prices.locator('.fallback-source', { hasText: /checked \d{4}-\d{2}-\d{2}/ }).count()) === 1)
  await prices.getByLabel("New model's ID").fill('claude-test-9')
  await prices.getByRole('button', { name: 'Add model' }).click()
  await lib.until(async () => !!(await update({})).providers['claude-code'].prices['claude-test-9'], 3000)
  await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).getByRole('button', { name: 'Remove from the table' }).click()
  await lib.until(async () => ((await update({})).providers['claude-code'].pricesRemoved ?? []).includes('claude-haiku-4-5'), 3000)
  const afterEdit = await update({})
  check('a model added and a shipped one removed', !!afterEdit.providers['claude-code'].prices['claude-test-9'] && afterEdit.providers['claude-code'].pricesRemoved?.includes('claude-haiku-4-5') && (await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).count()) === 0)
  await prices.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !Object.keys((await update({})).providers['claude-code'].prices).length, 3000)
  const afterReset = await update({})
  check("Reset to defaults: Hive's prices again", !Object.keys(afterReset.providers['claude-code'].prices).length && !afterReset.providers['claude-code'].pricesRemoved && (await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).count()) === 1)

  // The CLI back: its models again.
  await update({ providers: { 'claude-code': { executablePath: FAKE_CLAUDE } } })
  await inv('provider:refresh', 'claude-code')
  await lib.until(async () => (await info('claude-code')).catalog?.source === 'cli', 15000)
  check('with the CLI back, its models again', (await info('claude-code')).catalog?.source === 'cli')

  await app.close()
  if (failed) console.log(`${failed} failed`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
