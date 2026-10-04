// Agents finishing together: one chime, and one Windows notification naming them ("3 agents finished": alpha (2),
// beta (1)); an agent asking for input is told at once, on its own. The test build runs quiet (HIVE_TEST_QUIET) and
// records each notification it would show to HIVE_TEST_NOTIFY_LOG; the chimes are counted in the page. The agents are the fake
// Claude Code. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'bursts-profile')
const ws = path.join(lib.WORK, 'bursts-ws')
const claudeHome = path.join(lib.WORK, 'bursts-claude-home')
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

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, beta, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, chimeEnabled: true, chimeVolume: 0, desktopNotifications: true, notifyOnFinished: true, notifyOnWaiting: true, onlyWhenUnfocused: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const notifyLog = path.join(lib.WORK, 'bursts-notify.log')
  fs.rmSync(notifyLog, { force: true })
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47902), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_QUIET: '1', HIVE_TEST_NOTIFY_LOG: notifyLog }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await app.evaluate(({ Notification }) => {
    Notification.isSupported = () => true
  })
  // The notifications Hive would have shown, since the last clearNotes().
  const logged = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification')
  let notesFrom = 0
  const notes = async () => logged().slice(notesFrom)
  const clearNotes = () => (notesFrom = logged().length)
  const chimes = () => page.evaluate(() => window.__hiveChimes?.() ?? -1)

  const one = await lib.addAgent(inv, alpha, { name: 'One' })
  const two = await lib.addAgent(inv, alpha, { name: 'Two' })
  const three = await lib.addAgent(inv, beta, { name: 'Three' })
  const agents = [[alpha, one], [alpha, two], [beta, three]]
  const live = async (proj, a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === a.id)
  for (const [p, a] of agents) await inv('session:start', p, { agentId: a.id })
  check('three agents start', !!(await until(async () => (await Promise.all(agents.map(([p, a]) => live(p, a)))).every((s) => s?.status === 'ready'), 25000)))
  const send = async (p, a, text) => {
    await inv('pty:write', lib.ptyKey(p, a.id), text)
    await lib.sleep(100)
    await inv('pty:write', lib.ptyKey(p, a.id), '\r')
  }

  // --- All three finish together.
  const chimesBefore = await chimes()
  for (const [p, a] of agents) await send(p, a, 'go work 2')
  check('they all finish', !!(await until(async () => (await Promise.all(agents.map(([p, a]) => live(p, a)))).every((s) => s?.status === 'finished'), 15000)))
  await lib.sleep(4500) // A fixed wait on purpose: it waits out the burst window (agents finishing together are told in one notification, gathered over a few seconds) to show only one arrives.
  const burst = await notes()
  check('one notification for the three', burst.length === 1, JSON.stringify(burst))
  check('counted by project', burst[0]?.title === '3 agents finished' && burst[0]?.body === 'alpha (2), beta (1)', JSON.stringify(burst[0]))
  check('one chime', (await chimes()) - chimesBefore === 1, String((await chimes()) - chimesBefore))

  // --- Two in one project: named.
  clearNotes()
  await lib.sleep(2500) // A fixed wait on purpose: the previous burst's window has to close first, or these finishes would join it.
  await send(alpha, one, 'go work 1')
  await send(alpha, two, 'go work 1')
  await until(async () => (await notes()).length > 0, 10000)
  const pair = await notes()
  check('two in one project: named', pair.length === 1 && pair[0].title === '2 agents finished in alpha' && pair[0].body === 'One, Two', JSON.stringify(pair))

  // --- Asking for input is told at once, on its own, while a finish is still being collected.
  clearNotes()
  await send(beta, three, 'go work 1')
  await send(alpha, one, 'ask work 4')
  const asked = await until(async () => (await notes()).find((n) => /needs your input/.test(n.title)), 2500)
  check('a question is told at once', !!asked, JSON.stringify(await notes()))
  check('on its own', !!asked && !/finished/.test(asked.title) && /One/.test(asked.title), JSON.stringify(asked))
  await until(async () => (await notes()).some((n) => /finished/.test(n.title)), 8000)
  const fin = (await notes()).filter((n) => /finished/.test(n.title))
  check('and the finish that came meanwhile is told after, alone', fin.length === 1 && /Three finished|beta/.test(fin[0].title), JSON.stringify(fin))
  await until(async () => (await live(alpha, one))?.status === 'finished', 10000)

  for (const [p, a] of agents) await inv('session:stop', p, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
