// Codex: /compact, image paste (fake clipboard in the app only) and the "Ask me" file lock.
// Test CODEX_HOME (codex-home.cjs), throwaway profile, the scratch workspace. A few short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const http = require('http')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxextra-profile')
const ws = path.join(scratch, 'cxextra-ws')
const proj = path.join(ws, 'demo')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}
const post = (url, token, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let t = ''
      res.on('data', (d) => (t += d))
      res.on('end', () => resolve({ status: res.statusCode, body: t }))
    })
    req.on('error', reject)
    req.end(data)
  })
;(async () => {
  fs.rmSync(ws, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47894', CODEX_HOME: lib.CODEX_HOME }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await sleep(2000)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await sleep(800)
  await inv('project:updateConfig', proj, { layouts: ['columns2'], fileLocks: 'ask' })
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const agents = () => inv('workspace:get').then((w) => w.projects.find((p) => p.name === 'demo').agents)
  for (const name of ['Codex', 'Codex 2']) await lib.addAgent(inv, proj, { name, provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
  const codex = (await agents()).filter((a) => a.provider === 'codex')
  const [a1, a2] = codex
  check('two codex agents', codex.length >= 2)
  const live = async (id) => (await agents()).find((a) => a.id === id).live
  const waitFor = async (id, test, ms) => {
    const t = Date.now()
    for (;;) {
      const l = await live(id)
      if (test(l)) return l
      if (Date.now() - t > ms) return l
      await sleep(700)
    }
  }
  const text = async (id) => (await inv('pty:buffer', `session:${proj.toLowerCase()}#${id}`).catch(() => '')).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ')

  // --- Compact
  await inv('session:start', proj, { agentId: a1.id })
  await waitFor(a1.id, (l) => l?.status === 'ready', 60000)
  await inv('project:updateConfig', proj, { allowSessionInput: true }).catch(() => undefined)
  await sleep(1000)
  // A first turn, so there is something to compact.
  const key1 = `session:${proj.toLowerCase()}#${a1.id}`
  const type = async (key, t) => {
    await inv('pty:write', key, t)
    await sleep(400)
    await inv('pty:write', key, '\r')
  }
  await type(key1, 'Reply with the single word READY.')
  let l = await waitFor(a1.id, (x) => x?.sessionId && x.status === 'finished', 90000)
  check('first turn finished', l?.status === 'finished', l?.status)
  const before = await inv('session:usage', proj, l.sessionId).catch(() => null)
  await inv('session:compact', proj, undefined, a1.id)
  const sawCompacting = await waitFor(a1.id, (x) => /Compacting/i.test(x?.statusMessage ?? ''), 10000)
  check('status shows Compacting', /Compacting/i.test(sawCompacting?.statusMessage ?? ''), sawCompacting?.statusMessage)
  l = await waitFor(a1.id, (x) => !/Compacting/i.test(x?.statusMessage ?? '') && (x?.status === 'ready' || x?.status === 'finished'), 180000)
  check('compaction ends', !/Compacting/i.test(l?.statusMessage ?? ''), `${l?.status} ${l?.statusMessage ?? ''}`)
  await sleep(3000)
  const after = await inv('session:usage', proj, l.sessionId).catch(() => null)
  check('usage records the compaction', (after?.compactions?.length ?? 0) > (before?.compactions?.length ?? 0), JSON.stringify(after?.compactions))
  await page.screenshot({ path: path.join(scratch, 'cxe-1-compact.png') })

  // --- Image paste: a fake clipboard in the app; the real one is never touched.
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 120 } })
  await app.evaluate(async ({ clipboard }, b64) => {
    const bytes = Buffer.from(b64, 'base64')
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([bytes], { type: 'image/png' }) }]
  }, png.toString('base64'))
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => undefined } }))
  // The first Codex agent's pane is the left-hand column.
  await page.mouse.click(600, 650)
  await sleep(300)
  await page.keyboard.press('Control+V')
  await sleep(2500)
  const t1 = await text(a1.id)
  const imgDir = path.join(proj, '.hive', 'images', l.sessionId)
  const saved = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []
  check('image saved under the session', saved.length > 0, saved.join(','))
  check('Codex shows the pasted image', /\[Image|image #|\.png/i.test(t1.slice(-600)), t1.slice(-300))
  await page.screenshot({ path: path.join(scratch, 'cxe-2-image.png') })
  await inv('pty:write', key1, '\x15')
  await sleep(500)

  // --- "Ask me" lock: agent 2 holds notes.txt (a claim made through the hook server), agent 1 edits it.
  await inv('session:start', proj, { agentId: a2.id })
  const l2 = await waitFor(a2.id, (x) => x?.status === 'ready', 60000)
  // The token isn't in the log (Hive hides it): read it from agent 2's Codex command line.
  const hook = lib.codexHook(l2.runId)
  const m = hook ? [null, hook.token, hook.url] : null
  check('hook url and token found', !!m)
  const claim = await post(`${m[2]}?run=${l2.runId}`, m[1], {
    hook_event_name: 'PreToolUse',
    session_id: l2.sessionId || 'pending',
    cwd: proj,
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: notes.txt\n@@\n+claimed\n*** End Patch' }
  })
  check('agent 2 claims notes.txt', claim.status === 200, `${claim.status} ${claim.body}`)
  await sleep(800)
  const held = (await live(a2.id))?.lockedFiles ?? []
  check('lock shows on agent 2', held.some((f) => /notes\.txt$/i.test(f)), JSON.stringify(held))
  await type(key1, 'Use apply_patch to add the line "from agent 1" at the end of notes.txt. Do nothing else.')
  const w = await waitFor(a1.id, (x) => x?.status === 'finished' || x?.status === 'waiting', 120000)
  await page.screenshot({ path: path.join(scratch, 'cxe-3-lock-ask.png') })
  const notes0 = fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8')
  check('the locked edit is held back', !/from agent 1/.test(notes0), `${w?.status}`)
  console.log('TERMINAL TAIL:', (await text(a1.id)).slice(-400))
  const allow = page.locator('.toast', { hasText: 'wants to edit notes.txt' }).getByRole('button', { name: 'Allow' })
  check('Hive asks with an Allow button', (await allow.count()) > 0)
  await allow.first().click().catch(() => undefined)
  await waitFor(a1.id, (x) => x?.status === 'working', 20000)
  const w2 = await waitFor(a1.id, (x) => x?.status === 'finished' || x?.status === 'waiting', 120000)
  const notes1 = fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8')
  check('after Allow, Codex makes the edit', /from agent 1/.test(notes1), `${w2?.status}`)
  await page.screenshot({ path: path.join(scratch, 'cxe-4-allowed.png') })
  fs.writeFileSync(path.join(proj, 'notes.txt'), notes0)
  // Decline: Esc interrupts.
  await inv('pty:write', key1, '\x1b')
  await sleep(2000)

  await inv('session:stop', proj)
  await sleep(3000)
  await app.close()
  console.log(`${results.filter(Boolean).length}/${results.length}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
