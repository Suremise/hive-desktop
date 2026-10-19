// "The main process was busy" (#1109): a gap spanning the PC's sleep (a suspend and resume told by powerMonitor, faked
// here around a block of the main process) logs an info line, not a warning; an IPC call that holds the main process
// (HIVE_TEST_BLOCK_IPC) is named in the warning. Dev build, throwaway profile, no workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'stalls-profile')
const logFile = path.join(userData, 'logs', 'hive.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [])
const busyLines = () => lines().filter((l) => l.includes('[main] The main process was'))

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  // A warning a second at most, so one from Hive's own start doesn't hide the suite's.
  const { app, inv } = await lib.launch({ userData, env: { HIVE_TEST_STALL_QUIET_MS: '1000' } })
  try {
    // The PC sleeps: suspend, the main process held, resume.
    const before = busyLines().length
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
      for (const until = Date.now() + 1500; Date.now() < until; );
      powerMonitor.emit('resume')
    })
    const slept = await lib.until(() => busyLines().slice(before).find((l) => /\[INFO\] \[main\] The main process was paused for \d+ ms while the PC slept: not counted as busy/.test(l)), HUNG_MS)
    check('a gap spanning sleep is an info line', !!slept, busyLines().slice(before).join(' | '))
    check('and not a warning', !busyLines().slice(before).some((l) => l.includes('[WARN]')), busyLines().slice(before).join(' | '))

    // An IPC call holds the main process: the warning names it.
    const mark = busyLines().length
    await app.evaluate(() => {
      process.env.HIVE_TEST_BLOCK_IPC = 'app:info=1500*1'
    })
    await inv('app:info')
    const warned = await lib.until(() => busyLines().slice(mark).find((l) => /\[WARN\] \[main\] The main process was busy for \d+ ms/.test(l) && l.includes('ipc app:info')), HUNG_MS)
    check('a blocking IPC call is named in the warning', !!warned, busyLines().slice(mark).join(' | '))
    check('with its time and the CPU used', /ipc app:info \(\d+\.\d s\)/.test(warned ?? '') && /\(main thread CPU \d+ ms\)/.test(warned ?? ''), warned)
    if (warned) console.log(`  ${warned.trim()}`)
  } catch (e) {
    console.error(e)
    failed++
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})()
