// A card leaving the watch of an agent whose part in it ended (#420), on fake Claude Code agents (fake-claude/): a
// reviewer waiting for a card to arrive in Review is woken once when the card is given to another agent, and no longer
// waits; a watch on two cards drops one that gets blocked and keeps the other, told together when that one changes; the
// card's new agent keeps its own watch; the card's history says whose watch ended. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'watchrelease-profile')
const ws = path.join(lib.WORK, 'watchrelease-ws')
const claudeHome = path.join(lib.WORK, 'watchrelease-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47861))
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
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
  }
  const say = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  const watch = (cards, extra) => `hive hive_wait_for_tasks ${JSON.stringify({ cards, ...extra, wake: true })}`
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const other = await lib.addAgent(inv, alpha, { name: 'Other' })
  const newCard = async (title) => {
    const n = (await inv('tasks:create', { title, project: 'alpha', agent: builder.id })).number
    await inv('tasks:update', n, { column: 'doing', agent: builder.id })
    return n
  }
  for (const a of [builder, reviewer, other]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)) && (await idle(other.id)))))

  // The reviewer waits for Builder's card to arrive in Review; the card is given to Other.
  const c1 = await newCard('First')
  await say(reviewer.id, watch([c1], { column: 'review' }))
  check('the reviewer watches the card', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await inv('tasks:update', c1, { agent: other.id })
  check('given to another agent: the reviewer is woken', !!(await until(async () => wakes('Reviewer').length >= 1, 20000)))
  await lib.sleep(2000) // A fixed wait on purpose: this checks that a second line does NOT come.
  const w1 = wakes('Reviewer')
  check('…once, saying so, and to carry on', w1.length === 1 && w1[0] === `[Hive] #${c1} was reassigned to Other (your watch on it ended). Your card watch has ended: drop it from your list and carry on with your next card.`, JSON.stringify(w1))
  check('…and it no longer waits', !!(await until(() => idle(reviewer.id), 15000)) && !(await live(reviewer.id))?.watch)
  check("the card's history says whose watch ended", !!(await until(async () => (await card(c1))?.history.some((h) => h.by === 'Hive' && h.what === "Ended Reviewer (alpha)'s watch on it: reassigned to Other"), 10000)), JSON.stringify((await card(c1))?.history.map((h) => h.what)))

  // Its new agent watches it for a verdict; the reviewer starts reviewing it: the new agent keeps its watch.
  await say(other.id, watch([c1], { changes: ['verdict', 'column'], column: 'passed' }))
  await until(async () => (await live(other.id))?.status === 'watching', 15000)
  await inv('tasks:update', c1, { column: 'review', agent: other.id })
  await say(reviewer.id, `boardreview ${c1} start`)
  await until(async () => (await card(c1))?.review?.agent === reviewer.id, 15000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the new agent is NOT released.
  check("the card's new agent keeps its watch through a review", (await live(other.id))?.status === 'watching' && (await live(other.id))?.watch?.cards?.[0] === c1 && wakes('Other').length === 0, JSON.stringify({ status: (await live(other.id))?.status, wakes: wakes('Other') }))
  await until(() => idle(reviewer.id), 15000)

  // Two cards: one blocked leaves the watch quietly; the other's arrival tells both.
  const c2 = await newCard('Second')
  const c3 = await newCard('Third')
  await say(reviewer.id, watch([c2, c3], { column: 'review' }))
  await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)
  await inv('tasks:update', c2, { blocked: 'Waiting for the user to choose' })
  check('a blocked card leaves a watch on two', !!(await until(async () => JSON.stringify((await live(reviewer.id))?.watch?.cards) === JSON.stringify([c3]), 15000)), JSON.stringify((await live(reviewer.id))?.watch))
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the other card's watch isn't woken yet.
  check('…without a wake while the other card is still watched', wakes('Reviewer').length === 1, JSON.stringify(wakes('Reviewer').slice(1)))
  await inv('tasks:update', c3, { column: 'review' })
  check('the other card arriving tells both', !!(await until(async () => wakes('Reviewer').length === 2, 20000)) && wakes('Reviewer')[1].startsWith(`[Hive] #${c2} is blocked: "Waiting for the user to choose" (your watch on it ended); #${c3} (Builder's card) is in Review`), JSON.stringify(wakes('Reviewer').slice(1)))

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
