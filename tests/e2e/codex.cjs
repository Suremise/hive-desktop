// Hive running a Codex agent end to end, against the permanent test CODEX_HOME (codex-home.cjs, signed in).
// One short prompt on gpt-6-luna at low effort. Nothing touches the real ~/.codex or Hive profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxhive-profile')
const ws = path.join(scratch, 'cxhive-ws')
const proj = path.join(ws, 'demo')
const codexHome = lib.CODEX_HOME
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)

function prepare() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: proj })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: proj })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: proj })
  // The test Codex home trusts the project folder and has the non-admin sandbox set up.
  const cfg = path.join(codexHome, 'config.toml')
  let t = fs.readFileSync(cfg, 'utf8')
  if (!t.includes(proj)) t += `\n[projects.'${proj}']\ntrust_level = "trusted"\n`
  if (!/^\[windows\]/m.test(t)) t += `\n[windows]\nsandbox = "unelevated"\n`
  fs.writeFileSync(cfg, t)
  lib.enableProviders(userData, ['claude-code', 'codex'])
}

;(async () => {
  prepare()
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47892), CODEX_HOME: codexHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(500) } return null }

  const info = await waitFor(async () => { const i = (await inv('provider:info')).codex; return i && !i.checking ? i : null }, 30000)
  check('Codex found', !!info?.found, JSON.stringify(info))
  check('Codex signed in', info?.loggedIn === true, info?.authMethod)
  check('no readiness problems (sandbox set up in the test home)', !(info?.readiness ?? []).some((r) => r.level !== 'info'), JSON.stringify(info?.readiness))

  await lib.openWorkspace(inv, page, ws)
  const def = await inv('agents:add', proj, { name: 'Codex', provider: 'codex', location: 'project', model: 'gpt-6-luna', effort: 'low' })
  check('agent added with provider codex', def.provider === 'codex')
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const live = async () => (await inv('session:live')).find((l) => l.agentId === def.id)
  await inv('session:start', proj, { agentId: def.id })
  const started = await live()
  check('starts without a session id (Codex picks it)', started?.provider === 'codex' && started?.sessionId === '', JSON.stringify(started && { p: started.provider, s: started.sessionId }))
  const ready = await waitFor(async () => { const l = await live(); return l?.status === 'ready' ? l : null }, 60000)
  check('ready once Codex shows its prompt', !!ready, JSON.stringify(await live()))
  check('starts in Approve for me', ready?.permissionMode === 'approve-for-me', ready?.permissionMode)
  await page.screenshot({ path: path.join(scratch, 'cxh-1-ready.png') })

  // One prompt: an edit with apply_patch.
  const key = `session:${proj.toLowerCase()}#${def.id}`
  for (const ch of ['Use apply_patch to add a file notes.txt containing hi. Do nothing else.']) await inv('pty:write', key, ch)
  await sleep(400)
  await inv('pty:write', key, '\r')
  const working = await waitFor(async () => ((await live())?.status === 'working' ? true : null), 30000)
  check('prompt makes it working', !!working, (await live())?.status)
  const done = await waitFor(async () => ((await live())?.status === 'finished' ? true : null), 180000)
  check('turn finishes (Stop hook)', !!done, (await live())?.status)
  check('the patch was applied', fs.existsSync(path.join(proj, 'notes.txt')))
  // Codex names the session with its first hook (the first prompt).
  const sessionId = (await live())?.sessionId
  check('the first hook binds the session id', /^[0-9a-f-]{36}$/.test(sessionId ?? ''), sessionId)
  const recs = JSON.parse(fs.readFileSync(path.join(proj, '.hive', 'sessions.json'), 'utf8')).sessions
  const rec = recs.find((r) => r.id === sessionId)
  check('session recorded as Codex with its transcript path', rec?.agent === 'codex' && /rollout-.*\.jsonl$/.test(rec?.transcriptPath ?? ''), JSON.stringify(rec))
  // The backup tick reads the transcript for live details.
  await lib.until(async () => (await live())?.modelName === 'gpt-6-luna', 30000)
  const after = await live()
  check('live details: model from the transcript', after?.modelName === 'gpt-6-luna', after?.modelName)
  const plan = (await inv('app:planUsage')).codex
  check('plan usage from the transcript', !!plan?.limits?.length && plan.plan, JSON.stringify(plan))
  await page.screenshot({ path: path.join(scratch, 'cxh-2-finished.png') })

  const list = await inv('session:list', proj)
  const item = list.find((s) => s.id === sessionId)
  check('Sessions list: Codex session with usage', item?.provider === 'codex' && item.usage?.requests > 0 && item.usage?.contextWindow > 0, JSON.stringify(item?.usage))
  const tx = await inv('transcript:read', proj, sessionId)
  const kinds = tx.items.map((i) => i.kind)
  check('transcript: prompt, edit and reply', kinds.includes('user') && tx.items.some((i) => i.kind === 'tool' && i.tool.name === 'Edit') && kinds.includes('assistant'), kinds.join(','))

  await inv('session:setPlanMode', proj, def.id, true)
  await sleep(800)
  check('Plan mode on', (await live())?.planMode === true)
  await inv('session:setPlanMode', proj, def.id, false)
  await sleep(800)
  const r = await inv('session:setMode', proj, def.id, 'ask')
  await sleep(500)
  check('switches preset with the /permissions menu', r.ok && (await live())?.permissionMode === 'ask', JSON.stringify(r))
  await page.screenshot({ path: path.join(scratch, 'cxh-3-menu.png') })

  await inv('session:stop', proj, def.id)
  const stopped = await waitFor(async () => (!(await live()) ? true : null), 20000)
  check('stops', !!stopped)
  await sleep(1500) // A fixed wait on purpose: no condition Hive exposes says Codex's process has fully exited before the same thread is resumed.
  await inv('session:start', proj, { agentId: def.id, resumeId: sessionId })
  const resumed = await waitFor(async () => { const l = await live(); return l?.status === 'ready' ? l : null }, 60000)
  check('resumes the same conversation', resumed?.sessionId === sessionId, JSON.stringify(resumed && { s: resumed.sessionId, st: resumed.status }))
  await page.screenshot({ path: path.join(scratch, 'cxh-4-resumed.png') })
  await inv('session:stop', proj, def.id)
  await waitFor(async () => (!(await live()) ? true : null), 20000)
  await app.close()
  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
