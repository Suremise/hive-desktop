// Restart session: start a session, type nothing, change a setting that needs a restart (effort), click "Restart
// session": the session comes back with the new setting, resuming the same conversation. The agent runs the fake
// Claude Code (fake-claude/, #195), whose launches show what Hive started it with; that the real Claude Code takes the
// relaunch is claude-real's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'restart-profile')
const ws = path.join(scratch, 'restart-ws')
const shots = path.join(scratch, 'restart-shots')
const claudeHome = path.join(scratch, 'restart-claude-home')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

;(async () => {
  const claude = lib.fakeClaude(userData, claudeHome, [path.join(ws, 'demo')])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claude })
  const app = await _electron.launch({
    executablePath: lib.ELECTRON,
    args: [lib.ROOT],
    cwd: lib.ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])

  await lib.openWorkspace(inv, page, ws)
  const proj = path.join(ws, 'demo')
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { name: 'restart test', agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  // Up and ready (SessionStart arrived).
  check('the session starts', !!(await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)))
  await page.screenshot({ path: path.join(shots, '1-started.png') })

  await inv('project:updateConfig', proj, { providers: { 'claude-code': { effort: 'low' } } })
  await inv('workspace:refresh')
  check('a changed effort offers Restart session', !!(await lib.until(async () => (await page.getByRole('button', { name: 'Restart session' }).count()) > 0, 10000)))
  await page.screenshot({ path: path.join(shots, '2-banner.png') })
  await page.getByRole('button', { name: 'Restart session' }).click()
  // Restarted: the banner gone and the session ready again.
  // Ready again from the relaunch: the fake launched a second time.
  check('after Restart session it is ready again, the offer gone', !!(await lib.until(async () => launches().length === 2 && (await page.getByRole('button', { name: 'Restart session' }).count()) === 0 && (await inv('session:live')).some((l) => l.status === 'ready'), 30000)))
  await page.screenshot({ path: path.join(shots, '3-after-restart.png') })

  const live = await inv('session:live')
  const list = await inv('session:list', proj)
  const [first, second] = launches()
  check('the first launch had no effort set', !first?.opts['--effort'], JSON.stringify(first?.opts))
  check('the relaunch has the new effort', second?.opts['--effort'] === 'low', JSON.stringify(second?.opts))
  check('…and resumes the same conversation', second?.opts['--resume'] === st.sessionId && live.length === 1 && live[0].sessionId === st.sessionId, JSON.stringify({ resume: second?.opts['--resume'], live: live.map((l) => l.sessionId) }))
  check('one conversation in the list, still named', list.length === 1 && list[0].id === st.sessionId && /restart test/.test(list[0].name ?? ''), JSON.stringify(list.map((s) => ({ id: s.id, name: s.name }))))

  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
