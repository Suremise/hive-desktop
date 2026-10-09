// The card loop with wake-on-change (#128), on two fake Claude Code agents (fake-claude/): a builder and a reviewer work
// through two cards in order, one passing first time and one failing once then passing, each waiting with
// hive_wait_for_tasks wake (no polling): Hive types one line into the waiting agent when its card changes, and the
// fake answers it with the next line of its wake script. Checked: the order, the rounds, the final columns, one wake per
// change; the watching status (header, Agent API), dispatch refused while watching, hive_wait_for_agents not waiting on
// a watcher; no wake typed while the agent works or the user types; a watch surviving a stop and resume; Cancel.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'cardloop-profile')
const ws = path.join(lib.WORK, 'cardloop-ws')
const claudeHome = path.join(lib.WORK, 'cardloop-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47901))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // A short typing pause, so the test of "not while the user types" doesn't take long.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 4, enterEndsPause: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => !agent || w.agent === agent)
  }
  const script = (agent, lines) => fs.writeFileSync(path.join(claudeHome, `fake-wakes-${agent}.txt`), lines.join('\n') + '\n')
  const start = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    return until(async () => (await live(id))?.status === 'ready')
  }
  /** Types a prompt into an agent (as the user does), Enter included. */
  const say = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  const wait = (n, extra) => `hive hive_wait_for_tasks ${JSON.stringify({ cards: Array.isArray(n) ? n : [n], ...extra, wake: true })}`

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const c1 = (await inv('tasks:create', { title: 'First card', project: 'alpha', agent: builder.id })).number
  const c2 = (await inv('tasks:create', { title: 'Second card', project: 'alpha', agent: builder.id })).number
  const built = (n) => `boardmove ${n} doing then ${wait(n, { changes: ['verdict', 'column'], column: 'passed' })} then boardmove ${n} review then boardcomment ${n}`
  // What each does when woken, in order: c1 passes first time; c2 fails once, then passes.
  script('Builder', [built(c2), built(c2), 'work 1'])
  script('Reviewer', [
    `boardreview ${c1} start then boardreview ${c1} passed passed then ${wait(c2, { column: 'review' })}`,
    `boardreview ${c2} start then ${wait(c2, { column: 'review', fresh: true })} then boardreview ${c2} failed`,
    `boardreview ${c2} start then boardreview ${c2} passed passed`
  ])
  await start(reviewer.id)
  await start(builder.id)

  // The reviewer waits for c1 to arrive in Review: watching, never idle.
  await say(reviewer.id, wait(c1, { column: 'review' }))
  const watching = await until(async () => (await live(reviewer.id))?.status === 'watching')
  const st = await live(reviewer.id)
  check('the reviewer is watching: status watching, with what for', !!watching && st?.watch?.label === `Waiting for #${c1} → Review`, JSON.stringify({ status: st?.status, watch: st?.watch }))
  check('its header says so, with Cancel', !!(await until(async () => (await page.locator('.pane-status.watching', { hasText: `Waiting for #${c1} → Review` }).count()) >= 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching.png') })
  /** Whether the watching header's Cancel is on screen where a click lands on it (not clipped or covered). */
  const cancelHit = (agentName) =>
    page.locator('.pane-header-bar', { hasText: agentName }).locator('.pane-status.watching .watch-cancel').first().evaluate((b) => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { clickable: !!hit && (hit === b || b.contains(hit)), x: Math.round(r.x), width: Math.round(r.width), hit: hit?.className ?? null }
    })
  // Hive's narrowest window (900 px), two panes: Cancel still fits, the label gives way.
  await lib.fitWindow(app, page, { width: 900, height: 750 })
  await lib.sleep(700)
  const narrow = await cancelHit('Reviewer')
  check('at 900 px in two panes, Cancel is where a click lands on it', narrow.clickable, JSON.stringify(narrow))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching-narrow.png') })
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(500)
  const activity = await api('GET', `/v1/projects/alpha/agents/Reviewer/activity`)
  check('the Agent API reports it watching, with the cards', activity.body?.status === 'watching' && activity.body?.watching?.cards?.[0] === c1 && activity.body?.statusMessage === `Waiting for #${c1} → Review`, JSON.stringify(activity.body).slice(0, 200))
  // Every status reply says what it waits for: project status, the project list and its short rows.
  const label = `Waiting for #${c1} → Review`
  const status = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Reviewer')
  check('project status: watching, statusMessage and the watch', status?.status === 'watching' && status?.statusMessage === label && status?.watching?.cards?.[0] === c1 && status?.watching?.column === 'review', JSON.stringify(status))
  const listed = (await api('GET', '/v1/projects')).body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Reviewer')
  check('project list: the same', listed?.statusMessage === label && listed?.watching?.label === label, JSON.stringify(listed))
  const row = (await api('GET', '/v1/projects?view=short')).body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Reviewer')
  check('project list, short rows: what it waits for', row?.status === 'watching' && row?.watching === label, JSON.stringify(row))
  // Quitting and closing treat a watcher as busy. The dialog says what it waits for; "Quit when agents finish" waits for
  // it only while another agent works on its card (c1 in Todo: no; in Doing with the builder: yes).
  await inv('settings:update', { general: { confirmOnQuit: 'working' } })
  const quitDialog = async () => {
    await inv('app:quit')
    await until(async () => (await page.locator('.quit-row').count()) > 0, 5000)
    const r = { rows: (await page.locator('.quit-row').allInnerTexts()).join(' | '), waitOffered: (await page.locator('.dialog button', { hasText: 'Quit when' }).count()) === 1 }
    await page.locator('.dialog button', { hasText: /^\s*Cancel\s*$/ }).click()
    await until(async () => (await page.locator('.quit-row').count()) === 0, 5000)
    return r
  }
  const dormant = await quitDialog()
  check('quit dialog: the watcher names its card; no waiting for a card nobody works on', dormant.rows.includes(`#${c1}`) && !dormant.waitOffered, JSON.stringify(dormant))
  await inv('tasks:update', c1, { column: 'doing', agent: builder.id })
  check('a card with another agent in Doing keeps quitting waiting', !!(await until(async () => (await quitDialog()).waitOffered, 8000)))
  let closed = false
  const closing = inv('workspace:close').then(() => (closed = true))
  const asked = await until(async () => !!(await inv('app:quitState'))?.request, 5000)
  check('closing the workspace asks before stopping a watcher', !!asked && !closed)
  await page.locator('.dialog button', { hasText: /^\s*Cancel\s*$/ }).click()
  await closing
  check('…and cancelling keeps it watching', (await live(reviewer.id))?.status === 'watching')
  await inv('tasks:update', c1, { column: 'todo' })
  // Merge and the Assistant's stop treat it as busy too (unit-tested: mergeBlocked, the stop route's question).
  // Dispatch: starting a card on a watching agent is refused (the user's Start too), saying why.
  const spare = (await inv('tasks:create', { title: 'Something else', project: 'alpha' })).number
  const refused = await inv('tasks:start', spare, { kind: 'agent', agentId: reviewer.id }).then(() => 'started', (e) => String(e?.message ?? e))
  check('a card started on a watching agent is refused, saying why', /card watch/.test(refused), refused)
  check('…and nothing was typed into it (still watching)', (await live(reviewer.id))?.status === 'watching')
  const t0 = Date.now()
  const waited = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Reviewer' }], timeoutSeconds: 20 })
  check('hive_wait_for_agents doesn’t wait on a watcher: it reports watching at once, with what for', waited.body?.agents?.[0]?.status === 'watching' && waited.body?.agents?.[0]?.statusMessage === label && waited.body?.agents?.[0]?.watching?.cards?.[0] === c1 && Date.now() - t0 < 5000 && waited.body?.timedOut === false, JSON.stringify(waited.body))

  // The builder works c1, watching for its verdict before moving it to Review; then the loop runs by itself.
  await say(builder.id, built(c1))
  const done = await until(async () => (await card(c1))?.column === 'passed' && (await card(c2))?.column === 'passed', 90000)
  check('both cards end in Passed (#170)', !!done, JSON.stringify({ c1: (await card(c1))?.column, c2: (await card(c2))?.column }))
  await until(async () => wakes('Builder').length >= 3 && (await live(builder.id))?.status === 'finished', 20000)
  const bw = wakes('Builder').map((w) => w.text)
  const rw = wakes('Reviewer').map((w) => w.text)
  check('the builder was woken once per verdict: c1 passed, c2 failed, c2 passed', bw.length === 3 && bw[0].includes(`#${c1}`) && bw[1].includes(`#${c2}`) && bw[2].includes(`#${c2}`), JSON.stringify(bw))
  // The reviewer watches the builder's cards: each wake says whose card it is (#143).
  check("the reviewer was woken once per arrival: c1, c2, c2 again, each naming the builder's card", rw.length === 3 && rw[0].includes(`#${c1} (Builder's card) is in Review`) && rw[1].includes(`#${c2} (Builder's card) is in Review`) && rw[2].includes(`#${c2} (Builder's card) is in Review`), JSON.stringify(rw))
  // The builder's own cards: no owner, the reviewer and its verdict named (#143); Passed isn't called unmerged on its own card.
  check("the builder's wakes name the reviewer's verdict: passed, failed, passed", bw.length === 3 && bw[0].includes(`#${c1} is in Passed: Reviewer (alpha) passed it;`) && bw[1].includes(`#${c2} is in Review: Reviewer (alpha) failed it;`) && bw[2].includes(`#${c2} is in Passed: Reviewer (alpha) passed it;`), JSON.stringify(bw))
  // A pass is one call (verdict, move to Passed and comment): the wake names that comment, not the builder's before it (#138).
  const passed = 'latest comment by Reviewer (alpha): "Fake review: passed."'
  check("the builder's wakes on a pass name the reviewer's comment from the same call", bw.length === 3 && bw[0].includes(passed) && bw[2].includes(passed), JSON.stringify(bw))
  const h2 = (await card(c2)).history.map((h) => h.what)
  check('c2: failed once, then passed (two rounds)', h2.filter((x) => x === 'Review failed').length === 1 && h2.filter((x) => x === 'Review passed').length === 1, h2.join(' | '))
  check('c1 passed first time', (await card(c1)).history.filter((h) => h.what === 'Review failed').length === 0)
  const passedAt = (await card(c1)).history.find((h) => h.what === 'Review passed')?.at ?? ''
  const c2Doing = (await card(c2)).history.find((h) => h.what.startsWith('Moved to Doing'))?.at ?? ''
  check('in order: c1 passed before c2 was begun', !!passedAt && !!c2Doing && passedAt < c2Doing, JSON.stringify({ passedAt, c2Doing }))
  const end = await until(async () => (await live(builder.id))?.status === 'finished' && (await live(reviewer.id))?.status === 'finished', 15000)
  check('at the end neither is watching', !!end, JSON.stringify({ b: (await live(builder.id))?.status, r: (await live(reviewer.id))?.status }))

  // --- Not over the user's typing or the agent's own work; survives a stop and resume; Cancel.
  const third = await lib.addAgent(inv, alpha, { name: 'Third' })
  const c3 = (await inv('tasks:create', { title: 'Third card', project: 'alpha' })).number
  script('Third', ['work 1', 'work 1', 'work 1', 'work 1'])
  await start(third.id)
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching')
  // The user types (no Enter) in its terminal, then the card changes: no wake while the user may still be typing.
  await inv('pty:write', lib.ptyKey(alpha, third.id), 'half a thought')
  await inv('tasks:comment', c3, 'First change')
  await lib.sleep(2000) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while the user is typing there', wakes('Third').length === 0, JSON.stringify(wakes('Third')))
  const afterPause = await until(async () => wakes('Third').length === 1, 15000)
  check('…and one wake once the typing pause has passed', !!afterPause && wakes('Third').length === 1)
  await until(async () => (await live(third.id))?.status === 'finished')
  // A watch, then the agent busy (a turn the user started): the change waits for its turn to end.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching')
  await say(third.id, 'work 4')
  await until(async () => (await live(third.id))?.status === 'working')
  await inv('tasks:comment', c3, 'Second change')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while the agent is working', wakes('Third').length === 1)
  check('…and one wake when its turn ends', !!(await until(async () => wakes('Third').length === 2, 15000)))
  await until(async () => (await live(third.id))?.status === 'finished')
  // A watch survives a stop and a resume: a change while it is stopped wakes it once it is back.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching')
  const sid = (await live(third.id)).sessionId
  await inv('session:stop', alpha, third.id)
  await until(async () => !(await live(third.id)))
  await inv('tasks:comment', c3, 'Third change')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while it is stopped', wakes('Third').length === 2)
  await inv('session:start', alpha, { agentId: third.id, resumeId: sid })
  check('…and one wake after it is resumed', !!(await until(async () => wakes('Third').length === 3, 30000)))
  await until(async () => (await live(third.id))?.status === 'finished')
  // Compact while watching: allowed (the watch is kept); a change during the compaction wakes it only once that has ended.
  await say(third.id, wait(c3, { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching')
  await page.keyboard.press('Control+3')
  await lib.sleep(500)
  const compactBtn = page.locator('.pane-header-bar', { hasText: 'Third' }).locator('button[aria-label="Compact"]').first()
  check('Compact is on for a watching agent', await compactBtn.isEnabled())
  await compactBtn.click()
  await page.locator('.compact-focus textarea').fill('hold 4')
  await page.locator('.dialog button', { hasText: /^\s*Compact\s*$/ }).click()
  const compactingNow = await until(async () => (await live(third.id))?.status === 'working', 8000)
  check('…it compacts, its watch kept', !!compactingNow && !!(await live(third.id))?.watch, JSON.stringify(await live(third.id)))
  await inv('tasks:comment', c3, 'During the compaction')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('no wake while it compacts', wakes('Third').length === 3, JSON.stringify(wakes('Third')))
  check('…and one wake once the compaction has ended', !!(await until(async () => wakes('Third').length === 4, 20000)))
  await until(async () => (await live(third.id))?.status === 'finished')
  // Cancel: the watch ends, the status is finished again, and a change wakes nothing. A longer label (three cards) in a
  // pane at its narrowest header (three panes, under 340 px each): Cancel stays clickable, and is clicked there. The
  // agent's More menu has Cancel Card Watch too, for a pane too narrow for anything else.
  await say(third.id, wait([c3, c1, c2], { changes: ['comment'] }))
  await until(async () => (await live(third.id))?.status === 'watching')
  await page.keyboard.press('Control+3')
  await lib.sleep(500)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1))
  await lib.fitWindow(app, page, { width: 1100, height: 750 })
  await lib.sleep(800)
  const tight = await cancelHit('Third')
  check('three panes (under 340 px each), a three-card label: Cancel is clickable', tight.clickable, JSON.stringify(tight))
  await page.screenshot({ path: path.join(lib.WORK, 'cardloop-watching-tight.png') })
  // The More menu has it as well.
  await page.locator('.pane-header-bar', { hasText: 'Third' }).getByLabel('More').first().click()
  check('the agent menu offers Cancel Card Watch', (await page.getByText('Cancel Card Watch').count()) >= 1)
  await page.keyboard.press('Escape')
  await page.locator('.pane-header-bar', { hasText: 'Third' }).locator('.watch-cancel').first().click()
  check('Cancel ends the watch', !!(await until(async () => (await live(third.id))?.status === 'finished' && !(await live(third.id))?.watch, 5000)))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(500)
  await inv('tasks:comment', c3, 'Fourth change')
  await lib.sleep(2500) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('…and a later change wakes nothing', wakes('Third').length === 4)

  // --- A watch on another agent's card (a dependency, #143): the wake says whose card it is, and that Passed isn't merged.
  const dep = (await inv('tasks:create', { title: 'Needed first', project: 'alpha', agent: builder.id, column: 'review' })).number
  script('Third', ['work 1'])
  await say(third.id, wait(dep, { column: 'passed' }))
  await until(async () => (await live(third.id))?.status === 'watching')
  await inv('tasks:update', dep, { column: 'passed' })
  check("a dependency's wake names its agent and says Passed isn't merged", !!(await until(async () => wakes('Third').length === 5, 15000)) && wakes('Third')[4].text.includes(`#${dep} (Builder's card) is in Passed (Passed isn't merged)`), JSON.stringify(wakes('Third').slice(4)))
  await until(async () => (await live(third.id))?.status === 'finished')

  // --- A bounded wait (no wake): it returns on a comment, a move and a verdict; times out; since misses nothing.
  const c4 = (await inv('tasks:create', { title: 'Waited on', project: 'alpha', agent: builder.id })).number
  const t1 = Date.now()
  const quiet = await api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 2 })
  check('no change: it times out (after the timeout), with a since', quiet.body?.timedOut === true && (quiet.body?.since ?? '').startsWith('@') && Date.now() - t1 >= 1900, JSON.stringify(quiet.body))
  const onChange = async (change, cond = {}) => {
    const t = Date.now()
    const pending = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 30, ...cond })
    await lib.sleep(800)
    await change()
    const r = await pending
    return { r: r.body, ms: Date.now() - t }
  }
  const byComment = await onChange(() => inv('tasks:comment', c4, 'A note\nmore'), { changes: ['comment'] })
  check('it returns on a new comment, with its first line', byComment.r?.changes?.[0]?.changes?.includes('comment') && byComment.r.changes[0].comment?.firstLine === 'A note' && byComment.ms < 10000, JSON.stringify(byComment))
  const byMove = await onChange(() => inv('tasks:update', c4, { column: 'review' }), { column: 'review' })
  check('it returns on a move into the column', byMove.r?.changes?.[0]?.column === 'review' && byMove.ms < 10000, JSON.stringify(byMove))
  // since: a change between two waits is never missed.
  const since = byMove.r.since
  await inv('tasks:comment', c4, 'Between two waits')
  const missed = await api('POST', '/v1/tasks/wait', { cards: [c4], changes: ['comment'], since, timeoutSeconds: 5 })
  check('with since, a change made between two waits is reported at once', missed.body?.changes?.[0]?.comment?.firstLine === 'Between two waits', JSON.stringify(missed.body))
  // A verdict: the reviewer's own tools (the wait itself as a script, the verdict through the reviewer's fake).
  const byVerdict = await onChange(() => say(reviewer.id, `boardreview ${c4} start then boardreview ${c4} failed`), { changes: ['verdict'] })
  check('it returns on a review verdict', byVerdict.r?.changes?.[0]?.changes?.includes('verdict'), JSON.stringify(byVerdict.r))
  // Per caller: at most two at a time.
  const a1 = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  const a2 = api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  await lib.sleep(300)
  const a3 = await api('POST', '/v1/tasks/wait', { cards: [c4], timeoutSeconds: 3 })
  check('a third wait at once from the same caller is refused (429)', a3.status === 429, JSON.stringify(a3))
  await Promise.all([a1, a2])
  // Scope: a project agent's token waits only on its own project's cards.
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  await inv('workspace:refresh')
  const c5 = (await inv('tasks:create', { title: 'Beta card', project: 'beta' })).number
  // Every agent here is alpha's: its newest token (the files don't name the project) is an alpha agent's.
  const tokenDir = path.join(userData, 'agent-api')
  const newest = fs.readdirSync(tokenDir).map((f) => ({ f, t: fs.statSync(path.join(tokenDir, f)).mtimeMs })).sort((x, y) => y.t - x.t)[0]
  const agentToken = newest ? JSON.parse(fs.readFileSync(path.join(tokenDir, newest.f), 'utf8')).token : null
  if (agentToken) {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/wait`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: [c5], timeoutSeconds: 1 }) })
    check("an alpha agent can't wait on beta's card (unknown to it)", r.status === 404, String(r.status))
  } else check('an agent token was found to test scope with', false, fs.readdirSync(path.join(userData, 'agent-api')).join(','))

  await page.screenshot({ path: path.join(lib.WORK, 'cardloop.png') })

  // --- Quit when agents finish, with only a watcher left: it waits while another agent works on a card the watcher
  // waits on, and quits once none is, though no wake comes (the cards leave Doing without reaching Review).
  const q1 = (await inv('tasks:create', { title: 'Quit one', project: 'alpha', column: 'doing', agent: builder.id })).number
  const q2 = (await inv('tasks:create', { title: 'Quit two', project: 'alpha', column: 'doing', agent: builder.id })).number
  const reviewerWakes = wakes('Reviewer').length
  await say(reviewer.id, wait([q1, q2], { column: 'review' }))
  await until(async () => (await live(reviewer.id))?.status === 'watching')
  await inv('app:quit')
  const quitWhen = page.locator('.dialog button', { hasText: 'Quit when' })
  await until(async () => (await quitWhen.count()) === 1, 5000)
  await quitWhen.click()
  const pendingNow = await until(async () => (await inv('app:quitState'))?.pending === true, 5000)
  check('a quit is pending, waiting on the watcher', !!pendingNow && (await inv('app:quitState')).working === 1, JSON.stringify(await inv('app:quitState')))
  const quitting = await lib.quitWatch(app)
  await inv('tasks:update', q1, { column: 'done' })
  await lib.sleep(2500) // A fixed wait on purpose: this checks that Hive does NOT quit yet, which no condition can show.
  const still = await inv('app:quitState')
  check('…still waiting while the other card it watches is in Doing with the builder', still?.pending === true && still?.working === 1, JSON.stringify(still))
  const moved = Date.now()
  await inv('tasks:update', q2, { column: 'todo' })
  // Hive decides to quit (#424): timed from the move; its process ending after that is Electron's, only waited for.
  check('…and Hive quits once no watched card is being worked on', !!(await quitting.untilDecided(20000)) && (await quitting.gone(30000)), quitting.timings(moved))
  check('…without waking the watcher', wakes('Reviewer').length === reviewerWakes, JSON.stringify(wakes('Reviewer').slice(reviewerWakes)))
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
