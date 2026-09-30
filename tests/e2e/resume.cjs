// Resume per agent: guard against one conversation in two agents, AgentInfo.resume, the Resume split
// button + session picker, the session tag, Sessions tab Show / Resume in.
// Throwaway profile and git project under the trusted test folder. A real Claude Code session starts
// in Agent 1, but no prompt is ever sent. Clipboard untouched.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path'), { execSync } = require('child_process')
const scratch = lib.WORK, userData = path.join(scratch, 'resume-profile')
const root = path.join(lib.ROOT, 'node_modules/.hive-test')
const ws = path.join(root, 'ws')
for (const d of [userData, root]) fs.rmSync(d, { recursive: true, force: true })
const proj = path.join(ws, 'demo')
fs.mkdirSync(proj, { recursive: true })
const g = (cmd) => execSync(`git ${cmd}`, { cwd: proj, stdio: 'pipe' }).toString()
g('init -q -b main'); g('config user.email test@example.com'); g('config user.name Test')
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n'); g('add -A'); g('commit -q -m init')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
const shot = (page, n) => page.screenshot({ path: path.join(scratch, `resume-${n}.png`) })

;(async () => {
  lib.enableProviders(userData)
  const env = { ...process.env, HIVE_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const project = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await inv('project:setActive', proj, true)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(500)

  // Old sessions: two of Agent 1's, none of Agent 2's.
  const A1 = await lib.addAgent(inv, proj)
  const A2 = await lib.addAgent(inv, proj)
  const file = path.join(proj, '.hive', 'sessions.json')
  const old = (id, name, at, extra = {}) => ({ id, agent: 'claude-code', name, createdAt: at, lastActiveAt: at, archived: false, ...extra })
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [old('11111111-0000-4000-8000-000000000001', 'Older work', '2026-09-20T10:00:00Z', { agentId: A1.id }), old('11111111-0000-4000-8000-000000000002', 'Tray fixes', '2026-09-25T10:00:00Z', { agentId: A1.id })] }))
  let p = await project()
  const a1 = () => p.agents.find((a) => a.id === A1.id), a2 = () => p.agents.find((a) => a.id === A2.id)
  check('Agent 1 resume = its latest', a1().resume?.id === '11111111-0000-4000-8000-000000000002', JSON.stringify(a1().resume))
  check('Agent 2 has nothing of its own', a2().resume === null)

  // Two columns so both pane headers show.
  await inv('project:updateConfig', proj, { sessionLayout: 'columns2' }); await sleep(800)
  const h2 = page.locator('.pane-header-bar', { hasText: 'Agent 2' })
  check('Agent 2 Resume disabled', await h2.locator('button[aria-label="Resume"]').isDisabled())

  // Start Agent 1 fresh (no prompt sent).
  const st = await inv('session:start', proj, { agentId: A1.id })
  await lib.acceptClaudeTrust(inv, proj, A1.id)
  await sleep(4000)
  p = await project()
  check('Agent 1 running', !!a1().live)

  // Guard: Agent 2 can't take the conversation Agent 1 has open.
  const err = await page.evaluate(([folder, id, a2id]) => window.hive.invoke('session:start', folder, { resumeId: id, agentId: a2id }).then(() => 'started', (e) => String(e.message ?? e)), [proj, st.sessionId, A2.id])
  check('guard refuses a conversation open in another agent', /already open in Agent 1/.test(err), err)
  check('Agent 2 still stopped', !(await project()).agents.find((a) => a.id === A2.id).live)

  // Session tag in Agent 1's header.
  const h1 = page.locator('.pane-header-bar', { hasText: 'Agent 1' })
  check('session tag shown', (await h1.locator('.session-tag').count()) === 1, await h1.locator('.session-tag').textContent().catch(() => ''))

  // Picker for Agent 2: Agent 1's open session greyed, old sessions resumable.
  await h2.locator('button[aria-label="Resume a Session…"]').click(); await sleep(1200)
  const rows = page.locator('.menu .menu-item.two-line')
  const texts = await rows.allTextContents()
  check('picker lists 3 sessions', texts.length === 3, JSON.stringify(texts))
  check('open one is muted and names Agent 1', (await page.locator('.menu .menu-item.muted').count()) === 1 && /open in Agent 1/.test(texts.join('|')))
  check('old sessions say who ran them', texts.filter((t) => /last run by Agent 1/.test(t)).length === 2)
  await shot(page, '1-picker')
  // Clicking the open one shows Agent 1 instead of resuming.
  await page.locator('.menu .menu-item.muted').click(); await sleep(500)
  check('clicking the open one focuses Agent 1', await page.locator('.pane-header-bar.focused', { hasText: 'Agent 1' }).count() === 1)
  check('still only Agent 1 runs', (await project()).agents.filter((a) => a.live).length === 1)

  // Session tag → Sessions tab on that session, with Show instead of Resume.
  await h1.locator('.session-tag').click(); await sleep(1500)
  check('Sessions tab opened', await page.locator('.tabs .tab.active', { hasText: 'Sessions' }).count() === 1)
  check('live session selected', await page.locator('.session-row.selected').count() === 1)
  check('Show button for the running session', await page.locator('.transcript-toolbar button', { hasText: 'Show' }).count() === 1)
  await shot(page, '2-sessions-live')
  // An old session: Resume goes to the free agent, ▾ offers both.
  await page.locator('.session-row', { hasText: 'Tray fixes' }).click(); await sleep(800)
  const resumeBtn = page.locator('.transcript-toolbar .split-btn button').first()
  check('Resume in Agent 2 (Agent 1 is busy)', /Resume in Agent 2/.test(await resumeBtn.textContent()), await resumeBtn.textContent())
  await page.locator('.transcript-toolbar .split-caret').click(); await sleep(400)
  const inTexts = await page.locator('.menu .menu-item').allTextContents()
  check('Resume in menu lists both agents', inTexts.length === 2 && /running/.test(inTexts[0]), JSON.stringify(inTexts))
  await shot(page, '3-resume-in')
  await page.keyboard.press('Escape')

  // The agent header's Resume and Resume a Session… buttons
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click(); await sleep(500)
  await page.locator('.pane-header-bar', { hasText: 'Agent 2' }).click(); await sleep(300)
  check('header Resume disabled for Agent 2', await page.locator('.pane-header-bar', { hasText: 'Agent 2' }).locator('button[aria-label="Resume"]').isDisabled())
  await page.locator('.pane-header-bar', { hasText: 'Agent 2' }).locator('button[aria-label="Resume a Session…"]').click(); await sleep(1000)
  check('header picker opens', (await page.locator('.menu .menu-header').textContent()) === 'Resume in Agent 2')
  await shot(page, '4-header')
  await page.keyboard.press('Escape')

  // Rename the live session: the tag follows.
  await inv('session:rename', proj, st.sessionId, 'Renamed live')
  await sleep(600)
  check('tag follows rename', /Renamed live/.test(await h1.locator('.session-tag').textContent()))

  await inv('session:stop', proj, A1.id); await sleep(2500)
  p = await project()
  check('after stop Agent 1 resume is back', !!a1().resume, JSON.stringify(a1().resume))
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
