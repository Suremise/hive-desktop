// The task board: cards added in the Board view and through the Agent API (as an agent's hive tools would), Done kept
// for the user, dragging between columns, Start on a new agent (the fake Claude Code gets the card as its prompt),
// a project's Tasks tab, archiving; and Project → Remove Project… (Hide, restored from Settings → Workspace, and
// Delete). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR. Delete sends a small test folder to the
// Recycle Bin.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'board-profile')
const ws = path.join(lib.WORK, 'board-ws')
const claudeHome = path.join(lib.WORK, 'board-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = 47897
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  // Trusted already: an agent started from the board has no terminal on screen, so its trust question wraps narrowly.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  for (const p of ['beta', 'delta', 'gamma']) fs.mkdirSync(path.join(ws, p), { recursive: true })
  fs.writeFileSync(path.join(ws, 'gamma', 'notes.txt'), 'delete me')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const cards = () => inv('tasks:list')
  const card = async (n) => (await cards()).find((c) => c.number === n)
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })

  // The Board view, and a card added there.
  await page.getByRole('button', { name: 'Task Board' }).click()
  check('the Board shows four columns', !!(await until(async () => (await page.locator('.board-column').count()) === 4, 5000)))
  await page.getByRole('button', { name: 'New Card', exact: true }).click()
  const dialog = page.locator('.dialog', { hasText: 'New Card' })
  await dialog.locator('.task-title-input').fill('Add a greeting')
  await dialog.locator('select').first().selectOption('alpha')
  await dialog.locator('textarea').first().fill('Write `hello()` in a.ts and test it.')
  await dialog.getByRole('button', { name: 'Add Card' }).click()
  check('a new card shows in Todo', !!(await until(async () => (await column('Todo').locator('.task-card[data-task="1"]').count()) === 1, 5000)))
  const c1 = await card(1)
  check('with its project and description', c1?.project === 'alpha' && c1.description.includes('hello()') && c1.createdBy === 'You', JSON.stringify(c1))

  // As an agent: add a card, try Done (refused), move to Review with a comment.
  const made = await api('POST', '/v1/tasks', { title: 'Follow-up: docs', project: 'alpha', labels: ['docs'] })
  check('an agent adds a card through the Agent API', made.status === 200 && made.body.number === 2, JSON.stringify(made))
  check('it shows on the board', !!(await until(async () => (await tile(2).count()) === 1, 5000)))
  const done = await api('PATCH', '/v1/tasks/2', { column: 'done' })
  check('an agent may not move a card to Done', done.status === 403 && /Only the user/.test(done.body?.error), JSON.stringify(done))
  const review = await api('PATCH', '/v1/tasks/2', { column: 'review', comment: 'Docs drafted.' })
  check('an agent moves it to Review with a comment', review.status === 200 && review.body.column === 'review' && review.body.comments.length === 1, JSON.stringify(review.body))
  const badge = page.locator('.activity-btn[aria-label="Task Board"] .activity-badge')
  check('the activity bar counts cards waiting for review', !!(await until(async () => (await badge.count()) === 1 && (await badge.innerText()) === '1', 5000)))
  const start = await api('POST', '/v1/tasks/1/start', {})
  check('only the Assistant starts cards through the API', start.status === 403, JSON.stringify(start))

  // Dragging a card to another column.
  await tile(1).dragTo(column('Doing').locator('.board-column-body'))
  check('a card drags to another column', !!(await until(async () => (await card(1))?.column === 'doing', 5000)), (await card(1))?.column)
  await inv('tasks:update', 1, { column: 'todo' })

  // The card dialog saves only what the user changed: an agent's move meanwhile stays.
  const c3 = (await api('POST', '/v1/tasks', { title: 'Old title', project: 'beta' })).body.number
  await until(async () => (await tile(c3).count()) === 1, 5000)
  await tile(c3).click()
  const edit = page.locator('.dialog', { hasText: `#${c3}` })
  await edit.waitFor({ timeout: 5000 })
  await api('PATCH', `/v1/tasks/${c3}`, { column: 'review' })
  await lib.sleep(500)
  await edit.locator('.task-title-input').fill('New title')
  await edit.getByRole('button', { name: 'Save' }).click()
  const c3b = await until(async () => {
    const c = await card(c3)
    return c?.title === 'New title' && c
  }, 5000)
  check("saving the dialog keeps an agent's change made while it was open", c3b && c3b.column === 'review', JSON.stringify(c3b && { column: c3b.column }))
  await inv('tasks:delete', c3)

  // Start #1 on a new agent: it gets the card as its prompt, and the card goes to Doing.
  await tile(1).click()
  const open = page.locator('.dialog', { hasText: '#1' })
  await open.waitFor({ timeout: 5000 })
  await page.screenshot({ path: path.join(lib.WORK, 'board-card.png') })
  await open.getByRole('button', { name: 'Start…' }).click()
  await page.screenshot({ path: path.join(lib.WORK, 'board-start.png') })
  const startDialog = page.locator('.dialog', { hasText: 'Start #1' })
  await startDialog.locator('label.choice', { hasText: 'A new agent' }).first().click()
  await startDialog.getByRole('button', { name: 'Start' }).click()
  const project = async () => (await inv('workspace:get')).projects.find((p) => p.name === 'alpha')
  const agent = await until(async () => (await project())?.agents[0])
  check('Start adds an agent to the project', !!agent)
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const ran = !!(await until(async () => (await live())?.status === 'finished', 30000))
  check('and runs the card', ran, `${(await live())?.status}: ${String(await inv('pty:buffer', lib.ptyKey(alpha, agent.id))).replace(/\[[0-9;?]*[ -/]*[@-~]/g, ' ').slice(-600)}`)
  const c1b = await card(1)
  check('the card is in Doing, given to the agent', c1b.column === 'doing' && c1b.agent === agent.id, JSON.stringify({ column: c1b.column, agent: c1b.agent }))
  const tr = fs.readdirSync(path.join(claudeHome, 'projects'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
  const text = tr.map((f) => fs.readFileSync(path.join(claudeHome, 'projects', String(f)), 'utf8')).join('\n')
  check('the agent got the card as its prompt', /Work on task #1 from the Hive task board: Add a greeting/.test(text) && text.includes('hello()'))
  check('its tile shows the agent finished', !!(await until(async () => ((await tile(1).getAttribute('class')) ?? '').includes('finished') && /Finished/.test(await tile(1).innerText()), 8000)), await tile(1).innerText())
  await page.screenshot({ path: path.join(lib.WORK, 'board.png') })

  // The project's Tasks tab shows its cards.
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.locator('.sidebar .row', { hasText: 'alpha' }).first().click()
  await page.locator('.tab', { hasText: 'Tasks' }).click()
  check("the project's Tasks tab shows its cards", !!(await until(async () => (await page.locator('.board-view.in-tab .task-card').count()) === 2, 5000)))

  // The user moves it to Done, and archives it.
  await inv('tasks:update', 1, { column: 'done' })
  await inv('tasks:archive', 1, true)
  check('archived cards leave the board', !!(await until(async () => (await page.locator('.board-view.in-tab .task-card').count()) === 1, 5000)))
  await page.locator('.board-view.in-tab label', { hasText: 'Archived' }).click()
  check('and are listed under Archived', !!(await until(async () => (await page.locator('.task-archive-row').count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-tab.png') })

  // Project → Remove Project…: Hide delta.
  const removeVia = async (name, choice) => {
    await page.locator('.sidebar .row', { hasText: name }).first().click({ button: 'right' })
    await page.locator('.menu .menu-item', { hasText: 'Remove Project…' }).click()
    const d = page.locator('.dialog', { hasText: `Remove ${name}` })
    await d.waitFor({ timeout: 5000 })
    await until(async () => (await d.locator('label.choice').count()) === 3, 5000)
    await d.locator('label.choice').filter({ has: page.getByText(choice, { exact: true }) }).click()
    return d
  }
  await inv('tasks:create', { title: 'Delta work', project: 'delta' })
  let d = await removeVia('delta', 'Hide')
  await d.locator('.dialog-footer .btn', { hasText: 'Hide' }).click()
  const names = async () => (await inv('workspace:get')).projects.map((p) => p.name)
  check('Hide takes the project out of Hive', !!(await until(async () => !(await names()).includes('delta'), 8000)))
  check('its folder stays', fs.existsSync(path.join(ws, 'delta')))
  check('and its cards are archived', (await cards()).find((c) => c.project === 'delta')?.archivedFor === 'project-hidden')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  const row = page.locator('.hidden-projects tr', { hasText: 'delta' })
  check('Settings → Workspace lists it', !!(await until(async () => (await row.count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'board-settings.png') })
  await row.getByRole('button', { name: 'Restore' }).click()
  check('Restore brings it back', !!(await until(async () => (await names()).includes('delta'), 8000)))
  check('with its cards', !(await cards()).find((c) => c.project === 'delta')?.archived)

  // Delete gamma: the name has to be typed.
  await page.getByRole('button', { name: 'Projects' }).click()
  d = await removeVia('gamma', 'Delete')
  const del = d.locator('.dialog-footer .btn', { hasText: 'Delete' })
  check('Delete waits for the name to be typed', await del.isDisabled())
  await page.screenshot({ path: path.join(lib.WORK, 'board-remove.png') })
  await d.locator('input.input').fill('gamma')
  await del.click()
  check('Delete moves the folder to the Recycle Bin', !!(await until(async () => !fs.existsSync(path.join(ws, 'gamma')), 10000)))
  check('and Hive forgets it', !(await names()).includes('gamma'))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
