// Hive running GitHub Copilot agents end to end with the real Copilot CLI, offline, against the scripted stand-in model
// (fake-copilot-api.cjs: BYOK with COPILOT_OFFLINE, no sign-in, no credits). Two agents in a quiet test copy, A in Ask
// and B in Copilot's default, Accept edits: the folder trust question, statuses from Copilot's hooks (working, a
// permission dialog, a question, finished), a file lock that refuses the other agent's edit, the hive MCP tools and edits
// in B's folder with no prompt (an edit outside it still asks), a prompt queued while B works, a workspace skill through
// Copilot's skill tool, Shift+Tab to Plan and back, Esc on a dialog ending the turn (the transcript's abort), the
// Sessions tab's transcript and usage, and resume. Copilot runs in a home of the suite's own, with a fake profile folder and the GitHub CLI's login hidden
// (GH_CONFIG_DIR empty, gh off PATH): never the user's ~/.copilot or gh sign-in. Skipped where Copilot isn't installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')

const userData = path.join(lib.WORK, 'copilot-profile')
const ws = path.join(lib.WORK, 'copilot-ws')
// Glob characters in the project's name: Accept edits' write(<folder>/**) rule must take them as they are (#468). A
// sibling Copilot may reach (path-only access, as a saved allowed_directories entry gives) is still outside it.
const proj = path.join(ws, 'demo[1]{x}')
const sibling = path.join(ws, 'demo[1]{x}-y-')
// Parentheses in a path: Copilot can't approve edits in exactly that folder, so Accept edits approves none there and
// Hive says so (#468); its look-alike sibling (what a stand-in for each parenthesis would match) stays unwritten.
const proj2 = path.join(ws, 'paren(1)')
const sibling2 = path.join(ws, 'paren-1-')
const copilotDir = path.join(lib.WORK, 'copilot-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'copilot-api.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  lib.gitProject(proj, { 'a.ts': 'probe\n', 'README.md': '# demo\n' })
  lib.gitProject(proj2, { 'p.txt': 'probe\n' })
  for (const d of [sibling, sibling2]) fs.mkdirSync(d, { recursive: true })
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47823), ...copilotTestEnv(api, copilotDir) })
  // Path-only access to each sibling, as Copilot saves it in its (test) home when a path is allowed: never write access.
  const locations = Object.fromEntries([[proj, sibling], [proj2, sibling2]].map(([p, s]) => [p, { allowed_directories: [s], tool_approvals: [] }]))
  fs.writeFileSync(path.join(copilotHome, 'permissions-config.json'), JSON.stringify({ locations }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => { const i = (await inv('provider:info')).copilot; return i && !i.checking ? i : null }, 60000, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (${info?.source ?? '?'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop A', provider: 'copilot', location: 'project', permissionMode: 'ask' })
    const b = await inv('agents:add', proj, { name: 'Cop B', provider: 'copilot', location: 'project' })
    check('agents added with provider copilot', a.provider === 'copilot' && b.provider === 'copilot')
    const live = async (id) => (await inv('session:live')).find((l) => l.agentId === id)
    const key = (id) => lib.ptyKey(proj, id)
    const screen = async (id) => lib.plainText(await inv('pty:buffer', key(id)).catch(() => ''))
    const status = async (id) => (await live(id))?.status
    const reach = (id, wanted, ms = 30000) => lib.until(async () => wanted.includes(await status(id)), ms, 300)
    const send = (id, text, accept = ['working', 'waiting', 'finished']) => lib.sendPrompt(inv, key(id), text, { submitted: async () => accept.includes(await status(id)) })
    // The statuses an agent shows until its turn finishes or it waits for the user (or `ms` passes), polled.
    const timeline = async (id, ms = 30000) => {
      const seen = []
      const done = await lib.until(async () => {
        const st = await status(id)
        if (seen[seen.length - 1] !== st) seen.push(st)
        return st === 'finished' || st === 'waiting'
      }, ms, 150)
      return { seen, finished: !!done && seen[seen.length - 1] === 'finished', asked: seen.includes('waiting') }
    }

    // Starting: under the session id Hive chose; Copilot's folder-trust question shows as waiting until it's answered.
    const startAndTrust = async (agent) => {
      const s = await inv('session:start', proj, { agentId: agent.id })
      check(`${agent.name}: starts with a session id Hive chose (--session-id)`, /^[0-9a-f-]{36}$/.test(s?.sessionId ?? ''), s?.sessionId)
      const asked = await lib.until(async () => /Do you trust the files in this folder/.test(await screen(agent.id)), 30000, 300)
      check(`${agent.name}: the folder-trust question shows as waiting`, !!asked && (await status(agent.id)) === 'waiting', await status(agent.id))
      await inv('pty:write', key(agent.id), '\r')
      check(`${agent.name}: ready once answered`, !!(await reach(agent.id, ['ready'])), await status(agent.id))
      return s
    }
    const sa = await startAndTrust(a)
    check('A: the footer says Ask', (await live(a.id))?.permissionMode === 'ask', (await live(a.id))?.permissionMode)

    // A plain turn: working, then finished (Stop).
    check('A: a prompt makes it working', (await send(a.id, 'say Hello from the stand-in.', ['working', 'finished'])) > 0, await status(a.id))
    check('A: the turn finishes (Stop hook)', !!(await reach(a.id, ['finished'])), await status(a.id))

    // A workspace skill, through Copilot's skill tool: Hive's copy in .agents/skills (shared with Codex).
    await send(a.id, 'skill work-on-card then say Read it.', ['working', 'finished'])
    check('A: the skill turn finishes', !!(await reach(a.id, ['finished'])), await status(a.id))
    check("Hive's copy of the skill is in .agents/skills", fs.existsSync(path.join(proj, '.agents', 'skills', 'hive-work-on-card', 'SKILL.md')))

    // An edit of a.ts: PreToolUse claims it, then Copilot's permission dialog (Notification permission_prompt): waiting.
    await send(a.id, 'edit a.ts probe probed')
    const asking = await lib.until(async () => { const l = await live(a.id); return l?.status === 'waiting' ? l : null }, 30000, 300)
    check('A: the permission dialog shows as waiting, with what it asks', !!asking && /a\.ts/.test(asking.statusMessage ?? ''), `${await status(a.id)} ${asking?.statusMessage ?? ''}`)
    check('A: holds a.ts', ((await live(a.id))?.lockedFiles ?? []).some((f) => /a\.ts$/i.test(f)), JSON.stringify((await live(a.id))?.lockedFiles))
    await page.screenshot({ path: path.join(lib.WORK, 'copilot-1-permission.png') })

    // B edits the same file while A holds it: Hive's lock (block) refuses it, in Copilot's own words.
    const sb = await startAndTrust(b)
    await send(b.id, 'edit a.ts probe other', ['working', 'finished'])
    const denied = await lib.until(async () => /Denied by preToolUse hook: Cop A is editing a\.ts/.test(await screen(b.id)), 30000, 300)
    check("B: its edit of the file A holds is refused by the lock", !!denied, (await screen(b.id)).slice(-300))
    check('B: its turn finishes', !!(await reach(b.id, ['finished'])), await status(b.id))
    check('a.ts unchanged while A holds it', fs.readFileSync(path.join(proj, 'a.ts'), 'utf8') === 'probe\n')
    await page.screenshot({ path: path.join(lib.WORK, 'copilot-2-denied.png') })

    // A approves (Enter on Yes): the edit goes through and the turn finishes; the claim goes with it.
    await inv('pty:write', key(a.id), '\r')
    check('A: the approved edit finishes', !!(await reach(a.id, ['finished'])), await status(a.id))
    check('a.ts edited by A', fs.readFileSync(path.join(proj, 'a.ts'), 'utf8').includes('probed'))
    check('A: lets a.ts go at the end of its turn', !((await live(a.id))?.lockedFiles ?? []).length, JSON.stringify((await live(a.id))?.lockedFiles))

    // B: a hive tool, with no prompt in any mode (--allow-tool=hive, #468): it reaches Hive's Agent API.
    check('B: starts in Accept edits, Copilot’s default', (await live(b.id))?.permissionMode === 'accept-edits', (await live(b.id))?.permissionMode)
    await send(b.id, 'hive hive_list_projects then say Listed.', ['working', 'waiting'])
    const hiveTurn = await timeline(b.id)
    check('B: a hive tool runs without asking, and the turn finishes', hiveTurn.finished && !hiveTurn.asked, hiveTurn.seen.join(' → '))
    check('B: …no tool dialog on its screen', !/Do you want to use this tool\?/.test(await screen(b.id)))
    const listed = fs.readFileSync(apiLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check('Copilot offered the hive tools, named hive-<tool>', listed.some((r) => (r.tools ?? []).includes('hive-hive_list_projects')), JSON.stringify(listed[0]?.tools ?? []))
    check("Hive's guidance reached Copilot's system prompt (the hive server's instructions)", listed.some((r) => /use the hive tools/i.test(r.system ?? '')))
    const bScreen = await screen(b.id)
    check('B: the hive tool ran, and not refused', /hive_list_projects/.test(bScreen) && !/✗\s*hive_list_projects/.test(bScreen), bScreen.split('\n').filter((l) => /hive_list_projects/.test(l)).join(' | '))

    // B: Accept edits approves an edit in its folder (--allow-tool=write(<folder>/**)), and a new file in it.
    await send(b.id, 'edit README.md demo edited-by-b then write notes.txt from B then say Edited.', ['working', 'waiting'])
    const editTurn = await timeline(b.id)
    check('B: edits files in its folder without asking', editTurn.finished && !editTurn.asked, editTurn.seen.join(' → '))
    check('README.md edited and notes.txt written by B', fs.readFileSync(path.join(proj, 'README.md'), 'utf8').includes('edited-by-b') && fs.existsSync(path.join(proj, 'notes.txt')))
    // …but not outside it, even in a sibling it has path access to: Copilot still asks before the edit, and Esc on it
    // aborts the turn (the transcript's abort).
    await send(b.id, `write ../${path.basename(sibling)}/outside-b.txt from B`, ['working', 'waiting'])
    check('B: a file outside its folder still asks', !!(await reach(b.id, ['waiting'])), await status(b.id))
    await inv('pty:write', key(b.id), '\x1b')
    const bEvents = path.join(copilotHome, 'session-state', sb.sessionId, 'events.jsonl')
    const bLog = () => (fs.existsSync(bEvents) ? fs.readFileSync(bEvents, 'utf8') : '')
    check('B: refused with Esc, its turn ends', !!(await reach(b.id, ['ready', 'finished'], 20000)), await status(b.id))
    check('nothing written outside its folder', !fs.existsSync(path.join(sibling, 'outside-b.txt')))

    // B: a prompt typed while it works (Copilot queues it, and sends its UserPromptSubmit after the first turn's Stop):
    // Hive shows the queued turn working while it runs, not finished (#468: "finished" just as the next prompt started).
    // The turns' times come from Copilot's own events.jsonl; the statuses are sampled meanwhile.
    await send(b.id, 'work 4 then say First turn.', ['working'])
    await lib.sendPrompt(inv, key(b.id), 'work 4 then say Second turn.', { submitted: async () => /Second turn/.test(await screen(b.id)) })
    const samples = []
    /** The second turn's start and end in events.jsonl (ms), once both are there. */
    const secondTurn = () => {
      const evs = bLog().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const at = evs.findIndex((e) => e.type === 'user.message' && /Second turn/.test(e.data?.content ?? ''))
      const end = at < 0 ? -1 : evs.findIndex((e, i) => i > at && e.type === 'assistant.turn_end')
      return end < 0 ? null : { start: Date.parse(evs[at].timestamp), end: Date.parse(evs[end].timestamp) }
    }
    const turn = await lib.until(async () => {
      samples.push({ at: Date.now(), st: await status(b.id) })
      const t = secondTurn()
      return t && samples[samples.length - 1].st === 'finished' ? t : null
    }, 40000, 150)
    check('B: both turns run, and it ends finished', !!turn, samples.map((s) => s.st).filter((s, i, all) => s !== all[i - 1]).join(' → '))
    const during = turn ? samples.filter((s) => s.at > turn.start + 500 && s.at < turn.end - 300) : []
    check('B: shown working while the queued turn runs', during.length > 3 && during.every((s) => s.st === 'working'), `${during.length} samples: ${[...new Set(during.map((s) => s.st))].join(', ')}`)

    // C, in paren(1): Copilot can't approve edits in exactly a folder whose path has parentheses, so Accept edits approves
    // none there (#468): Hive says so as it starts, an edit asks and goes through once approved, and the look-alike
    // sibling it has path access to stays unwritten.
    const c = await inv('agents:add', proj2, { name: 'Cop C', provider: 'copilot', location: 'project' })
    const keyC = lib.ptyKey(proj2, c.id)
    const liveC = async () => (await inv('session:live')).find((l) => l.agentId === c.id)
    const statusC = async () => (await liveC())?.status
    const reachC = (wanted, ms = 30000) => lib.until(async () => wanted.includes(await statusC()), ms, 300)
    const sendC = (text) => lib.sendPrompt(inv, keyC, text, { submitted: async () => ['working', 'waiting'].includes(await statusC()) })
    await inv('session:start', proj2, { agentId: c.id })
    if (await lib.until(async () => /Do you trust the files in this folder/.test(lib.plainText(await inv('pty:buffer', keyC).catch(() => ''))), 30000, 300)) await inv('pty:write', keyC, '\r')
    check('C: ready in paren(1)', !!(await reachC(['ready'])), await statusC())
    check('C: in Accept edits, Copilot’s default', (await liveC())?.permissionMode === 'accept-edits', (await liveC())?.permissionMode)
    const told = await lib.until(async () => (await page.getByText('Copilot will ask before each edit').count()) > 0, 15000, 300)
    check('C: Hive says Copilot will ask before each edit there', !!told)
    await page.screenshot({ path: path.join(lib.WORK, 'copilot-4-parentheses.png') })
    await sendC('edit p.txt probe probed-by-c')
    check('C: an edit in its folder asks', !!(await reachC(['waiting'])), await statusC())
    check('p.txt unchanged until approved', fs.readFileSync(path.join(proj2, 'p.txt'), 'utf8') === 'probe\n')
    await inv('pty:write', keyC, '\r')
    check('C: approved, the edit goes through and the turn finishes', !!(await reachC(['finished'])), await statusC())
    check('p.txt edited by C once approved', fs.readFileSync(path.join(proj2, 'p.txt'), 'utf8').includes('probed-by-c'))
    await sendC(`write ../${path.basename(sibling2)}/outside-c.txt from C`)
    check('C: a write into the look-alike sibling asks', !!(await reachC(['waiting'])), await statusC())
    await inv('pty:write', keyC, '\x1b')
    check('C: refused with Esc, its turn ends', !!(await reachC(['ready', 'finished'], 20000)), await statusC())
    check('nothing written in the look-alike sibling', !fs.existsSync(path.join(sibling2, 'outside-c.txt')))
    await inv('session:stop', proj2, c.id).catch(() => {})

    // A: a question (ask_user: Notification elicitation_dialog): waiting with its question, then answered.
    await send(a.id, 'question then say Thanks.')
    const q = await lib.until(async () => { const l = await live(a.id); return l?.status === 'waiting' ? l : null }, 30000, 300)
    check('A: its question shows as waiting, with the question', !!q && /Which one should I use/.test(q.statusMessage ?? ''), `${await status(a.id)} ${q?.statusMessage ?? ''}`)
    await inv('pty:write', key(a.id), '\r')
    check('A: the answered question finishes', !!(await reach(a.id, ['finished'])), await status(a.id))

    // Shift+Tab: Plan and back to Ask (through Autopilot), read from the footer; Allow all needs a restart.
    const toPlan = await inv('session:setMode', proj, a.id, 'plan')
    check('A: switches to Plan in the running session', !!toPlan?.ok && (await live(a.id))?.permissionMode === 'plan', JSON.stringify(toPlan))
    const toAsk = await inv('session:setMode', proj, a.id, 'ask')
    check('A: and back to Ask', !!toAsk?.ok && (await live(a.id))?.permissionMode === 'ask', JSON.stringify(toAsk))
    const toAll = await inv('session:setMode', proj, a.id, 'allow-all').catch((e) => ({ ok: false, message: String(e.message) }))
    check('A: Allow all needs a restart', toAll?.ok === false, JSON.stringify(toAll))

    // Esc on a permission dialog: no hook comes; the transcript's abort ends the turn.
    await send(a.id, 'shell New-Item -Path made-by-copilot.txt -ItemType File')
    check('A: the command waits for permission', !!(await reach(a.id, ['waiting'])), await status(a.id))
    await inv('pty:write', key(a.id), '\x1b')
    check('A: Esc on the dialog ends the turn (abort in the transcript)', !!(await reach(a.id, ['ready', 'finished'], 20000)), await status(a.id))
    check('the command never ran', !fs.existsSync(path.join(proj, 'made-by-copilot.txt')))

    // A ends as a person ends it, with /exit: Copilot writes the session's token totals (session.shutdown) only as it exits
    // by itself, and Hive's Stop ends the process, which can be before it has (#465). The Sessions tab then reads the
    // conversation and its usage from the test COPILOT_HOME.
    const events = path.join(copilotHome, 'session-state', sa.sessionId, 'events.jsonl')
    // Ended: Hive has let the session go (it can show stopped for a moment first).
    const ended = async () => !(await live(a.id))
    await lib.sendPrompt(inv, key(a.id), '/exit', { submitted: ended })
    check('A: ends on /exit', !!(await lib.until(ended, 20000, 300)), await status(a.id))
    check("the session's events.jsonl is in the suite's COPILOT_HOME", fs.existsSync(events))
    const shutdown = await lib.until(() => fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('"type":"session.shutdown"'), 15000, 300)
    check('Copilot recorded the end of the session with its totals (session.shutdown)', !!shutdown, fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').slice(-3).map((l) => /"type":"([^"]+)"/.exec(l)?.[1]).join(' | ') : 'no events.jsonl')
    const t = await inv('transcript:read', proj, sa.sessionId)
    const items = t?.items ?? []
    check('the Sessions tab shows the conversation: its prompts', items.some((x) => x.kind === 'user' && /Hello from the stand-in/.test(x.text)), JSON.stringify(items.filter((x) => x.kind === 'user').map((x) => x.text).slice(0, 4)))
    check('…the replies', items.some((x) => x.kind === 'assistant' && /Hello from the stand-in/.test(x.text)))
    check('…and the tool calls (the skill, the edit)', ['skill', 'edit'].every((n) => items.some((x) => x.kind === 'tool' && new RegExp(n, 'i').test(x.tool?.name ?? ''))), JSON.stringify(items.filter((x) => x.kind === 'tool').map((x) => x.tool?.name)))
    const usage = await lib.until(async () => { const u = await inv('session:usage', proj, sa.sessionId); return u && u.inputTokens > 0 ? u : null }, 15000, 500)
    check('usage: the tokens Copilot counted, and its model', !!usage && usage.outputTokens > 0 && /gpt-4\.1/.test(usage.model ?? ''), JSON.stringify(usage && { in: usage.inputTokens, out: usage.outputTokens, model: usage.model, cost: usage.costUsd }))
    // Copilot reports the session's cost itself (its AI credits): offline, 0 credits, which is $0 as reported, not unknown.
    check('usage: the cost Copilot reported offline is 0 (no AI credits), not estimated', !!usage && usage.costUsd === 0 && usage.costEstimated === false, JSON.stringify(usage && { cost: usage.costUsd, estimated: usage.costEstimated }))
    const list = await inv('session:list', proj)
    check('the Sessions tab lists the session as Copilot’s', list.some((s) => s.id === sa.sessionId && s.provider === 'copilot'), JSON.stringify(list.map((s) => ({ id: s.id, provider: s.provider }))))

    // Resume: --resume <id>, the same session, the earlier conversation on screen.
    const r = await inv('session:start', proj, { agentId: a.id, resumeId: sa.sessionId })
    check('A: resumes the same session id', r?.sessionId === sa.sessionId, r?.sessionId)
    if (await lib.until(async () => /Do you trust the files in this folder/.test(await screen(a.id)), 15000, 300)) await inv('pty:write', key(a.id), '\r')
    check('A: the resumed session is ready', !!(await reach(a.id, ['ready'])), await status(a.id))
    check('A: …with the earlier conversation on screen', /Hello from the stand-in/.test(await screen(a.id)))
    await page.screenshot({ path: path.join(lib.WORK, 'copilot-3-resumed.png') })

    // What Hive wrote for the launches: in its own data (the hook token is in the plugin's hooks.json), never the project.
    const projFiles = fs.readdirSync(proj, { recursive: true }).map(String).filter((f) => !f.startsWith('.git' + path.sep) && f !== '.git')
    check('no hooks.json or MCP config in the project', !projFiles.some((f) => /hooks\.json|mcp\.json/i.test(f)), projFiles.filter((f) => /json/i.test(f)).join(', '))
    check('no requests went anywhere but the stand-in (offline), and some did', api.requests > 0)
    for (const id of [a.id, b.id]) await inv('session:stop', proj, id).catch(() => {})
    await lib.until(async () => !(await live(a.id)) && !(await live(b.id)), 20000, 300)
  } finally {
    await app.close().catch(() => {})
    await api.close()
  }
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.error(e)
  console.log('FAIL the suite threw')
  process.exit(1)
})
