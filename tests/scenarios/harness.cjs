// Runs one scenario (scenarios.cjs) through Hive's dev build: a throwaway profile and workspace, a CLI home that is
// never the user's own, the scenario's cards, notes, handovers and skill changes; the agent or the Assistant started
// with its prompt; then what it actually did:
// - the hive tool calls the hive MCP server ran (its test log, HIVE_TEST_MCP_LOG: executed, with whether each worked);
// - the Hive skills it read (a successful Skill call, or a read whose result is that skill's own text);
// - every tool call in its transcript (Hive's parser), names of hive tools it only mentions kept apart;
// - the board, notes and files afterwards (the Agent API and the disk), its usage, and whether any API token showed up
//   in what it printed or said;
// - what Hive's own parts cost during the turn (its performance metrics, before the launch and after the turn: the
//   difference is the scenario's), for benchmarks (measuresOf).
// Scenarios check outcomes, never wording.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const lib = require('../e2e/lib.cjs')
const { measuresOf, metricsTotals } = require('./benchmark.cjs')

/**
 * The Claude Code home the model trials use: a test home signed in once by hand (never the user's own ~/.claude, and
 * never a copy of its credentials, whose refresh could sign the user out). See README.md.
 */
const CLAUDE_TEST_HOME = process.env.HIVE_TEST_CLAUDE_HOME || path.join(path.dirname(lib.CODEX_HOME), 'claude')
const claudeSignedIn = () => fs.existsSync(path.join(CLAUDE_TEST_HOME, '.credentials.json'))

/** The CLI each provider runs here: the fakes, or the real standalone CLIs, each in its test home. */
const PROVIDERS = {
  fake: { provider: 'claude-code', fake: true, executable: path.join(lib.ROOT, 'tests', 'e2e', 'fake-claude', 'fake-claude.cmd'), mode: 'bypassPermissions' },
  // The fake Codex, in a throwaway home of its own (never the signed-in test home).
  'fake-codex': { provider: 'codex', fake: true, executable: path.join(lib.ROOT, 'tests', 'e2e', 'fake-codex', 'fake-codex.cmd'), mode: 'full-access' },
  // Accept edits, with the hive tools, commands and skills allowed on the command line (the project's extra arguments):
  // it never asks, and needs no bypass mode (which Claude Code asks to accept once).
  'claude-code': { provider: 'claude-code', executable: '', mode: 'acceptEdits', extraArgs: '--allowedTools mcp__hive Bash PowerShell Skill' },
  codex: { provider: 'codex', executable: '', mode: 'full-access' }
}

const sleep = lib.sleep
const plain = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ').replace(/\s+/g, ' ')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Tools that write or edit files: what they're given is never evidence of a read. */
const WRITERS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/i

/**
 * What a session's transcript shows: every tool call (name, summary, input, result, error), the Hive skills it read,
 * the hive tools it names (mentions: a transcript isn't proof a call ran; the server's log is), and its last reply.
 * A skill counts as read only when the read worked and shows the skill: a Skill call for it that didn't fail, or a
 * tool (not a writer) given its SKILL.md whose result has the skill's own `name:` line.
 */
