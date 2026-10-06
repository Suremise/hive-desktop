// Stop an agent and switch workspace at once (#297). The switch stops every live session of the workspace, and the
// agent just stopped was still live (its process hadn't exited yet), so its terminal was killed a second time. On
// Windows node-pty closes the pseudoconsole a moment after a kill, and a second kill before the first had finished
// corrupted the heap: Hive's main process died, with nothing in its log (replysize's page closed this way under load).
// Twelve rounds, two agents each (one stopped just before the switch, one still working): Hive survives every switch, and
// each switch leaves no session running. Fake Claude Code; dev build, throwaway profile and workspaces, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const base = path.join(lib.WORK, 'stopswitch')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const [wsA, wsB] = ['ws-a', 'ws-b'].map((n) => path.join(base, n))
const projects = [path.join(wsA, 'alpha'), path.join(wsB, 'beta')]
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  for (const p of projects) fs.mkdirSync(p, { recursive: true })
  const env = lib.fakeClaude(userData, home, projects)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // Switching stops the agents without asking, as after the user says so.
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: lib.port(47922) } })
  let gone = null
  page.on('close', () => (gone ??= new Date().toISOString()))
  const mainPid = await app.evaluate(() => process.pid)
  const alive = () => {
    try {
      process.kill(mainPid, 0)
      return true
    } catch {
      return false
    }
  }
  const agents = {}
  const live = async (proj) => (await inv('session:list', proj)).filter((s) => s.live).length

  let rounds = 0
  try {
    for (let r = 0; r < 12; r++) {
      if (gone) break
      const proj = projects[r % 2]
      await lib.openWorkspace(inv, page, r % 2 ? wsB : wsA)
      if (r > 1) check(`round ${r}: the last switch left no session running in ${path.basename(projects[(r + 1) % 2])}`, (await live(projects[(r + 1) % 2]).catch(() => 0)) === 0)
      agents[proj] ??= [await lib.addAgent(inv, proj, { name: 'One' }), await lib.addAgent(inv, proj, { name: 'Two' })]
      const [one, two] = agents[proj]
      await inv('session:start', proj, { agentId: one.id })
      await inv('session:start', proj, { agentId: two.id })
      await lib.until(async () => (await live(proj)) === 2, 10000)
      // Stop one (Stop pressed again while it stops, as an impatient user might), and switch straight away: the switch
      // stops the other, and finds this one still live.
      await Promise.all([inv('session:stop', proj, one.id), inv('session:stop', proj, one.id), inv('session:stop', proj, one.id)])
      rounds = r + 1
    }
    if (!gone) await lib.openWorkspace(inv, page, wsA)
  } catch (e) {
    console.log(`stopped at round ${rounds}: ${String(e.message).split('\n')[0]}`)
  }
  check('Hive survives stopping an agent and switching workspace at once, twelve times', !gone && alive() && rounds === 12, JSON.stringify({ rounds, pageClosed: gone, mainAlive: alive() }))

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
