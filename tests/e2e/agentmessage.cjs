// The Assistant leaves a message for an agent that can't take a prompt now (#530), on fake Claude Code agents
// (fake-claude/), through hive_message_agent as the Assistant calls it (hive-mcp.js with the Assistant's token): a
// watching reviewer is woken by it at once and keeps its watch (hive_prompt_agent is refused and points to the tool); a
// working builder gets it queued, its pane shows "1 message waiting", and it is typed as its next line once the builder
// is idle; hive_agent_activity says what waits and that it was delivered; the user cancels one from the pane, and it is
// never typed; a message queued for an agent whose card or agent watch fires meanwhile rides that wake, first, in one
// line; one whose sender may no longer send it (Control turned down) is refused, never typed. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'agentmessage-profile')
const ws = path.join(lib.WORK, 'agentmessage-ws')
const claudeHome = path.join(lib.WORK, 'agentmessage-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47867))
const API = `http://127.0.0.1:${PORT}`
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
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
  }
  const say = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  const idle = async (id) => ['ready', 'finished'].includes((await live(alpha, id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await idle(builder.id)) && (await idle(reviewer.id)))))

  // The Assistant, for its own token: its tools go through hive-mcp.js as it calls them.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'ready')
  const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const tool = (name, args) => {
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: lib.childEnv({ HIVE_API_URL: API, HIVE_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', HIVE_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', HIVE_PROJECT: '' }),
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  const activity = (agent) => JSON.parse(tool('hive_agent_activity', { project: 'alpha', agent }).text)

  // --- 1. A watching reviewer: hive_prompt_agent is refused and names the tool; a message wakes it, and its watch stays.
  const c1 = (await inv('tasks:create', { title: 'Review me later', project: 'alpha', agent: builder.id, column: 'doing' })).number
  await say(reviewer.id, `hive hive_wait_for_tasks ${JSON.stringify({ cards: [c1], column: 'review', wake: true })}`)
  check('the reviewer watches the card', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'watching', 15000)))
  const prompted = tool('hive_prompt_agent', { project: 'alpha', agent: 'Reviewer', text: 'Review the card' })
  check('hive_prompt_agent refuses a watching agent and points to hive_message_agent', prompted.isError && /hive_message_agent/.test(prompted.text), prompted.text)
  const sent = tool('hive_message_agent', { project: 'alpha', agent: 'Reviewer', text: `Darren answered #${c1}: review it when it returns.` })
  check('a message to a watching agent is typed at once', !sent.isError && sent.text === 'Typed into Reviewer now: its watch carries on.', sent.text)
  check('…the reviewer gets it, told its watch carries on', !!(await until(async () => wakes('Reviewer').some((t) => t.startsWith(`[Hive] Message from the Assistant: Darren answered #${c1}: review it when it returns. (Your watch is still on, waiting for #${c1} → Review:`)), 15000)), JSON.stringify(wakes('Reviewer')))
  check('…and is watching the card again after it', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'watching' && (await live(alpha, reviewer.id))?.watch?.cards?.[0] === c1, 15000)))
  await inv('tasks:update', c1, { column: 'review' })
  check('…so the card arriving in Review still wakes it', !!(await until(async () => wakes('Reviewer').some((t) => t.startsWith(`[Hive] #${c1} (Builder's card) is in Review`)), 20000)), JSON.stringify(wakes('Reviewer')))

  // --- 2. A working builder: queued, shown in its pane, typed as its next line once it is idle.
  await say(builder.id, 'work 8')
  check('the builder works', !!(await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)))
  const queued = tool('hive_message_agent', { project: 'alpha', agent: 'Builder', text: `Add #${c1}'s follow-up to your lane after it.` })
  check('a message to a working agent is queued', !queued.isError && queued.text === 'Queued for Builder (working): typed with its next line, a wake or once it is idle; 1 waiting. hive_agent_activity says when it is delivered.', queued.text)
  const pane = page.locator('.pane-header-bar', { hasText: 'Builder' }).locator('.agent-messages')
  check("the builder's pane shows it waiting", !!(await until(async () => /1 message waiting/.test((await pane.innerText().catch(() => '')) ?? ''), 10000)))
  await pane.hover()
  check('…its tooltip says who from and what', !!(await until(async () => (await page.locator('.tip', { hasText: `From the Assistant: Add #${c1}'s follow-up` }).count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'agentmessage-waiting.png') })
  const waiting = activity('Builder')
  check('its activity lists the message waiting', waiting.messagesWaiting?.length === 1 && waiting.messagesWaiting[0].from === 'the Assistant' && !waiting.lastMessages, JSON.stringify(waiting))
  check('…not typed while it works', !wakes('Builder').length)
  check('once idle, it is typed as its next line', !!(await until(async () => wakes('Builder').some((t) => t === `[Hive] Message from the Assistant: Add #${c1}'s follow-up to your lane after it.`), 30000)), JSON.stringify(wakes('Builder')))
  check('…the pane no longer shows it', !!(await until(async () => (await pane.count()) === 0, 10000)))
  const done = activity('Builder')
  check('…and its activity says it was delivered', !done.messagesWaiting && done.lastMessages?.outcome === 'delivered' && done.lastMessages?.count === 1, JSON.stringify(done))

  // --- 3. Cancelled by the user from the pane: never typed.
  await until(() => idle(builder.id), 15000)
  await say(builder.id, 'work 6')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  tool('hive_message_agent', { project: 'alpha', agent: 'Builder', text: 'Never mind this one.' })
  await until(async () => (await pane.count()) === 1, 10000)
  await pane.click()
  await page.getByText('Cancel the Message', { exact: true }).click()
  check('the user cancels it from the pane', !!(await until(async () => (await pane.count()) === 0, 5000)))
  check('…its activity says so', activity('Builder').lastMessages?.outcome === 'cancelled')
  await until(() => idle(builder.id), 20000)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that the cancelled message is NOT typed.
  check('…and it is never typed', !wakes('Builder').some((t) => t.includes('Never mind this one.')), JSON.stringify(wakes('Builder')))

  // --- 4. A message queued for a busy reviewer whose card watch fires meanwhile: both in one line, the message first.
  const c2 = (await inv('tasks:create', { title: 'Revised scope', project: 'alpha', agent: builder.id, column: 'doing' })).number
  await until(() => idle(reviewer.id), 15000)
  await say(reviewer.id, `hive hive_wait_for_tasks ${JSON.stringify({ cards: [c2], column: 'review', wake: true })}`)
  await until(async () => (await live(alpha, reviewer.id))?.status === 'watching', 15000)
  await say(reviewer.id, 'work 8')
  check('the watching reviewer works (the user gave it something)', !!(await until(async () => (await live(alpha, reviewer.id))?.status === 'working', 10000)))
  const before4 = wakes('Reviewer').length
  check('a message for it is queued', tool('hive_message_agent', { project: 'alpha', agent: 'Reviewer', text: 'Use the revised review scope.' }).text.startsWith('Queued for Reviewer (working)'))
  await inv('tasks:update', c2, { column: 'review' })
  check('its watch wake carries the message, first, in one line', !!(await until(async () => wakes('Reviewer').length > before4, 30000)) && wakes('Reviewer')[before4].startsWith(`[Hive] Message from the Assistant: Use the revised review scope. [Hive] #${c2} (Builder's card) is in Review`), JSON.stringify(wakes('Reviewer').slice(before4)))
  await until(() => idle(reviewer.id), 15000)
  check('…and only once', wakes('Reviewer').filter((t) => t.includes('Use the revised review scope.')).length === 1 && activity('Reviewer').lastMessages?.outcome === 'delivered', JSON.stringify(wakes('Reviewer').slice(before4)))

  // --- 5. The same with an agent watch: the builder waits for the reviewer to finish, is busy, and gets a message.
  await until(() => idle(builder.id), 15000)
  await say(reviewer.id, 'work 6')
  await until(async () => (await live(alpha, reviewer.id))?.status === 'working', 10000)
  await say(builder.id, `hive hive_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: 'Reviewer' }], wake: true })}`)
  check('the builder watches the reviewer (an agent watch)', !!(await until(async () => (await live(alpha, builder.id))?.status === 'watching', 15000)))
  await say(builder.id, 'work 14')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  const before5 = wakes('Builder').length
  tool('hive_message_agent', { project: 'alpha', agent: 'Builder', text: 'Merge main before your next card.' })
  check('its agent watch wake carries the message, first, in one line', !!(await until(async () => wakes('Builder').length > before5, 40000)) && wakes('Builder')[before5].startsWith('[Hive] Message from the Assistant: Merge main before your next card. [Hive] Reviewer (alpha) finished'), JSON.stringify(wakes('Builder').slice(before5)))

  // --- 6. Settings → Assistant → Control turned down while a message waits: refused, never typed.
  await until(() => idle(builder.id), 15000)
  await say(builder.id, 'work 6')
  await until(async () => (await live(alpha, builder.id))?.status === 'working', 10000)
  tool('hive_message_agent', { project: 'alpha', agent: 'Builder', text: 'This needs Control agents.' })
  await inv('settings:update', { assistant: { control: 'look' } })
  check('with Control turned down, the waiting message is refused when the builder is idle', !!(await until(async () => activity('Builder').lastMessages?.outcome === 'refused', 30000)), JSON.stringify(activity('Builder').lastMessages))
  check('…and never typed', !wakes('Builder').some((t) => t.includes('This needs Control agents.')), JSON.stringify(wakes('Builder')))
  await inv('settings:update', { assistant: { control: 'projects' } })

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
