// The Assistant watches whole lanes (#531), on fake Claude Code agents (fake-claude/): one lane watch
// (hive_wait_for_tasks with lanes ["all"]) shows "Waiting on all running lanes"; a card moved into Review stays quiet; a
// failed review in the lane wakes it with one line naming the lane and the card; a lane started later is followed by the
// next watch too. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'lanewatch-profile')
const ws = path.join(lib.WORK, 'lanewatch-ws')
const claudeHome = path.join(lib.WORK, 'lanewatch-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47868))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  /** The lines Hive typed into the Assistant (fake-wakes.jsonl; the project agents' loop wakes left out), as text. */
  const wakes = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => !['Builder', 'Reviewer', 'Builder2'].includes(w.agent)).map((w) => w.text)
  }
  const say = async (p, id, text) => {
    await inv('pty:write', lib.ptyKey(p, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(p, id), '\r')
  }
  const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const builder2 = await lib.addAgent(inv, alpha, { name: 'Builder2' })
  const home = (await inv('workspace:refresh')).assistant.path
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), home.toLowerCase()]))
  for (const a of [builder, reviewer, builder2]) await inv('session:start', alpha, { agentId: a.id })
  await inv('session:start', home, { agentId: 'assistant' })
  check('the agents and the Assistant start', !!(await until(async () => (await idle(alpha, builder.id)) && (await idle(alpha, reviewer.id)) && (await idle(alpha, builder2.id)) && ['ready', 'finished'].includes((await live(home, 'assistant'))?.status), HUNG_MS)), JSON.stringify(await Promise.all([[alpha, builder.id], [alpha, reviewer.id], [alpha, builder2.id], [home, 'assistant']].map(async ([p, id]) => (await live(p, id))?.status ?? 'none'))))

  // A lane: Builder builds #a, #b; Reviewer reviews. Registered by the builder, as card-loop does.
  const newCard = async (title, agentId) => (await inv('tasks:create', { title, project: 'alpha', agent: agentId, column: 'doing' })).number
  const a = await newCard('Greeting says Hi', builder.id)
  const b = await newCard('Greeting trims the name', builder.id)
  await say(alpha, builder.id, `hive hive_lane ${JSON.stringify({ action: 'start', cards: [a, b], reviewer: 'Reviewer', name: 'greetings' })}`)
  await until(() => idle(alpha, builder.id), 15000)

  // The Assistant watches every running lane in one watch.
  await say(home, 'assistant', 'hive hive_wait_for_tasks {"lanes":["all"],"wake":true,"limitMinutes":360}')
  check('the Assistant watches the lanes: "Waiting on all running lanes"', !!(await until(async () => (await live(home, 'assistant'))?.status === 'watching' && (await live(home, 'assistant'))?.watch?.label === 'Waiting on all running lanes', 15000)), JSON.stringify((await live(home, 'assistant'))?.watch))
  const before = wakes().length
  await inv('tasks:update', a, { column: 'review' })
  await lib.sleep(3000) // A fixed wait on purpose: this checks that a plain move into Review does NOT wake it.
  check('a card moved into Review stays quiet', wakes().length === before && (await live(home, 'assistant'))?.status === 'watching', JSON.stringify(wakes().slice(before)))

  // The review fails: one line, naming the lane and the card.
  await until(() => idle(alpha, reviewer.id), 20000)
  await say(alpha, reviewer.id, `boardreview ${a} start`)
  await until(async () => (await inv('tasks:list')).find((c) => c.number === a)?.review?.agent === reviewer.id, 15000)
  await until(() => idle(alpha, reviewer.id), 15000)
  await say(alpha, reviewer.id, `boardreview ${a} failed`)
  const failedLine = () => wakes().slice(before).find((t) => t.startsWith('[Hive] Lane Builder / Reviewer (greetings):'))
  check('a failed review wakes it: one line with the lane and the card', !!(await until(async () => !!failedLine(), 20000)) && failedLine().includes(`#${a} failed review (Reviewer (alpha))`) && failedLine().includes('Your lane watch has ended'), JSON.stringify(wakes().slice(before)))

  // A lane started after its next watch began is followed too.
  await until(async () => ['ready', 'finished'].includes((await live(home, 'assistant'))?.status), 20000)
  await say(home, 'assistant', 'hive hive_wait_for_tasks {"lanes":["all"],"wake":true,"limitMinutes":360}')
  await until(async () => (await live(home, 'assistant'))?.status === 'watching', 15000)
  const c = await newCard('README usage', builder2.id)
  await say(alpha, builder2.id, `hive hive_lane ${JSON.stringify({ action: 'start', cards: [c], reviewer: 'Reviewer' })}`)
  await until(() => idle(alpha, builder2.id), 15000)
  await inv('tasks:update', c, { blocked: 'Which example should the README show?' })
  const blockedLine = () => wakes().find((t) => t.startsWith('[Hive] Lane Builder2 / Reviewer:'))
  check('a lane started later is followed: its blocked card wakes it', !!(await until(async () => !!blockedLine(), 20000)) && blockedLine().includes(`#${c} is blocked: "Which example should the README show?"`), JSON.stringify(wakes().slice(before)))
  await page.screenshot({ path: path.join(lib.WORK, 'lanewatch.png') })

  await inv('session:stop', alpha)
  await inv('session:stop', home)
  await until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
