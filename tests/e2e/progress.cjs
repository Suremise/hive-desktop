// The Progress panel: agents report long runs through the Agent API with their own tokens, and Hive shows each run with
// its agent in a panel on the right (folded: a strip with a bar per run) and on the taskbar button. A run is its
// agent's: another agent can't touch it. Passed runs fade into Recent; failed ones stay until seen, then fold into Recent
// marked red (or when dismissed); a row opens its details, its agent's name shows the agent (flashing its pane); an agent that
// stops leaves its run "stopped reporting", and the setting turns it all off; another tells agents to run long commands
// through hive-progress, which reaches a new session's guidance (#167). The agents are the fake Claude Code;
// dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR. The taskbar calls are recorded through
// HIVE_TEST_TASKBAR_LOG (the page can't see them).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PORT = Number(lib.port(47911))
const userData = path.join(lib.WORK, 'progress-profile')
const ws = path.join(lib.WORK, 'progress-ws')
const claudeHome = path.join(lib.WORK, 'progress-claude-home')
const taskbarLog = path.join(lib.WORK, 'progress-taskbar.jsonl')
const shots = path.join(lib.WORK, 'progress-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
/** The last taskbar call for the workspace. */
const taskbar = () => {
  if (!fs.existsSync(taskbarLog)) return null
  const lines = fs.readFileSync(taskbarLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return lines.filter((l) => l.ws.toLowerCase() === ws.toLowerCase()).at(-1) ?? null
}
const near = (a, b) => Math.abs(a - b) < 0.001

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(taskbarLog, { force: true })
  for (const d of [alpha, beta, claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TASKBAR_LOG: taskbarLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.waitForProvider(inv)
  const alfie = await lib.addAgent(inv, alpha, { name: 'Alfie' })
  const betty = await lib.addAgent(inv, beta, { name: 'Betty' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  await inv('session:start', alpha, { agentId: alfie.id })
  await inv('session:start', beta, { agentId: betty.id })
  check('both agents start', !!(await until(async () => (await live(alfie.id))?.status === 'ready' && (await live(betty.id))?.status === 'ready', 25000)))

  // Each agent's own token, from its launch environment.
  const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const tokenOf = (dir) => launches.filter((l) => l.cwd.toLowerCase() === dir.toLowerCase()).at(-1)?.env?.HIVE_API_TOKEN
  const alfieToken = tokenOf(alpha)
  const bettyToken = tokenOf(beta)
  const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  check('each agent has its own token', !!alfieToken && !!bettyToken && alfieToken !== bettyToken && alfieToken !== workspaceToken)
  const call = async (token, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  // --- Folded: a strip, no runs yet. The panel never opens by itself.
  const rail = page.locator('.progress-rail')
  const panel = page.locator('.progress-panel')
  check('the Progress strip shows, folded, with no runs', (await rail.count()) === 1 && (await panel.count()) === 0 && (await rail.locator('.progress-mini').count()) === 0)
  const railWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)

  let r = await call(alfieToken, 'POST', '/v1/progress', { title: 'e2e: 3 suites', total: 3, step: 0, stepName: 'about', estimateMs: 180000, command: 'npm run e2e', agentName: 'Mallory' })
  const run1 = r.body?.id
  check('an agent starts a run with its token', r.status === 200 && typeof run1 === 'string', JSON.stringify(r))
  check('the strip shows a bar for it, and the panel stays folded', !!(await until(async () => (await rail.locator('.progress-mini').count()) === 1)) && (await panel.count()) === 0)
  check('the taskbar shows it (0 of 3)', !!(await until(async () => taskbar()?.mode === 'normal' && near(taskbar().value, 0))), JSON.stringify(taskbar()))
  r = await call(workspaceToken, 'GET', '/v1/projects/alpha')
  const status = r.body?.agents?.find((a) => a.name === 'Alfie')?.progress
  check("the agent's status has its progress", status?.title === 'e2e: 3 suites' && status.step === 0 && status.total === 3 && status.stepName === 'about' && status.etaMs > 0, JSON.stringify(status))
  r = await call(alfieToken, 'GET', `/v1/projects/alpha/agents/${alfie.id}/activity`)
  check('and its activity', r.body?.progress?.title === 'e2e: 3 suites', JSON.stringify(r.body?.progress))
  r = await call(workspaceToken, 'GET', '/v1/projects?view=short')
  const row0 = r.body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Alfie')
  check("and the short listing hive_list_projects uses", /^e2e: 3 suites 0\/3, about 3 min left$/.test(row0?.progress ?? ''), JSON.stringify(row0))

  // --- Another agent can't touch it: as if it didn't exist.
  r = await call(bettyToken, 'PATCH', `/v1/progress/${run1}`, { step: 3 })
  const r2 = await call(bettyToken, 'POST', `/v1/progress/${run1}/finish`, { ok: false })
  const r3 = await call(bettyToken, 'PATCH', '/v1/progress/no-such-run', { step: 1 })
  check("another agent's update and finish are 404, as for an unknown run", r.status === 404 && r2.status === 404 && r3.status === 404 && r.body?.error === r3.body?.error, `${r.status} ${r2.status} ${r3.status}`)
  check('bad input is 400', (await call(alfieToken, 'POST', '/v1/progress', { total: 3 })).status === 400 && (await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 9 })).status === 400)

  // --- Open the panel (its shortcut): the run with its agent, project, step and time.
  await page.locator('.xterm').first().click().catch(() => undefined)
  await page.keyboard.press('Control+Alt+P')
  check('Ctrl+Alt+P opens the panel', !!(await until(async () => (await panel.count()) === 1)))
  const row = panel.locator(`.progress-run[data-run="${run1}"]`)
  const rowText = async () => (await row.textContent().catch(() => '')) ?? ''
  check("the run shows its agent (by token, not the request's name), project, title and step", !!(await until(async () => /Alfie/.test(await rowText()) && /alpha/.test(await rowText()) && /e2e: 3 suites/.test(await rowText()) && /1 of 3: about/.test(await rowText()))) && !/Mallory/.test(await rowText()), await rowText())
  check('and the time left', /about 3 min left/.test(await rowText()), await rowText())

  r = await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 1, stepName: 'board', estimateMs: 120000 })
  check('an update is accepted', r.status === 200 && r.body?.ok === true, JSON.stringify(r))
  check('the row follows it', !!(await until(async () => /2 of 3: board/.test(await rowText()))), await rowText())
  check('the taskbar follows (1 of 3)', !!(await until(async () => near(taskbar()?.value ?? -1, 1 / 3))), JSON.stringify(taskbar()))

  // --- A second agent's run, without steps: a moving bar; the taskbar still counts the run with steps only.
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'npm run build' })
  const run2 = r.body?.id
  const row2 = panel.locator(`.progress-run[data-run="${run2}"]`)
  check("a second agent's run shows too, with a moving bar", !!(await until(async () => (await row2.count()) === 1 && (await row2.locator('.progress-bar.indeterminate').count()) === 1)) && /Betty/.test((await row2.textContent()) ?? ''))
  check('the newest is listed first', (await panel.locator('.progress-run').first().getAttribute('data-run')) === run2)
  await page.screenshot({ path: path.join(shots, 'dark-two-runs.png') })

  // --- Showing a run's agent (#141): from the keyboard (Tab to the agent's name, Enter or Space), or a click anywhere on
  // the row; the whole row shows the focus.
  const shownProject = async () => ((await page.locator('.project-header h1').first().textContent().catch(() => '')) ?? '').trim()
  const toAlpha = async () => {
    await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click()
    return !!(await until(async () => (await shownProject()) === 'alpha'))
  }
  const show2 = row2.locator('button.progress-run-show')
  check("a run's agent is a button named for what it shows", (await show2.count()) === 1 && (await show2.getAttribute('aria-label')) === 'Show Betty, which ran npm run build', await show2.getAttribute('aria-label'))
  check('alpha is shown to start with', await toAlpha())
  await panel.locator('button[aria-label^="Fold the Progress panel"]').focus()
  await page.keyboard.press('Tab')
  check('Tab from the header reaches the newest run', await show2.evaluate((b) => b === document.activeElement))
  check('…and the whole row shows the focus', (await row2.evaluate((el) => getComputedStyle(el).outlineStyle)) === 'solid')
  await page.screenshot({ path: path.join(shots, 'dark-run-focused.png') })
  await page.keyboard.press('Enter')
  check('Enter shows its agent (Betty, in beta)', !!(await until(async () => (await shownProject()) === 'beta')), await shownProject())
  check('back to alpha', await toAlpha())
  await show2.focus()
  await page.keyboard.press('Space')
  check('Space does too', !!(await until(async () => (await shownProject()) === 'beta')), await shownProject())
  check('back to alpha', await toAlpha())
  // A click on the row opens its details (#220); its agent's name shows the agent, which says so: its pane flashes
  // and its terminal takes the keyboard, also when it was on screen already.
  await row2.locator('.progress-bar').click()
  const details2 = row2.locator('.progress-details')
  check('a click on the row (its bar) opens its details, not its agent', !!(await until(async () => (await details2.count()) === 1)) && (await shownProject()) === 'alpha', await shownProject())
  check('…its toggle says it is open', (await row2.locator('button.progress-details-toggle').getAttribute('aria-expanded')) === 'true')
  await row.locator('button.progress-run-show').click()
  check("a click on another run's agent shows that one (Alfie, in alpha)", !!(await until(async () => (await shownProject()) === 'alpha')), await shownProject())
  const flashed = await until(async () => (await page.locator('.agent-pane.flash').count()) === 1, 2000)
  check('…its pane flashes, though it was on screen already', !!flashed)
  check("…and its terminal has the keyboard", !!(await until(async () => page.evaluate((key) => document.activeElement?.closest(".terminal-host")?.dataset.pty === key, lib.ptyKey(alpha, alfie.id)), 2000)))
  await page.screenshot({ path: path.join(shots, 'dark-details-flash.png') })
  await details2.locator('button', { hasText: 'Show the agent' }).click()
  check('"Show the agent" in the details shows Betty, in beta', !!(await until(async () => (await shownProject()) === 'beta')), await shownProject())
  check("…with Betty's terminal taking the keyboard", !!(await until(async () => page.evaluate((key) => document.activeElement?.closest(".terminal-host")?.dataset.pty === key, lib.ptyKey(beta, betty.id)), 2000)))
  await row2.locator('button.progress-details-toggle').focus()
  await page.keyboard.press('Escape')
  check('Escape closes the details', !!(await until(async () => (await details2.count()) === 0)))
  check('back to alpha', await toAlpha())

  // --- Passed: ✓ and the time, then it fades into Recent.
  r = await call(alfieToken, 'POST', `/v1/progress/${run1}/finish`, { ok: true, summary: '3 passed' })
  check('a finish is accepted', r.status === 200)
  check('a passed run shows ✓ and how long it took', !!(await until(async () => (await row.locator('.progress-ok').count()) === 1 && /Passed in/.test(await rowText()))), await rowText())
  check('a finished run takes no more updates (409)', (await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 2 })).status === 409)
  check('after a few seconds it leaves the list for Recent', !!(await until(async () => (await row.count()) === 0 && (await panel.locator('.progress-recent.passed').count()) === 1, 15000)))

  // --- Failed, with the panel folded: the taskbar goes red until the panel is looked at; the run stays until dismissed.
  await page.keyboard.press('Control+Alt+P')
  check('Ctrl+Alt+P folds it again', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 1)))
  r = await call(bettyToken, 'POST', `/v1/progress/${run2}/finish`, { ok: false, summary: '2 errors in src/a.ts' })
  check('a failure turns the taskbar red', !!(await until(async () => taskbar()?.mode === 'error')), JSON.stringify(taskbar()))
  check('the strip shows the failed run', (await rail.locator('.progress-mini.failed').count()) === 1)
  await page.screenshot({ path: path.join(shots, 'dark-strip.png'), clip: { x: 1200, y: 30, width: 200, height: 300 } })
  // Focused as the test says (Windows won't give a background app the focus while another window has it): the window's
  // focus is stubbed and the event Hive listens for sent with it.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.isFocused = () => true
    w.emit('focus')
  })
  await rail.click()
  check('opening the panel (window focused) clears the red', !!(await until(async () => taskbar()?.mode === 'none')), JSON.stringify(taskbar()))
  check('the failed run is still listed now it has been seen, with its summary', (await row2.locator('.progress-fail').count()) === 1 && /2 errors in src\/a\.ts/.test((await row2.textContent()) ?? ''))
  // Seen (#220): a few seconds later it folds into Recent, marked red, as a passed run does.
  check('…then folds into Recent by itself, marked red', !!(await until(async () => (await row2.count()) === 0 && (await panel.locator(`.progress-recent-item[data-run="${run2}"] button.progress-recent.failed`).count()) === 1, 20000)))
  check('…in red', (await panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-recent-text`).evaluate((el) => getComputedStyle(el).color)) !== (await panel.locator('.progress-recent.passed .progress-recent-text').first().evaluate((el) => getComputedStyle(el).color)))
  // Dismiss still folds one away at once, without showing its agent.
  check('alpha is shown before dismissing', await toAlpha())
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'npm run lint', command: 'npm run lint -- --deny-warnings' })
  const run2b = r.body?.id
  await call(bettyToken, 'POST', `/v1/progress/${run2b}/finish`, { ok: false, summary: '3 warnings', exitCode: 1 })
  const row2b = panel.locator(`.progress-run[data-run="${run2b}"]`)
  await until(async () => (await row2b.count()) === 1)
  await row2b.locator('button[aria-label^="Dismiss"]').click()
  check('Dismiss folds a failed run into Recent at once', !!(await until(async () => (await row2b.count()) === 0 && (await panel.locator(`.progress-recent-item[data-run="${run2b}"]`).count()) === 1, 3000)))
  check("…without showing its agent", (await shownProject()) === 'alpha', await shownProject())
  // A Recent run opens its details: what Hive has for it, its agent to show.
  const recent2 = panel.locator(`.progress-recent-item[data-run="${run2}"] button.progress-recent`)
  check('a Recent run is a button naming it, for its details', (await recent2.count()) === 1 && /^Betty: npm run build, failed in .*\. Details$/.test((await recent2.getAttribute('aria-label')) ?? '') && (await recent2.getAttribute('aria-expanded')) === 'false', await recent2.getAttribute('aria-label').catch(() => ''))
  await recent2.focus()
  await page.keyboard.press('Enter')
  const recentDetails = panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-details`)
  check('Enter on it opens its details', !!(await until(async () => (await recentDetails.count()) === 1)))
  const detailText = (await recentDetails.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('…with the agent, provider, started and ended (yyyy-mm-dd hh:mm), how long, its steps, state and summary', !/Command/.test(detailText) && /Agent Betty · beta/.test(detailText) && /Provider Claude Code/.test(detailText) && /Started \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(detailText) && /Ended \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(detailText) && /Took \d+ (s|min)/.test(detailText) && /State Failed/.test(detailText) && /2 errors in src\/a\.ts/.test(detailText), detailText)
  // Copy writes to the clipboard: stubbed in the page, so the test never touches the real one.
  await page.evaluate(() => {
    window.__copied = []
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t)
  })
  await recentDetails.locator('button', { hasText: 'Copy summary' }).click()
  check('the summary can be copied (no command was reported: nothing to copy there)', JSON.stringify(await page.evaluate(() => window.__copied)) === JSON.stringify(['2 errors in src/a.ts']) && (await recentDetails.locator('button', { hasText: 'Copy command' }).count()) === 0, JSON.stringify(await page.evaluate(() => window.__copied)))
  await page.screenshot({ path: path.join(shots, 'dark-recent-details.png') })
  await recentDetails.locator('button', { hasText: 'Show the agent' }).click()
  check('…and "Show the agent" shows Betty', !!(await until(async () => (await shownProject()) === 'beta')), await shownProject())
  const lint = panel.locator(`.progress-recent-item[data-run="${run2b}"]`)
  await lint.locator('button.progress-recent').click()
  const lintText = (await lint.locator('.progress-details').innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('a run that gave its exit code shows it', /Exit code 1/.test(lintText) && /Command npm run lint -- --deny-warnings/.test(lintText), lintText)
  await lint.locator('button', { hasText: 'Copy command' }).click()
  check('…and its command can be copied', (await page.evaluate(() => window.__copied)).at(-1) === 'npm run lint -- --deny-warnings', JSON.stringify(await page.evaluate(() => window.__copied)))
  await page.keyboard.press('Escape')
  check('back to alpha', await toAlpha())

  // --- An agent that stops leaves its run "stopped reporting". Folded, so it stays unseen (and in the strip) for what
  // follows: the open panel would count it as seen, and fold it into Recent.
  await page.keyboard.press('Control+Alt+P')
  check('folded again for the strip', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 1)))
  r = await call(alfieToken, 'POST', '/v1/progress', { title: 'long run', total: 10 })
  const run3 = r.body?.id
  await inv('session:stop', alpha, alfie.id)
  const row3 = panel.locator(`.progress-run[data-run="${run3}"]`)
  check("a stopped agent's run goes stale (amber in the strip), saying its agent stopped", !!(await until(async () => (await rail.locator(`.progress-mini.stale[data-run="${run3}"]`).count()) === 1, 25000)) && (await inv('progress:list')).find((x) => x.id === run3)?.staleReason === 'agent-stopped')

  check("a stale run still shows in its agent's status", (await call(workspaceToken, 'GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Alfie')?.progress?.stale === true)

  // --- More than six runs (#142), from two agents and a script, running, failed and stale: the folded strip keeps its
  // width, a bar for the newest six and "+2" for the rest (amber: the stale one is among them), listed on hover; its
  // name counts them all. The panel doesn't open by itself.
  const extra = []
  const startAs = async (token, title) => {
    const res = await call(token, 'POST', '/v1/progress', { title })
    extra.push({ token, id: res.body?.id })
    return res.body?.id
  }
  await startAs(bettyToken, 'b0')
  const failedId = await startAs(workspaceToken, 'f1')
  await call(workspaceToken, 'POST', `/v1/progress/${failedId}/finish`, { ok: false, summary: 'broke' })
  for (const t of ['b1', 'b2', 'b3']) await startAs(bettyToken, t)
  for (const t of ['s1', 's2']) await startAs(workspaceToken, t)
  const more = rail.locator('.progress-more')
  check('eight runs: six bars and "+2"', !!(await until(async () => (await rail.locator('.progress-mini').count()) === 6 && ((await more.textContent().catch(() => '')) ?? '').trim() === '+2')), `${await rail.locator('.progress-mini').count()} ${await more.textContent().catch(() => '')}`)
  check('the failed run has its bar among the six', (await rail.locator(`.progress-mini.failed[data-run="${failedId}"]`).count()) === 1)
  check('"+2" is amber: the stale run is among the rest', (await more.getAttribute('class'))?.split(' ').includes('stale'), await more.getAttribute('class'))
  check("the strip's name counts every run", (await rail.getAttribute('aria-label')) === 'Show the Progress panel (8 runs: 6 running, 1 failed, 1 stopped reporting)', await rail.getAttribute('aria-label'))
  const wideWith = await rail.evaluate((el) => el.getBoundingClientRect().width)
  check('the strip keeps its width', wideWith === railWidth, `${wideWith} vs ${railWidth}`)
  await more.hover()
  const tip = page.locator('.tip')
  check('hovering "+2" lists the rest', !!(await until(async () => /2 more:.*Betty: b0 \(running\).*Alfie: long run \(stopped reporting\)/.test((await tip.textContent().catch(() => '')) ?? ''))), await tip.textContent().catch(() => ''))
  await page.screenshot({ path: path.join(shots, 'dark-strip-more.png'), clip: { x: 900, y: 30, width: 500, height: 420 } })
  await page.mouse.move(600, 400)
  check('the panel stayed folded', (await panel.count()) === 0)
  // Tidy up for what follows: the extra runs pass, and opening the panel (window focused) clears the failure's red.
  for (const { token, id } of extra) if (id !== failedId) await call(token, 'POST', `/v1/progress/${id}/finish`, { ok: true })
  await rail.click()
  check('opened again', !!(await until(async () => (await panel.count()) === 1 && taskbar()?.mode !== 'error')), JSON.stringify(taskbar()))
  // Seen: the strip's red (and amber) goes at the same moment as the taskbar's, though the runs are still listed.
  await until(async () => (await inv('progress:list')).filter((x) => x.id === failedId || x.id === run3).every((x) => x.seenAt !== null))
  await page.keyboard.press('Control+Alt+P')
  check('folded right after: the seen failure and stall have no bar in the strip', !!(await until(async () => (await rail.count()) === 1)) && (await rail.locator(`[data-run="${failedId}"], [data-run="${run3}"]`).count()) === 0)
  await rail.click()
  await until(async () => (await panel.count()) === 1)
  await panel.locator(`.progress-run[data-run="${failedId}"] button[aria-label^="Dismiss"]`).click()
  await row3.locator('button[aria-label^="Dismiss"]').click()
  check('dismissing the stale run ends it: gone from status, the taskbar off, no more reports', !!(await until(async () => !(await call(workspaceToken, 'GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Alfie')?.progress && taskbar()?.mode === 'none')) && (await call(alfieToken, 'PATCH', `/v1/progress/${run3}`, { step: 1 })).status !== 200, JSON.stringify(taskbar()))

  // --- Five open runs per agent.
  const starts = []
  for (let i = 0; i < 6; i++) starts.push((await call(bettyToken, 'POST', '/v1/progress', { title: `run ${i}` })).status)
  check('a sixth open run for one agent is 429', starts.slice(0, 5).every((s) => s === 200) && starts[5] === 429, starts.join(','))
  await page.screenshot({ path: path.join(shots, 'dark-panel.png') })

  // --- Long text stays in the run's box (#220): a title, command and step at their longest, at the panel's narrowest
  // and widest, at 100% and 125%. One-line texts end in an ellipsis; nothing reaches past the box.
  const long = 'npm run e2e -- --all --build --record ' + 'with-a-very-long-argument '.repeat(4)
  r = await call(workspaceToken, 'POST', '/v1/progress', { title: long, command: long, total: 40, step: 3, stepName: 'a-suite-with-an-extremely-long-name-that-goes-on-and-on-and-on' })
  const longId = r.body?.id
  const longRow = panel.locator(`.progress-run[data-run="${longId}"]`)
  await until(async () => (await longRow.count()) === 1)
  const escapes = () =>
    longRow.evaluate((runEl) => {
      const box = runEl.getBoundingClientRect()
      const panelBox = runEl.closest('.progress-panel').getBoundingClientRect()
      const body = runEl.closest('.progress-body')
      const out = []
      for (const el of runEl.querySelectorAll('*')) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || el.closest('.tip')) continue
        if (b.right > box.right + 0.5 || b.left < box.left - 0.5) out.push(`${el.className || el.tagName}: ${Math.round(b.left)}–${Math.round(b.right)} outside ${Math.round(box.left)}–${Math.round(box.right)}`)
      }
      if (box.right > panelBox.right + 0.5) out.push('the run box is past the panel')
      if (body.scrollWidth > body.clientWidth + 1) out.push('the panel scrolls sideways')
      return out
    })
  // The panel's own width (its inline style, from its saved size) comes back afterwards.
  const panelWidth = await panel.evaluate((el) => el.style.width)
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    for (const w of [220, 640]) {
      await panel.evaluate((el, px) => (el.style.width = `${px}px`), w)
      await lib.sleep(250)
      const bad = await escapes()
      check(`${zoom * 100}%, panel ${w}px: no text escapes the run's box`, !bad.length, bad.slice(0, 4).join('; '))
      const title = longRow.locator('.progress-title')
      check(`${zoom * 100}%, panel ${w}px: the title ends in an ellipsis, its whole text on hover`, await title.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'))
      if (zoom === 1 && w === 220) await page.screenshot({ path: path.join(shots, 'dark-long-narrow.png') })
    }
  }
  await panel.evaluate((el, px) => (el.style.width = px), panelWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await longRow.locator('.progress-bar').click()
  await longRow.locator('.progress-details').waitFor()
  const detailBad = await escapes()
  check('…its details too, the long command wrapping', !detailBad.length, detailBad.slice(0, 4).join('; '))
  await page.screenshot({ path: path.join(shots, 'dark-long-details.png') })
  check("a script's run has no agent to show, and its details say so", (await longRow.locator('button.progress-run-show').count()) === 0 && /A script reported it/.test(await longRow.locator('.progress-details').innerText()))
  await call(workspaceToken, 'POST', `/v1/progress/${longId}/finish`, { ok: true })

  // A run whose agent was removed since: its details say so rather than offering to show it.
  const cara = await lib.addAgent(inv, beta, { name: 'Cara' })
  await inv('session:start', beta, { agentId: cara.id })
  await until(async () => (await live(cara.id))?.status === 'ready', 20000)
  const caraSession = (await live(cara.id))?.sessionId
  const caraToken = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.sessionId === caraSession).at(-1)?.env?.HIVE_API_TOKEN
  r = await call(caraToken, 'POST', '/v1/progress', { title: 'cara builds' })
  const caraRun = r.body?.id
  await call(caraToken, 'POST', `/v1/progress/${caraRun}/finish`, { ok: true })
  await inv('session:stop', beta, cara.id)
  await until(async () => !(await live(cara.id)), 15000)
  await inv('agents:remove', beta, cara.id, { deleteWorktree: false })
  const caraItem = panel.locator(`.progress-recent-item[data-run="${caraRun}"]`)
  await until(async () => (await caraItem.count()) === 1, 20000)
  await caraItem.locator('button.progress-recent').click()
  check('a removed agent: its run says so, with nothing to show', !!(await until(async () => /Cara has been removed from beta/.test(await caraItem.locator('.progress-details').innerText().catch(() => '')))) && (await caraItem.locator('button', { hasText: 'Show the agent' }).count()) === 0)
  await page.keyboard.press('Escape')

  // --- Light theme, and with the Assistant's panel open beside it.
  await inv('settings:update', { appearance: { theme: 'light' } })
  await page.keyboard.press('Control+Alt+I')
  await lib.sleep(800)
  const boxes = await page.evaluate(() => ['.progress-panel', '.assistant-panel'].map((s) => document.querySelector(s)?.getBoundingClientRect().left ?? null))
  check("with the Assistant's panel open, Progress sits to its left", boxes[0] !== null && boxes[1] !== null && boxes[0] < boxes[1], JSON.stringify(boxes))
  await page.screenshot({ path: path.join(shots, 'light-with-assistant.png') })
  await panel.locator('button[aria-label^="Fold the Progress panel"]').focus()
  await page.keyboard.press('Tab')
  const firstRow = panel.locator('.progress-run').first()
  check('light: the focused run shows the focus too', (await firstRow.evaluate((el) => getComputedStyle(el).outlineStyle)) === 'solid')
  await page.screenshot({ path: path.join(shots, 'light-run-focused.png') })
  await firstRow.locator('.progress-bar').click()
  await firstRow.locator('.progress-details').waitFor()
  await page.screenshot({ path: path.join(shots, 'light-details.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Alt+I')

  // --- The setting off: no panel, no strip, no taskbar; reports are accepted and ignored.
  await inv('settings:update', { general: { progressPanel: false } })
  check('turned off, the panel and strip go', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 0)))
  check('and the taskbar bar', !!(await until(async () => taskbar()?.mode === 'none')))
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'ignored' })
  const ri = await call(bettyToken, 'PATCH', `/v1/progress/${r.body?.id}`, { step: 1 })
  const rf = await call(bettyToken, 'POST', `/v1/progress/${r.body?.id}/finish`, { ok: true })
  check('reports are accepted and ignored', r.status === 200 && r.body?.ignored === true && ri.body?.ignored === true && rf.body?.ignored === true, JSON.stringify([r, ri, rf]))
  await inv('settings:update', { general: { progressPanel: true } })
  check('on again, the strip is back, with nothing from before', !!(await until(async () => (await rail.count()) === 1 || (await panel.count()) === 1)) && (await page.locator('.progress-run').count()) === 0)

  // --- Agents show long commands (#167): on by default, in Settings under the Progress panel and greyed out while the
  // panel is off; a session started afterwards gets the matching rule (its hive MCP server's instructions).
  const instructionsOf = async (dir) => {
    const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cwd.toLowerCase() === dir.toLowerCase()).at(-1)
    const server = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive
    const p = spawn(server.command, server.args, { env: lib.childEnv(server.env) })
    let out = ''
    const got = new Promise((resolve) => p.stdout.on('data', (d) => {
      out += d
      const line = out.split('\n').find((l) => l.includes('"id":1'))
      if (line) resolve(JSON.parse(line).result?.instructions ?? '')
    }))
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
    const text = await Promise.race([got, lib.sleep(15000).then(() => '(no reply)')])
    p.kill()
    return text
  }
  check('on by default', (await inv('settings:get')).general.progressCommands === true)
  let told = await instructionsOf(alpha)
  check("a session's guidance says to run long commands through hive-progress", /over 30 s.*`hive-progress -- <command>`/.test(told), told.slice(-400))
  await page.keyboard.press('Control+Comma')
  const wrapSwitch = page.getByRole('switch', { name: 'Agents show long commands in the Progress panel' })
  check('Settings → General shows it, on', !!(await until(async () => (await wrapSwitch.count()) === 1)) && (await wrapSwitch.getAttribute('aria-checked')) === 'true' && (await wrapSwitch.isEnabled()))
  await inv('settings:update', { general: { progressPanel: false } })
  check('greyed out while the Progress panel is off, saying why', !!(await until(async () => !(await wrapSwitch.isEnabled()))) && (await page.getByText('Turn on the Progress panel to use this.').count()) === 1)
  await wrapSwitch.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(shots, 'settings-wrap-greyed.png') })
  await inv('settings:update', { general: { progressPanel: true } })
  await until(async () => wrapSwitch.isEnabled())
  await wrapSwitch.click()
  check('turned off, it is saved', !!(await until(async () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).settings?.general?.progressCommands === false)))
  await page.screenshot({ path: path.join(shots, 'settings-wrap-off.png') })
  await page.keyboard.press('Control+Comma')
  await inv('session:stop', alpha, alfie.id)
  await until(async () => !(await live(alfie.id)) || (await live(alfie.id))?.status === 'stopped', 15000)
  await inv('session:start', alpha, { agentId: alfie.id })
  check('the agent starts again', !!(await until(async () => (await live(alfie.id))?.status === 'ready', 25000)))
  told = await instructionsOf(alpha)
  check('a session started afterwards is told: only when the user asks', /hive-progress -- <command>`.*only when the user asks/.test(told) && !/over 30 s/.test(told), told.slice(-400))
  await inv('settings:update', { general: { progressCommands: true } })

  // --- Switching the window to another workspace and back: its runs are gone, old ids unknown, the taskbar clear.
  r = await call(workspaceToken, 'POST', '/v1/progress', { title: 'script run', total: 2 })
  const run4 = r.body?.id
  check('a script reports a run', r.status === 200 && !!(await until(async () => taskbar()?.mode === 'normal')))
  const ws2 = path.join(lib.WORK, 'progress-ws2')
  fs.rmSync(ws2, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws2, 'gamma'), { recursive: true })
  await inv('workspace:open', ws2)
  check('switching away clears the taskbar', !!(await until(async () => taskbar()?.mode === 'none')), JSON.stringify(taskbar()))
  await lib.openWorkspace(inv, page, ws)
  check('reopened, the workspace has no runs', (await inv('progress:list')).length === 0)
  r = await call(workspaceToken, 'PATCH', `/v1/progress/${run4}`, { step: 1 })
  check("and the old run's id is unknown (404)", r.status === 404, JSON.stringify(r))

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll progress checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
