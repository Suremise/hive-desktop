// Templates view and tab, export and import (#127): the Templates view on the activity bar (next to Skills) lists the
// workspace's templates and each project's, with a filter; selecting one shows its agents and layout; Rename…,
// Duplicate… (into another project), Load into Project… (the project chosen, then loading's own confirmation),
// Export… to a test folder (nothing personal in the file), Import… of that file (where to keep it; a name clash offers
// Keep Both), an invalid file refused with the reason, and Delete. A project's Templates tab lists its own and the
// workspace's with their scopes, and loads into that project. Screenshots and reachability at 1700 and 900 px in both
// themes. #271: Edit… in the view (name, description, layout; an agent changed in the Agent Settings dialog, one added
// (a taken name refused), moved, one removed), saved, then loaded: exactly those agents. The file dialogs and the
// Recycle Bin are answered in main (never the real ones). Agents use the fake Claude
// Code (fake-claude/), never started. Dev build, throwaway profile and workspace; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')

const userData = path.join(lib.WORK, 'templateshare-profile')
const ws = path.join(lib.WORK, 'templateshare-ws')
const claudeHome = path.join(lib.WORK, 'templateshare-claude-home')
const exports_ = path.join(lib.WORK, 'templateshare-files')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, exports_]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(exports_, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47921), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const projectCfg = (p) => JSON.parse(fs.readFileSync(path.join(p, '.hive', 'project.json'), 'utf8'))
  const dialog = page.locator('.dialog').last()
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `templateshare-${name}.png`) })
  const sidebar = page.locator('.sidebar')
  // The view's main area (a project's Templates tab has a .tab-body of its own).
  const detail = page.locator('.main-area > .tab-body .template-detail')
  const rowNames = async (where) => (await where.locator('.template-row .label').allInnerTexts()).map((t) => t.split('\n')[0].trim())
  // (Their headers are upper-case by CSS.)
  const groups = async () => (await sidebar.locator('.template-group .skill-group').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
  const templatesOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [])
  const wsTemplates = path.join(ws, '.hive', 'templates')
  const own = (p) => path.join(p, '.hive', 'templates')
  // The file dialogs and the Recycle Bin, answered in main.
  const saveTo = (file) => app.evaluate(({ dialog: d }, f) => { d.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, file)
  const openFile = (file) => app.evaluate(({ dialog: d }, f) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, file)
  await app.evaluate(({ shell }) => {
    const fsm = process.getBuiltinModule('fs')
    shell.trashItem = async (p) => fsm.rmSync(p, { force: true })
  })
  const toast = async (re) => lib.until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => re.test(t)), 5000)

  // --- alpha: Builder (builder) and Reviewer, two columns: "Pair" for the workspace, "Solo" for alpha only.
  await lib.addAgent(inv, alpha, { name: 'Builder', role: 'builder', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  await inv('project:updateConfig', alpha, { layout: 'columns2' })
  await inv('templates:save', alpha, 'workspace', 'Pair', false)
  await inv('templates:save', alpha, 'project', 'Solo', false)
  await lib.addAgent(inv, beta, { name: 'Old' })
  await inv('workspace:refresh')

  // --- The Templates view, next to Skills.
  const bar = await page.locator('.activitybar .activity-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  check('the Templates icon is next to Skills on the activity bar', bar.indexOf('Templates') === bar.indexOf('Skills') + 1, JSON.stringify(bar))
  await page.locator('.activitybar [aria-label="Templates"]').click()
  check('the view lists the workspace\'s templates, then each project\'s under its name', !!(await lib.until(async () => JSON.stringify(await groups()) === '["workspace 1","alpha 1"]', 5000)) && JSON.stringify(await rowNames(sidebar)) === '["Pair","Solo"]', JSON.stringify([await groups(), await rowNames(sidebar)]))
  await sidebar.locator('select[aria-label="Show templates of"]').selectOption({ label: 'alpha' })
  check('the filter shows one project\'s', !!(await lib.until(async () => JSON.stringify(await rowNames(sidebar)) === '["Solo"]', 3000)))
  await sidebar.locator('select[aria-label="Show templates of"]').selectOption({ label: 'All templates' })
  await sidebar.locator('.template-row[aria-label="Pair"]').click()
  await detail.waitFor({ timeout: 5000 })
  const table = (await detail.locator('table tbody tr').allInnerTexts()).map((r) => r.split('\t').map((c) => c.trim()))
  check('selecting one shows its agents (role, model, where they work) and layout', table.length === 2 && table[0][0] === 'Builder' && table[0][1] === 'builder' && table[0][3] === 'opus' && table[0][6] === 'The project folder' && /2 agents, two columns layout/i.test(await detail.innerText()), JSON.stringify(table))
  await shot('1-view')

  // Rename: in place, the file kept.
  await detail.getByRole('button', { name: 'Rename…' }).click()
  await dialog.locator('input.input').fill('Team')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  check('Rename… renames it where it is kept, the file kept', !!(await lib.until(async () => JSON.stringify(await rowNames(sidebar)) === '["Team","Solo"]', 5000)) && JSON.parse(fs.readFileSync(path.join(wsTemplates, 'pair.json'), 'utf8')).name === 'Team')

  // Duplicate into beta.
  await detail.getByRole('button', { name: 'Duplicate…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta (this project only)' })
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click()
  check('Duplicate… copies it into another project', !!(await lib.until(async () => templatesOf(own(beta)).length === 1, 5000)) && !!(await lib.until(async () => JSON.stringify(await groups()) === '["workspace 1","alpha 1","beta 1"]', 5000)), JSON.stringify(await groups()))

  // Load into Project…: the project chosen, then the list of who goes and who comes.
  await sidebar.locator('.template-row[aria-label="Team"]').first().click()
  await detail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const confirmLoad = page.locator('.dialog', { hasText: 'Load "Team"?' })
  await confirmLoad.waitFor({ timeout: 5000 })
  check("…then loading's confirmation, for the chosen project", /Removed:\s*• Old/.test(await confirmLoad.innerText()))
  await confirmLoad.getByRole('button', { name: 'Load template' }).click()
  check('Load into Project… replaces that project\'s agents and layout', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]', 10000)) && projectCfg(beta).layout === 'columns2')

  // Export to a test folder: what the template holds, nothing personal.
  const exported = path.join(exports_, 'Team.hive-template.json')
  await saveTo(exported)
  await detail.getByRole('button', { name: 'Export…' }).click()
  check('Export… writes the template file', !!(await lib.until(async () => fs.existsSync(exported), 5000)) && !!(await toast(/Template exported/)))
  const text = fs.readFileSync(exported, 'utf8')
  const json = JSON.parse(text)
  check('the exported file holds the template and nothing personal (no paths, ids, sessions, user names)', JSON.stringify(Object.keys(json).sort()) === '["agents","layout","name","savedAt","version"]' && !/templateshare|Users|"id"|lastSessionId/i.test(text) && !text.toLowerCase().includes(os.userInfo().username.toLowerCase()), text.slice(0, 200))

  // Import it into alpha: where to keep it asked; again, a clash: Keep Both.
  const importInto = async (label) => {
    await openFile(exported)
    await sidebar.locator('[aria-label="Import Template…"]').click()
    const ask = page.locator('.dialog', { hasText: 'Import "Team"' })
    await ask.waitFor({ timeout: 5000 })
    await ask.locator('select').selectOption({ label })
    await ask.getByRole('button', { name: 'Import', exact: true }).click()
  }
  await importInto('alpha (this project only)')
  check('Import… asks where to keep it, then imports it there', !!(await lib.until(async () => templatesOf(own(alpha)).length === 2, 5000)))
  const importedFile = templatesOf(own(alpha)).find((f) => f !== 'solo.json')
  const imported = JSON.parse(fs.readFileSync(path.join(own(alpha), importedFile), 'utf8'))
  check('export then import round-trips it exactly', JSON.stringify(imported) === JSON.stringify(json), JSON.stringify(imported).slice(0, 200))
  await importInto('alpha (this project only)')
  const clash = page.locator('.dialog', { hasText: 'A template of that name is already there' })
  check('a name already there: Replace or Keep Both', !!(await lib.until(async () => (await clash.count()) === 1, 5000)) && (await clash.getByRole('button', { name: 'Replace' }).count()) === 1)
  await clash.getByRole('button', { name: 'Keep Both' }).click()
  check('Keep Both adds it as "Team (2)"', !!(await lib.until(async () => templatesOf(own(alpha)).map((f) => JSON.parse(fs.readFileSync(path.join(own(alpha), f), 'utf8')).name).sort().join() === 'Solo,Team,Team (2)', 5000)))

  // An invalid file: refused with the reason, nothing asked or written.
  const bad = path.join(exports_, 'future.json')
  fs.writeFileSync(bad, JSON.stringify({ ...json, version: 99 }))
  await openFile(bad)
  const before = templatesOf(wsTemplates).length + templatesOf(own(alpha)).length + templatesOf(own(beta)).length
  await sidebar.locator('[aria-label="Import Template…"]').click()
  check('an invalid file is refused, saying why', !!(await toast(/Could not import the template[\s\S]*newer version of Hive/)) && (await page.locator('.dialog').count()) === 0 && templatesOf(wsTemplates).length + templatesOf(own(alpha)).length + templatesOf(own(beta)).length === before)

  // Delete Team (2).
  await sidebar.locator('.template-row[aria-label="Team (2)"]').click()
  await detail.locator('[aria-label="Delete template"]').click()
  await page.locator('.dialog', { hasText: 'Delete "Team (2)"?' }).getByRole('button', { name: 'Delete' }).click()
  check('Delete removes it (to the Recycle Bin)', !!(await lib.until(async () => templatesOf(own(alpha)).length === 2, 5000)) && !!(await lib.until(async () => !(JSON.stringify(await rowNames(sidebar))).includes('Team (2)'), 5000)))

  // --- alpha's Templates tab: its own and the workspace's, with their scopes; Load goes into alpha.
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await page.locator('.project-row', { hasText: 'alpha' }).first().click()
  await page.locator('.tabs .tab').filter({ has: page.locator('.tab-label', { hasText: /^Templates$/ }) }).click()
  const tab = page.locator('.split-list').filter({ has: page.locator('.pane-header', { hasText: 'Templates' }) })
  await tab.waitFor({ timeout: 5000 })
  // Each row's name and the badge saying where it is kept.
  const tabRows = async () => tab.locator('.template-row .label').evaluateAll((els) => els.map((el) => `${el.firstChild.textContent.trim()}: ${el.querySelector('.badge')?.textContent.trim() ?? ''}`))
  check("the project's tab lists its own and the workspace's, each with its scope", !!(await lib.until(async () => JSON.stringify(await tabRows()) === '["Solo: alpha","Team: alpha","Team: Workspace"]', 5000)), JSON.stringify(await tabRows()))
  await tab.locator('.template-row[aria-label="Solo"]').click()
  const tabDetail = page.locator('.split-main .template-detail')
  const ids = JSON.stringify(projectCfg(alpha).agents.map((a) => a.id))
  await tabDetail.getByRole('button', { name: 'Load into This Project…' }).click()
  const confirmTab = page.locator('.dialog', { hasText: 'Load "Solo"?' })
  await confirmTab.waitFor({ timeout: 5000 })
  await confirmTab.getByRole('button', { name: 'Load template' }).click()
  check("Load into This Project… loads into the tab's project (new agents, as the template has them)", !!(await lib.until(async () => JSON.stringify(projectCfg(alpha).agents.map((a) => a.id)) !== ids, 10000)) && JSON.stringify(projectCfg(alpha).agents.map((a) => a.name)) === '["Builder","Reviewer"]')

  // --- Reachable at 1700 and 900 px, in both themes: the detail's buttons inside the window and clickable.
  const reachable = (sel) =>
    page.evaluate((s) => {
      const els = [...document.querySelectorAll(`${s} .template-detail-actions button`)]
      return els.length > 0 && els.every((el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.right <= window.innerWidth && r.width > 0 && !!t && (t === el || el.contains(t))
      })
    }, sel)
  for (const width of [1700, 900]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 800 })
      await lib.sleep(400)
      check(`${theme}, ${width} px: the tab's template actions are inside the window and clickable`, await reachable('.split-main'))
      await shot(`tab-${width}-${theme}`)
    }
  }
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await sidebar.locator('.template-row[aria-label="Solo"]').click()
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(400)
    check(`${theme}, 900 px: the view's template actions are inside the window and clickable`, await reachable('.main-area > .tab-body'))
    await shot(`view-900-${theme}`)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- #271: Edit… a template in the view: its name, description and layout; Reviewer changed in the Agent Settings
  // dialog (a role, its own worktree), Tester added (a name taken refused), moved up, Builder removed; saved, then loaded
  // into beta: exactly those agents, in that order, with that layout. Both themes.
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await sidebar.locator('.template-row[aria-label="Team"]').first().click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  const editor = page.locator('.main-area > .tab-body .template-editor')
  await editor.waitFor({ timeout: 5000 })
  check('Edit… opens the editor with its agents', JSON.stringify(await editor.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.agent))) === '["Builder","Reviewer"]')
  await editor.locator('#template-name').fill('Team edited')
  await editor.locator('#template-description').fill('Builds, then reviews.')
  await editor.locator('#template-layout').selectOption('columns3')
  await editor.locator('[aria-label="Edit Reviewer…"]').click()
  const agentDialog = page.locator('.dialog', { hasText: 'Reviewer settings (template)' })
  await agentDialog.waitFor({ timeout: 5000 })
  check('…each agent in the Agent Settings dialog (template mode: where it works is a choice)', (await agentDialog.locator('[role="radiogroup"][aria-label="Works in"]').count()) === 1 && (await agentDialog.locator('.provider-choice').count()) === 1)
  await agentDialog.locator('#agent-role').fill('checker')
  await agentDialog.getByRole('radio', { name: 'Its own worktree' }).click()
  await shot('edit-agent-dialog')
  await agentDialog.getByRole('button', { name: 'Save' }).click()
  await lib.until(async () => (await agentDialog.count()) === 0, 3000)
  await editor.getByRole('button', { name: 'Add Agent…' }).click()
  const newAgent = page.locator('.dialog', { hasText: 'New agent (template)' })
  await newAgent.waitFor({ timeout: 5000 })
  await newAgent.locator('input[aria-label="Name"]').fill('reviewer')
  check('…a name another agent of the template has is refused', (await newAgent.getByRole('button', { name: 'Save' }).isDisabled()) && /Another agent of the template is called "reviewer"/.test(await newAgent.innerText()))
  await newAgent.locator('input[aria-label="Name"]').fill('Tester')
  await newAgent.getByRole('button', { name: 'Save' }).click()
  await lib.until(async () => (await newAgent.count()) === 0, 3000)
  await editor.locator('[aria-label="Move Tester up"]').click()
  await editor.locator('[aria-label="Remove Builder"]').click()
  const editedRows = await editor.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.agent))
  check('…added, moved and removed in the editor', JSON.stringify(editedRows) === '["Tester","Reviewer"]', JSON.stringify(editedRows))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`editor-${theme}`)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await editor.getByRole('button', { name: 'Save Template' }).click()
  const teamFile = path.join(wsTemplates, 'pair.json')
  const savedTeam = await lib.until(async () => {
    const j = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
    return j.name === 'Team edited' ? j : null
  }, 5000)
  check('Save Template writes it where it is kept: name, description, layout and the agents in order', !!savedTeam && savedTeam.description === 'Builds, then reviews.' && savedTeam.layout === 'columns3' && JSON.stringify(savedTeam.agents.map((a) => [a.name, a.role ?? '', a.worktree])) === '[["Tester","",false],["Reviewer","checker",true]]', JSON.stringify(savedTeam))
  check('…and the view shows it again, with its description', !!(await lib.until(async () => (await detail.count()) === 1 && /Builds, then reviews\./.test(await detail.innerText()), 5000)))
  await detail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const loadEdited = page.locator('.dialog', { hasText: 'Load "Team edited"?' })
  await loadEdited.waitFor({ timeout: 5000 })
  await loadEdited.getByRole('button', { name: 'Load template' }).click()
  check('loaded into beta: exactly those agents, in order, with that layout', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => [a.name, a.role ?? '', !!a.worktree])) === '[["Tester","",false],["Reviewer","checker",true]]', 15000)) && projectCfg(beta).layout === 'columns3', JSON.stringify(projectCfg(beta).agents))
  // A save made while the editor is open is never overwritten (#271): the draft (a new name) is open; "Team edited" is
  // changed on disk (a description) and the editor's own list refreshes (another template saved, from the palette).
  // The editor says so; Save is refused, keeping both the draft and the change; Discard and Reload shows the change.
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  await editor.locator('#template-name').fill('Local draft')
  const onDisk = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
  fs.writeFileSync(teamFile, JSON.stringify({ ...onDisk, description: 'external change must survive', savedAt: new Date(Date.now() + 1000).toISOString() }, null, 2))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Save Agents as Template')
  await lib.sleep(300)
  await page.keyboard.press('Enter')
  await dialog.locator('input.input').waitFor({ timeout: 5000 })
  await dialog.locator('input.input').fill('Bump')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  check('the editor says the template was saved again meanwhile', !!(await lib.until(async () => (await editor.locator('.template-stale').count()) === 1, 8000)))
  await editor.getByRole('button', { name: 'Save Template' }).click()
  check('…Save is refused, saying why', !!(await lib.until(async () => /changed since you started editing it/.test(await editor.innerText()), 5000)), await editor.innerText())
  const kept = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
  check('…the change made meanwhile survives', kept.description === 'external change must survive' && kept.name === 'Team edited', JSON.stringify(kept))
  check('…and the draft is still open', (await editor.locator('#template-name').inputValue()) === 'Local draft')
  await shot('editor-stale')
  await editor.getByRole('button', { name: 'Discard and Reload' }).click()
  await page.locator('.dialog', { hasText: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click()
  check('Discard and Reload shows it as it is now', !!(await lib.until(async () => (await editor.count()) === 0 && /external change must survive/.test(await detail.innerText()), 5000)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
