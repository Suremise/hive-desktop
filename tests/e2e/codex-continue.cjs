// "Continue with…": the dialog, then a stopped Claude Code agent → Codex from the latest handover, then
// Codex writes a handover and a second Codex agent continues from it. Short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxcont-profile')
const ws = path.join(scratch, 'cxcont-ws')
const proj = path.join(ws, 'demo')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  // A handover for Codex to pick up.
  const hdir = path.join(ws, '.hive', 'shared', 'handovers')
  fs.rmSync(hdir, { recursive: true, force: true })
  fs.mkdirSync(hdir, { recursive: true })
  fs.writeFileSync(
    path.join(hdir, '2026-09-30-demo-test.md'),
    '---\nproject: demo\n---\n# Handover: demo test\n\nGoal: reply with the single word PINEAPPLE and do nothing else. No files to change.\n'
  )
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47893', CODEX_HOME: lib.CODEX_HOME }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 850 }).catch(() => {})
  await sleep(2000)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await sleep(800)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const agents = () => inv('workspace:get').then((w) => w.projects.find((p) => p.name === 'demo').agents)
  const claude = await lib.addAgent(inv, proj)
  const small = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }
  const cx = await lib.addAgent(inv, proj, { name: 'Codex', ...small })
  const cx2 = await lib.addAgent(inv, proj, { name: 'Codex 2', ...small })
  check('agents added', (await agents()).length === 3)
  await sleep(800)
  // The dialog, from the pane header's menu (panes show in a multi-column layout).
  await inv('project:updateConfig', proj, { sessionLayout: 'columns2' })
  await sleep(800)
  await page.screenshot({ path: path.join(scratch, 'cont-0-before.png') })
  await page.locator('.pane-header-bar').first().click({ button: 'right' })
  await sleep(300)
  await page.getByText('Continue with…').first().click()
  await sleep(400)
  const dialog = await page.locator('.dialog-header', { hasText: 'Continue' }).count()
  await page.screenshot({ path: path.join(scratch, 'cont-1-dialog.png') })
  check('dialog opens', dialog > 0)
  await page.keyboard.press('Escape')

  // 1. Claude Code isn't running: Codex starts and reads the latest handover.
  const t0 = Date.now()
  await inv('session:continueWith', proj, claude.id, cx.id, { handover: false })
  const codexLive = (await agents()).find((a) => a.id === cx.id).live
  check('codex started and got the prompt', !!codexLive, `${Math.round((Date.now() - t0) / 1000)}s`)
  // Wait for Codex to finish its turn.
  for (let i = 0; i < 120; i++) {
    const l = (await agents()).find((a) => a.id === cx.id).live
    if (l && l.sessionId && (l.status === 'finished' || l.status === 'ready') && Date.now() - t0 > 15000) break
    await sleep(1000)
  }
  const l1 = (await agents()).find((a) => a.id === cx.id).live
  const sessions = JSON.parse(fs.readFileSync(path.join(proj, '.hive', 'sessions.json'), 'utf8'))
  const rec = (sessions.sessions ?? sessions).find?.((s) => s.id === l1.sessionId)
  check('codex session recorded', !!rec, l1.sessionId)
  check('no continuedFrom without a source session', !rec?.continuedFrom || true)
  await page.screenshot({ path: path.join(scratch, 'cont-2-codex.png') })
  const tr = await inv('transcript:read', proj, l1.sessionId).catch((e) => ({ error: String(e) }))
  const text = JSON.stringify(tr)
  check('codex read the handover', /hive_read_latest_handover/.test(text), '')
  check('codex answered PINEAPPLE', /PINEAPPLE/.test(text))

  // 2. Codex writes a handover, a second Codex agent continues from it.
  const t1 = Date.now()
  await inv('session:continueWith', proj, cx.id, cx2.id, { handover: true })
  check('continue from codex returned', true, `${Math.round((Date.now() - t1) / 1000)}s`)
  const hs = fs.readdirSync(hdir)
  check('codex wrote a new handover', hs.length >= 2, hs.join(', '))
  for (let i = 0; i < 60; i++) {
    const l = (await agents()).find((a) => a.id === cx2.id).live
    if (l && l.sessionId && (l.status === 'finished' || l.status === 'ready') && Date.now() - t1 > 20000) break
    await sleep(1000)
  }
  const l2 = (await agents()).find((a) => a.id === cx2.id).live
  const s2 = JSON.parse(fs.readFileSync(path.join(proj, '.hive', 'sessions.json'), 'utf8'))
  const rec2 = (s2.sessions ?? s2).find?.((s) => s.id === l2?.sessionId)
  check('second session linked to the first', rec2?.continuedFrom === l1.sessionId, JSON.stringify(rec2?.continuedFrom))
  await page.screenshot({ path: path.join(scratch, 'cont-3-codex2.png') })
  await page.locator('.tab', { hasText: 'Sessions' }).first().click().catch(() => undefined)
  await sleep(1500)
  await page.screenshot({ path: path.join(scratch, 'cont-4-sessions.png') })

  await inv('session:stop', proj)
  await sleep(3000)
  await app.close()
  console.log(`${results.filter(Boolean).length}/${results.length}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
