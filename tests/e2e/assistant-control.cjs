// The Hive Assistant's control (Settings → Assistant → Control), through the Agent API with the Assistant's own
// token, with the Agent API itself turned off. Agents run the fake Claude Code (fake-claude/), so nothing signs in
// or spends tokens. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'control-profile')
const ws = path.join(lib.WORK, 'control-ws')
const claudeHome = path.join(lib.WORK, 'control-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47895))
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
  fs.mkdirSync(path.join(ws, 'gamma'))
  lib.enableProviders(userData)
  // Claude Code is the fake one; the Agent API is off (the Assistant still gets in with its own token).
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: false }
  // Closing at the end must not wait on the quit dialog (an agent may still be working).
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // A long pause, which Enter doesn't end, so the typing checks hold however long the steps take.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 600, enterEndsPause: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const info = await inv('workspace:refresh')
  const home = info.assistant.path
  const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }

  // The Assistant starts in the workspace folder; the fake asks to trust it, which shows as waiting for the user.
  await page.getByText('gamma', { exact: true }).first().click()
  await lib.sleep(300)
  await inv('session:start', home, { agentId: 'assistant' })
  const asking = await until(async () => (await live(home, 'assistant'))?.status === 'waiting' && (await live(home, 'assistant')))
  check('a trust question before the start shows as waiting', !!asking && /trust/i.test(asking.statusMessage ?? ''), JSON.stringify(asking && { status: asking.status, msg: asking.statusMessage }))
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  check('answered, it starts', !!(await until(async () => (await live(home, 'assistant'))?.status === 'ready')))

  // Its hive tools: its own token file, its role and control level.
  const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
  // In its launch's private folder in Hive's user data, not the project (#345).
  const mcp = JSON.parse(fs.readFileSync(path.join(lib.launchDir(userData, (await live(home, 'assistant')).runId), 'mcp.json'), 'utf8')).mcpServers.hive
  check("the Assistant's hive tools use its token and role", mcp?.env.HIVE_API_TOKEN_FILE === tokenFile && mcp.env.HIVE_ROLE === 'assistant' && mcp.env.HIVE_ASSISTANT_CONTROL === 'projects', JSON.stringify(mcp?.env))
  // Its skills: the workspace's skills for the Assistant (coordinate-agents and the shared ones), none for agents only.
  const assistantSkills = fs.readdirSync(path.join(home, '.hive', 'launch-assistant', 'plugin', 'skills')).sort()
  check('the Assistant gets the skills for it', ['coordinate-agents', 'handover', 'pick-up', 'split-work', 'workspace-note'].every((n) => assistantSkills.includes(n)) && !['work-on-card', 'review-agent-work', 'merge-ready', 'use-hive-api'].some((n) => assistantSkills.includes(n)), assistantSkills.join(','))
  // Its instructions: its control level and boundaries, the skill that says how, then the mode.
  const told = fs.readFileSync(path.join(home, '.hive', 'launch-assistant', 'instructions.md'), 'utf8')
  check('its instructions give its control level and point to coordinate-agents, before the mode', /Control agents and create projects/.test(told) && told.indexOf('coordinate-agents skill') > 0 && told.indexOf('coordinate-agents skill') < told.indexOf('# Your mode'), told.slice(0, 300))
  const api = async (method, p, body, bearer = token) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  check('with the Agent API off, its own token is refused', (await api('GET', '/v1/projects', null, apiToken)).status === 403)
  check("the Assistant's token still works", (await api('GET', '/v1/projects')).status === 200)
  const providers = (await api('GET', '/v1/providers')).body
  check('it lists the providers with their models, efforts and modes', providers?.some((p) => p.id === 'claude-code' && p.enabled && p.installed && p.models.length && p.efforts.length && p.modes.length), JSON.stringify(providers?.map((p) => p.id)))

  // Create a project; add an agent that starts on a task (on the command line). The view stays on gamma.
  const created = await api('POST', '/v1/projects', { name: 'beta' })
  check('it creates a project, turned on', created.status === 200 && created.body?.active === true && fs.existsSync(path.join(ws, 'beta')), JSON.stringify(created.body))
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Builder', prompt: 'work 3' })
  check('it adds an agent that starts on a task', added.status === 200 && added.body?.agent?.name === 'Builder', JSON.stringify(added.body))
  const builder = added.body?.agent?.id
  const trusting = await until(async () => (await live(alpha, builder))?.status === 'waiting')
  check("a new folder's trust question waits for the user", !!trusting)
  await inv('pty:write', lib.ptyKey(alpha, builder), '\r')
  check('then it works on the task', !!(await until(async () => (await live(alpha, builder))?.status === 'working')))
  check("the user's view didn't move", (await page.locator('.project-header, .project-title').first().innerText().catch(() => '')).includes('gamma'))
  const busy = await api('POST', `/v1/projects/alpha/agents/Builder/prompt`, { text: 'more' })
  check('no task for a working agent', busy.status === 409 && /working/.test(busy.body?.error), JSON.stringify(busy.body))
  const waited = await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Builder' }], timeoutSeconds: 30 })
  check('waiting returns when it finishes', waited.body?.timedOut === false && waited.body.agents[0].status === 'finished', JSON.stringify(waited.body))
  const act = (await api('GET', '/v1/projects/alpha/agents/Builder/activity')).body
  check('its activity: the task and the reply', act?.currentTask === 'work 3' && act.latestReply === 'Done: work 3', JSON.stringify(act))
  const typed = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'next' })
  check("no task where the user typed in the last minute", typed.status === 409 && /typed/.test(typed.body?.error), JSON.stringify(typed.body))
  // The user's last key was Enter: with Enter ends the pause, the task goes in.
  await inv('settings:update', { assistant: { enterEndsPause: true } })
  const afterEnter = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'work 1' })
  check('Enter ends the pause', afterEnter.status === 200, JSON.stringify(afterEnter.body))
  await inv('settings:update', { assistant: { enterEndsPause: false } })
  await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Builder' }], timeoutSeconds: 30 })

  // A second agent, started idle, takes a task; its edit shows as a locked file and a tool call.
  const second = await api('POST', '/v1/projects/alpha/agents', { name: 'Fixer', start: true })
  const fixer = second.body?.agent?.id
  check('an agent started idle is ready', !!(await until(async () => (await live(alpha, fixer))?.status === 'ready')))
  const given = await api('POST', '/v1/projects/alpha/agents/Fixer/prompt', { text: 'edit a.ts work 6' })
  check('an idle agent takes a task', given.status === 200, JSON.stringify(given.body))
  await until(async () => (await live(alpha, fixer))?.status === 'working')
  await lib.until(async () => { const b = (await api('GET', '/v1/projects/alpha/agents/Fixer/activity')).body; return b?.recentTools?.some((t) => t.tool === 'Edit') && b.lockedFiles?.includes('a.ts') }, 10000)
  const working = (await api('GET', '/v1/projects/alpha/agents/Fixer/activity')).body
  check('its activity shows the edit and the locked file', working?.recentTools?.some((t) => t.tool === 'Edit') && working.lockedFiles?.includes('a.ts'), JSON.stringify(working))

  // Stopping a busy agent asks the user, in the panel: no, then yes.
  await inv('settings:update', {})
  await page.keyboard.press('Control+Alt+I').catch(() => {})
  await lib.sleep(500)
  const stopping = api('POST', '/v1/projects/alpha/agents/Fixer/stop', { reason: 'testing' })
  const card = page.locator('.assistant-question', { hasText: 'Stop Fixer in alpha?' })
  await card.waitFor({ timeout: 10000 }).catch(() => {})
  check('stopping a busy agent asks the user on a card', (await card.count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'control-1-question.png') })
  await card.locator('button', { hasText: "Don't stop" }).click()
  const refused = await stopping
  check("the user's no is the answer", refused.status === 409 && /chose not to stop/.test(refused.body?.error) && !!(await live(alpha, fixer)), JSON.stringify(refused.body))
  const stopping2 = api('POST', '/v1/projects/alpha/agents/Fixer/stop', {})
  await card.waitFor({ timeout: 10000 }).catch(() => {})
  const qs = await inv('assistant:questions')
  await inv('assistant:answer', qs[0]?.id, true)
  check('and a yes stops it', (await stopping2).status === 200 && !!(await until(async () => !(await live(alpha, fixer)))))

  // What it did is listed in the panel.
  const done = await inv('assistant:actions')
  check('its actions are listed', done.some((x) => x.text.startsWith('Created the project beta')) && done.some((x) => x.text.startsWith('Stopped Fixer')) && done.some((x) => !x.ok), JSON.stringify(done.map((x) => x.text)))
  check('the panel shows them', (await page.locator('.assistant-action').count()) >= 3)
  await page.screenshot({ path: path.join(lib.WORK, 'control-2-actions.png') })

  // Look and advise: changes are refused (and listed).
  await inv('settings:update', { assistant: { control: 'look' } })
  const looked = await api('POST', '/v1/projects/alpha/agents', { name: 'Nope' })
  check('Look and advise refuses changes', looked.status === 403 && /Look and advise/.test(looked.body?.error), JSON.stringify(looked.body))
  check('but it can still read', (await api('GET', '/v1/projects/alpha/agents/Builder/activity')).status === 200)
  await inv('settings:update', { assistant: { control: 'agents' } })
  check('Control agents can\'t create projects', (await api('POST', '/v1/projects', { name: 'delta' })).status === 403)
  check('nor remove agents (no such call)', (await api('DELETE', `/v1/projects/alpha/agents/Builder`)).status === 404)

  // From the latest handover: there has to be one.
  const none = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check('no hand-over from the latest handover when there is none', none.status === 409 && /no handover/i.test(none.body?.error), JSON.stringify(none.body))
  fs.mkdirSync(path.join(ws, '.hive', 'shared', 'handovers'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.hive', 'shared', 'handovers', '2026-10-01-alpha-plan.md'), '# Plan\n\n- **Project:** alpha\n\nwork 1\n')
  // Handing over: refused at once while project agents lack Hive's tools (the Agent API is off), then done.
  const noTools = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check("no hand-over while agents can't use Hive's tools", noTools.status === 409 && /Hive's tools/.test(noTools.body?.error), JSON.stringify(noTools.body))
  await inv('settings:update', { agentApi: { enabled: true } })
  await lib.until(async () => (await api('GET', '/v1/status').catch(() => ({}))).status === 200, 10000)
  const typedIn = await api('POST', '/v1/projects/alpha/handover', { from: 'Builder', to: 'Fixer', handover: false })
  check('no hand-over from an agent the user just typed in', typedIn.status === 409 && /typed/.test(typedIn.body?.error), JSON.stringify(typedIn.body))
  await api('POST', '/v1/projects/alpha/agents', { name: 'Checker' })
  const handed = await api('POST', '/v1/projects/alpha/handover', { from: 'Fixer', to: 'Checker', handover: false })
  check('it hands one agent\'s work over to another', handed.status === 200, JSON.stringify(handed.body))
  const picked = await until(async () => /Read the handover "handovers\/2026-10-01-alpha-plan\.md"/.test((await api('GET', '/v1/projects/alpha/agents/Checker/activity')).body?.currentTask ?? ''), 30000)
  check('the other agent starts on the handover', !!picked)
  check('the hand-over is listed', (await inv('assistant:actions')).some((x) => x.ok && x.text.startsWith("Handing Fixer's work over to Checker")))

  // Through its real hive tools, with the Agent API on: the CLI hands its own environment to MCP servers, and
  // that may carry the Agent API's token (HIVE_API_TOKEN); the Assistant's tools must still use its own.
  const viaTool = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hive_activate_project', arguments: { project: 'alpha', active: true } } }) + '\n',
    env: lib.childEnv({ HIVE_API_TOKEN: apiToken, ...mcp.env, HIVE_API_URL: API }),
    timeout: 15000
  }).toString()
  const toolReply = JSON.parse(viaTool.split('\n')[0]).result
  const asAssistant = (await inv('assistant:actions')).some((x) => x.ok && x.text === 'Activated alpha')
  check("its hive tools act as the Assistant with the Agent API on", !toolReply?.isError && asAssistant, JSON.stringify(toolReply).slice(0, 300))

  // The task board: the Assistant adds and starts cards, and moves one to Done without a question.
  const added2 = await api('POST', '/v1/tasks', { title: 'Write the README', project: 'alpha', description: 'work 1' })
  check('the Assistant adds a card', added2.status === 200 && added2.body?.createdBy === 'Assistant', JSON.stringify(added2.body))
  const cardNo = added2.body?.number
  const started = await api('POST', `/v1/tasks/${cardNo}/start`, { name: 'Writer' })
  check('and starts it on a new agent', started.status === 200 && started.body?.added === true && started.body?.card?.column === 'doing', JSON.stringify(started.body))
  const writer = (await inv('workspace:get')).projects.find((x) => x.name === 'alpha').agents.find((a) => a.name === 'Writer')
  check('which runs the card', !!writer && !!(await until(async () => (await live(alpha, writer.id))?.status === 'finished', 30000)))
  await api('PATCH', `/v1/tasks/${cardNo}`, { column: 'review', comment: 'Ready.' })
  const moved = await api('PATCH', `/v1/tasks/${cardNo}`, { column: 'done' })
  check('the Assistant moves it to Done', moved.status === 200 && moved.body?.column === 'done', JSON.stringify(moved.body))
  check('without asking the user', (await page.locator('.assistant-question').count()) === 0)
  check('its history says the Assistant did it', moved.body?.history?.at(-1)?.by === 'Assistant' && moved.body.history.at(-1).what === 'Moved to Done', JSON.stringify(moved.body?.history?.at(-1)))
  check('the board changes are listed', (await inv('assistant:actions')).some((x) => x.ok && x.text.startsWith(`Started #${cardNo} on a new agent, Writer`)))
  // Putting cards in order: listed in Done by the Assistant; the order of Done is the user's, refused without asking.
  const o1 = (await api('POST', '/v1/tasks', { title: 'Order one', project: 'alpha' })).body.number
  const o2 = (await api('POST', '/v1/tasks', { title: 'Order two', project: 'alpha' })).body.number
  const ordered = await api('POST', '/v1/tasks/reorder', { column: 'todo', cards: [o2, o1] })
  const o2Card = (await api('GET', `/v1/tasks/${o2}`)).body
  check('the Assistant puts cards in order', ordered.status === 200 && ordered.body[0]?.number === o2 && o2Card.history.at(-1)?.by === 'Assistant', JSON.stringify(ordered.body?.map?.((c) => c.number) ?? ordered))
  const top = await api('PATCH', `/v1/tasks/${o1}`, { position: 'top' })
  check('and one card to the top', top.status === 200 && (await api('GET', '/v1/tasks?column=todo')).body[0]?.number === o1, JSON.stringify(top.body))
  const listed = (await inv('assistant:actions')).map((x) => x.ok && x.text)
  check('both are listed in Done by the Assistant', listed.includes(`Put #${o2}, #${o1} at the top of Todo`) && listed.some((t) => t && t.startsWith(`#${o1} `) && t.endsWith('moved it to the top of Todo')), JSON.stringify(listed.slice(-3)))
  const doneTop = await api('PATCH', `/v1/tasks/${cardNo}`, { position: 'top' })
  check("the Assistant can't put Done in order, and the user isn't asked", doneTop.status === 403 && (await page.locator('.assistant-question').count()) === 0, JSON.stringify(doneTop))

  // At most 30 changes for one message.
  let status = 200
  let n = 0
  while (status === 200 && n < 40) {
    status = (await api('POST', '/v1/projects/alpha/activate')).status
    n++
  }
  check('at most 30 changes for one message', status === 429, `${status} after ${n}`)
  // A batch needs its whole allowance: none is left, so it changes none of its cards and says how many fit (none).
  const batch = await api('POST', '/v1/tasks/batch', { numbers: [o1, o2], column: 'doing' })
  const columns = [(await api('GET', `/v1/tasks/${o1}`)).body.column, (await api('GET', `/v1/tasks/${o2}`)).body.column]
  check('a batch over the limit changes none of its cards and says how many fit', batch.status === 429 && batch.body?.fits === 0 && columns.every((c) => c === 'todo'), JSON.stringify({ status: batch.status, body: batch.body, columns }))
  check('and lists the batch as refused, not as changes', (await inv('assistant:actions')).some((x) => !x.ok && x.text === 'Change 2 cards on the board'))

  // The tools its hive MCP server offers follow the control level; project agents never get them.
  const tools = (envExtra) => {
    const outText = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', env: lib.childEnv({ HIVE_API_URL: API, ...envExtra }), timeout: 10000 }).toString()
    return JSON.parse(outText.split('\n')[0]).result.tools.map((t) => t.name)
  }
  const asAgent = tools({ HIVE_PROJECT: 'alpha' })
  const asAgents = tools({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'agents' })
  const asLook = tools({ HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'look' })
  check('project agents get no control tools', !asAgent.includes('hive_add_agent') && !asAgent.includes('hive_agent_activity') && !asAgent.includes('hive_start_task'), asAgent.join(','))
  check('project agents get the board tools', ['hive_list_tasks', 'hive_read_task', 'hive_create_task', 'hive_update_task', 'hive_reorder_tasks'].every((t) => asAgent.includes(t)), asAgent.join(','))
  check('Control agents: agent tools, no project creation', asAgents.includes('hive_prompt_agent') && asAgents.includes('hive_stop_agent') && asAgents.includes('hive_hand_over') && asAgents.includes('hive_start_task') && !asAgents.includes('hive_create_project'))
  check('Look and advise: reading tools only', asLook.includes('hive_agent_activity') && asLook.includes('hive_wait_for_agents') && asLook.includes('hive_list_tasks') && !asLook.includes('hive_add_agent') && !asLook.includes('hive_start_task'))

  // Let the agents finish before closing.
  await until(async () => !(await inv('session:live')).some((s) => s.status === 'working' || s.status === 'starting'), 30000)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
