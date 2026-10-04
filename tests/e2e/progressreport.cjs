// The hive-progress wrapper in an agent's session (#137), on a fake Claude Code agent (fake-claude/) whose "shell:" step
// runs a command in cmd with the session's environment: hive-progress is on the session's PATH (Hive's bin folder
// first), passes the command's output and exit code through and takes out its step lines.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'progressreport-profile')
const ws = path.join(lib.WORK, 'progressreport-ws')
const claudeHome = path.join(lib.WORK, 'progressreport-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = 47913
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const shells = () => {
    const f = path.join(claudeHome, 'fake-shell.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  /** Has the agent run a command (as its shell would) and resolves to what it recorded. */
  const shell = async (id, cmd) => {
    const before = shells().length
    await until(async () => (await live(id))?.status !== 'working', 15000)
    await inv('pty:write', lib.ptyKey(alpha, id), `shell: ${cmd}`)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(() => shells().length > before, 30000)
    return shells()[before]
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  await inv('session:start', alpha, { agentId: builder.id })
  check('the agent starts', !!(await until(async () => (await live(builder.id))?.status === 'ready')))

  const bin = path.join(userData, 'bin')
  const where = await shell(builder.id, 'where hive-progress')
  // where lists the sh script (for Git Bash) too; cmd and PowerShell run the .cmd beside it, as with npm's pair.
  const found = (where?.stdout ?? '').trim().split(/\r?\n/).map((l) => l.toLowerCase())
  const mine = [path.join(bin, 'hive-progress'), path.join(bin, 'hive-progress.cmd')].map((f) => f.toLowerCase())
  check("hive-progress is on the session's PATH, from this Hive's bin folder first (the .cmd and the sh script)", where?.code === 0 && mine.every((f) => found.slice(0, 2).includes(f)), JSON.stringify(where))

  const run = await shell(builder.id, `hive-progress --title Demo -- node -e "console.log('hi'); console.log('##hive-progress step=1 total=2 name=one'); console.error('warn'); process.exit(3)"`)
  check("the command's output passes through, without its step lines", run?.stdout.replace(/\r/g, '') === 'hi\n' && run?.stderr.replace(/\r/g, '') === 'warn\n', JSON.stringify(run))
  check('…and its exit code', run?.code === 3, JSON.stringify(run))

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
