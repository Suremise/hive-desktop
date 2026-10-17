// The project header's batch actions and tidy-up (#216, #974): Resume and Stop beside the Active switch, and Start New,
// Archive and Start New and Remove All for every agent in its Agents ▾ menu, each saying how many agents it acts on
// ("Stop (2)", #275, also in the Session menu and the palette), the same agents its question lists, following agents as
// they start and stop; the state line ("1 waiting · 2 working", #974); folding at narrow widths (icons, then Agents ▾'s
// actions in ⋯); Explorer, Terminal and Project Settings in the ⋯ menu; the Session menu and the palette have both new
// actions; the Project menu lists every tab and Project Settings; thin dividers between agent tabs (none beside the
// focused one, the page-start marker kept). Three agents run the fake Claude Code (fake-claude/): one working, one idle,
// one stopped. Start New (All) asks once (the working one flagged), Cancel changes nothing, and then every agent has a
// new session with the old ones kept; Archive and Start New (All) archives each agent's session and starts fresh ones.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

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

  const PORT = lib.port(47884)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
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
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status), HUNG_MS)
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    await type(id, 'hello')
    return until(async () => (await live(id))?.status === 'finished', HUNG_MS)
  }
  const sessions = async () => inv('session:list', alpha)

  await page.getByText('alpha', { exact: true }).first().click()
  const w = await lib.addAgent(inv, alpha, { name: 'Worker' })
  const i = await lib.addAgent(inv, alpha, { name: 'Idle' })
  const s = await lib.addAgent(inv, alpha, { name: 'Stopped' })
  for (const a of [w, i, s]) check(`${a.name} ran once`, !!(await run(a.id)))
  await inv('session:stop', alpha, s.id)
  check('Stopped stopped', !!(await until(async () => !(await live(s.id)), HUNG_MS)))
  await type(w.id, 'work 120')
  check('Worker is working', !!(await until(async () => (await live(w.id))?.status === 'working', HUNG_MS)))
  const before = { w: (await live(w.id)).sessionId, i: (await live(i.id)).sessionId }
  await inv('workspace:refresh')

  // --- The header (#974): Active · Resume · Stop (2) · Agents ▾ · ⋯ (two running, one stopped with a session to resume;
  // all three have one to archive), and its state line from the agents' marks.
  const header = page.locator('.project-header .actions')
  const labels = async () => (await header.locator('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
  check('the header shows Resume Agent, Stop (2) and Agents, in that order', !!(await until(async () => JSON.stringify(await labels()) === JSON.stringify(['Resume Agent', 'Stop (2)', 'Agents']), 5000)), JSON.stringify(await labels()))
  const stateLine = page.locator('.project-header .project-state')
  check('its state line: 1 working (idle agents left out), with the working mark', !!(await until(async () => (await stateLine.innerText().catch(() => '')).trim() === '1 working' && (await stateLine.locator('.state-mark.working').count()) === 1, 5000)), await stateLine.innerText().catch(() => ''))
  const tipOf = async (name) => {
    await header.getByRole('button', { name, exact: true }).hover()
    const tip = page.locator('.tip')
    await tip.waitFor({ timeout: 3000 }).catch(() => undefined)
    const t = (await tip.count()) ? (await tip.innerText()).trim() : null
    await page.mouse.move(0, 0)
    await lib.until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    return t
  }
  check('the tooltips keep the full meaning', (await tipOf('Stop (2)')) === 'Stop the 2 running agents' && /Actions on all the project's agents/.test((await tipOf('Agents')) ?? ''), `${await tipOf('Stop (2)')} / ${await tipOf('Agents')}`)
  check('no Explorer or Terminal button in the header', (await header.locator('button', { hasText: /Explorer|Terminal/ }).count()) === 0)
  // Agents ▾: the batch actions with their counts, Remove All last after a line; each in its action's colour (#344).
  check('Agents ▾ has Start New (3), Archive and Start New (3) and Remove All (3)…', JSON.stringify(await lib.agentsMenu(page)) === JSON.stringify(['Start New (3)', 'Archive and Start New (3)', 'Remove All (3)…']))
  const acts = () => page.locator('.menu .menu-item').evaluateAll((items) => items.map((m) => [...m.classList].find((c) => c.startsWith('act-')) ?? 'none'))
  check("each entry wears its action's colour", JSON.stringify(await acts()) === JSON.stringify(['act-start', 'act-archive-start', 'act-remove']), JSON.stringify(await acts()))
  check('…with a line before Remove All', !!(await page.locator('.menu > *').evaluateAll((els) => els.at(-2)?.classList.contains('menu-sep'))))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, 5000)
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-${theme}.png`), clip: { x: 0, y: 0, width: 1500, height: 260 } })
  }
  await page.keyboard.press('Escape')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // From the keyboard (#974): Enter on Agents ▾ opens it with the focus in the menu, its chosen entry named as the active
  // descendant (what a screen reader announces) and the button expanded; ↓ moves it; Escape closes it and gives the focus
  // back to the button.
  const agentsButton = page.locator('.project-header .agents-menu')
  await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
  await agentsButton.focus()
  await page.keyboard.press('Enter')
  const focusState = () =>
    page.evaluate(() => {
      const f = document.activeElement
      const id = f?.getAttribute('aria-activedescendant')
      const chosen = id ? document.getElementById(id) : null
      return { role: f?.getAttribute('role') ?? f?.tagName, chosen: chosen?.getAttribute('role') === 'menuitem' ? chosen.innerText.trim() : null, expanded: document.querySelector('.project-header .agents-menu')?.getAttribute('aria-expanded'), onButton: f?.classList.contains('agents-menu') ?? false }
    })
  const opened = await lib.until(async () => {
    const f = await focusState()
    return f.role === 'menu' && f.chosen === 'Start New (3)' && f.expanded === 'true' ? f : null
  }, HUNG_MS)
  check('Enter on Agents ▾: the focus is in the menu, on Start New (3) as its active descendant, the button expanded', !!opened, JSON.stringify(await focusState()))
  await page.keyboard.press('ArrowDown')
  check('↓: the active descendant is Archive and Start New (3)', !!(await lib.until(async () => (await focusState()).chosen === 'Archive and Start New (3)', HUNG_MS)), JSON.stringify(await focusState()))
  await page.keyboard.press('Escape')
  check('Escape: the menu closes, the focus back on Agents ▾, no longer expanded', !!(await lib.until(async () => {
    const f = await focusState()
    return (await page.locator('.menu').count()) === 0 && f.onButton && f.expanded === 'false'
  }, HUNG_MS)), JSON.stringify(await focusState()))
  await page.evaluate(() => document.activeElement?.blur())
  // Narrower: the actions turn to icons (named for screen readers and in their tooltips) and the title gives way; at the
  // narrowest window Hive supports (900 px, sidebar and rails open), every action is inside the header, on screen and
  // the thing under its own centre, in both themes. With the Assistant's panel open too, Agents ▾'s actions go into ⋯.
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
  check('narrow (1020 px): every action is in the header and clickable', !!(await lib.until(async () => allReachable(await actionsAt()), 5000)), JSON.stringify(await actionsAt()))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-narrow.png'), clip: { x: 0, y: 0, width: 1020, height: 120 } })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.fitWindow(app, page, { width: 900, height: 900 })
    const names = ['Active', 'Resume Agent', 'Stop (2)', 'Agents', 'More actions']
    const at = (await lib.until(async () => {
      const a = await actionsAt()
      return JSON.stringify(a.map((x) => x.name)) === JSON.stringify(names) && allReachable(a) ? a : null
    }, 5000)) || (await actionsAt())
    check(`${theme}, 900 px: Active, Resume, Stop (2), Agents ▾ and ⋯ are all in the header and clickable`, JSON.stringify(at.map((a) => a.name)) === JSON.stringify(names) && allReachable(at), JSON.stringify(at))
    check(`${theme}, 900 px: the header keeps one row`, (await page.locator('.project-header').evaluate((el) => el.getBoundingClientRect().height)) < 48)
    await page.screenshot({ path: path.join(lib.WORK, `startall-header-900-${theme}.png`), clip: { x: 0, y: 0, width: 900, height: 120 } })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // Really clicked at 900 px: Start New asks (Cancel), and ⋯ opens with Explorer and Terminal.
  await lib.agentsMenuRun(page, 'Start New (3)')
  const asked = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  check('900 px: Start New opens its question', !!(await lib.until(async () => (await asked.count()) === 1, 5000)))
  await asked.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const narrowItems = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('900 px: ⋯ opens with Explorer and Terminal first', JSON.stringify(narrowItems.slice(0, 2)) === JSON.stringify(['Explorer', 'Terminal']), JSON.stringify(narrowItems))
  await page.keyboard.press('Escape')
  // The Assistant's panel open too: Agents ▾'s actions are in ⋯, and what stays in the header is all reachable.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const cramped = (await lib.until(async () => {
    const a = await actionsAt()
    return !a.some((x) => x.name === 'Agents') && allReachable(a) ? a : null
  }, 5000)) || (await actionsAt())
  check("900 px with the Assistant open (a squeezed main area): Agents ▾ leaves the header, the rest stays reachable (wrapping if it must)", !cramped.some((a) => a.name === 'Agents') && allReachable(cramped), JSON.stringify(cramped))
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const crampedItems = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('…and its actions are at the top of ⋯', JSON.stringify(crampedItems.slice(0, 5)) === JSON.stringify(['Start New (3)', 'Archive and Start New (3)', 'Remove All (3)…', 'Explorer', 'Terminal']), JSON.stringify(crampedItems))
  await page.screenshot({ path: path.join(lib.WORK, 'startall-header-cramped.png') })
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.until(async () => (await page.locator('.project-header .agents-menu').count()) === 1, 5000)

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
  check('the Project menu lists the 12 tabs in the strip order, and Project Settings', JSON.stringify(tabs) === JSON.stringify(['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Attachments', 'Git', 'Memory', 'Skills', 'Templates', 'MCP', 'Project Settings'].map((t) => `Go to ${t}`)), JSON.stringify(tabs))
  check('and Explorer and Terminal', project.some((t) => /Explorer/.test(t)) && project.some((t) => /Terminal/.test(t)), JSON.stringify(project))
  const session = await menuItems('Session')
  check('the Session menu has Start New (3)… and Archive and Start New (3)…', session.includes('Start New (3)…') && session.includes('Archive and Start New (3)…') && session.includes('Archive Session and Start New…'), JSON.stringify(session))
  const palette = async () => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').fill('Start New')
    await lib.sleep(300)
    const found = await page.locator('.palette-item').allInnerTexts()
    // The palette's first Escape clears what was typed (#433), the next closes it.
    await page.keyboard.press('Escape')
    if (await page.locator('.palette').count()) await page.keyboard.press('Escape')
    return found
  }
  const found = await palette()
  check('the palette has both, with their counts', found.some((t) => t.includes('Start New (3)…')) && found.some((t) => t.includes('Archive and Start New (3)…')), JSON.stringify(found))

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

  // The confirms' agents are a table (#572): each row's cells by its agent's name; the plain lines stay for screen readers.
  const tableOf = (d) =>
    d.locator('table.agents-table').evaluate((t) => ({
      heads: [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()),
      rows: Object.fromEntries([...t.querySelectorAll('tbody tr[data-agent]')].map((r) => [r.dataset.agent, [...r.children].map((c) => ({ text: c.textContent.trim(), warn: c.classList.contains('agents-table-warn') }))])),
      hidden: t.closest('[aria-hidden="true"]') !== null
    }))
  const plainLines = (d) => d.locator('.agents-detail .visually-hidden').innerText()
  const bothThemes = async (name) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, `${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  // --- Stop (2): the running agents as a table, Agent · State · Card, its card named; Cancel changes nothing.
  const card = (await inv('tasks:create', { title: 'Batch tables', project: 'alpha', column: 'doing', agent: w.id })).number
  // Once the window's board has it: the Worker's tab shows the card.
  await until(async () => (await page.locator(`.agent-tab[data-agent="${w.id}"]`).innerText().catch(() => '')).includes(`#${card}`), HUNG_MS)
  // Idle reviews another card (started with its own token, as its CLI would): its row says "reviewing #n …".
  const reviewed = (await inv('tasks:create', { title: 'Review table', project: 'alpha', column: 'review', agent: s.id })).number
  const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const idleToken = launches().filter((l) => l.sessionId === before.i).at(-1)?.env?.HIVE_API_TOKEN
  const startReview = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${reviewed}`, { method: 'PATCH', headers: { Authorization: `Bearer ${idleToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ review: 'start' }) })
  check('Idle starts reviewing a card', !!idleToken && startReview.status === 200, `${!!idleToken} ${startReview.status}`)
  await until(async () => (await page.locator(`.agent-tab[data-agent="${i.id}"]`).innerText().catch(() => '')).includes(`#${reviewed}`), HUNG_MS)
  // What a screen reader gets: the accessibility tree's text (the table is hidden from it, so a cell is never said twice).
  const cdp = await page.context().newCDPSession(page)
  const axTexts = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter((n) => !n.ignored).map((n) => n.name?.value ?? '')
  const stopDialog = page.locator('.dialog', { hasText: 'Stop all agents?' })
  await header.getByRole('button', { name: 'Stop (2)', exact: true }).click()
  await stopDialog.waitFor({ timeout: 5000 })
  const stopTable = await tableOf(stopDialog)
  check('Stop all lists the running agents as a table: Agent, State, Card', JSON.stringify(stopTable.heads) === JSON.stringify(['Agent', 'State', 'Card']) && JSON.stringify(Object.keys(stopTable.rows).sort()) === JSON.stringify(['Idle', 'Worker']), JSON.stringify(stopTable))
  check("…the Worker's card in its row, and the one Idle reviews in its", stopTable.rows.Worker?.[2]?.text === `#${card} Batch tables` && /Working/.test(stopTable.rows.Worker?.[1]?.text ?? '') && stopTable.rows.Idle?.[2]?.text === `reviewing #${reviewed} Review table`, JSON.stringify(stopTable.rows))
  const stopAx = await axTexts()
  check('…a screen reader gets each card too, the reviewed one as such', stopAx.some((t) => t.includes(`• Worker — Working`) && t.includes(`card #${card} Batch tables`)) && stopAx.some((t) => t.includes(`• Idle — `) && t.includes(`card reviewing #${reviewed} Review table`)), JSON.stringify(stopAx.filter((t) => t.includes('•'))))
  // The table itself is out of the accessibility tree, so no cell of it is said twice.
  const tableIgnored = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.dialog table.agents-table' })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    return nodes.length > 0 && nodes.every((n) => n.ignored)
  }
  check('…and the table itself is ignored by screen readers, so nothing is said twice', (await tableIgnored()) && !stopAx.includes(`#${card} Batch tables`), JSON.stringify(stopAx.filter((t) => /Batch tables/.test(t))))
  check('…the table hidden from screen readers, its plain lines for them instead, and the note under it', stopTable.hidden && /• Worker — Working/.test(await plainLines(stopDialog)) && /conversations are kept/.test(await stopDialog.locator('.agents-detail-note').innerText()))
  await bothThemes('startall-stop-confirm')
  await stopDialog.getByRole('button', { name: 'Cancel' }).click()
  await stopDialog.waitFor({ state: 'detached', timeout: 5000 })
  check('…and Cancel stops nobody', (await live(w.id))?.status === 'working' && !!(await live(i.id)))

  // --- Start New (All): one question listing every agent, the working one flagged; Cancel changes nothing.
  const dialog = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
  await lib.agentsMenuRun(page, 'Start New (3)')
  await dialog.waitFor({ timeout: 5000 })
  const text = await dialog.innerText()
  check('it lists every agent, flagging the working one', /Worker — Working.*\(will be interrupted\)/.test(text) && /Idle — /.test(text) && /Stopped — Not running · A new session/.test(text), text)
  const newTable = await tableOf(dialog)
  const newAx = await axTexts()
  check('…a screen reader gets each agent with its card and what happens to it', newAx.some((t) => t.includes(`• Worker — Working`) && t.includes(`card #${card} Batch tables`) && t.includes('Stopped (will be interrupted), then a new session')) && newAx.some((t) => t.includes(`card reviewing #${reviewed} Review table`)), JSON.stringify(newAx.filter((t) => t.includes('•'))))
  check('…as a table: Agent, State, Card, What happens', JSON.stringify(newTable.heads) === JSON.stringify(['Agent', 'State', 'Card', 'What happens']) && Object.keys(newTable.rows).length === 3, JSON.stringify(newTable))
  check('…the working one stopped first, in the warning colour; the stopped one only starts', newTable.rows.Worker?.[3]?.text === 'Stopped (will be interrupted), then a new session' && newTable.rows.Worker[3].warn && newTable.rows.Stopped?.[3]?.text === 'A new session' && !newTable.rows.Stopped[3].warn && newTable.rows.Stopped?.[1]?.text === 'Not running', JSON.stringify(newTable.rows))
  await bothThemes('startall-confirm')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(1500) // on purpose: nothing may stop or start after Cancel
  check('Cancel changes nothing', (await live(w.id))?.sessionId === before.w && (await live(w.id))?.status === 'working' && (await live(i.id))?.sessionId === before.i && !(await live(s.id)))
  await lib.agentsMenuRun(page, 'Start New (3)')
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
    await until(async () => (await live(a.id))?.status === 'ready', HUNG_MS)
    await type(a.id, 'hello')
    await until(async () => (await live(a.id))?.status === 'finished', HUNG_MS)
  }
  const current = Object.fromEntries(await Promise.all([w, i, s].map(async (a) => [a.id, (await live(a.id)).sessionId])))
  await type(w.id, 'work 120')
  await until(async () => (await live(w.id))?.status === 'working', HUNG_MS)
  const archiveDialog = page.locator('.dialog', { hasText: 'Archive and start new for all agents?' })
  await lib.agentsMenuRun(page, 'Archive and Start New (3)')
  await archiveDialog.waitFor({ timeout: 5000 })
  const archiveText = await archiveDialog.innerText()
  const archiveTable = await tableOf(archiveDialog)
  check('Archive lists them as a table too, saying each session is archived', archiveTable.rows.Worker?.[3]?.text === 'Stopped (will be interrupted), then its session archived, then a new one' && Object.keys(archiveTable.rows).length === 3, JSON.stringify(archiveTable.rows))
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

  // --- The counts follow the agents (#275): Idle and Stopped stop (after an exchange, so each has a session to resume).
  for (const a of [i, s]) {
    if ((await live(a.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
    await until(async () => (await live(a.id))?.status === 'ready', HUNG_MS)
    await type(a.id, 'hello')
    await until(async () => (await live(a.id))?.status === 'finished', HUNG_MS)
    await inv('session:stop', alpha, a.id)
    await until(async () => !(await live(a.id)), HUNG_MS)
  }
  await inv('workspace:refresh')
  check('one running, two to resume: Resume All Agents (2), Stop Agent, Agents', !!(await until(async () => JSON.stringify(await labels()) === JSON.stringify(['Resume All Agents (2)', 'Stop Agent', 'Agents']), 10000)), JSON.stringify(await labels()))
  check('…and Resume says which in its tooltip', (await tipOf('Resume All Agents (2)')) === 'Resume the 2 stopped agents (running ones are left alone)')
  // The count is what the question lists.
  await lib.agentsMenuRun(page, 'Archive and Start New (3)')
  await archiveDialog.waitFor({ timeout: 5000 })
  const listed = (await archiveDialog.innerText()).split('\n').filter((l) => l.startsWith('• '))
  check('Archive and Start New (3) lists 3 agents', listed.length === 3, JSON.stringify(listed))
  await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
  // Idle resumes: two running again, one to resume.
  await header.getByRole('button', { name: 'Resume All Agents (2)' }).waitFor({ timeout: 5000 })
  const idleSession = (await inv('session:list', alpha)).find((x) => x.agentId === i.id && !x.archived && x.id !== current[i.id])
  await inv('session:start', alpha, { agentId: i.id, resumeId: idleSession?.id })
  check('Idle resumed: Resume Agent, Stop (2)', !!(await until(async () => JSON.stringify((await labels()).slice(0, 2)) === JSON.stringify(['Resume Agent', 'Stop (2)']), 15000)), JSON.stringify(await labels()))

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
