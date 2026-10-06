// Remove All (#291): the project header's "Remove All (n)" (and the Session menu's and the palette's "Remove All Agents
// (n)…") removes every agent after one question in the danger style, listing them (the working one flagged, worktrees
// marked: merged and clean, or always kept and why). Running agents are stopped first; cards are asked about once for
// all of them; each tab shows the spinner while it goes; sessions stay. Worktrees and branches are kept by default; the
// opt-in box deletes only merged, clean ones (unmerged work is kept even ticked); a failure is reported with the rest
// still removed. Cancel changes nothing. Fake Claude Code (fake-claude/), throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy. Two projects: alpha (the default) and beta (the box ticked, one removal failing).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'removeall-profile')
const ws = path.join(lib.WORK, 'removeall-ws')
const claudeHome = path.join(lib.WORK, 'removeall-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Removals take a moment, so the spinners can be seen.
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47887), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_SLOW_IPC: 'agents:remove=1200' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const type = async (proj, id, text) => {
    await inv('pty:write', lib.ptyKey(proj, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(proj, id), '\r')
  }
  const agentsOf = async (proj) => ((await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === proj.toLowerCase())?.agents ?? []).map((a) => a.name)
  const branches = (proj) => lib.git(proj, ['branch', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean)

  // Four agents: Worker (project folder, working), Idle (project folder, never started), Merged (a worktree with nothing
  // on it: merged and clean) and Unmerged (a worktree with a commit of its own).
  const setUp = async (proj) => {
    await page.getByText(path.basename(proj), { exact: true }).first().click()
    const worker = await lib.addAgent(inv, proj, { name: 'Worker' })
    await lib.addAgent(inv, proj, { name: 'Idle' })
    const merged = await lib.addAgent(inv, proj, { name: 'Merged', location: 'new-worktree' })
    const unmerged = await lib.addAgent(inv, proj, { name: 'Unmerged', location: 'new-worktree' })
    fs.writeFileSync(path.join(unmerged.worktree.path, 'b.ts'), 'export const b = 2\n')
    lib.git(unmerged.worktree.path, ['add', '-A'])
    lib.git(unmerged.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unmerged work'])
    await inv('session:start', proj, { agentId: worker.id })
    await until(async () => ['waiting', 'ready'].includes((await live(proj, worker.id))?.status))
    if ((await live(proj, worker.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, worker.id), '\r')
    await until(async () => (await live(proj, worker.id))?.status === 'ready')
    await type(proj, worker.id, 'work 120')
    check(`${path.basename(proj)}: Worker is working`, !!(await until(async () => (await live(proj, worker.id))?.status === 'working')))
    await inv('workspace:refresh')
    return { worker, merged, unmerged }
  }

  // --- alpha: the header, the menus, the question, Cancel; then the default (worktrees kept), cards asked once.
  const a = await setUp(alpha)
  const cardW = await inv('tasks:create', { title: 'Worker card', project: 'alpha', agent: a.worker.id, column: 'doing' })
  const cardU = await inv('tasks:create', { title: 'Unmerged card', project: 'alpha', agent: a.unmerged.id })
  const header = page.locator('.project-header .actions')
  const removeButton = header.getByRole('button', { name: 'Remove All (4)', exact: true })
  check('the header shows Remove All (4), after the other batch actions', !!(await until(async () => (await removeButton.count()) === 1, 5000)) && (await header.locator('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean).at(-1) === 'Remove All (4)', JSON.stringify(await header.locator('button').allInnerTexts()))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.locator('.project-header').screenshot({ path: path.join(lib.WORK, `removeall-header-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // Narrow: an icon with its count; tighter, at the top of ⋯ (the rarest action goes first).
  const headerWidth = () => page.locator('.project-header').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  await lib.fitWindow(app, page, { width: 1200, height: 900 })
  await lib.sleep(500)
  check('narrow: an icon keeping its count', (await removeButton.count()) === 1 && (await removeButton.innerText()).trim() === '4', `${await headerWidth()} px: ${await removeButton.innerText().catch(() => '')}`)
  await lib.fitWindow(app, page, { width: 900, height: 900 })
  await lib.sleep(500)
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  const more = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  await page.keyboard.press('Escape')
  check('tight: in ⋯ instead, first, with its count', (await removeButton.count()) === 0 && more[0] === 'Remove All (4)…', `${await headerWidth()} px: ${JSON.stringify(more)}`)
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(400)

  await page.locator('.menubar .menubar-item', { hasText: 'Session' }).click()
  await lib.sleep(250)
  const session = (await page.locator('.menu .menu-item > span:not(.menu-key)').allInnerTexts()).map((t) => t.trim())
  await page.keyboard.press('Escape')
  check('the Session menu has Remove All Agents (4)…', session.includes('Remove All Agents (4)…'), JSON.stringify(session))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Remove All')
  await lib.sleep(300)
  const found = await page.locator('.palette-item').allInnerTexts()
  await page.keyboard.press('Escape')
  check('so does the palette', found.some((t) => t.includes('Remove All Agents (4)…')), JSON.stringify(found))

  const dialog = page.locator('.dialog', { hasText: 'Remove all 4 agents?' })
  await removeButton.click()
  await dialog.waitFor({ timeout: 5000 })
  const text = await dialog.innerText()
  check('one question lists all four, flagging the working one', /Worker — Working.*\(will be interrupted\)/.test(text) && /Idle — not running/.test(text) && /Merged — not running · worktree hive\/merged: merged and clean/.test(text) && /Unmerged — not running · worktree hive\/unmerged: always kept \(1 commit not merged into (main|master)\)/.test(text), text)
  check('it says running agents stop first and sessions stay', /Running agents are stopped first\./.test(text) && /sessions stay in the Sessions tab/.test(text), text)
  check('in the danger style', (await dialog.locator('button.danger', { hasText: 'Remove 4 agents' }).count()) === 1)
  const box = dialog.locator('.dialog-check')
  check('the box is offered for the merged, clean worktree only, unticked', (await box.count()) === 1 && (await box.innerText()).trim().endsWith('hive/merged') && !/unmerged/.test(await box.innerText()) && !(await box.locator('input').isChecked()), await box.innerText().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `removeall-confirm-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(1500) // on purpose: nothing may stop or go after Cancel
  check('Cancel changes nothing', JSON.stringify(await agentsOf(alpha)) === JSON.stringify(['Worker', 'Idle', 'Merged', 'Unmerged']) && (await live(alpha, a.worker.id))?.status === 'working')
  const workerSession = (await live(alpha, a.worker.id)).sessionId

  await removeButton.click()
  await dialog.waitFor({ timeout: 5000 })
  await dialog.getByRole('button', { name: 'Remove 4 agents' }).click()
  const cards = page.locator('.dialog', { hasText: 'The 4 agents have 2 open cards' })
  check('their cards are asked about once, together', !!(await until(async () => (await cards.count()) === 1, 5000)), await page.locator('.dialog').allInnerTexts().then((t) => t.join(' | ')))
  await cards.getByRole('button', { name: 'Move them back' }).click()
  const spinning = await until(async () => {
    const n = await page.locator('.agent-tab .codicon-loading').count()
    return n >= 2 ? n : 0
  }, 5000)
  check('the tabs show the removing spinner', !!spinning, String(spinning))
  check('every agent goes', !!(await until(async () => (await agentsOf(alpha)).length === 0, 30000)), JSON.stringify(await agentsOf(alpha)))
  check('the working one was stopped first', !(await live(alpha, a.worker.id)))
  check('its session stays in the Sessions tab', (await inv('session:list', alpha)).some((s) => s.id === workerSession))
  check('by default every worktree and branch is kept', fs.existsSync(a.merged.worktree.path) && fs.existsSync(a.unmerged.worktree.path) && ['hive/merged', 'hive/unmerged'].every((b) => branches(alpha).includes(b)), JSON.stringify(branches(alpha)))
  const after = (await inv('tasks:list')).filter((c) => [cardW.number, cardU.number].includes(c.number))
  check('the cards were moved back (nobody has them; Doing to Todo)', after.length === 2 && after.every((c) => !c.agent) && after.find((c) => c.number === cardW.number)?.column === 'todo', JSON.stringify(after.map((c) => [c.number, c.agent, c.column])))
  check('the button goes with the agents', (await removeButton.count()) === 0 && (await header.getByRole('button', { name: /^Remove/ }).count()) === 0)
  check('no failure notice', (await page.locator('.toast.error').count()) === 0)

  // --- beta: the box ticked: the merged, clean worktree is deleted with its branch, the unmerged one kept; the first
  // removal fails and is reported, the others still go.
  const b = await setUp(beta)
  await app.evaluate(() => {
    process.env.HIVE_TEST_FAIL_IPC = 'agents:remove*1'
  })
  const betaDialog = page.locator('.dialog', { hasText: 'Remove all 4 agents?' })
  await header.getByRole('button', { name: 'Remove All (4)', exact: true }).click()
  await betaDialog.waitFor({ timeout: 5000 })
  await betaDialog.locator('.dialog-check input').check()
  await betaDialog.getByRole('button', { name: 'Remove 4 agents' }).click()
  check('the others go', !!(await until(async () => JSON.stringify(await agentsOf(beta)) === JSON.stringify(['Worker']), 30000)), JSON.stringify(await agentsOf(beta)))
  check('the merged, clean worktree and its branch are deleted', !!(await until(async () => !fs.existsSync(b.merged.worktree.path), 5000)) && !branches(beta).includes('hive/merged'), JSON.stringify(branches(beta)))
  check('the unmerged one is kept, ticked or not', fs.existsSync(b.unmerged.worktree.path) && branches(beta).includes('hive/unmerged'))
  const notice = page.locator('.toast', { hasText: '1 of 4 agents could not be removed' })
  check('one notice says which could not be removed, why, and what happened to the worktrees', !!(await until(async () => (await notice.count()) === 1, 5000)) && /Worker:/.test(await notice.innerText()) && /Worktrees deleted: hive\/merged/.test(await notice.innerText()) && /Worktrees kept: hive\/unmerged \(1 commit not merged into (main|master)\)/.test(await notice.innerText()), await notice.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'removeall-result.png') })
  check('with one agent left the button is Remove Agent', (await header.getByRole('button', { name: 'Remove Agent', exact: true }).count()) === 1)
  check('the stopped agent that failed was stopped', !(await live(beta, b.worker.id)))

  await app.evaluate(() => {
    delete process.env.HIVE_TEST_FAIL_IPC
  })
  await inv('session:stop', alpha)
  await inv('session:stop', beta)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
