// Claude Code's agent view stays off in Hive's sessions: ← on an empty prompt must not move the session into
// Claude Code's background service (where Hive can't see or stop it). Throwaway profile and workspace; no prompt
// is sent. If a background job appears anyway, it is stopped and removed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const userData = path.join(lib.WORK, 'agentview-profile')
const ws = path.join(lib.WORK, 'agentview-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  lib.enableProviders(userData, ['claude-code'])
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47894' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1200, height: 750 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(800)
  const settings = await inv('settings:get')
  check('background sessions are off by default', settings.providers['claude-code'].allowBackgroundSessions === false)
  const agent = await lib.soloAgent(inv, proj)
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  const t0 = Date.now()
  while (Date.now() - t0 < 25000 && (await inv('session:live'))[0]?.status !== 'ready') await lib.sleep(300)
  const live = (await inv('session:live'))[0]
  check('session ready', live?.status === 'ready', live?.status)
  const claude = live?.executable || path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe')
  const jobs = () => {
    try {
      return JSON.parse(execFileSync(claude, ['agents', '--json'], { encoding: 'utf8' })).filter((j) => j.kind === 'background' && j.cwd.toLowerCase() === proj.toLowerCase())
    } catch {
      return []
    }
  }
  await lib.sleep(2000)
  await inv('pty:write', lib.ptyKey(proj, agent.id), '\x1b[D')
  await lib.sleep(6000)
  const left = jobs()
  check('← on an empty prompt keeps the session in Hive', left.length === 0, JSON.stringify(left))
  check('the session is still running in Hive', (await inv('session:live'))[0]?.status === 'ready')
  for (const j of left) {
    try {
      execFileSync(claude, ['stop', j.id])
      execFileSync(claude, ['rm', j.id])
    } catch {
      // best effort
    }
  }
  await inv('session:stop', proj)
  await lib.sleep(1500)
  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
