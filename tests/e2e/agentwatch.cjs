// Agent watches (#416): hive_wait_for_agents with wake, on fake Claude Code agents (fake-claude/). A watcher asks to be
// told when another agent is done and ends its turn at once (watching, "Waiting for Worker to finish"); Hive types one
// line into it when the agent finishes its turn (with its reply), starts waiting for the user, or stops; exactly once
// each. Also: an agent not working is the answer at once; nothing is typed while the watcher works or the user types
// there; limitMinutes ends a watch with a "still working" line; cancel ends one. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'agentwatch-profile')
const ws = path.join(lib.WORK, 'agentwatch-ws')
const claudeHome = path.join(lib.WORK, 'agentwatch-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47863))
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
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => !agent || w.agent === agent).map((w) => w.text)
  }
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
  const watchOn = (name, extra = {}) => `hive hive_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: name }], wake: true, ...extra })}`
  /** The result of the agent's latest hive_wait_for_agents call, from its transcript. */
  const lastWaitReply = async (id) => {
    const s = await live(id)
    const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
    return items.filter((x) => x.kind === 'tool' && x.tool.name === 'hive · hive_wait_for_agents').at(-1)?.tool.result ?? null
  }
  /** Whether an agent's turn has ended and it isn't watching. */
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const watcher = await lib.addAgent(inv, alpha, { name: 'Watcher' })
  const worker = await lib.addAgent(inv, alpha, { name: 'Worker' })
  const limiter = await lib.addAgent(inv, alpha, { name: 'Limiter' })
  const slow = await lib.addAgent(inv, alpha, { name: 'Slow' })
  for (const a of [watcher, worker, limiter, slow]) await start(a.id)

  // --- The limit (checked at the end): Limiter watches Slow, which works longer than the watch's one minute.
  await say(slow.id, 'work 240')
  await until(async () => (await live(slow.id))?.status === 'working')
  await say(limiter.id, watchOn('Slow', { limitMinutes: 1 }))
  const limitFrom = Date.now()
  check('a watch on a working agent: the watcher ends its turn at once, watching', !!(await until(async () => (await live(limiter.id))?.status === 'watching', 15000)), (await live(limiter.id))?.status)

  // --- An agent not working is the answer at once: no watch.
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await lastWaitReply(watcher.id)) !== null && (await idle(watcher.id)), 15000)
  const already = await lastWaitReply(watcher.id)
  check('watching an idle agent answers at once: already, and no watch', (already ?? '').startsWith('Already: Worker (alpha) is idle') && !(await live(watcher.id))?.watch, already)

  // --- Finishing its turn: one line, with its reply.
  await say(worker.id, 'work 6')
  await until(async () => (await live(worker.id))?.status === 'working')
  const t0 = Date.now()
  await say(watcher.id, watchOn('Worker'))
  const watching = await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  const st = await live(watcher.id)
  check('the watcher is watching while the worker still works, with what for', !!watching && st?.watch?.label === 'Waiting for Worker to finish' && (await live(worker.id))?.status === 'working', JSON.stringify({ watch: st?.watch, worker: (await live(worker.id))?.status, ms: Date.now() - t0 }))
  const reply = await lastWaitReply(watcher.id)
  check('the tool replied at once, saying to end the turn', (reply ?? '').startsWith('Waiting for Worker to finish. End your turn now'), reply)
  check('its header says so, with Cancel', !!(await until(async () => (await page.locator('.pane-status.watching', { hasText: 'Waiting for Worker to finish' }).count()) >= 1, 5000)))
  const status = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Watcher')
  check('the Agent API reports the watch, with the agent watched', status?.status === 'watching' && status?.statusMessage === 'Waiting for Worker to finish' && status?.watching?.agents?.[0] === 'Worker', JSON.stringify(status))
  await page.screenshot({ path: path.join(lib.WORK, 'agentwatch-watching.png') })
  await until(async () => wakes('Watcher').length >= 1, 30000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that a second line does NOT come.
  const w1 = wakes('Watcher')
  check('woken exactly once when the worker finished, with its reply', w1.length === 1 && w1[0].startsWith('[Hive] Worker (alpha) finished: "Done: work 6"') && w1[0].includes('Your agent watch has ended'), JSON.stringify(w1))
  await until(() => idle(watcher.id))
  check('…and the watch has ended', !(await live(watcher.id))?.watch)

  // --- Waiting for the user: a permission prompt a few seconds into its turn.
  await say(worker.id, 'askafter 3 work 15')
  await until(async () => (await live(worker.id))?.status === 'working')
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  await until(async () => wakes('Watcher').length >= 2, 30000)
  const w2 = wakes('Watcher')
  check('woken once when the worker waits for the user', w2.length === 2 && w2[1].startsWith('[Hive] Worker (alpha) is waiting for the user'), JSON.stringify(w2.slice(1)))
  await until(async () => (await idle(watcher.id)) && (await idle(worker.id)), 30000)

  // --- Not while the watcher works: the line waits for its turn to end.
  await say(worker.id, 'work 4')
  await until(async () => (await live(worker.id))?.status === 'working')
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  await say(watcher.id, 'work 12')
  await until(async () => (await live(watcher.id))?.status === 'working')
  await until(() => idle(worker.id), 20000)
  await lib.sleep(2500) // A fixed wait on purpose: this checks that no line comes while the watcher works.
  check('no line while the watcher works', wakes('Watcher').length === 2, JSON.stringify(wakes('Watcher').slice(2)))
  check('…then one, once its turn has ended', !!(await until(async () => wakes('Watcher').length === 3, 30000)) && wakes('Watcher')[2].startsWith('[Hive] Worker (alpha) finished'), JSON.stringify(wakes('Watcher').slice(2)))
  await until(() => idle(watcher.id))

  // --- Not while the user types there (no Enter): the line waits out the typing pause.
  await say(worker.id, 'work 4')
  await until(async () => (await live(worker.id))?.status === 'working')
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  await until(() => idle(worker.id), 20000)
  await inv('pty:write', lib.ptyKey(alpha, watcher.id), 'half a thought')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that no line comes while the user types.
  check('no line while the user is typing there', wakes('Watcher').length === 3, JSON.stringify(wakes('Watcher').slice(3)))
  check('…and one once the typing pause has passed', !!(await until(async () => wakes('Watcher').length === 4, 20000)), JSON.stringify(wakes('Watcher').slice(3)))
  await until(() => idle(watcher.id))

  // --- Stopping: one line.
  await say(worker.id, 'work 30')
  await until(async () => (await live(worker.id))?.status === 'working')
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  await inv('session:stop', alpha, worker.id)
  await until(async () => wakes('Watcher').length >= 5, 30000)
  const w5 = wakes('Watcher')
  check('woken once when the worker stops', w5.length === 5 && w5[4].startsWith('[Hive] Worker (alpha) stopped'), JSON.stringify(w5.slice(4)))
  await until(() => idle(watcher.id))

  // --- Cancel: the watcher ends its own watch, and nothing is typed when the agent finishes.
  await start(worker.id)
  await say(worker.id, 'work 6')
  await until(async () => (await live(worker.id))?.status === 'working')
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await live(watcher.id))?.status === 'watching', 15000)
  await say(watcher.id, 'hive hive_wait_for_agents {"cancel":true}')
  await until(async () => (await lastWaitReply(watcher.id)) === 'Cancelled your agent watch.' && (await idle(watcher.id)), 15000)
  check('cancel ends the agent watch', (await lastWaitReply(watcher.id)) === 'Cancelled your agent watch.' && !(await live(watcher.id))?.watch, await lastWaitReply(watcher.id))
  await until(() => idle(worker.id), 20000)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that no line comes after a cancel.
  check('…and no line came when the worker finished', wakes('Watcher').length === 5, JSON.stringify(wakes('Watcher').slice(5)))

  // --- The limit: a minute with Slow still working ends Limiter's watch with a "still working" line.
  const left = 60000 - (Date.now() - limitFrom)
  if (left > 0) await lib.sleep(left)
  await until(async () => wakes('Limiter').length >= 1, 30000)
  const lw = wakes('Limiter')
  check('limitMinutes passing with the agent still working: one "still working" line', lw.length === 1 && lw[0].startsWith('[Hive] Slow is still working after 1 min: your agent watch has ended'), JSON.stringify(lw))
  check('…while Slow still works', ['working'].includes((await live(slow.id))?.status), (await live(slow.id))?.status)

  await inv('session:stop', alpha, slow.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
