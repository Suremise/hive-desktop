// The Session tab's toolbar (#975), which replaced the agent strip: Panes | Tiles, remembered per project (project.json
// sessionView), the default for projects that haven't chosen from Settings → Sessions → Default session view, and the
// palette's Switch Between Panes and Tiles; Tiles hides the panes (the terminals keep running) for its view (#976's,
// a placeholder until then). The summary chip counts the agents by state ("1 waiting · 1 working · 2 idle") with the most
// urgent one's mark, and its ▾ lists them most urgent first, each with its state, status and card: a menu that holds the
// focus, its chosen entry named as the active descendant, the chip expanded while it is open; choosing one shows that
// agent (another page too). + Add ▾ has Configure Agent and Add…, Add Agent, Add Agent from Template and Templates. No
// agent tabs are left. Four agents run the fake Claude Code (fake-claude/): one waits for a permission, one works.
// Throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'sessiontoolbar-profile')
const ws = path.join(lib.WORK, 'sessiontoolbar-ws')
const claudeHome = path.join(lib.WORK, 'sessiontoolbar-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.fakeClaude(userData, claudeHome, [alpha, beta])
  const { app, page, inv } = await lib.launch({ userData, env: { CLAUDE_CONFIG_DIR: claudeHome, HIVE_API_PORT: lib.port(47836) }, viewport: { width: 1500, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const projectCfg = (p) => JSON.parse(fs.readFileSync(path.join(p, '.hive', 'project.json'), 'utf8'))
    const select = async (name) => {
      await page.locator('.project-row', { hasText: name }).first().click()
      await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === name, HUNG_MS)
    }
    await select('alpha')
    // Four agents in two columns: two pages. W waits for a permission, X works, Y and Z are idle.
    const ids = {}
    for (const name of ['W', 'X', 'Y', 'Z']) ids[name] = (await lib.addAgent(inv, alpha, { name })).id
    await inv('project:updateConfig', alpha, { layout: 'columns2' })
    for (const name of ['W', 'X']) await inv('session:start', alpha, { agentId: ids[name] })
    for (const name of ['W', 'X']) await lib.until(async () => ['ready', 'waiting'].includes((await live(ids[name]))?.status), HUNG_MS)
    for (const name of ['W', 'X']) if ((await live(ids[name]))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, ids[name]), '\r')
    for (const name of ['W', 'X']) await lib.until(async () => (await live(ids[name]))?.status === 'ready', HUNG_MS)
    const prompts = (name) => lib.fakePrompts(inv, lib.ptyKey(alpha, ids[name]), () => live(ids[name]), { home: claudeHome })
    await prompts('W').type('ask work 300')
    await lib.until(async () => (await live(ids.W))?.status === 'waiting', HUNG_MS)
    await prompts('X').type('work 300')
    await lib.until(async () => (await live(ids.X))?.status === 'working', HUNG_MS)
    await inv('workspace:refresh')

    // --- No agent strip; the toolbar.
    check('no agent tabs are left (#975)', (await page.locator('.agent-tab, .agent-strip').count()) === 0)
    const chip = page.locator('.session-toolbar .summary-chip')
    const chipText = () => page.locator('.session-toolbar .summary-chip-text').innerText().catch(() => '')
    check('the summary chip: 1 waiting · 1 working · 2 idle', !!(await lib.until(async () => (await chipText()) === '1 waiting · 1 working · 2 idle', HUNG_MS)), await chipText())
    check("…with the most urgent state's mark, a diamond", (await chip.locator('.state-mark.waiting').count()) === 1 && /\bwaiting\b/.test((await chip.getAttribute('class')) ?? ''))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.locator('.session-toolbar').screenshot({ path: path.join(lib.WORK, `sessiontoolbar-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })

    // --- The chip's list, from the keyboard: a menu holding the focus, its entry named as the active descendant.
    await chip.focus()
    await page.keyboard.press('Enter')
    const focusState = () =>
      page.evaluate(() => {
        const f = document.activeElement
        const id = f?.getAttribute('aria-activedescendant')
        const chosen = id ? document.getElementById(id) : null
        return { role: f?.getAttribute('role'), chosen: chosen?.getAttribute('role') === 'menuitem' ? chosen.innerText.split('\n')[0].trim() : null, expanded: document.querySelector('.session-toolbar .summary-chip')?.getAttribute('aria-expanded') }
      })
    check('Enter on the chip: its list, the focus in it on W (most urgent), the chip expanded', !!(await lib.until(async () => JSON.stringify(await focusState()) === '{"role":"menu","chosen":"W","expanded":"true"}', HUNG_MS)), JSON.stringify(await focusState()))
    const entries = await page.locator('.menu .menu-item').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.menu-label')?.textContent ?? '', detail: e.querySelector('.menu-detail')?.textContent ?? '', mark: [...(e.querySelector('.state-mark')?.classList ?? [])].join(' ') })))
    check('it lists the agents most urgent first: W (waiting), X (working), then Y and Z in their order', entries.map((e) => e.name).join() === 'W,X,Y,Z', JSON.stringify(entries))
    check('…each with its state in words and its mark', entries[0].detail.startsWith('Waiting for you') && entries[0].mark.includes('waiting') && entries[1].detail.startsWith('Working') && entries[1].mark.includes('working') && entries[2].detail.startsWith('Idle') && entries[3].mark.includes('idle'), JSON.stringify(entries))
    await page.screenshot({ path: path.join(lib.WORK, 'sessiontoolbar-chip-menu.png') })
    // Z is on page 2: ↓ to it, Enter shows it there.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    check('↓ ↓ ↓: Z', (await focusState()).chosen === 'Z', JSON.stringify(await focusState()))
    await page.keyboard.press('Enter')
    const focusedPane = () => page.locator('.pane-header-bar.focused .agent-name').innerText().catch(() => '')
    check('Enter shows Z, on page 2, its pane focused', !!(await lib.until(async () => (await focusedPane()) === 'Z' && (await page.locator('.page-switch button.active').innerText().catch(() => '')).trim() === '2', HUNG_MS)), await focusedPane())
    check('…and the chip is no longer expanded', (await chip.getAttribute('aria-expanded')) === 'false')
    await lib.showAgent(page, 'W')
    check('chosen with the mouse: W, back on page 1', (await focusedPane()) === 'W' && (await page.locator('.page-switch button.active').innerText()).trim() === '1')

    // --- + Add ▾.
    await page.locator('.session-toolbar .add-menu').click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
    const adds = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.split('\n')[0].trim())
    check('+ Add ▾: Configure Agent and Add…, Add Agent, Add Agent from Template, Templates', JSON.stringify(adds) === '["Configure Agent and Add…","Add Agent","Add Agent from Template","Templates"]', JSON.stringify(adds))
    check('…Add Agent with its shortcut', (await lib.menuEntry(page, 'Add Agent').innerText()).includes('Ctrl+Alt+Shift+N'))
    await page.screenshot({ path: path.join(lib.WORK, 'sessiontoolbar-add-menu.png') })
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)

    // --- Panes | Tiles: Tiles hides the panes (the terminals keep running), remembered in project.json.
    const tiles = page.locator('.view-switch [data-view="tiles"]')
    const panes = page.locator('.view-switch [data-view="panes"]')
    check('Panes is the default, and chosen', (await panes.getAttribute('aria-checked')) === 'true' && (await tiles.getAttribute('aria-checked')) === 'false' && projectCfg(alpha).sessionView === undefined)
    await tiles.click()
    check('Tiles: its view in place of the panes, saved for the project', !!(await lib.until(async () => (await page.locator('.agent-tiles').count()) === 1 && (await page.locator('.agents-area.shown').count()) === 0 && projectCfg(alpha).sessionView === 'tiles', HUNG_MS)), JSON.stringify(projectCfg(alpha).sessionView))
    check('…the layouts and pages hidden, the chip and + Add ▾ kept', (await page.locator('.session-toolbar .layout-switch, .session-toolbar .page-switch').count()) === 0 && (await chip.count()) === 1 && (await page.locator('.session-toolbar .add-menu').count()) === 1)
    check('…the agents still running', (await live(ids.X))?.status === 'working' && (await live(ids.W))?.status === 'waiting')
    await page.screenshot({ path: path.join(lib.WORK, 'sessiontoolbar-tiles.png') })
    // Another project hasn't chosen: Panes (the default), and alpha keeps Tiles.
    await select('beta')
    await lib.addAgent(inv, beta, { name: 'B' })
    check('another project shows Panes', !!(await lib.until(async () => (await page.locator('.view-switch [data-view="panes"][aria-checked="true"]').count()) === 1 && (await page.locator('.agent-tiles').count()) === 0, HUNG_MS)))
    // Settings → Sessions → Default session view: Tiles for the projects that haven't chosen.
    await inv('settings:update', { sessions: { defaultView: 'tiles' } })
    check('Default session view Tiles: beta, which never chose, shows Tiles', !!(await lib.until(async () => (await page.locator('.agent-tiles').count()) === 1, HUNG_MS)))
    await page.locator('.view-switch [data-view="panes"]').click()
    check("beta's own choice wins over the default", !!(await lib.until(async () => (await page.locator('.agent-tiles').count()) === 0 && projectCfg(beta).sessionView === 'panes', HUNG_MS)))
    await inv('settings:update', { sessions: { defaultView: 'panes' } })
    await select('alpha')
    check('alpha still shows Tiles, its own choice', !!(await lib.until(async () => (await page.locator('.agent-tiles').count()) === 1, HUNG_MS)))
    // The palette's command switches back.
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill('Switch Between Panes and Tiles')
    await lib.until(async () => (await page.locator('.palette-item', { hasText: 'Switch Between Panes and Tiles' }).count()) > 0, HUNG_MS)
    await page.locator('.palette-item', { hasText: 'Switch Between Panes and Tiles' }).first().click()
    check("the palette's Switch Between Panes and Tiles: back to Panes, saved", !!(await lib.until(async () => (await page.locator('.agent-tiles').count()) === 0 && (await page.locator('.agents-area.shown').count()) === 1 && projectCfg(alpha).sessionView === 'panes', HUNG_MS)))
  } finally {
    await inv('session:stop', alpha).catch(() => undefined)
    await lib.until(async () => (await inv('session:live').catch(() => [])).length === 0, HUNG_MS)
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
