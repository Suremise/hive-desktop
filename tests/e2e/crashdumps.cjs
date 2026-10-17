// Why Hive stopped (#985): a normal quit logs each step of its way out, with the caller; a crash of the window's page
// and of the main process each leave a crash dump in the profile (never uploaded) and the page's a log line; the next
// start logs the dumps and Copy Diagnostics names the newest. Crashes only this test copy: its page by loading
// chrome://crash, its main process by process.crash() in it, and anything left of it is ended by its own pid and start
// time (lib.identify), never by name. Dev build, throwaway profile, no workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'crashdumps-profile')
const reports = path.join(userData, 'Crashpad', 'reports')
const logFile = path.join(userData, 'logs', 'hive.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const dumps = () => (fs.existsSync(reports) ? fs.readdirSync(reports).filter((f) => f.toLowerCase().endsWith('.dmp')) : [])
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
/** The log since the last start: this run's lines. */
const thisRun = () => {
  const text = logText()
  const at = text.lastIndexOf('] Hive ')
  return at < 0 ? '' : text.slice(text.lastIndexOf('\n', at) + 1)
}
const has = (text, re) => re.test(text)

// Playwright gives up on a page whose renderer crashed (it throws "Target crashed" from its connection), and on an app
// whose main process went; neither is this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target crashed|Target page, context or browser has been closed|has been closed/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  let current = null
  const identities = []
  const start = async () => {
    current = await lib.launch({ userData })
    identities.push(...lib.identify([current.app.process().pid]))
    return current
  }
  try {
    // A normal quit: each step of it, and who asked.
    {
      const { app, inv } = await start()
      check('a fresh profile has no crash dumps', dumps().length === 0, dumps().join(', '))
      const quitting = await lib.quitWatch(app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits', !!(await quitting.gone(HUNG_MS)), quitting.timings(Date.now()))
      const run = thisRun()
      for (const [what, re] of [
        ['before-quit', /\[exit\] before-quit/],
        ['the call, with its caller', /\[exit\] Leaving by app\.quit: quitting/],
        ['will-quit', /\[exit\] will-quit/],
        ['quit, with its exit code', /\[exit\] quit \(exit code 0\)/],
        ["the process's exit", /\[exit\] The main process is exiting \(exit code 0\)/]
      ]) check(`a normal quit logs ${what}`, has(run, re), run.split('\n').filter((l) => l.includes('[exit]')).join(' | '))
      current = null
    }

    // The window's page crashes: a dump and a line; Hive reloads it.
    {
      const { app } = await start()
      await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].webContents.loadURL('chrome://crash').catch(() => undefined))
      check("the page's crash leaves a crash dump", !!(await lib.until(() => dumps().length === 1, HUNG_MS)), `${dumps().length} dump(s)`)
      check("the page's crash is logged with its reason", !!(await lib.until(() => /\[exit\] A page's process went \(crashed, exit code/.test(thisRun()), HUNG_MS)))

      // The main process crashes: a dump, and no quit in the log.
      const before = dumps().length
      const proc = app.process()
      const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
      await app.evaluate(() => process.crash()).catch(() => undefined)
      check('the main process ends', await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), HUNG_MS))]))
      check("the main process's crash leaves a crash dump", !!(await lib.until(() => dumps().length === before + 1, HUNG_MS)), `${dumps().length} dump(s)`)
      check('a crash logs no quit', !has(thisRun(), /\[exit\] (before-quit|will-quit|quit \()/))
      current = null
    }

    // The next start logs them, and Copy Diagnostics names the newest.
    {
      const { app, inv } = await start()
      check('the next start logs the dumps', !!(await lib.until(() => /\[exit\] 2 crash dump\(s\) in the profile; the newest from \d{4}-/.test(thisRun()), HUNG_MS)))
      const report = await inv('app:diagnostics')
      check('Copy Diagnostics names the newest dump', /### Crash dumps\n\n- 2 in `[^`]*Crashpad\\reports`; the newest from [^:]+:[^`]*`[\w-]+\.dmp`/.test(report), report.slice(report.indexOf('### Crash dumps'), report.indexOf('### Crash dumps') + 300))
      check('and says they are never sent', /Hive never sends them/.test(report))
      const quitting = await lib.quitWatch(app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits again', !!(await quitting.gone(HUNG_MS)))
      current = null
    }
  } catch (e) {
    check('no unexpected error', false, e?.stack ?? String(e))
  } finally {
    if (current) await current.app.close().catch(() => undefined)
    // Anything left of a copy this suite started, by its own pid and start time only.
    for (const id of identities) lib.endTreeExactly(id)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
