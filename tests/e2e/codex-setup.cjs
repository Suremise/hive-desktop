// The Codex sandbox "Set up" task: Hive opens Codex in a task terminal and types /setup-default-sandbox.
// Only looks at the menu Codex shows; never chooses an option (the admin one needs the user).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxsetup-profile')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData, ['codex'])
  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: '47890', CODEX_HOME: lib.CODEX_HOME }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 850 }).catch(() => {})
  await sleep(3000)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const key = await inv('provider:task', 'codex', 'setup')
  check('setup task starts', key === 'task:codex:setup', key)
  let text = ''
  for (let i = 0; i < 40 && !/sandbox/i.test(text); i++) {
    await sleep(1000)
    text = (await inv('pty:buffer', key)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ')
  }
  check('Codex opened without a trust prompt', !/Trust this folder/.test(text))
  check('Hive typed /setup-default-sandbox and Codex shows its setup menu', /Set up default sandbox|non-admin sandbox|setup-default-sandbox/i.test(text), text.slice(-400))
  await inv('pty:kill', key)
  await sleep(1500)
  await app.close()
  console.log(results.join('\n'))
  console.log('TAIL:', text.slice(-600))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
