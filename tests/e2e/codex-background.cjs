// Codex's background terminals: a command Codex leaves running when its turn ends is counted, Codex stays finished
// (it isn't told when the command ends, so it never carries on by itself), and the count drops when it ends.
// Test CODEX_HOME, throwaway profile and workspace. One short prompt on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'cxbg-profile')
const ws = path.join(lib.WORK, 'cxbg-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!lib.codexSignedIn()) {
    console.log('SKIP Codex is not signed in to the test home')
    process.exit(0)
  }
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47897', CODEX_HOME: lib.CODEX_HOME }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.sleep(2000)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(800)
  await page.getByText('demo', { exact: true }).first().click()
  await lib.addAgent(inv, proj, { name: 'Codex', provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
  const agent = (await inv('workspace:get')).projects.find((p) => p.name === 'demo').agents.find((a) => a.name === 'Codex')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
  const seen = new Set()
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    for (;;) {
      const s = await live()
      if (s) seen.add(s.status)
      if ((v = await fn(s)) || Date.now() - t > ms) return v
      await lib.sleep(700)
    }
  }

  await inv('session:start', proj, { agentId: agent.id })
  check('Codex starts', !!(await until((s) => s?.status === 'ready', 60000)))
  const key = lib.ptyKey(proj, agent.id)
  const prompt =
    "Call exec_command once with cmd \"Start-Sleep -Seconds 40; Set-Content -Path bg-done.txt -Value done\" and yield_time_ms 1000. It will return a session id while the command keeps running: do not wait for it, poll it or call write_stdin. Reply with the single word STARTED and end your turn."
  // Typed the way Hive types prompts (a long text at once is a paste to Codex, and Enter then adds a line).
  for (let i = 0; i < prompt.length; i += 8) {
    await inv('pty:write', key, prompt.slice(i, i + 8))
    await lib.sleep(15)
  }
  await lib.sleep(1000)
  await inv('pty:write', key, '\r')
  const ended = await until((s) => s?.status === 'finished' && s, 120000)
  const t0 = Date.now()
  check('its turn ends: finished, not background (Codex is never told)', ended?.status === 'finished', JSON.stringify(ended && { status: ended.status }))
  const counted = await until((s) => s?.backgroundTasks === 1 && s, 10000)
  check('the running command is counted', counted?.backgroundTasks === 1, JSON.stringify(ended && { tasks: ended.backgroundTasks }))
  seen.clear()
  await page.screenshot({ path: path.join(lib.WORK, 'codex-background.png') })

  // The command ends about 40 s after it started: the count drops, and Codex doesn't start a turn of its own.
  const done = await until((s) => !s?.backgroundTasks && fs.existsSync(path.join(proj, 'bg-done.txt')) && s, 90000)
  check('the count drops when the command ends', !!done && !done.backgroundTasks, JSON.stringify(done && { tasks: done.backgroundTasks, file: fs.existsSync(path.join(proj, 'bg-done.txt')) }))
  await until(() => Date.now() - t0 > 60000, 30000)
  const after = await live()
  check('Codex stayed finished: no turn of its own when the command ended', after?.status === 'finished' && !seen.has('working'), JSON.stringify({ status: after?.status, seen: [...seen] }))

  await inv('session:stop', proj, agent.id).catch(() => undefined)
  await lib.sleep(1500)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
