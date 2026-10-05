// The project header's batch actions and tidy-up (#216): Stop (All), Start New (All) and Archive and Start New (All)
// beside Resume; Explorer and Terminal in the ⋯ menu (Changes out of it); the Session menu and the palette have both new
// actions; the Project menu lists every tab in the strip's order; thin dividers between agent tabs (none beside the
// focused one, the page-start marker kept). Three agents run the fake Claude Code (fake-claude/): one working, one idle,
// one stopped. Start New (All) asks once (the working one flagged), Cancel changes nothing, and then every agent has a
// new session with the old ones kept; Archive and Start New (All) archives each agent's session and starts fresh ones.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'startall-profile')
const ws = path.join(lib.WORK, 'startall-ws')
const claudeHome = path.join(lib.WORK, 'startall-claude-home')
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
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47884), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const type = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  // Starts an agent (trusting its folder) and has one exchange, so it has a conversation.
  const run = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status))
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready')
    await type(id, 'hello')
    return until(async () => (await live(id))?.status === 'finished')
  }
  const sessions = async () => inv('session:list', alpha)

  await page.getByText('alpha', { exact: true }).first().click()
  const w = await lib.addAgent(inv, alpha, { name: 'Worker' })
  const i = await lib.addAgent(inv, alpha, { name: 'Idle' })
  const s = await lib.addAgent(inv, alpha, { name: 'Stopped' })
  for (const a of [w, i, s]) check(`${a.name} ran once`, !!(await run(a.id)))
  await inv('session:stop', alpha, s.id)
  check('Stopped stopped', !!(await until(async () => !(await live(s.id)))))
  await type(w.id, 'work 120')
  check('Worker is working', !!(await until(async () => (await live(w.id))?.status === 'working')))
  const before = { w: (await live(w.id)).sessionId, i: (await live(i.id)).sessionId }
  await inv('workspace:refresh')

  // --- The header: Active · Resume · Stop (All) · Start New (All) · Archive and Start New (All) · ⋯
  const header = page.locator('.project-header .actions')
  const labels = async () => (await header.locator('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
  check('the header shows Resume, Stop (All), Start New (All) and Archive and Start New (All), in that order', !!(await until(async () => JSON.stringify(await labels()) === JSON.stringify(['Resume Agent', 'Stop (All)', 'Start New (All)', 'Archive and Start New (All)']), 5000)), JSON.stringify(await labels()))
  check('no Explorer or Terminal button in the header', (await header.locator('button', { hasText: /Explorer|Terminal/ }).count()) === 0)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // Narrower: the actions turn to icons (named for screen readers and in their tooltips) and the title gives way; at the
  // narrowest window Hive supports (900 px, sidebar and rails open), every action is inside the header, on screen and
  // the thing under its own centre, in both themes. With the Assistant's panel open too, the batch actions go into ⋯.
  const actionsAt = async () => {
    const buttons = await header.locator('button, label').all()
    return (await Promise.all(
      buttons.map((b) =>
        b.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const h = el.closest('.project-header').getBoundingClientRect()
          const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (el.tagName === 'BUTTON' && el.closest('label')) return null
          return { width: Math.round(h.width), name: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim(), inside: r.left >= h.left - 0.5 && r.right <= h.right + 0.5 && r.right <= window.innerWidth, hit: !!t && (t === el || el.contains(t)) }
        })
      )
    )).filter(Boolean)
  }
  const allReachable = (list) => list.length > 0 && list.every((a) => a.inside && a.hit)
  await lib.fitWindow(app, page, { width: 1020, height: 900 })
  await lib.sleep(500)
  const narrowNew = header.getByRole('button', { name: 'Start New (All)', exact: true })
  const narrowArchive = header.getByRole('button', { name: 'Archive and Start New (All)' })
  check('narrow: Start New (All) and Archive and Start New (All) are icons with their names', (await narrowNew.count()) === 1 && (await narrowArchive.count()) === 1 && !(await narrowNew.innerText()).trim() && !(await narrowArchive.innerText()).trim(), JSON.stringify(await labels()))
  check('narrow (1020 px): every action is in the header and clickable', allReachable(await actionsAt()), JSON.stringify(await actionsAt()))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-narrow.png') })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.fitWindow(app, page, { width: 900, height: 900 })
    await lib.sleep(500)
    const at = await actionsAt()
    check(`${theme}, 900 px: Active, Resume, Stop (All), Start New (All), Archive and Start New (All) and ⋯ are all in the header and clickable`, JSON.stringify(at.map((a) => a.name)) === JSON.stringify(['Active', 'Resume Agent', 'Stop (All)', 'Start New (All)', 'Archive and Start New (All)', 'More actions']) && allReachable(at), JSON.stringify(at))
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-900-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.sleep(300)
  // Really clicked at 900 px: Start New (All) asks (Cancel), and ⋯ opens with Explorer and Terminal.
  await header.getByRole('button', { name: 'Start New (All)', exact: true }).click()
  const asked = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  check('900 px: Start New (All) opens its question', !!(await lib.until(async () => (await asked.count()) === 1, 5000)))
  await asked.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const narrowItems = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('900 px: ⋯ opens, with Explorer and Terminal', narrowItems.includes('Explorer') && narrowItems.includes('Terminal'), JSON.stringify(narrowItems))
  await page.keyboard.press('Escape')
  // The Assistant's panel open too: the batch actions are in ⋯, and what stays in the header is all reachable.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.sleep(600)
  const cramped = await actionsAt()
  check('900 px with the Assistant open (a squeezed main area): the batch actions leave the header, the rest stays reachable (wrapping if it must)', !cramped.some((a) => /Start New/.test(a.name)) && allReachable(cramped), JSON.stringify(cramped))
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const crampedItems = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('…and are at the top of ⋯', JSON.stringify(crampedItems.slice(0, 4)) === JSON.stringify(['Start New (All)', 'Archive and Start New (All)', 'Explorer', 'Terminal']), JSON.stringify(crampedItems))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-cramped.png') })
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(400)

  // --- ⋯: Explorer, Terminal, Project Settings, Remove Project… (Changes is a tab).
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const items = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('⋯ has Explorer, Terminal, Project Settings and Remove Project…, without Changes', JSON.stringify(items) === JSON.stringify(['Explorer', 'Terminal', 'Project Settings', 'Remove Project…']), JSON.stringify(items))
  await page.keyboard.press('Escape')

  // --- Menus: the Project menu lists every tab in the strip's order; the Session menu has both new actions.
  const menuItems = async (name) => {
    await page.locator('.menubar .menubar-item', { hasText: name }).click()
    await lib.sleep(250)
    const t = await page.locator('.menu .menu-item > span:not(.menu-key)').allInnerTexts()
    await page.keyboard.press('Escape')
    return t.map((x) => x.trim())
  }
  const project = await menuItems('Project')
  const tabs = project.filter((t) => t.startsWith('Go to '))
  check('the Project menu lists all 12 tabs in the strip order', JSON.stringify(tabs) === JSON.stringify(['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Images', 'Changes', 'Memory', 'Skills', 'MCP', 'Project Settings'].map((t) => `Go to ${t}`)), JSON.stringify(tabs))
  check('and Explorer and Terminal', project.some((t) => /Explorer/.test(t)) && project.some((t) => /Terminal/.test(t)), JSON.stringify(project))
  const session = await menuItems('Session')
  check('the Session menu has Start New (All)… and Archive and Start New (All)…', session.includes('Start New (All)…') && session.includes('Archive and Start New (All)…') && session.includes('Archive Session and Start New…'), JSON.stringify(session))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('(All)')
  await lib.sleep(300)
  const found = await page.locator('.palette-item').allInnerTexts()
  check('the palette has both', found.some((t) => t.includes('Start New (All)…')) && found.some((t) => t.includes('Archive and Start New (All)…')), JSON.stringify(found))
  await page.keyboard.press('Escape')

  // --- Dividers between agent tabs: none beside the focused one (Worker, first), one between Idle and Stopped.
  await page.locator('.agent-tab', { hasText: 'Worker' }).click()
  await lib.sleep(300)
  const divider = (name) => page.locator('.agent-tab', { hasText: name }).evaluate((el) => {
    const b = getComputedStyle(el, '::before')
    return b.content !== 'none' && b.display !== 'none' && b.borderLeftWidth === '1px'
  })
  check('a divider between Idle and Stopped', await divider('Stopped'))
  check('none beside the focused tab (Worker | Idle)', !(await divider('Idle')))
  check('none before the first tab', !(await divider('Worker')))
  await page.locator('.agent-tab', { hasText: 'Idle' }).hover()
  await lib.sleep(200)
  const hoverBg = await page.locator('.agent-tab', { hasText: 'Idle' }).evaluate((el) => getComputedStyle(el).backgroundColor)
  check('hover still highlights the tab', hoverBg !== 'rgba(0, 0, 0, 0)', hoverBg)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.locator('.agent-strip, .agent-tabs').first().screenshot({ path: path.join(lib.WORK, `startall-tabs-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(0, 0)

  // --- Start New (All): one question listing every agent, the working one flagged; Cancel changes nothing.
  const dialog = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  await header.getByRole('button', { name: 'Start New (All)', exact: true }).click()
  await dialog.waitFor({ timeout: 5000 })
  const text = await dialog.innerText()
  check('it lists every agent, flagging the working one', /Worker — Working.*\(will be interrupted\)/.test(text) && /Idle — /.test(text) && /Stopped — not running/.test(text), text)
  await page.screenshot({ path: path.join(lib.WORK, 'startall-confirm.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(1500) // on purpose: nothing may stop or start after Cancel
  check('Cancel changes nothing', (await live(w.id))?.sessionId === before.w && (await live(w.id))?.status === 'working' && (await live(i.id))?.sessionId === before.i && !(await live(s.id)))
  await header.getByRole('button', { name: 'Start New (All)', exact: true }).click()
  await dialog.waitFor({ timeout: 5000 })
  await dialog.getByRole('button', { name: 'Start new' }).click()
  const fresh = await until(async () => {
    const l = await Promise.all([w, i, s].map((a) => live(a.id)))
    return l.every((x) => x && ['ready', 'waiting'].includes(x.status)) && l[0].sessionId !== before.w && l[1].sessionId !== before.i ? l : null
  }, 30000)
  check('every agent has a new session', !!fresh, JSON.stringify(await Promise.all([w, i, s].map((a) => live(a.id)))))
  const list = await sessions()
  check('the old sessions are kept, not archived', [before.w, before.i].every((id) => list.some((x) => x.id === id && !x.archived)), JSON.stringify(list.map((x) => [x.id.slice(0, 8), x.archived])))

  // --- Archive and Start New (All): each agent's session archived, fresh ones started.
  for (const a of [w, i, s]) {
    if ((await live(a.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
    await until(async () => (await live(a.id))?.status === 'ready')
    await type(a.id, 'hello')
    await until(async () => (await live(a.id))?.status === 'finished')
  }
  const current = Object.fromEntries(await Promise.all([w, i, s].map(async (a) => [a.id, (await live(a.id)).sessionId])))
  await type(w.id, 'work 120')
  await until(async () => (await live(w.id))?.status === 'working')
  const archiveDialog = page.locator('.dialog', { hasText: 'Archive and start new for all agents?' })
  await header.getByRole('button', { name: 'Archive and Start New (All)' }).click()
  await archiveDialog.waitFor({ timeout: 5000 })
  const archiveText = await archiveDialog.innerText()
  check('Archive asks once, listing the agents with sessions, the working one flagged', /Worker — Working.*\(will be interrupted\)/.test(archiveText) && /Idle — /.test(archiveText) && /Stopped — /.test(archiveText) && /\.hive\/archive/.test(archiveText), archiveText)
  await archiveDialog.getByRole('button', { name: 'Archive and start new' }).click()
  const renewed = await until(async () => {
    const l = await Promise.all([w, i, s].map((a) => live(a.id)))
    return l.every((x) => x && x.sessionId !== current[x.agentId] && ['ready', 'waiting'].includes(x.status))
  }, 30000)
  check('every agent has a fresh session', !!renewed)
  const after = await sessions()
  const archivedIds = Object.values(current).filter((id) => after.some((x) => x.id === id && x.archived))
  check("each agent's session was archived", archivedIds.length === 3, JSON.stringify(after.map((x) => [x.id.slice(0, 8), x.archived])))
  check('in .hive/archive', fs.existsSync(path.join(alpha, '.hive', 'archive')) && fs.readdirSync(path.join(alpha, '.hive', 'archive'), { recursive: true }).length > 0)
  check('no failure notice', (await page.locator('.toast.error').count()) === 0)

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
