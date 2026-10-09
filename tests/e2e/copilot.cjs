// Hive running GitHub Copilot agents end to end with the real Copilot CLI, offline, against the scripted stand-in model
// (fake-copilot-api.cjs: BYOK with COPILOT_OFFLINE, no sign-in, no credits). Two agents in a quiet test copy: the folder
// trust question, statuses from Copilot's hooks (working, a permission dialog, a question, finished), a file lock that
// refuses the other agent's edit, the hive MCP tools, a workspace skill through Copilot's skill tool, Shift+Tab to Plan
// and back, Esc on a dialog ending the turn (the transcript's abort), the Sessions tab's transcript and usage, and
// resume. Copilot runs in a home of the suite's own, with a fake profile folder and the GitHub CLI's login hidden
// (GH_CONFIG_DIR empty, gh off PATH): never the user's ~/.copilot or gh sign-in. Skipped where Copilot isn't installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')

const userData = path.join(lib.WORK, 'copilot-profile')
const ws = path.join(lib.WORK, 'copilot-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'copilot-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'copilot-api.jsonl')
const sleep = lib.sleep
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
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47823), ...copilotTestEnv(api, copilotDir) })
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
    const a = await inv('agents:add', proj, { name: 'Cop A', provider: 'copilot', location: 'project' })
    const b = await inv('agents:add', proj, { name: 'Cop B', provider: 'copilot', location: 'project' })
    check('agents added with provider copilot', a.provider === 'copilot' && b.provider === 'copilot')
    const live = async (id) => (await inv('session:live')).find((l) => l.agentId === id)
    const key = (id) => lib.ptyKey(proj, id)
    const screen = async (id) => lib.plainText(await inv('pty:buffer', key(id)).catch(() => ''))
    const status = async (id) => (await live(id))?.status
    const reach = (id, wanted, ms = 30000) => lib.until(async () => wanted.includes(await status(id)), ms, 300)
    const send = (id, text, accept = ['working', 'waiting', 'finished']) => lib.sendPrompt(inv, key(id), text, { submitted: async () => accept.includes(await status(id)) })

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
    await startAndTrust(b)
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

    // B: a hive tool (asked first, as Copilot asks before any MCP tool in Ask): it reaches Hive's Agent API.
    await send(b.id, 'hive hive_list_projects then say Listed.')
    const dialog = await lib.until(async () => /Do you want to use this tool\?/.test(await screen(b.id)), 30000, 300)
    check('B: Copilot asks before a hive tool, and Hive shows it waiting', !!dialog && (await status(b.id)) === 'waiting', await status(b.id))
    await sleep(300)
    await inv('pty:write', key(b.id), '\r')
    check('B: the hive tool turn finishes', !!(await reach(b.id, ['finished'])), await status(b.id))
    const listed = fs.readFileSync(apiLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check('Copilot offered the hive tools, named hive-<tool>', listed.some((r) => (r.tools ?? []).includes('hive-hive_list_projects')), JSON.stringify(listed[0]?.tools ?? []))
    check("Hive's guidance reached Copilot's system prompt (the hive server's instructions)", listed.some((r) => /use the hive tools/i.test(r.system ?? '')))

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

    // Esc on the prompt for a file outside its folder (a read asks for the path, "Path permission needed"; in Ask a
    // write asks to write it): Copilot records the refusal and ends the turn with neither a hook nor an abort, and Hive
    // reads the end from its events (#475).
    const aEvents = path.join(copilotHome, 'session-state', sa.sessionId, 'events.jsonl')
    const aLog = () => fs.readFileSync(aEvents, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
    const refused = (e) => e.type === 'permission.completed' && e.data?.result?.kind === 'denied-interactively-by-user'
    const refuse = async (prompt, what, asked) => {
      const before = aLog().filter(refused).length
      await send(a.id, prompt)
      const prompting = await lib.until(async () => asked.test(await screen(a.id)) && (await status(a.id)) === 'waiting', 30000, 300)
      check(`A: ${what} asks first`, !!prompting, `${await status(a.id)} ${(await screen(a.id)).slice(-300)}`)
      await sleep(300)
      await inv('pty:write', key(a.id), '\x1b')
      // From this refusal on: the log's next after the earlier ones.
      const after = await lib.until(() => {
        const evs = aLog()
        const at = evs.map((e, k) => (refused(e) ? k : -1)).filter((k) => k >= 0)[before] ?? -1
        return at >= 0 && evs.slice(at).some((e) => e.type === 'assistant.turn_end') ? evs.slice(at) : null
      }, 20000, 300)
      check(`A: Copilot records the refusal of ${what} and the turn's end, with no abort or Stop`, !!after && !after.some((e) => e.type === 'abort' || (e.type === 'hook.start' && e.data?.hookType === 'agentStop')), JSON.stringify(after?.map((e) => e.type)))
      check(`A: refusing ${what} with Esc leaves it ready, not waiting`, !!(await reach(a.id, ['ready'], 20000)), await status(a.id))
    }
    const outside = path.join(ws, 'outside-a.txt')
    fs.writeFileSync(path.join(ws, 'outside-read.txt'), 'outside\n')
    await refuse('view ../outside-read.txt', 'a read outside its folder', /Path permission|listed directory/i)
    await refuse('write ../outside-a.txt from A', 'a write outside its folder', /outside-a\.txt/)
    check('nothing written outside its folder', !fs.existsSync(outside))

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
    // Copilot shows a resumed conversation full screen, scrolled to its end: only the latest exchange is sure to be drawn
    // (the first prompt shows only in a passing frame while plugins load, if that frame is drawn at all: #467).
    const resumed = await lib.until(async () => { const s = await screen(a.id); return /shell New-Item -Path made-by-copilot\.txt/.test(s) && /Operation aborted by user/.test(s) }, 20000, 300)
    check('A: …with the earlier conversation on screen (its latest exchange)', !!resumed, (await screen(a.id)).trim().split('\n').slice(-12).join(' | '))
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
