// Agent templates (#126): Save Template… on the agent strip (a name; the workspace scope ticked; replacing asks),
// loading into another project (the warning lists who goes and who comes; refused while an agent runs, while a worktree
// agent has uncommitted work, and while a provider the template needs is off), the layout and roles recreated, the
// removed worktree kept, Add Agent from Template (a taken name numbered), and the strip's controls at narrow widths in
// both themes, every one reachable. Agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

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
  const select = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === name, 5000)
  }

  // --- alpha: Builder (role builder) and Reviewer, two columns. Save Template…, for the workspace.
  await select('alpha')
  await lib.addAgent(inv, alpha, { name: 'Builder', role: 'builder', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  await inv('project:updateConfig', alpha, { layout: 'columns3' })
  await inv('workspace:refresh')
  await strip.getByRole('button', { name: 'Save Template…' }).click()
  await dialog.waitFor({ timeout: 5000 })
  await dialog.locator('input.input').fill('Pair')
  await dialog.locator('input[type="checkbox"]').check()
  await page.screenshot({ path: path.join(lib.WORK, 'templates-1-save.png') })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const file = path.join(ws, '.hive', 'templates', 'pair.json')
  check('Save Template… keeps the agents, roles and layout for the workspace', !!(await lib.until(async () => fs.existsSync(file), 5000)) && /"role": "builder"/.test(fs.readFileSync(file, 'utf8')) && /"layout": "columns3"/.test(fs.readFileSync(file, 'utf8')))
  check('without sessions, ids or paths', !/lastSessionId|"id"|templates-ws/.test(fs.readFileSync(file, 'utf8')))
  // The same name again: asks before replacing.
  await strip.getByRole('button', { name: 'Save Template…' }).click()
  await dialog.locator('input.input').fill('pair')
  await dialog.locator('input[type="checkbox"]').check()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const replace = page.locator('.dialog', { hasText: 'Replace the template?' })
  check('saving over a name asks first', !!(await lib.until(async () => (await replace.count()) === 1, 5000)))
  await replace.getByRole('button', { name: 'Replace' }).click()
  await lib.until(async () => JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair', 5000)
  check('…and replaces it', JSON.parse(fs.readFileSync(file, 'utf8')).name === 'pair')

  // --- beta: Old (running) and Tree (a worktree agent with uncommitted work). Loading is refused until both are dealt with.
  await select('beta')
  const old = await lib.addAgent(inv, beta, { name: 'Old' })
  const tree = await lib.addAgent(inv, beta, { name: 'Tree', location: 'new-worktree' })
  await inv('session:start', beta, { agentId: old.id })
  await lib.until(async () => (await live(beta, old.id))?.status === 'ready', 15000)
  fs.writeFileSync(path.join(tree.worktree.path, 'wip.txt'), 'uncommitted')
  await inv('workspace:refresh')
  const loadMenu = async () => {
    await strip.getByRole('button', { name: 'Template', exact: true }).click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
  }
  await loadMenu()
  check('Template ▾ lists the workspace template', (await menuItems()).includes('pair'), JSON.stringify(await menuItems()))
  await item('pair').click()
  const blocked = page.locator('.dialog', { hasText: "Can't load" })
  await blocked.waitFor({ timeout: 5000 })
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
  await blocked.waitFor({ timeout: 5000 })
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
  await warn.waitFor({ timeout: 5000 })
  const text = await warn.innerText()
  check('the warning lists who goes and who comes', /Removed:[\s\S]*Old[\s\S]*Tree \(its worktree and branch hive\/tree stay\)[\s\S]*Created:[\s\S]*Builder — builder[\s\S]*Reviewer/.test(text), text)
  await page.screenshot({ path: path.join(lib.WORK, 'templates-3-warning.png') })
  await warn.getByRole('button', { name: 'Load template' }).click()
  const loaded = await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer"]', 15000)
  check('loading replaces the agents', !!loaded, JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  const b = projectCfg(beta)
  check('…recreating them exactly: role, model, the layout', b.agents[0].role === 'builder' && b.agents[0].model === 'opus' && b.layout === 'columns3', JSON.stringify(b))
  check("the removed worktree agent's worktree stays", fs.existsSync(tree.worktree.path))
  await lib.until(async () => (await page.locator('.agent-tab').allInnerTexts()).join('|').includes('Reviewer'), 5000)

  // --- Add Agent from Template: one agent, the others left alone; Builder's name is taken, so "Builder 2".
  await strip.getByRole('button', { name: 'Add Agent from Template' }).click()
  await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, 5000)
  await item('Builder').click()
  check('Add Agent from Template adds one, numbering a taken name', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["Builder","Reviewer","Builder 2"]', 8000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))
  check('…with its role', projectCfg(beta).agents[2].role === 'builder')

  // --- Narrow: icons, then one Templates menu; every control inside the strip and clickable, in both themes.
  const reachable = async () =>
    page.evaluate(() => {
      const s = document.querySelector('.agent-strip').getBoundingClientRect()
      const els = [...document.querySelectorAll('.template-controls button, .agent-strip button[aria-label="Templates"], .layout-switch button')]
      return els.length > 0 && els.every((el) => {
        const r = el.getBoundingClientRect()
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.right <= window.innerWidth && !!t && (t === el || el.contains(t))
      })
    })
  for (const [width, mode] of [[1700, 'labels or icons'], [1200, 'icons'], [900, 'one menu']]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 900 })
      await lib.sleep(500)
      check(`${theme}, ${width} px (${mode}): the template controls are inside the strip and clickable`, await reachable())
      await page.screenshot({ path: path.join(lib.WORK, `templates-strip-${width}-${theme}.png`) })
    }
  }
  check('at 900 px the controls are one Templates menu', (await strip.locator('button[aria-label="Templates"]').count()) === 1 && (await strip.locator('.template-controls').count()) === 0)
  await strip.locator('button[aria-label="Templates"]').click()
  check('…with Load, Save and Add Agent from Template', JSON.stringify(await menuItems()) === '["Load Template…","Save Template…","Add Agent from Template…"]', JSON.stringify(await menuItems()))
  await page.keyboard.press('Escape')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await inv('session:stop', beta)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