function observeTranscript(items, skillNames) {
  const tools = items.filter((x) => x.kind === 'tool').map((x) => ({ name: x.tool.name, summary: x.tool.summary, input: String(x.tool.input ?? ''), isError: x.tool.isError, result: String(x.tool.result ?? '') }))
  const skillsRead = []
  for (const t of tools) {
    if (t.isError || WRITERS.test(t.name)) continue
    for (const n of skillNames) {
      if (skillsRead.includes(n)) continue
      const viaTool = /^skill$/i.test(t.name) && new RegExp(`(^|[":\\s])(hive:)?${escape(n)}(\\b|$)`).test(t.input)
      const viaRead = new RegExp(`skills[\\\\/]+(hive-)?${escape(n)}[\\\\/]+SKILL\\.md`, 'i').test(t.input) && new RegExp(`(^|\\s)name:\\s*["']?${escape(n)}["']?\\s*$`, 'm').test(t.result)
      if (viaTool || viaRead) skillsRead.push(n)
    }
  }
  // Names of hive tools in the transcript: a direct call (mcp__hive__x, hive.x, Hive's "hive · x"), or one written in a
  // Codex script (tools.mcp__hive__x(...)), which may or may not have run.
  const hiveName = (name) => /(?:^|[_.\s])(hive_[a-z]+(?:_[a-z]+)*)$/.exec(name)?.[1]
  const hiveMentions = tools.flatMap((t) => (hiveName(t.name) ? [hiveName(t.name)] : [...t.input.matchAll(/\btools\.(?:mcp__hive__)?(hive_[a-z]+(?:_[a-z]+)*)\s*\(/g)].map((m) => m[1])))
  const replies = items.filter((x) => x.kind === 'assistant').map((x) => x.text)
  return { tools, skillsRead, hiveMentions, finalReply: replies.at(-1) ?? '', replies }
}

/** The calls the hive MCP servers ran, from their test log: [{ tool, role, project, agent, ok, error, args }]. */
function readMcpLog(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * The source a run used: the commit, and a fingerprint of everything uncommitted: changes to tracked files (the diff
 * against HEAD) and the untracked files that aren't ignored, each by its path and its bytes, in path order. Null when
 * there's nothing uncommitted.
 */
function sourceFingerprint(root = lib.ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  const head = git('rev-parse', '--short', 'HEAD').toString().trim()
  const h = require('crypto').createHash('sha256')
  const diff = git('diff', '--binary', 'HEAD')
  h.update('diff\0').update(diff)
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort()
  for (const f of untracked) {
    h.update(`\0file\0${f}\0`)
    h.update(fs.readFileSync(path.join(root, f)))
  }
  return { head, dirty: diff.length || untracked.length ? h.digest('hex').slice(0, 12) : null }
}

/**
 * Runs `sc` with `providerKey` (fake, claude-code or codex). `opts`: { model, effort, timeoutMs, port, keep, workRoot }.
 * Returns { scenario, provider, model, cliVersion, guidance, observed, checks, usage, seconds, error }.
 */
async function runScenario(sc, providerKey, opts = {}) {
  const p = PROVIDERS[providerKey]
  const id = `${sc.id}-${providerKey}`
  const root = path.join(opts.workRoot ?? path.join(lib.WORK, '..', 'scenarios'), id)
  const userData = path.join(root, 'profile')
  const ws = path.join(root, 'ws')
  const alpha = path.join(ws, 'alpha')
  const fakeHome = path.join(root, 'claude-home')
  const fakeCodexHome = path.join(root, 'codex-home')
  const mcpLog = path.join(root, 'mcp-calls.jsonl')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(fakeHome, { recursive: true })
  if (providerKey === 'fake-codex') {
    fs.mkdirSync(fakeCodexHome, { recursive: true })
    fs.writeFileSync(path.join(fakeCodexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  }
  lib.gitProject(alpha, { 'README.md': '# alpha\n\nA small project for Hive scenarios.\n', 'math.js': 'module.exports = {}\n', ...sc.files })
  for (const other of sc.projects ?? []) lib.gitProject(path.join(ws, other), { 'README.md': `# ${other}\n` })
  // The fake trusts these folders; the real Claude Code asks (answered below); Codex reads its test home's trust list.
  fs.writeFileSync(path.join(fakeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  if (providerKey === 'codex') {
    lib.trustForCodex(alpha)
    lib.trustForCodex(ws)
  }

  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  if (p.executable) cfg.settings.providers[p.provider].executablePath = p.executable
  for (const pid of ['claude-code', 'codex']) cfg.settings.providers[pid] = { ...cfg.settings.providers[pid], enableDangerousMode: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  if (sc.role === 'assistant') {
    cfg.settings.assistant = {
      ...cfg.settings.assistant,
      provider: p.provider,
      control: sc.control ?? 'projects',
      providers: { ...cfg.settings.assistant?.providers, [p.provider]: { model: opts.model ?? '', effort: opts.effort ?? '', permissionMode: p.mode, extraArgs: p.extraArgs ?? '' } }
    }
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const port = opts.port ?? 47930
  const started = Date.now()
  // Each CLI's home is a test one: the fake's per run, the real Claude Code's and Codex's signed-in test homes.
  const env = {
    HIVE_API_PORT: String(port),
    HIVE_TEST_TIPS: 'off',
    HIVE_TEST_MCP_LOG: mcpLog,
    CLAUDE_CONFIG_DIR: providerKey === 'claude-code' ? CLAUDE_TEST_HOME : fakeHome,
    CODEX_HOME: providerKey === 'fake-codex' ? fakeCodexHome : lib.CODEX_HOME
  }
  const { app, inv } = await lib.launch({ userData, env })
  const result = { scenario: sc.id, title: sc.title, provider: providerKey, model: opts.model ?? '(default)', role: sc.role ?? 'agent', control: sc.role === 'assistant' ? (sc.control ?? 'projects') : undefined, cliVersion: null, guidance: null, checks: [], observed: null, usage: null, measures: null, metricsOverheadMs: 0, seconds: 0, error: null }
  try {
    const info = await lib.waitForProvider(inv, p.provider, 60000)
    result.cliVersion = info.version ?? null
    await inv('workspace:open', ws)
    await sleep(1200)
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // not JSON
      }
      return { status: res.status, body: parsed, text }
    }
    // The guidance and skills Hive has before the scenario's setup (the session's own, after it, are recorded below).
    result.guidance = { atStart: (await api('GET', '/v1/status')).body?.guidance ?? null, delivered: null }

    if (p.extraArgs) await inv('project:updateConfig', alpha, { providers: { [p.provider]: { extraArgs: p.extraArgs } } })
    // The project's agents: the one under test (Coder), and another that did earlier work (Implementer, never started).
    const coder = await lib.addAgent(inv, alpha, { name: 'Coder', provider: p.provider, model: opts.model ?? '', effort: opts.effort ?? '', permissionMode: p.mode })
    const implementer = await lib.addAgent(inv, alpha, { name: 'Implementer', provider: p.provider, model: opts.model ?? '', effort: opts.effort ?? '', permissionMode: p.mode })
    const ctx = {
      api,
      inv,
      ws,
      alpha,
      skillsDir: path.join(ws, '.hive', 'skills'),
      agents: { coder, implementer },
      cards: {},
      /** A card: { title, description, project (alpha), column, agent ('coder' | 'implementer'), labels, comments: [text] }. */
      card: async (key, c) => {
        const r = await api('POST', '/v1/tasks', { title: c.title, description: c.description ?? '', project: c.project ?? 'alpha', labels: c.labels ?? [], ...(c.agent ? { agent: ctx.agents[c.agent].id } : {}) })
        if (r.status !== 200) throw new Error(`card ${key}: ${r.text}`)
        for (const text of c.comments ?? []) await api('POST', `/v1/tasks/${r.body.number}/comments`, { text })
        if (c.column && c.column !== 'todo') await inv('tasks:update', r.body.number, { column: c.column, ...(c.agent ? { agent: ctx.agents[c.agent].id } : {}) })
        ctx.cards[key] = r.body.number
        return r.body.number
      },
      handover: (title, content) => api('POST', '/v1/shared/handovers', { title, content, project: 'alpha' }),
      note: (rel, content) => api('PUT', `/v1/shared/file?path=${encodeURIComponent(rel)}`, { content }),
      write: (rel, text) => fs.writeFileSync(path.join(alpha, rel), text),
      read: (rel) => (fs.existsSync(path.join(alpha, rel)) ? fs.readFileSync(path.join(alpha, rel), 'utf8') : null),
      git: (...a) => execFileSync('git', a, { cwd: alpha, encoding: 'utf8' })
    }
    if (sc.setup) await sc.setup(ctx)
    const skillNames = fs.existsSync(ctx.skillsDir) ? fs.readdirSync(ctx.skillsDir).filter((d) => !d.startsWith('.')) : []

    // Start the session under test, answer a trust question, wait until it's ready, and send the prompt.
    const home = (await inv('workspace:refresh')).assistant.path
    const [host, agentId] = sc.role === 'assistant' ? [home, 'assistant'] : [alpha, coder.id]
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === agentId)
    // Hive's performance metrics before the launch (the run's own workspace: everything in it is this run's).
    const metricsFrom = new Date(started - 2 * 3600_000).toISOString()
    const snapshot = async () => {
      const t = Date.now()
      const r = await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(metricsFrom)}`)
      result.metricsOverheadMs += Date.now() - t
      return r.status === 200 ? r.body : null
    }
    const metricsBefore = await snapshot()
    // A change made inside the measured window (a skill edited after the snapshot, before the launch), for scenarios
    // that compare the skill service's work on unchanged and changed revisions.
    if (sc.beforeLaunch) await sc.beforeLaunch(ctx)
    await inv('session:start', host, { agentId })
    const key = lib.ptyKey(host, agentId)
    const readyBy = Date.now() + 90000
    while (Date.now() < readyBy) {
      const s = await live()
      if (s?.status === 'ready' || s?.status === 'finished') break
      if (/trust this folder/i.test(plain(await inv('pty:buffer', key).catch(() => '')))) {
        await inv('pty:write', key, p.provider === 'codex' ? '\r' : '\x1b[B')
        await sleep(300)
        if (p.provider !== 'codex') await inv('pty:write', key, '\r')
        await sleep(1500)
      }
      await sleep(500)
    }
    // What the session under test was given at its launch (after setup): Hive's guidance and each skill as delivered.
    const subject = sc.role === 'assistant' ? (await inv('workspace:refresh')).assistant : (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')
    result.guidance.delivered = subject?.agents.find((a) => a.id === agentId)?.live?.launched ?? null
    const prompt = typeof sc.prompt === 'function' ? sc.prompt(ctx) : sc.prompt
    const fakePrompt = typeof sc.fake === 'function' ? sc.fake(ctx) : sc.fake
    const text = p.fake ? fakePrompt : prompt
    // The prompt is sent, then checked: a CLI still drawing its first screen can drop an Enter (sent again) or the
    // whole line (typed again).
    const submitted = async (ms) => {
      const t = Date.now()
      while (Date.now() - t < ms) {
        const s = await live()
        if (['working', 'background'].includes(s?.status)) return true
        const items = s?.sessionId ? ((await inv('transcript:read', host, s.sessionId).catch(() => null))?.items ?? []) : []
        if (items.some((x) => x.kind === 'user' && x.text.includes(text.slice(0, 40)))) return true
        await sleep(500)
      }
      return false
    }
    await sleep(1500)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt < 2 || !plain(await inv('pty:buffer', key).catch(() => '')).includes(text.slice(0, 30))) await inv('pty:write', key, attempt ? `\x15${text}` : text)
      await sleep(400)
      await inv('pty:write', key, '\r')
      if (await submitted(20000)) break
    }
    const sentAt = Date.now()

    // Wait for the turn to end: working (or background) first, then finished/ready for a few seconds. `during` sees the
    // board while it works, for scenarios that change things under it.
    const limit = Date.now() + (opts.timeoutMs ?? 300000)
    let sawWork = false
    let quietSince = 0
    while (Date.now() < limit) {
      const s = await live()
      const status = s?.status ?? 'stopped'
      if (['working', 'background', 'starting'].includes(status)) {
        sawWork = true
        quietSince = 0
      } else if (sawWork || Date.now() - sentAt > 60000) {
        quietSince ||= Date.now()
        if (Date.now() - quietSince > (status === 'waiting' ? 3000 : 6000)) break
      }
      if (sc.during) await sc.during(ctx, status)
      // Other agents of the project started during the run (the Assistant dispatching one) ask to trust its folder.
      for (const a of Object.values(ctx.agents)) {
        if (sc.role !== 'assistant' && a.id === coder.id) continue
        const k = lib.ptyKey(alpha, a.id)
        if (/trust this folder/i.test(plain(await inv('pty:buffer', k).catch(() => '')).slice(-2000))) {
          await inv('pty:write', k, p.provider === 'codex' ? '\r' : '\x1b[B')
          await sleep(300)
          if (p.provider !== 'codex') await inv('pty:write', k, '\r')
        }
      }
      // A dispatched agent's work is part of the outcome: wait while one is still working (within the limit).
      if (sc.waitForAgents && quietSince && (await inv('session:live')).some((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && ['working', 'starting', 'background'].includes(x.status))) quietSince = Date.now()
      await sleep(1000)
    }
    const s = await live()
    if (!s || Date.now() >= limit) result.error = s ? 'timed out' : 'the session ended'
    // The bridge reports its calls when its CLI closes input: give the last report a moment.
    await sleep(p.fake ? 500 : 2500)
    const metricsAfter = await snapshot()
    const sessionId = s?.sessionId ?? (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')?.agents.find((a) => a.id === coder.id)?.lastSessionId
    const transcript = sessionId ? await inv('transcript:read', host, sessionId).catch(() => null) : null
    // Tool calls the parser shortened for display are read in full (for the token check and read evidence).
    const items = transcript?.items ?? []
    for (const it of items) {
      if (it.kind === 'tool' && (it.tool.inputLength || it.tool.resultLength)) it.tool = (await inv('transcript:tool', host, sessionId, it.id).catch(() => null)) ?? it.tool
    }
    const observed = observeTranscript(items, skillNames)
    observed.status = s?.status ?? 'stopped'
    observed.guidance = result.guidance
    // What the hive servers ran: the subject's own calls, and everyone's (an agent the Assistant started).
    observed.allHiveCalls = readMcpLog(mcpLog)
    observed.hiveCalls = observed.allHiveCalls.filter((c) => (sc.role === 'assistant' ? c.role === 'assistant' : c.agent === coder.id))
    // Any Agent API token (the workspace's, or an agent's for this launch) in what the session printed or said.
    const tokensIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).token) : [])
    const tokens = [apiToken, ...tokensIn(path.join(userData, 'agent-api')), ...tokensIn(path.join(userData, 'assistant-api'))].filter((t) => typeof t === 'string' && t.length >= 16)
    observed.tokenLeak = tokens.some((t) => observed.tools.some((x) => x.result.includes(t)) || observed.replies.some((r) => r.includes(t)))
    observed.cards = Object.fromEntries(await Promise.all(Object.entries(ctx.cards).map(async ([k, n]) => [k, (await api('GET', `/v1/tasks/${n}`)).body])))
    observed.allCards = (await api('GET', '/v1/tasks')).body ?? []
    observed.notes = ((await api('GET', '/v1/shared')).body ?? []).flatMap(function flat(e) {
      return e.isDir ? (e.children ?? []).flatMap(flat) : [e.relPath]
    })
    observed.gitStatus = ctx.git('status', '--porcelain')
    observed.live = (await inv('session:live')).map((x) => ({ project: path.basename(x.projectPath), agentId: x.agentId, status: x.status }))
    result.usage = sessionId ? await inv('session:usage', host, sessionId).catch(() => null) : null
    // A fake acts a scenario out with scripted board moves: checks only a model's own work can meet are skipped there.
    result.measures = metricsBefore && metricsAfter ? measuresOf(metricsBefore, metricsAfter, observed, result.usage) : null
    result.metricsRecording = metricsAfter?.recording ?? null
    // How complete the measurement was: both reads, recording on, nothing dropped or evicted in between.
    const partial = []
    if (!metricsBefore || !metricsAfter) partial.push('Hive’s metrics weren’t read')
    if (metricsAfter && metricsAfter.recording === false) partial.push('recording was off')
    const dropped = Math.max(0, (metricsAfter?.dropped ?? 0) - (metricsBefore?.dropped ?? 0))
    if (dropped) partial.push(`${dropped} measurements dropped`)
    if (metricsAfter?.coverage?.evictedThrough) partial.push('history removed for space')
    result.coverage = { recording: metricsAfter?.recording ?? null, dropped, partial }
    // Every scenario starts a new session (session:start with no resumeId): its usage is the scenario's own.
    result.resumed = false
    observed.measures = result.measures
    // The guidance Hive had at the start against what the session was given: a mismatch is a stale launch.
    const startRev = result.guidance?.atStart?.revision
    const gotRev = result.guidance?.delivered?.guidance
    result.staleGuidance = !!(startRev && gotRev && startRev !== gotRev)
    result.checks = (sc.expect?.(observed, ctx) ?? []).map(([name, ok, detail]) =>
      p.fake && (sc.fakeSkips ?? []).includes(name) ? { name, ok: null, skipped: 'fake provider' } : { name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? '').slice(0, 300) }) }
    )
    // Kept short in the results (whole tool calls can be large, and must not carry a token).
    const short = (v) => tokens.reduce((x, t) => x.split(t).join('<token>'), String(v)).slice(0, 400)
    result.observed = { ...observed, tools: observed.tools.map((t) => ({ ...t, input: short(t.input), result: short(t.result) })), replies: undefined, finalReply: short(observed.finalReply) }
  } catch (e) {
    result.error = String(e?.stack ?? e)
  } finally {
    for (const x of await inv('session:live').catch(() => [])) await inv('session:stop', x.projectPath, x.agentId).catch(() => undefined)
    await sleep(1500)
    await app.close().catch(() => undefined)
    result.seconds = Math.round((Date.now() - started) / 1000)
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
  return result
}

module.exports = { runScenario, observeTranscript, readMcpLog, sourceFingerprint, metricsTotals, measuresOf, PROVIDERS, CLAUDE_TEST_HOME, claudeSignedIn }
