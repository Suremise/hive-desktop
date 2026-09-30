// Repro: start a session, type nothing, change permission mode, click "Restart session".
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'profile')
const ws = path.join(scratch, 'ws')
const shots = path.join(scratch, 'shots')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  lib.enableProviders(userData)
  const env = { ...process.env, HIVE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: lib.ELECTRON,
    args: [lib.ROOT],
    cwd: lib.ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])

  await inv('workspace:open', ws)
  const proj = path.join(ws, 'demo')
  await sleep(1000)
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { name: 'restart test', agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  console.log('started', st.sessionId)
  await sleep(10000)
  await page.screenshot({ path: path.join(shots, '1-started.png') })

  await inv('project:updateConfig', proj, { providers: { 'claude-code': { effort: 'low' } } })
  await inv('workspace:refresh')
  await sleep(1500)
  await page.screenshot({ path: path.join(shots, '2-banner.png') })
  await page.getByRole('button', { name: 'Restart session' }).click()
  await sleep(10000)
  await page.screenshot({ path: path.join(shots, '3-after-restart.png') })

  const live = await inv('session:live')
  const list = await inv('session:list', proj)
  console.log('live', JSON.stringify(live.map((l) => ({ id: l.sessionId, status: l.status }))))
  console.log('list', JSON.stringify(list.map((s) => ({ id: s.id, name: s.name }))))
  const logFile = path.join(userData, 'logs', 'hive.log')
  if (fs.existsSync(logFile)) console.log(fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /transcript|fresh|exit/i.test(l)).join('\n'))

  await inv('session:stop', proj)
  await sleep(1500)
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
