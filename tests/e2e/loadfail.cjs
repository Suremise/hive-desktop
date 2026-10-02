// A failed load says so, with Retry, instead of looking like an empty result: the Sessions tab's search, the
// project's Skills tab and the Workspace Overview (first load, and a refresh over the last figures). Uses the
// test-only HIVE_TEST_FAIL_IPC (unpackaged builds), set in the main process as each step needs it.
// No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'loadfail-profile')
const ws = path.join(lib.WORK, 'loadfail-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n' })
  lib.enableProviders(userData)

  const env = { ...process.env, HIVE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.sleep(1500)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  // Each call to fail (a new value each time: the same one again isn't read as a change).
  let round = 0
  const failNext = (channel) => app.evaluate((_e, v) => (process.env.HIVE_TEST_FAIL_IPC = v), `${channel}*1,round${++round}`)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }
  const text = (sel) => page.locator(sel).first().innerText().catch(() => '')
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Sessions tab: a failed search isn't "No matches".
  await page.locator('.tab', { hasText: 'Sessions' }).click()
  await page.locator('.sessions-scope button', { hasText: 'All sessions' }).click()
  await failNext('transcript:search')
  await page.locator('.files-filter input').fill('needle')
  const failedBox = page.locator('.load-failed')
  check('search: a failure shows the error with Retry', !!(await until(async () => /Could not load the search results: .*failed/.test(await text('.load-failed')))))
  check('search: no "No matches" for a failure', !/No matches/.test(await text('.sessions-scope')))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-1-search.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('search: Retry searches again (a real empty result)', !!(await until(async () => (await failedBox.count()) === 0 && /No matches/.test(await text('.sessions-scope')))))

  // --- Skills tab: a failed read isn't "no skills"; Retry loads them without reopening the tab.
  await failNext('skills:list')
  await page.locator('.tab', { hasText: 'Skills' }).click()
  check('skills: a failure shows the error with Retry', !!(await until(async () => /Could not load the skills: .*failed/.test(await text('.load-failed')))))
  check('skills: no empty groups for a failure', (await page.locator('.skill-group').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-2-skills.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('skills: Retry loads them', !!(await until(async () => (await failedBox.count()) === 0 && (await page.locator('.skill-group').count()) > 0)))
  // A refresh that fails keeps the list, with a note.
  await failNext('skills:list')
  await page.locator('.split-list .pane-header').getByRole('button', { name: 'Refresh' }).click()
  check('skills: a failed refresh keeps the list, with a note', !!(await until(async () => /Could not refresh the skills/.test(await text('.load-stale')) && (await page.locator('.skill-group').count()) > 0)))
  await page.locator('.load-stale').getByRole('button', { name: 'Retry' }).click()
  check('skills: Retry clears the note', !!(await until(async () => (await page.locator('.load-stale').count()) === 0)))

  // --- Workspace Overview: a failed first load isn't a spinner forever.
  await failNext('workspace:usage')
  await page.keyboard.press('Control+Shift+O')
  check('overview: a failure shows the error with Retry', !!(await until(async () => /Could not load the workspace's usage: .*failed/.test(await text('.load-failed')))))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-3-overview.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('overview: Retry loads it', !!(await until(async () => (await failedBox.count()) === 0 && /Summary/.test(await text('.overview-head')))))
  // A failed refresh keeps the figures, with when they're from.
  await failNext('workspace:usage')
  await page.locator('.overview-head').getByRole('button', { name: 'Refresh' }).click()
  check('overview: a failed refresh keeps the figures, with a note', !!(await until(async () => /Could not refresh the usage; last updated \d/.test(await text('.load-stale')) && (await page.locator('.cards').count()) > 0)))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-4-stale.png') })
  await page.locator('.load-stale').getByRole('button', { name: 'Retry' }).click()
  check('overview: Retry clears the note', !!(await until(async () => (await page.locator('.load-stale').count()) === 0)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
