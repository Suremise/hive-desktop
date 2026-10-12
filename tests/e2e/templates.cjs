// Agent templates (#126, #286): Template ▾ → Save Template… on the agent strip (a name; the workspace scope ticked;
// replacing asks), loading into another project from Template ▾ (the warning lists who goes and who comes; refused while
// an agent runs, while a worktree agent has uncommitted work, and while a provider the template needs is off), the layout
// and roles recreated, the removed worktree kept, Add Agent ▾ → Add Agent from Template (a taken name numbered), with the
// mouse, the keyboard and the palette, and the strip's controls at narrow widths in both themes, every one reachable,
// in the order Template ▾, pages, layouts (#292), with one page and with two. #702: agent names unique across the
// workspace: Add Agent refuses another project's agent's name, offering one, and shows what hive/ in a branch means; a
// template whose names another project's agents have opens with this project's prefix filled in, each name editable, a
// clashing one marked and refused. Agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'templates-profile')
const ws = path.join(lib.WORK, 'templates-ws')
const claudeHome = path.join(lib.WORK, 'templates-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47886), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const projectCfg = (p) => JSON.parse(fs.readFileSync(path.join(p, '.hive', 'project.json'), 'utf8'))
  const strip = page.locator('.agent-strip')
  const dialog = page.locator('.dialog').last()
  const menuItems = async () => (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.split('\n')[0].trim())
  // A menu item by its label exactly (its detail line aside).
  const item = (label) => page.locator('.menu .menu-item').filter({ has: page.getByText(label, { exact: true }) }).first()
  // A menu its button opened, waited for and checked (#663): one that never opened throws instead of the next step failing.
  const menuOpen = async () => {
    if (!(await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS))) throw new Error(`the menu didn't open; the window: ${await page.locator('.project-header h1').innerText().catch(() => '?')}`)
  }
  // Template ▾: Save Template…, a separator, then the templates to load.
  const templateMenu = async () => {
    await strip.getByRole('button', { name: 'Template', exact: true }).click()
    await menuOpen()
  }
  const saveTemplate = async () => {
    await templateMenu()
    await item('Save Template…').click()
  }
  // A dialog that follows a click (a load's confirmation comes once the template's plan, git included, is read):
  // waited for as it shows, bounded only for a hung run (#663). A slow one is logged with how long it took; one that
  // never came throws with what the window showed instead.
  const shown = async (d, what) => {
    const t = Date.now()
    const ok = await lib.until(() => d.isVisible(), HUNG_MS)
    if (Date.now() - t > 2000) console.log(`  (${what} took ${Date.now() - t} ms)`)
    if (!ok) throw new Error(`${what} didn't show; the window: ${await page.locator('.project-header h1').innerText().catch(() => '?')}, dialogs ${JSON.stringify(await page.locator('.dialog').allInnerTexts())}, menu ${JSON.stringify(await menuItems())}`)
  }
  const select = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    const shows = async () => page.locator('.project-header h1').innerText().catch(() => '')
    if (!(await lib.until(async () => (await shows()) === name, HUNG_MS))) throw new Error(`${name} wasn't selected; the window shows ${await shows()}`)
  }

  // --- alpha: Builder (role builder) and Reviewer, two columns. Save Template…, for the workspace.
  await select('alpha')
  await lib.addAgent(inv, alpha, { name: 'Builder', role: 'builder', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  await inv('workspace:refresh')
  await saveTemplate()
  await shown(dialog, 'dialog')
  await dialog.locator('input.input').fill('Pair')
  await dialog.locator('input[type="checkbox"]').check()
  await page.screenshot({ path: path.join(lib.WORK, 'templates-1-save.png') })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const file = path.join(ws, '.hive', 'templates', 'pair.json')
  check('Save Template… keeps the agents, roles and layout for the workspace', !!(await lib.until(async () => fs.existsSync(file), 5000)) && /"role": "builder"/.test(fs.readFileSync(file, 'utf8')) && /"layout": "columns3"/.test(fs.readFileSync(file, 'utf8')))
  check('without sessions, ids or paths', !/lastSessionId|"id"|templates-ws/.test(fs.readFileSync(file, 'utf8')))
  // The same name again: asks before replacing.
  await saveTemplate()
  await dialog.locator('input.input').fill('pair')
  await dialog.locator('input[type="checkbox"]').check()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const replace = page.locator('.dialog', { hasText: 'Replace the template?' })
  check('saving over a name asks first', !!(await lib.until(async () => (await replace.count()) === 1, 5000)))
  await replace.getByRole('button', { name: 'Replace' }).click()
  await lib.until(async () => JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair', 5000)
  check('…and replaces it', JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair')
  // alpha's agents renamed (names are unique across the workspace, #702), so pair's Builder and Reviewer are free in beta.
  for (const a of projectCfg(alpha).agents) await inv('agents:update', alpha, a.id, { name: `Alpha ${a.name.toLowerCase()}` })

  // --- beta: Old (running) and Tree (a worktree agent with uncommitted work). Loading is refused until both are dealt with.
  await select('beta')
  const old = await lib.addAgent(inv, beta, { name: 'Old' })
  const tree = await lib.addAgent(inv, beta, { name: 'Tree', location: 'new-worktree' })
  await inv('session:start', beta, { agentId: old.id })
  await lib.until(async () => (await live(beta, old.id))?.status === 'ready', 15000)
  fs.writeFileSync(path.join(tree.worktree.path, 'wip.txt'), 'uncommitted')
  await inv('workspace:refresh')
  const loadMenu = templateMenu
  await loadMenu()
  check('Template ▾ lists the workspace template', (await menuItems()).includes('pair'), JSON.stringify(await menuItems()))
  const shape = await page.evaluate(() => [...document.querySelector('.menu').children].slice(0, 3).map((el) => el.className.split(' ')[0] + ':' + el.textContent.trim()))
  check('…after Save Template… and a separator', shape[0] === 'menu-item:Save Template…' && shape[1] === 'menu-sep:' && shape[2] === 'menu-header:Workspace templates', JSON.stringify(shape))
  await item('pair').click()
  const blocked = page.locator('.dialog', { hasText: "Can't load" })
  await shown(blocked, 'blocked')
  const why = await blocked.innerText()
  check('refused while Old runs and Tree has uncommitted work', /Old is running or starting: stop it first/.test(why) && /Tree has uncommitted work/.test(why), why)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-2-blocked.png') })
  await blocked.getByRole('button', { name: 'OK' }).click()
  check('nothing changed', JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Old","Tree"]')

  // A provider the template needs is off: refused, saying which.
  fs.mkdirSync(path.join(ws, '.hive', 'templates'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.hive', 'templates', 'codex-pair.json'), JSON.stringify({ version: 1, name: 'Codex pair', savedAt: new Date().toISOString(), layout: 'auto', agents: [{ name: 'Coder', provider: 'codex', worktree: false }] }))
  await loadMenu()
  await item('Codex pair').click()
  await shown(blocked, 'blocked')
  check('refused while a provider it needs is off, saying which', /Codex is turned off.*needed by Coder/.test(await blocked.innerText()), await blocked.innerText())
  await blocked.getByRole('button', { name: 'OK' }).click()

  // Stopped, and the work cleaned up: the warning lists who goes and who comes; loading replaces them.
  await inv('session:stop', beta, old.id)
  await lib.until(async () => !(await live(beta, old.id)), 10000)
  fs.rmSync(path.join(tree.worktree.path, 'wip.txt'))
  await inv('workspace:refresh')
  await loadMenu()
  await item('pair').click()
  const warn = page.locator('.dialog', { hasText: 'Load "pair"?' })
  await shown(warn, 'warn')
  // The plan as a table (#511): a removed agent's line, a created agent's row and its cells, by column.
  const removedLine = async (d, name) => (await d.locator(`.template-plan-removed li[data-agent="${name}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ')
  const planRow = (d, name) => d.locator(`.template-plan-table tbody tr[data-agent="${name}"]`)
  // (An agent's name is a field to edit, #702: its value, then the cell's text.)
  const cells = (d, name) => planRow(d, name).locator('td').evaluateAll((tds) => tds.map((td) => `${td.querySelector('input')?.value ?? ''} ${td.innerText}`.replace(/\s+/g, ' ').trim()))
  const placeOf = async (d, name) => ({ text: (await planRow(d, name).locator('td').last().innerText()).replace(/\s+/g, ' ').trim(), path: (await planRow(d, name).locator('.template-plan-place').getAttribute('data-path').catch(() => null)) ?? '' })
  const created = (d) => d.locator('.template-plan-table tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.agent))
  check('the warning lists who goes and who comes', (await warn.locator('.template-plan-removed li').evaluateAll((l) => l.map((x) => x.dataset.agent))).join() === 'Old,Tree' && /its worktree and branch hive\/tree, merged into \w+ and clean, stay unless you tick below/i.test(await removedLine(warn, 'Tree')) && (await created(warn)).join() === 'Builder,Reviewer' && /^Builder builder$/.test((await cells(warn, 'Builder'))[0]), JSON.stringify([await removedLine(warn, 'Tree'), await created(warn), await cells(warn, 'Builder')]))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-3-warning.png') })
  await warn.getByRole('button', { name: 'Load template' }).click()
  const loaded = await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]', 15000)
  check('loading replaces the agents', !!loaded, JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  const b = projectCfg(beta)
  check('…recreating them exactly: role, model, the layout', b.agents[0].role === 'builder' && b.agents[0].model === 'opus' && b.layout === 'columns3', JSON.stringify(b))
  check("the removed worktree agent's worktree stays", fs.existsSync(tree.worktree.path))
  await lib.until(async () => (await page.locator('.agent-tab').allInnerTexts()).join('|').includes('Reviewer'), 5000)

  // #268: the warning says where each new worktree goes in this project (its branch and folder), marks the agents a new
  // one of the same name replaces, gives each new agent's settings, and the setup command its worktree runs. Cancelled.
  fs.writeFileSync(path.join(ws, '.hive', 'templates', 'trees.json'), JSON.stringify({ version: 1, name: 'Trees', savedAt: new Date().toISOString(), layout: 'columns2', agents: [{ name: 'Builder', provider: 'claude-code', model: 'opus', effort: 'high', worktree: true }, { name: 'Helper', provider: 'claude-code', worktree: false }] }))
  await inv('project:updateConfig', beta, { worktreeSetup: 'npm install' })
  await inv('workspace:refresh')
  await loadMenu()
  await item('Trees').click()
  const treesWarn = page.locator('.dialog', { hasText: 'Load "Trees"?' })
  await shown(treesWarn, 'treesWarn')
  const tw = await treesWarn.innerText()
  const treePath = path.join(`${ws}.worktrees`, 'beta', 'builder')
  check('the warning marks Builder, replaced by a new agent of the same name', /replaced by a new agent with the same name/.test(await removedLine(treesWarn, 'Builder')) && !/replaced/.test(await removedLine(treesWarn, 'Reviewer')), tw)
  // Agent, Coding agent, Model, Effort, Mode, Where; what the template leaves to the defaults marked "(default)".
  const builderCells = await cells(treesWarn, 'Builder')
  const helperCells = await cells(treesWarn, 'Helper')
  check("…gives each new agent's settings in a row (inherited ones as their default)", builderCells[0].startsWith('Builder') && (await planRow(treesWarn, 'Builder').locator('.badge', { hasText: 'new' }).count()) === 1 && builderCells[1] === 'Claude Code' && builderCells[2] === 'Opus 5.5' && builderCells[3] === 'High' && builderCells[4].endsWith(' (default)') && helperCells[2] === 'Opus 5.5 (default)' && helperCells[4].endsWith(' (default)'), JSON.stringify([builderCells, helperCells]))
  const builderPlace = await placeOf(treesWarn, 'Builder')
  check("…and the new worktree's branch, its folder in this project on hover", builderPlace.text === 'own worktree hive/builder' && builderPlace.path.toLowerCase() === treePath.toLowerCase() && (await placeOf(treesWarn, 'Helper')).text === 'project folder', JSON.stringify(builderPlace))
  await planRow(treesWarn, 'Builder').locator('.template-plan-place').hover()
  const tip = page.locator('.tip', { hasText: 'A new worktree in' })
  check('…the full folder in its tooltip', !!(await lib.until(async () => (await tip.count()) === 1 && (await tip.innerText()).toLowerCase().includes(treePath.toLowerCase()), HUNG_MS)), await tip.innerText().catch(() => ''))
  await page.mouse.move(0, 0)
  check('…and the setup command it runs', tw.includes("Each new worktree runs the project's setup command (npm install) before its agent first starts."), tw)
  const planBox = treesWarn.locator('.detail.rich')
  check('the table fits the dialog: no scrolling sideways', await planBox.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `templates-6-load-details-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await treesWarn.getByRole('button', { name: 'Cancel' }).click()
  check('cancelled: nothing changed', JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]' && !fs.existsSync(treePath))
  await inv('project:updateConfig', beta, { worktreeSetup: '' })
  fs.rmSync(path.join(ws, '.hive', 'templates', 'trees.json'))
  // #511: twelve agents, builders with worktrees and reviewers in the project folder (as Darren's 6Bx6R): one row each,
  // in the template's order; the table scrolls down in its box and never sideways. Both themes. Cancelled.
  const twelve = ['HB1', 'HB2', 'HB3', 'HR1', 'HR2', 'HR3', 'HB4', 'HB5', 'HB6', 'HR4', 'HR5', 'HR6']
  fs.writeFileSync(path.join(ws, '.hive', 'templates', 'twelve.json'), JSON.stringify({ version: 1, name: 'Twelve', savedAt: new Date().toISOString(), layout: 'grid', agents: twelve.map((name) => ({ name, provider: 'claude-code', worktree: name.startsWith('HB') })) }))
  await inv('workspace:refresh')
  await loadMenu()
  await item('Twelve').click()
  const twelveWarn = page.locator('.dialog', { hasText: 'Load "Twelve"?' })
  await shown(twelveWarn, 'twelveWarn')
  check('twelve agents: a row each, in the order of the template', (await created(twelveWarn)).join() === twelve.join(), JSON.stringify(await created(twelveWarn)))
  check('…builders in their own worktrees, reviewers in the project folder', (await placeOf(twelveWarn, 'HB1')).text === 'own worktree hive/hb1' && (await placeOf(twelveWarn, 'HR6')).text === 'project folder')
  const twelveBox = twelveWarn.locator('.detail.rich')
  check('…the table scrolls in its box, never sideways', await twelveBox.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `templates-10-twelve-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await twelveWarn.getByRole('button', { name: 'Cancel' }).click()
  fs.rmSync(path.join(ws, '.hive', 'templates', 'twelve.json'))

  // --- Add Agent ▾ → Add Agent from Template: one agent, the others left alone; Builder's name is taken, so "Builder 2".
  const caret = strip.locator('.agent-add.split-caret')
  await caret.click()
  await menuOpen()
  check('Add Agent ▾ offers Configure Agent and Add… and Add Agent from Template', JSON.stringify(await menuItems()) === '["Configure Agent and Add…","Add Agent from Template"]', JSON.stringify(await menuItems()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-4-add-menu.png') })
  await item('Add Agent from Template').click()
  await lib.until(async () => (await menuItems()).includes('Builder'), 5000)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-5-add-from.png') })
  await item('Builder').click()
  check('Add Agent from Template adds one, numbering a taken name', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer","Builder 2"]', 8000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  check('…with its role', projectCfg(beta).agents[2].role === 'builder')
  await lib.until(async () => (await page.locator('.agent-tab').count()) === 3, 5000)
  // The main part is Configure Agent and Add…: the dialog, nothing added until it's confirmed.
  await strip.locator('.agent-add:not(.split-caret)').click()
  const addDialog = page.locator('.dialog', { hasText: 'Add an agent' })
  check("Add Agent's main click opens the Add Agent dialog", !!(await lib.until(async () => (await addDialog.count()) === 1, 5000)))
  await lib.sleep(500)
  check('…without adding an agent', projectCfg(beta).agents.length === 3, JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  // #702: another project's agent's name is refused, saying whose, with a free one to use.
  const nameField = addDialog.locator('.agent-form input.input').first()
  await nameField.fill('alpha builder')
  const taken = addDialog.locator('[data-name-taken]')
  check("Add Agent refuses another project's agent's name, saying whose", !!(await lib.until(async () => /alpha already has an agent called Alpha builder: agent names are unique across the workspace\. Use alpha builder \(beta\)/.test(await taken.innerText().catch(() => '')), HUNG_MS)) && (await addDialog.getByRole('button', { name: 'Add Agent' }).isDisabled()), await taken.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-11-name-taken.png') })
  await taken.locator('a').click()
  check('…and its suggestion fills the name in', (await nameField.inputValue()) === 'alpha builder (beta)' && (await taken.count()) === 0 && (await addDialog.getByRole('button', { name: 'Add Agent' }).isEnabled()), await nameField.inputValue())
  // New worktree: what hive/ in its branch means.
  await addDialog.locator('label.choice', { hasText: 'New worktree' }).locator('input[type="radio"]').check()
  const hint = addDialog.locator('[data-branch-hint]')
  check('Add Agent says what hive/ in a branch means', !!(await lib.until(async () => (await hint.innerText().catch(() => '')) === 'hive/ marks branches Hive made, so it can reuse and tidy them up.', HUNG_MS)), await hint.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-12-branch-hint.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await addDialog.count()) === 0, HUNG_MS)

  // The keyboard: Enter on ▾ opens the menu on its first entry, ↓ moves, → opens Add Agent from Template, Enter adds.
  const active = () => page.locator('.menu .menu-item.active').innerText().then((t) => t.split('\n')[0].trim(), () => '')
  await caret.focus()
  await page.keyboard.press('Enter')
  await menuOpen()
  check('Enter on Add Agent ▾ opens its menu on Configure Agent and Add…', (await active()) === 'Configure Agent and Add…', await active())
  await page.keyboard.press('ArrowDown')
  check('↓ moves to Add Agent from Template', (await active()) === 'Add Agent from Template', await active())
  await page.keyboard.press('ArrowRight')
  await lib.until(async () => (await menuItems()).includes('Reviewer'), 5000)
  const first = (await page.locator('.menu .menu-item:not(.disabled)').first().innerText()).split('\n')[0].trim()
  check('→ opens the template agents on the first one', (await active()) === first, `${await active()} / ${first}`)
  for (let i = 0; i < 12 && (await active()) !== 'Reviewer'; i++) await page.keyboard.press('ArrowDown')
  check('→ opens the template agents, ↓ reaches Reviewer', (await active()) === 'Reviewer', await active())
  await page.keyboard.press('Enter')
  check('Enter adds it', !!(await lib.until(async () => projectCfg(beta).agents.map((a) => a.name).includes('Reviewer 2'), 8000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  await lib.until(async () => (await page.locator('.agent-tab').count()) === 4, 5000)

  // The palette: Load Template… and Add Agent from Template… open the strip's menus, on their first entry.
  const palette = async (label) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill(label)
    await lib.sleep(300)
    await page.locator('.palette-item', { hasText: label }).first().click()
    await menuOpen()
  }
  await palette('Load Template…')
  check('the palette\'s Load Template… opens Template ▾ on Save Template…', (await active()) === 'Save Template…' && (await menuItems()).includes('pair'), `${await active()} ${JSON.stringify(await menuItems())}`)
  await page.keyboard.press('Escape')
  await palette('Add Agent from Template…')
  check('the palette\'s Add Agent from Template… lists the template agents', (await menuItems()).includes('Builder') && (await active()) !== '', `${await active()} ${JSON.stringify(await menuItems())}`)
  await page.keyboard.press('Escape')

  // --- Narrow: Template ▾ labelled, then its icon; Add Agent, Template ▾ and the layouts inside the strip and clickable, in both themes.
  const reachable = async () =>
    page.evaluate(() => {
      const s = document.querySelector('.agent-strip').getBoundingClientRect()
      const els = [...document.querySelectorAll('.agent-strip .split-btn button, .template-controls button, .page-switch button, .layout-switch button')]
      return els.length > 0 && els.every((el) => {
        const r = el.getBoundingClientRect()
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.right <= window.innerWidth && !!t && (t === el || el.contains(t))
      })
    })
  const labelled = () => strip.getByRole('button', { name: 'Template', exact: true }).innerText().then((t) => t.includes('Template'))
  // Left to right, none overlapping the next: Add Agent, Template ▾, the pages (when there are two or more), the layouts (#292).
  const order = () =>
    page.evaluate(() => {
      const els = ['.agent-strip .split-btn', '.agent-strip .template-controls', '.agent-strip .page-switch', '.agent-strip .layout-switch'].map((s) => document.querySelector(s)).filter(Boolean)
      const boxes = els.map((el) => el.getBoundingClientRect())
      return { names: els.map((el) => el.className.split(' ').find((c) => c !== 'segmented')), inOrder: boxes.every((box, i) => i === 0 || boxes[i - 1].right <= box.left + 0.5) }
    })
  for (const [width, mode] of [[1700, 'labelled'], [1200, 'labelled'], [900, 'icon']]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 900 })
      await lib.sleep(500)
      check(`${theme}, ${width} px (${mode}): the strip's controls are inside it and clickable`, await reachable())
      check(`…Template ▾ ${mode}`, (await labelled()) === (mode === 'labelled'))
      const o = await order()
      check('…in the order Add Agent, Template ▾, pages, layouts, none overlapping', o.inOrder && JSON.stringify(o.names) === '["split-btn","template-controls","page-switch","layout-switch"]', JSON.stringify(o))
      await page.screenshot({ path: path.join(lib.WORK, `templates-strip-${width}-${theme}.png`) })
    }
  }
  // One page (the grid of six shows all four): no page buttons, Template ▾ beside the layouts.
  await inv('project:updateConfig', beta, { layout: 'grid6' })
  await inv('workspace:refresh')
  await lib.until(async () => (await strip.locator('.page-switch').count()) === 0, 5000)
  for (const width of [1700, 900]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 900 })
      await lib.sleep(500)
      const o = await order()
      check(`${theme}, ${width} px, one page: Add Agent, Template ▾, layouts, none overlapping, all clickable`, o.inOrder && JSON.stringify(o.names) === '["split-btn","template-controls","layout-switch"]' && (await reachable()), JSON.stringify(o))
      await page.screenshot({ path: path.join(lib.WORK, `templates-strip-1page-${width}-${theme}.png`) })
    }
  }
  await inv('project:updateConfig', beta, { layout: 'columns3' })
  await inv('workspace:refresh')
  await lib.until(async () => (await strip.locator('.page-switch').count()) === 1, 5000)
  await templateMenu()
  check('at 900 px Template ▾ still has Save Template… and the templates', (await menuItems())[0] === 'Save Template…' && (await menuItems()).includes('pair'), JSON.stringify(await menuItems()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-strip-900-menu.png') })
  await page.keyboard.press('Escape')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await inv('session:stop', beta)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)

  // --- #268: alpha's own template, with a worktree agent ("Tree", on alpha's hive/tree), loaded into beta from the
  // Templates view. beta's new Tree gets a new worktree of beta's: beta already has a hive/tree branch and a tree folder
  // (its earlier Tree's, kept) with uncommitted work, so not that one (#289) but hive/tree-2 in …worktrees\beta\tree-2,
  // as the confirmation said, with why. alpha's is untouched. Then (#289) a template in between and back: Tree works in
  // a clean worktree of its name again, no new one.
  await select('alpha')
  const srcTree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  await inv('workspace:refresh')
  await saveTemplate()
  await shown(dialog, 'dialog')
  await dialog.locator('input.input').fill('Alpha trees')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const alphaTrees = path.join(alpha, '.hive', 'templates', 'alpha-trees.json')
  check("alpha's own template saved, with its worktree agent (and no path or branch)", !!(await lib.until(async () => fs.existsSync(alphaTrees), 5000)) && /"name": "Tree",[\s\S]*"worktree": true/.test(fs.readFileSync(alphaTrees, 'utf8')) && !/hive\/tree|worktrees/.test(fs.readFileSync(alphaTrees, 'utf8')))
  // alpha's Tree renamed after saving (its worktree stays), so the template's Tree is free in beta; its other two aren't.
  await inv('agents:update', alpha, srcTree.id, { name: 'Alpha tree' })
  const srcCfg = JSON.stringify(projectCfg(alpha).agents.find((a) => a.id === srcTree.id).worktree)
  const want = path.join(`${ws}.worktrees`, 'beta', 'tree-2')
  const oldTree = path.join(`${ws}.worktrees`, 'beta', 'tree')
  check("beta already has a hive/tree branch and a tree folder (its earlier Tree's)", lib.git(beta, ['branch', '--list', 'hive/tree']).includes('hive/tree') && fs.existsSync(oldTree))
  fs.writeFileSync(path.join(oldTree, 'wip.txt'), 'unfinished')
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await page.locator('.sidebar .template-row[aria-label="Alpha trees"]').first().click()
  const tplDetail = page.locator('.main-area > .tab-body .template-detail')
  await tplDetail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const crossLoad = page.locator('.dialog', { hasText: 'Load "Alpha trees"?' })
  await shown(crossLoad, 'crossLoad')
  // #702: its names are alpha's agents': beta's prefix (B) is filled in for them all, each name editable.
  const nameInputs = crossLoad.locator('.template-plan-name-input')
  const namesNow = () => nameInputs.evaluateAll((l) => l.map((x) => x.value))
  check("names alpha's agents have: beta's prefix filled in", (await crossLoad.locator('#template-prefix').inputValue()) === 'B' && JSON.stringify(await namesNow()) === '["BAlpha builder","BAlpha reviewer","BTree"]', JSON.stringify(await namesNow()))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-13-prefix.png') })
  // Another prefix renames them all; a name alpha has is marked, and the load refused (the dialog stays, saying why).
  await crossLoad.locator('#template-prefix').fill('Beta ')
  check('…another prefix renames them all', JSON.stringify(await namesNow()) === '["Beta Alpha builder","Beta Alpha reviewer","Beta Tree"]', JSON.stringify(await namesNow()))
  await nameInputs.nth(0).fill('Alpha builder')
  check("…a name alpha's agent has is marked", /alpha has an agent called Alpha builder/.test(await crossLoad.locator('.template-plan-table .field-error').first().innerText().catch(() => '')))
  await crossLoad.getByRole('button', { name: 'Load template' }).click()
  check('…and refused, saying why', !!(await lib.until(async () => /Agent names are unique across the workspace/.test(await crossLoad.innerText()), HUNG_MS)) && JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer","Builder 2","Reviewer 2"]', await crossLoad.innerText())
  await page.screenshot({ path: path.join(lib.WORK, 'templates-14-name-refused.png') })
  // Each name its own: Tree keeps its name, so its worktree is found by it.
  await nameInputs.nth(0).fill('BAB')
  await nameInputs.nth(1).fill('BAR')
  await nameInputs.nth(2).fill('Tree')
  const placeSettled = async (name, wanted) => lib.until(async () => wanted.test((await placeOf(crossLoad, name).catch(() => ({ text: '' }))).text), HUNG_MS)
  await placeSettled('Tree', /^own worktree hive\/tree-2/)
  const cl = await placeOf(crossLoad, 'Tree')
  check("the confirmation gives Tree's new worktree in beta: hive/tree-2 in …worktrees\\beta\\tree-2", cl.text.startsWith('own worktree hive/tree-2') && cl.path.toLowerCase() === want.toLowerCase(), `${want}\n${JSON.stringify(cl)}`)
  check('…not the kept hive/tree, saying why (#289)', cl.text.includes('new: hive/tree has 1 uncommitted file'), cl.text)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-7-cross-project.png') })
  // (Refused once above, its button says Try Again.)
  await crossLoad.getByRole('button', { name: 'Try Again' }).click()
  check("loaded into beta: alpha's agents, with the names chosen", !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["BAB","BAR","Tree"]', 15000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  const made = projectCfg(beta).agents.find((a) => a.name === 'Tree')?.worktree
  check("beta's Tree is where the confirmation said: hive/tree-2 in …worktrees\\beta\\tree-2", made?.branch === 'hive/tree-2' && made.path.toLowerCase() === want.toLowerCase(), JSON.stringify(made))
  const norm = (p) => p.toLowerCase().replace(/\\/g, '/')
  check("…a worktree and branch of beta's repository", norm(lib.git(beta, ['worktree', 'list', '--porcelain'])).includes(norm(want)) && lib.git(beta, ['branch', '--list', 'hive/tree-2']).includes('hive/tree-2'))
  check("…not of alpha's", !norm(lib.git(alpha, ['worktree', 'list', '--porcelain'])).includes(norm(want)) && !lib.git(alpha, ['branch', '--list', 'hive/tree-2']).includes('hive/tree-2'))
  check("alpha's Tree and its worktree are untouched", JSON.stringify(projectCfg(alpha).agents.find((a) => a.id === srcTree.id).worktree) === srcCfg && fs.existsSync(srcTree.worktree.path) && lib.git(srcTree.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === srcTree.worktree.branch && norm(made.path) !== norm(srcTree.worktree.path))
  check('the kept worktree with uncommitted work is still there, its work too', fs.readFileSync(path.join(oldTree, 'wip.txt'), 'utf8') === 'unfinished')

  // --- #289: "pair" in between (Tree replaced, its worktree kept), then "Alpha trees" again: Tree works in a clean
  // worktree of its name again, and none is made. The kept hive/tree is clean now too: of the two, the unnumbered one.
  fs.rmSync(path.join(oldTree, 'wip.txt'))
  const hiveBranches = () => lib.git(beta, ['branch', '--list', 'hive/*']).split('\n').map((s) => s.replace('*', '').trim()).filter(Boolean).sort().join(',')
  const branchesBefore = hiveBranches()
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await select('beta')
  await loadMenu()
  await item('pair').click()
  const toPair = page.locator('.dialog', { hasText: 'Load "pair"?' })
  await shown(toPair, 'toPair')
  check('replaced by "pair", Tree\'s worktree stays', /its worktree and branch hive\/tree-2, merged into \w+ and clean, stay unless you tick below/i.test(await removedLine(toPair, 'Tree')), await removedLine(toPair, 'Tree'))
  await toPair.getByRole('button', { name: 'Load template' }).click()
  await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]', 15000)
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await page.locator('.sidebar .template-row[aria-label="Alpha trees"]').first().click()
  await tplDetail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await shown(crossLoad, 'crossLoad')
  await nameInputs.nth(2).fill('Tree')
  await placeSettled('Tree', /^reuses /)
  const back = await placeOf(crossLoad, 'Tree')
  check('back to "Alpha trees": the confirmation says Tree reuses its clean worktree on hive/tree', back.text === 'reuses hive/tree' && back.path.toLowerCase() === oldTree.toLowerCase(), JSON.stringify(back))
  await page.screenshot({ path: path.join(lib.WORK, 'templates-8-reuse.png') })
  await crossLoad.getByRole('button', { name: 'Load template' }).click()
  await lib.until(async () => projectCfg(beta).agents.some((a) => a.name === 'Tree'), 15000)
  const reattached = projectCfg(beta).agents.find((a) => a.name === 'Tree')?.worktree
  check('…and works in it: no new worktree or branch', norm(reattached?.path ?? '') === norm(oldTree) && reattached.branch === 'hive/tree' && hiveBranches() === branchesBefore, `${JSON.stringify(reattached)} ${hiveBranches()} / ${branchesBefore}`)

  // --- #289: "pair" again: Tree's worktree (hive/tree: nothing of its own, so merged, and clean) is offered for removal,
  // unticked; ticked, it goes with its branch once the load is done.
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await select('beta')
  await loadMenu()
  await item('pair').click()
  await shown(toPair, 'toPair')
  const tick = toPair.locator('.dialog-check input[type="checkbox"]')
  const tickLabel = (await toPair.locator('.dialog-check').innerText().catch(() => '')).trim()
  check('the dialog offers to remove the merged, clean old worktree, unticked', /^Also remove the old worktree and its branch \(merged into \w+ and clean\): hive\/tree$/.test(tickLabel) && !(await tick.isChecked()), tickLabel)
  check('…and says so on its line', /its worktree and branch hive\/tree, merged into \w+ and clean, stay unless you tick below/i.test(await removedLine(toPair, 'Tree')), await removedLine(toPair, 'Tree'))
  await tick.check()
  await page.screenshot({ path: path.join(lib.WORK, 'templates-9-remove-old.png') })
  await toPair.getByRole('button', { name: 'Load template' }).click()
  await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]', 15000)
  // The removal runs once the load is published (after the agents change), and the notice says it is over: waited for
  // first, as a slow machine can take a while over the git checks.
  check('ticked: the load says the old worktree went', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'Removed an old worktree' }).count()) === 1, 30000)))
  check('…and it and its branch are gone', !fs.existsSync(oldTree) && !lib.git(beta, ['branch', '--list', 'hive/tree']).includes('hive/tree'))
  check('…and nothing else: the other kept worktree stays', fs.existsSync(want) && lib.git(beta, ['branch', '--list', 'hive/tree-2']).includes('hive/tree-2'))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
