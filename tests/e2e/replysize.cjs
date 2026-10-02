// Hive's tool replies stay lean: every hive MCP tool (through out/main/hive-mcp.js, as an agent and as the
// Assistant) and the Agent API routes behind them, against a busy workspace (four projects, ~75 cards with long
// descriptions and comments, handovers, notes, running agents). Checks what the replies say and that each stays
// within its size; prints every reply's size in characters and writes the sizes and texts to replysize.json and
// replysize-texts.json in the e2e folder. The Agent API's own replies are checked to be unchanged. Agents run the fake Claude Code. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')

const userData = path.join(lib.WORK, 'replysize-profile')
const ws = path.join(lib.WORK, 'replysize-ws')
const claudeHome = path.join(lib.WORK, 'replysize-claude-home')
const PORT = 47899
const API = `http://127.0.0.1:${PORT}`
const PROJECTS = ['alpha', 'beta', 'gamma', 'delta']
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Text like a real card's description: a few markdown sections, about `n` characters. */
const prose = (seed, n) => {
  const words = 'the agent should check the settings view and make sure each value is kept when the window reloads then update the tests and the user guide so the behaviour is described clearly including edge cases like an empty field a negative number or a value pasted with spaces'.split(' ')
  let out = `## Why\nCard ${seed}: `
  for (let i = 0; out.length < n; i++) out += (i % 40 === 39 ? '.\n\n## What\n- ' : words[(i * 7 + seed) % words.length] + ' ')
  return out
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  for (const p of PROJECTS) lib.gitProject(path.join(ws, p))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), ...PROJECTS.map((p) => path.join(ws, p).toLowerCase())]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, allowSessionInput: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const until = async (fn, ms = 15000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body, bearer = apiToken) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    return { status: res.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }
  for (const p of PROJECTS) await inv('project:setActive', path.join(ws, p), true).catch(() => undefined)

  // Agents: two in alpha (one running a few turns), one in beta.
  const alpha = path.join(ws, 'alpha')
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.addAgent(inv, alpha, { name: 'Tester' })
  await lib.addAgent(inv, path.join(ws, 'beta'), { name: 'Builder' })
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  await inv('session:start', alpha, { agentId: coder.id })
  await until(async () => (await live(alpha, coder.id))?.status === 'ready')
  for (let i = 1; i <= 4; i++) {
    await inv('pty:write', lib.ptyKey(alpha, coder.id), `turn ${i}`)
    await lib.sleep(200)
    await inv('pty:write', lib.ptyKey(alpha, coder.id), '\r')
    await until(async () => String(await inv('pty:buffer', lib.ptyKey(alpha, coder.id))).includes(`Done: turn ${i}`))
  }

  // The board: 50 in Todo, 6 in Doing, 10 in Review, 10 in Done; long descriptions, three comments each, some history.
  const cols = [...Array(50).fill('todo'), ...Array(6).fill('doing'), ...Array(10).fill('review'), ...Array(10).fill('done')]
  const numbers = []
  for (let i = 0; i < cols.length; i++) {
    const r = await api('POST', '/v1/tasks', { title: `Card ${i + 1}: ${prose(i, 60).split('\n')[1].slice(0, 50)}`, description: prose(i, 1800), project: PROJECTS[i % 4], labels: i % 3 ? ['bug'] : ['feature', 'polish'] })
    numbers.push(r.body.number)
    for (let c = 0; c < 3; c++) await api('POST', `/v1/tasks/${r.body.number}/comments`, { text: prose(i * 10 + c, 400) })
    if (cols[i] !== 'todo') await inv('tasks:update', r.body.number, { column: cols[i] }).catch(() => api('PATCH', `/v1/tasks/${r.body.number}`, { column: cols[i] }))
  }
  check(`seeded ${numbers.length} cards`, numbers.length === cols.length)
  // Handovers and notes.
  for (let i = 0; i < 6; i++) await api('POST', '/v1/shared/handovers', { title: `Handover ${i}`, content: prose(100 + i, 3500), project: PROJECTS[i % 4] })
  for (let i = 0; i < 8; i++) await api('PUT', `/v1/shared/file?path=${encodeURIComponent(`notes/note-${i}.md`)}`, { content: prose(200 + i, 2500) })

  // The Assistant: its own token, for its tools.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'ready')
  const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)

  /** One hive tool call through hive-mcp.js: the text the agent gets. */
  const tool = (name, args, role = 'agent') => {
    const extra = role === 'assistant' ? { HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', HIVE_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '' } : { HIVE_API_TOKEN: apiToken, HIVE_PROJECT: 'alpha', HIVE_AGENT_ID: coder.id }
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: { ...process.env, HIVE_API_URL: API, HIVE_WORKSPACE: ws, ...extra },
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  const sizes = {}
  const texts = {}
  /** Records a reply's size; with `max`, checks it worked and stays within it. */
  const measure = (label, r, max) => {
    const text = typeof r === 'string' ? r : r.text
    sizes[label] = text.length
    texts[label] = text
    console.log(`${String(text.length).padStart(8)}  ${label}${r.isError ? `  (error: ${text.slice(0, 120)})` : ''}`)
    if (max !== undefined) check(`${label}: at most ${max.toLocaleString('en')} characters`, !r.isError && text.length <= max, `${text.length}: ${text.slice(0, 200)}`)
    return text
  }
  const todo = numbers.slice(0, 50)
  const target = numbers[3]

  console.log('\n--- hive tools (as an agent)')
  const projects = measure('hive_list_projects', tool('hive_list_projects', {}), 1000)
  check('projects: a line each, with their agents', /^alpha \(on, \w+\): Coder \[claude-code\] idle; Tester \[claude-code\] stopped$/m.test(projects), projects)
  measure('hive_project_status', tool('hive_project_status', {}), 3000)
  const usage = measure('hive_session_usage', tool('hive_session_usage', {}), 1500)
  check('usage leaves out its days unless asked', !usage.includes('"days"') && tool('hive_session_usage', { days: true }).text.includes('"days"'))
  const notes = measure('hive_list_shared_notes', tool('hive_list_shared_notes', {}), 1500)
  check('notes: one path a line', /^notes\/note-1\.md \(\d{4}-\d\d-\d\d\)$/m.test(notes), notes)
  const note = measure('hive_read_shared_note', tool('hive_read_shared_note', { path: 'notes/note-1.md' }))
  check('a note reads as its text', note.startsWith('notes/note-1.md\n\n## Why\n'), note.slice(0, 80))
  check('writing a note confirms it', measure('hive_write_shared_note', tool('hive_write_shared_note', { path: 'notes/new.md', content: prose(300, 2500) }), 200) === 'Wrote notes/new.md (2,500 characters).' || /^Wrote notes\/new\.md \([\d,]+ characters\)\.$/.test(texts.hive_write_shared_note), texts.hive_write_shared_note)
  measure('hive_write_shared_note (append)', tool('hive_write_shared_note', { path: 'notes/new.md', content: prose(301, 500), append: true }), 200)
  measure('hive_read_latest_handover', tool('hive_read_latest_handover', {}))
  check('a handover is saved and named', /^Handover saved as handovers\/.+\.md\.$/.test(measure('hive_create_handover', tool('hive_create_handover', { title: 'Measured', content: prose(400, 3500) }), 300)), texts.hive_create_handover)
  measure('hive_notify', tool('hive_notify', { title: 'Hello', message: 'Measuring' }), 100)
  const all = measure('hive_list_tasks (all)', tool('hive_list_tasks', {}), 76 * 200)
  check('the board: a line a card, no descriptions', all.split('\n').filter((l) => l.startsWith('#')).length === 76 && !all.includes('## Why'), all.slice(0, 300))
  const todoList = measure('hive_list_tasks (todo)', tool('hive_list_tasks', { column: 'todo' }), 50 * 200)
  check('Todo is listed top first', todoList.startsWith('Todo (50, top first):\n#'), todoList.slice(0, 80))
  measure('hive_list_tasks (alpha)', tool('hive_list_tasks', { project: 'alpha' }), 25 * 200)
  const full = tool('hive_list_tasks', { column: 'review', details: true }).text
  check('details=true still lists cards in full', JSON.parse(full).length === 10 && JSON.parse(full)[0].description.length > 1000)
  const read = JSON.parse(measure('hive_read_task', tool('hive_read_task', { number: target })))
  check('a read has the description and comments, not the history', read.description.length > 1000 && read.comments.length === 3 && !('history' in read) && read.historyEntries >= 1, Object.keys(read).join(','))
  check('history=true adds it', JSON.parse(tool('hive_read_task', { number: target, history: true }).text).history.length >= 1)
  const latest = JSON.parse(measure('hive_read_task (latestComment)', tool('hive_read_task', { number: target, latestComment: true }), 1500))
  check('latestComment=true: the newest comment only', latest.number === target && latest.comment?.text === read.comments.at(-1).text && JSON.stringify(Object.keys(latest)) === '["number","comment"]', JSON.stringify(latest).slice(0, 200))
  const created = measure('hive_create_task', tool('hive_create_task', { title: 'Measured card', description: prose(500, 1800), labels: ['bug'] }), 400)
  check('a new card: its number and place', /^#\d+ created in Todo \(51st of 51\) for alpha: Measured card$/.test(created), created)
  const commented = measure('hive_update_task (comment)', tool('hive_update_task', { number: target, comment: 'Looked at it.' }), 400)
  check('a comment is confirmed with where the card is', new RegExp(`^#${target} .+: Commented\\. Now in Todo \\(\\d+\\w\\w of 51\\), \\w+\\.$`).test(commented), commented)
  const top = measure('hive_update_task (to top)', tool('hive_update_task', { number: target, position: 'top' }), 400)
  check('a move says where to', /: Moved to the top of Todo\. Now in Todo \(1st of 51\), \w+\.$/.test(top), top)
  const review = measure('hive_update_task (to review)', tool('hive_update_task', { number: target, column: 'review', comment: 'Done: see the branch.' }), 400)
  check('a move to Review and a comment, both said', /: Moved to Review; Commented\. Now in Review \(11th of 11\)/.test(review), review)
  const reordered = measure('hive_reorder_tasks (3 cards)', tool('hive_reorder_tasks', { column: 'todo', cards: [todo[10], todo[5], todo[7]] }), 300)
  check('a reorder confirms the new top', reordered === `Todo now starts #${todo[10]}, #${todo[5]}, #${todo[7]}; its other 47 cards keep their order below.`, reordered)
  measure('hive_list_skills', tool('hive_list_skills', {}))

  console.log('\n--- hive tools (as the Assistant)')
  measure('hive_list_providers', tool('hive_list_providers', {}, 'assistant'))
  measure('hive_agent_activity', tool('hive_agent_activity', { project: 'alpha', agent: 'Coder' }, 'assistant'), 3000)
  measure('hive_wait_for_agents', tool('hive_wait_for_agents', { agents: [{ project: 'alpha', agent: 'Coder' }], timeoutSeconds: 5 }, 'assistant'), 1000)
  check('activating a project confirms it', measure('hive_activate_project', tool('hive_activate_project', { project: 'gamma' }, 'assistant'), 300) === 'gamma is on.')
  measure('hive_create_project', tool('hive_create_project', { name: 'epsilon' }, 'assistant'), 300)
  const added = measure('hive_add_agent', tool('hive_add_agent', { project: 'beta', name: 'Helper' }, 'assistant'), 400)
  check('a new agent: its name, id and folder', /^Added Helper \(id a-\w+\) to beta: claude-code, in the project folder, stopped\.$/.test(added), added)
  measure('hive_update_agent', tool('hive_update_agent', { project: 'beta', agent: 'Helper', effort: 'high' }, 'assistant'), 1000)
  const started = measure('hive_start_agent', tool('hive_start_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 400)
  check('a start: its status and session', /^Started Helper in beta: \w+, session [\w-]+\. Follow it with hive_wait_for_agents\.$/.test(started), started)
  await until(async () => (await live(path.join(ws, 'beta'), (await inv('workspace:refresh')).projects.find((p) => p.name === 'beta').agents.find((a) => a.name === 'Helper').id))?.status === 'ready')
  measure('hive_prompt_agent', tool('hive_prompt_agent', { project: 'beta', agent: 'Helper', text: 'turn 1' }, 'assistant'), 300)
  await lib.sleep(2500)
  measure('hive_stop_agent', tool('hive_stop_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 300)
  const startedCard = measure('hive_start_task', tool('hive_start_task', { number: todo[20], name: 'Starter' }, 'assistant'), 600)
  check('a started card: who has it', new RegExp(`^Started #${todo[20]} .+ on a new agent, Starter in \\w+; the card is in Doing\\.`).test(startedCard), startedCard)
  measure('hive_list_tasks (as Assistant, all)', tool('hive_list_tasks', {}, 'assistant'), 80 * 200)
  measure('hive_create_task (as Assistant)', tool('hive_create_task', { title: 'Assistant card', project: 'alpha', description: prose(600, 1800) }, 'assistant'), 400)
  measure('hive_update_task (as Assistant)', tool('hive_update_task', { number: todo[30], comment: 'Noted.' }, 'assistant'), 400)
  measure('hive_reorder_tasks (as Assistant)', tool('hive_reorder_tasks', { column: 'todo', cards: [todo[31], todo[32]] }, 'assistant'), 300)

  console.log('\n--- Agent API routes not behind a tool')
  const route = async (label, method, p, body) => measure(`API ${label}`, (await api(method, p, body)).text)
  await route('GET /v1/status', 'GET', '/v1/status')
  await route('GET /v1/workspace', 'GET', '/v1/workspace')
  await route('GET /v1/workspaces', 'GET', '/v1/workspaces')
  await route('GET /v1/projects/alpha/sessions', 'GET', '/v1/projects/alpha/sessions')
  await route('POST /v1/projects/delta/deactivate', 'POST', '/v1/projects/delta/deactivate')
  await route('POST /v1/projects/alpha/input', 'POST', '/v1/projects/alpha/input', { agent: 'Coder', text: '', submit: false })
  await route('POST /v1/tasks/n/comments', 'POST', `/v1/tasks/${todo[40]}/comments`, { text: 'Seen.' })
  await route('GET /v1/mcp', 'GET', '/v1/mcp')
  await route('GET /v1/health', 'GET', '/v1/health')

  // The Agent API's own replies are unchanged unless a caller asks for the short ones.
  const apiList = (await api('GET', '/v1/tasks?column=todo')).body
  check('API: GET /v1/tasks still gives whole cards', apiList.length === 50 && typeof apiList[0].description === 'string' && Array.isArray(apiList[0].history))
  const apiCard = (await api('PATCH', `/v1/tasks/${todo[41]}`, { comment: 'API' })).body
  check('API: PATCH still answers with the card', apiCard.number === todo[41] && Array.isArray(apiCard.comments) && Array.isArray(apiCard.history))
  const apiProjects = (await api('GET', '/v1/projects')).body
  check('API: GET /v1/projects still has settings', apiProjects.every((x) => x.settings && x.path))
  const apiShort = (await api('GET', '/v1/tasks?column=todo&view=short')).body
  check('API: ?view=short gives rows', apiShort.length === 50 && !('description' in apiShort[0]) && typeof apiShort[0].comments === 'number')

  const out = path.join(lib.WORK, process.env.REPLYSIZE_OUT || 'replysize.json')
  fs.writeFileSync(out, JSON.stringify(sizes, null, 2))
  fs.writeFileSync(out.replace(/\.json$/, '-texts.json'), JSON.stringify(texts, null, 2))
  console.log(`\nWrote ${out}`)
  await inv('session:stop', alpha, coder.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
