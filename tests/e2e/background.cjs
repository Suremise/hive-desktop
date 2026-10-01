// An agent waiting on a background task it started: shown as background (not finished), waited for by
// hive_wait_for_agents, refused new tasks, and finished once the task's notification has run its turn. The agent
// runs the fake Claude Code (fake-claude/), so nothing signs in or spends tokens. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'bg-profile')
const ws = path.join(lib.WORK, 'bg-ws')
const claudeHome = path.join(lib.WORK, 'bg-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = '47896'
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n' })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: true, port: Number(PORT), provideHiveMcp: true, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  // Adding agents and giving them tasks is the Assistant's: start it (also the fake) and use its token.
  const info = await inv('workspace:refresh')
  const home = info.assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'waiting')
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await live(home, 'assistant'))?.status === 'ready')
  const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  // An agent that starts a 12-second background task and ends its turn at once.
  await page.getByText('alpha', { exact: true }).first().click()
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Tester', prompt: 'background 12' })
  check('the agent starts on its task', added.status === 200, JSON.stringify(added.body))
  const id = added.body?.agent?.id
  await until(async () => (await live(alpha, id))?.status === 'waiting')
  await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  const bg = await until(async () => {
    const s = await live(alpha, id)
    return s?.status === 'background' && s
  })
  check('its turn ends with the task running: background, not finished', bg?.backgroundTasks === 1, JSON.stringify(bg && { status: bg.status, tasks: bg.backgroundTasks }))
  const t0 = Date.now()

  const short = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 5 })
  check('waiting goes on through the background task', short.body?.timedOut === true && short.body.agents[0].status === 'background' && short.body.agents[0].backgroundTasks === 1, JSON.stringify(short.body))
  const ignoring = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30, ignoreBackground: true })
  check('ignoreBackground returns at the end of its turn', ignoring.body?.timedOut === false && ignoring.body.waitedSeconds <= 2, JSON.stringify(ignoring.body))
  const refused = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'something else' })
  check('no new task while it waits on its background task', refused.status === 409 && /background task/.test(refused.body?.error ?? ''), JSON.stringify(refused.body))
  const act = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body
  check('its activity counts the task', act?.status === 'background' && act.backgroundTasks === 1, JSON.stringify(act && { status: act.status, tasks: act.backgroundTasks }))
  const status = await page.locator('.pane-status').first().innerText().catch(() => '')
  check("the pane says what it's waiting on", /Waiting on 1 background task/.test(status), status)
  await page.screenshot({ path: path.join(lib.WORK, 'background.png') })
  const overview = (await api('GET', '/v1/projects/alpha')).body
  check('the project status shows it too', overview?.agents?.[0]?.status === 'background' && overview.agents[0].backgroundTasks === 1, JSON.stringify(overview?.agents))

  // The task ends: its notification starts a turn by itself, which then ends with nothing left running.
  const done = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 60 })
  const a = done.body?.agents?.[0]
  check('waiting returns once the task has ended and the agent finished', done.body?.timedOut === false && a?.status === 'finished' && a.backgroundTasks === 0 && Date.now() - t0 >= 9000, JSON.stringify(done.body))
  const after = (await api('GET', '/v1/projects/alpha/agents/Tester/activity')).body
  check('it replied to the task notification', /background task .* has finished/.test(after?.latestReply ?? ''), after?.latestReply)
  const given = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'work 1' })
  check('then it takes a task again', given.status === 200, JSON.stringify(given.body))
  await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30 })

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
