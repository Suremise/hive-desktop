// Several windows, like VS Code: each shows its own workspace. New Window, a workspace already open in
// another window is brought forward instead, events stay in their window, the Agent API names workspaces,
// windows are reopened at start, and closing a window stops its workspace's agents (after asking).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { _electron } = require('playwright-core')

const userData = path.join(lib.WORK, 'windows-profile')
const wsA = path.join(lib.WORK, 'windows-ws-a')
const wsB = path.join(lib.WORK, 'windows-ws-b')
const PORT = 47893
const sleep = lib.sleep
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

function api(method, p, headers = {}) {
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function start() {
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT) }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  app.on('window', (p) => p.on('pageerror', (e) => console.log('FAIL page error', e.message)))
  return app
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
async function waitFor(fn, ms = 15000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(300)
  }
  return null
}

;(async () => {
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  for (const [ws, names] of [[wsA, ['shared', 'alpha']], [wsB, ['shared', 'beta']]]) for (const n of names) fs.mkdirSync(path.join(ws, n), { recursive: true })
  lib.enableProviders(userData, ['claude-code'])
  // Ask before stopping any session, so closing a window with one running shows the dialog.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'always' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // --- Two windows, two workspaces.
  let app = await start()
  const p1 = await app.firstWindow()
  await sleep(2000)
  const inv1 = invOn(p1)
  await inv1('workspace:open', wsA)
  const next = app.waitForEvent('window')
  await inv1('window:new')
  const p2 = await next
  await p2.waitForLoadState('domcontentloaded')
  await sleep(2000)
  const inv2 = invOn(p2)
  check('New Window opens a second window on the welcome page', (await inv2('workspace:get')) === null)
  await inv2('workspace:open', wsB)
  await sleep(500)
  check('each window has its own workspace', (await inv1('workspace:get'))?.path === wsA && (await inv2('workspace:get'))?.path === wsB)

  // Opening A in window 2 brings window 1 forward and leaves window 2 as it is.
  const again = await inv2('workspace:open', wsA)
  check('a workspace open elsewhere: that window comes forward, this one keeps its own', again?.path === wsB && (await inv2('workspace:get'))?.path === wsB)

  // A change in one window's workspace shows there only.
  await inv1('project:create', 'gamma')
  await sleep(1200)
  const t1 = await p1.locator('.sidebar').innerText().catch(() => '')
  const t2 = await p2.locator('.sidebar').innerText().catch(() => '')
  check("a workspace's changes reach its own window", /gamma/.test(t1), t1.slice(0, 200))
  check("…and not the other's", !/gamma/.test(t2) && /beta/.test(t2), t2.slice(0, 200))

  // The Agent API names workspaces.
  let r = await api('GET', '/v1/workspaces')
  check('API: /v1/workspaces lists both', r.status === 200 && r.body.length === 2, JSON.stringify(r.body))
  r = await api('GET', '/v1/projects')
  const names = (r.body ?? []).map((x) => `${x.workspace}/${x.name}`).sort()
  check('API: /v1/projects lists every window\'s projects with their workspace', JSON.stringify(names) === JSON.stringify(['windows-ws-a/alpha', 'windows-ws-a/gamma', 'windows-ws-a/shared', 'windows-ws-b/beta', 'windows-ws-b/shared']), JSON.stringify(names))
  r = await api('GET', '/v1/projects/shared')
  check('API: a project name in two workspaces is ambiguous (409)', r.status === 409, JSON.stringify(r))
  r = await api('GET', `/v1/projects/${encodeURIComponent('windows-ws-b/shared')}`)
  check('API: <workspace>/<project> picks one', r.status === 200 && r.body.path === path.join(wsB, 'shared'), JSON.stringify(r))
  r = await api('GET', '/v1/projects/shared', { 'X-Hive-Workspace': encodeURIComponent(wsA) })
  check("API: a session's workspace header picks its own", r.status === 200 && r.body.path === path.join(wsA, 'shared'), JSON.stringify(r))
  r = await api('GET', '/v1/shared')
  check('API: workspace-wide calls ask which workspace when several are open (400)', r.status === 400, JSON.stringify(r))
  r = await api('GET', '/v1/shared?workspace=windows-ws-b')
  check('API: …and answer with ?workspace=', r.status === 200, JSON.stringify(r))

  // --- Quit, and start again: both windows come back.
  const exited = app.waitForEvent('close', { timeout: 20000 }).then(() => true).catch(() => false)
  await inv1('app:quit').catch(() => undefined)
  check('Hive quits with no agents running', await exited)
  app = await start()
  await app.firstWindow()
  await waitFor(async () => app.windows().length >= 2, 15000)
  await sleep(3000)
  const pages = app.windows()
  const shown = []
  for (const pg of pages) shown.push((await invOn(pg)('workspace:get'))?.path ?? null)
  check('at start, the windows open when Hive quit come back', pages.length === 2 && shown.includes(wsA) && shown.includes(wsB), JSON.stringify(shown))

  // --- Closing a window with a running agent: asks, then stops that workspace's agent only.
  const pb = pages[shown.indexOf(wsB)]
  const pa = pages[shown.indexOf(wsA)]
  const invB = invOn(pb)
  const invA = invOn(pa)
  const beta = path.join(wsB, 'beta')
  const agent = await lib.addAgent(invB, beta)
  await invB('session:start', beta, { agentId: agent.id })
  await lib.acceptClaudeTrust(invB, beta, agent.id)
  check('an agent runs in window B', !!(await waitFor(async () => (await invA('session:live')).length === 1)))
  await pb.evaluate(() => window.hive.invoke('window:close')).catch(() => undefined)
  const dialog = await waitFor(async () => (await pb.getByText('Close this window?').count()) > 0, 8000)
  check('closing it asks first ("Close this window?")', !!dialog)
  await pb.screenshot({ path: path.join(lib.WORK, 'windows-close.png') }).catch(() => undefined)
  await pb.locator('.dialog .btn', { hasText: 'Close window' }).click().catch(() => undefined)
  const closed = await waitFor(async () => app.windows().length === 1, 10000)
  check('the window closes', !!closed)
  check("its workspace's agent was stopped", (await invA('session:live')).length === 0)
  check('the other window stays, with its workspace', (await invA('workspace:get'))?.path === wsA)
  // Settings are saved a moment after they change.
  const readSaved = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).windows ?? []
  const saved = (await waitFor(async () => (readSaved().length === 1 ? readSaved() : null), 5000)) ?? readSaved()
  check('the closed window is no longer reopened at start', saved.length === 1 && saved[0].workspace === wsA, JSON.stringify(saved.map((w) => w.workspace)))

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
