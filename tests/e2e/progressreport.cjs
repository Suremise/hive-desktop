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
  /** Has the agent start a command (as its shell would); resolves to a wait for what it recorded. */
  const startShell = async (id, cmd, ms = 30000) => {
    const before = shells().length
    await until(async () => (await live(id))?.status !== 'working', 15000)
    await inv('pty:write', lib.ptyKey(alpha, id), `shell: ${cmd}`)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    return async () => {
      await until(() => shells().length > before, ms)
      return shells()[before]
    }
  }
  const shell = async (id, cmd, ms) => (await startShell(id, cmd, ms))()
  const runs = () => inv('progress:list')
  const newRun = async (known, match) => until(async () => (await runs()).find((r) => !known.includes(r.id) && match(r)), 60000)

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
  const demo = (await runs()).find((r) => r.title === 'Demo')
  check('the run was reported as the agent, and failed with its exit code', demo?.agentName === 'Builder' && demo?.state === 'failed' && demo?.summary === 'exit code 3', JSON.stringify(demo))

  // --- An Electron app run through either shim starts as an app (the shims run hive-progress with Hive's executable as
  // Node; that setting isn't passed on to the command).
  const electronApp = path.join(lib.WORK, 'progressreport-electron-app.cjs')
  fs.writeFileSync(electronApp, "let app = null\ntry { app = require('electron').app } catch {}\nif (!app) { console.log('BROKEN: running as Node'); process.exit(23) }\napp.whenReady().then(() => { console.log('OK: Electron app'); app.exit(0) })\n")
  const viaCmd = await shell(builder.id, `hive-progress -- "${lib.ELECTRON}" "${electronApp}"`)
  check('an Electron app through hive-progress (cmd, the .cmd shim) starts as an app', viaCmd?.code === 0 && viaCmd?.stdout.trim() === 'OK: Electron app', JSON.stringify(viaCmd))
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (fs.existsSync(gitBash)) {
    const posix = (p) => p.replace(/\\/g, '/')
    const viaBash = await shell(builder.id, `"${gitBash}" -c "hive-progress -- '${posix(lib.ELECTRON)}' '${posix(electronApp)}'"`)
    check('…and through Git Bash (the sh shim)', viaBash?.code === 0 && viaBash?.stdout.trim() === 'OK: Electron app', JSON.stringify(viaBash))
  } else console.log('(no Git Bash: the sh shim not checked here)')

  // --- In the Progress panel while it runs: the agent's name, the title and its steps.
  await page.locator('.xterm').first().click().catch(() => undefined)
  await page.keyboard.press('Control+Alt+P')
  const panel = page.locator('.progress-panel')
  check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1)))
  let known = (await runs()).map((r) => r.id)
  const stepped = await startShell(builder.id, `hive-progress --title "Stepped demo" -- node -e "console.log('##hive-progress step=1 total=3 name=alpha'); setTimeout(() => console.log('##hive-progress step=2 name=beta'), 2500); setTimeout(() => process.exit(0), 6000)"`)
  const live1 = await newRun(known, (r) => r.title === 'Stepped demo')
  const row = panel.locator(`.progress-run[data-run="${live1?.id}"]`)
  const rowText = async () => (await row.textContent().catch(() => '')) ?? ''
  check('the panel shows the run with the agent, its title and its first step', !!live1 && !!(await until(async () => /Builder/.test(await rowText()) && /Stepped demo/.test(await rowText()) && /1 of 3: alpha/.test(await rowText()), 10000)), await rowText())
  check('…then its next step', !!(await until(async () => /2 of 3: beta/.test(await rowText()), 10000)), await rowText())
  await page.screenshot({ path: path.join(lib.WORK, 'progressreport-panel.png') })
  const end1 = await stepped()
  check('…and it passes', end1?.code === 0 && (await until(async () => (await runs()).find((r) => r.id === live1?.id)?.state === 'passed', 10000)), JSON.stringify(end1))

  // --- Hive's own runners in an agent's session: shown in this Hive's panel as the agent's, with steps and estimates.
  const root = lib.ROOT
  const unitCmd = `cd /d "${root}" && npx vitest run tests/tips.test.ts tests/e2esuites.test.ts`
  known = (await runs()).map((r) => r.id)
  const unit1 = await shell(builder.id, unitCmd, 120000)
  const u1 = (await runs()).find((r) => !known.includes(r.id) && /^unit: 2 files$/.test(r.title))
  check('npm test reports "unit: 2 files", a step per file, as the agent', unit1?.code === 0 && u1?.agentName === 'Builder' && u1?.total === 2 && u1?.step === 2 && u1?.state === 'passed', JSON.stringify({ code: unit1?.code, u1 }))
  known = (await runs()).map((r) => r.id)
  await shell(builder.id, unitCmd, 120000)
  const u2 = (await runs()).find((r) => !known.includes(r.id) && /^unit: 2 files$/.test(r.title))
  check('…and the next time, with an estimate', u2?.estimateMs > 0, JSON.stringify(u2))
  known = (await runs()).map((r) => r.id)
  const off = await shell(builder.id, `set HIVE_PROGRESS=0&& ${unitCmd}`, 120000)
  await lib.sleep(1500)
  check('HIVE_PROGRESS=0: the tests run, nothing is reported', off?.code === 0 && (await runs()).every((r) => known.includes(r.id)), JSON.stringify((await runs()).filter((r) => !known.includes(r.id))))

  known = (await runs()).map((r) => r.id)
  const e2e = await shell(builder.id, `cd /d "${root}" && node tests/e2e/run.mjs about`, 180000)
  const e1 = (await runs()).find((r) => !known.includes(r.id) && r.title === 'e2e: 1 suite')
  check('npm run e2e reports "e2e: 1 suite" as the agent, with its step and the estimate from earlier runs', e2e?.code === 0 && e1?.agentName === 'Builder' && e1?.total === 1 && e1?.state === 'passed' && e1?.estimateMs > 0, JSON.stringify({ code: e2e?.code, out: e2e?.stdout?.slice(-300), e1 }))
  check('…and its output is the runner\'s usual', /about\s+pass/.test(e2e?.stdout ?? '') && /1 passed, 0 failed, 0 skipped/.test(e2e?.stdout ?? ''), e2e?.stdout)
  check('only those runs: the test Hive the suite started reported nothing here', (await runs()).filter((r) => !known.includes(r.id)).length === 1, JSON.stringify((await runs()).filter((r) => !known.includes(r.id))))

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
