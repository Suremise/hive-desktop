// Performance → Compare (#117): import scenario benchmarks (the fixtures from a real fake run: a baseline, an
// intentional reduction, and the same reduction that broke a scenario) and see each scenario judged correctness first;
// a project's page refuses a scenario benchmark and compares its own kept views; a file of another kind isn't
// comparable and says why; a pair switched while a slow read is out shows the new pair. Screenshots at two widths in
// both themes. No agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'perfcompare-profile')
const ws = path.join(lib.WORK, 'perfcompare-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)
fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
const FIX = path.join(lib.ROOT, 'tests', 'fixtures', 'benchmarks')

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` (${extra})` : ''}`)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await inv('workspace:open', ws)
  await lib.sleep(1000)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const pageSel = '.performance-page:visible'
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `perfcompare-${name}.png`) })
  // The open dialog answered in main: the next import picks `file`.
  const picks = async (file) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, file)
  const importFile = async (file) => {
    await picks(file)
    await page.locator(`${pageSel} button`, { hasText: 'Import' }).click()
    await lib.sleep(600)
  }
  const statusOf = async (id) => (await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: id }).first().locator('.badge').innerText().catch(() => '')).trim()

  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  check('Compare starts empty and says how to begin', !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`, { hasText: 'Nothing to compare yet' }).count()) === 1)))

  await importFile(path.join(FIX, 'baseline.json'))
  await importFile(path.join(FIX, 'smaller-wrong.json'))
  check('two imports: the newest is the run, the one before it the baseline', !!(await until(async () => (await page.locator(`${pageSel} .perf-scenarios`).count()) === 1)))
  check('comparable: the same scenarios, provider and setup', (await page.locator(`${pageSel} .banner.success`, { hasText: 'Comparable' }).count()) === 1)
  check('a smaller reply that broke a scenario is "smaller but failing"', (await statusOf('card-detail')) === 'Smaller but failing', await statusOf('card-detail'))
  check('…and leads the table', (await page.locator(`${pageSel} .perf-scenarios tbody tr`).first().innerText()).includes('card-detail'))
  check('the summary counts it', /1 smaller but failing/.test(await page.locator(`${pageSel} .perf-summary`).innerText()))
  await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().click()
  check('a scenario opens to every measure, with notes', !!(await until(async () => (await page.locator(`${pageSel} .perf-detail-body`, { hasText: 'Tool replies' }).count()) === 1)) && /One sample/.test(await page.locator(`${pageSel} .perf-detail-body`).innerText()))
  await shot('failing-dark')

  await importFile(path.join(FIX, 'smaller.json'))
  await page.locator(`${pageSel} select[aria-label="Baseline"]`).selectOption({ label: 'fake, fixtures v5 (baseline)' })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller replies)' })
  check('the intentional reduction: "smaller, still correct"', !!(await until(async () => (await statusOf('card-detail')) === 'Smaller, still correct')), await statusOf('card-detail'))
  await shot('better-dark')

  // A pair switched while a slow read is out: the new pair is what shows.
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = 'benchmarks:read=2000*2'
  })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller but wrong)' })
  await lib.sleep(200)
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = ''
  })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller replies)' })
  await lib.sleep(3000)
  check("a pair switched during a slow read shows the new pair, not the old one's late answer", (await statusOf('card-detail')) === 'Smaller, still correct', await statusOf('card-detail'))
  check('the choice is remembered for the scope', (await inv('benchmarks:list', { kind: 'workspace' })).run !== null)
  check('the table shows the checks themselves: passed and skipped, baseline → run', /4✓ 1– → 4✓ 1–/.test(await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().innerText()), await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().innerText())
  check('what each side is, provider and fixtures, is shown', /Fake fake, fixtures v5/.test(await page.locator(`${pageSel} .perf-pair`).innerText()))
  check('the live range and filters are hidden while comparing (they only shape Keep current view)', (await page.locator(`${pageSel} select[aria-label="Who did the work"]`).count()) === 0 && (await page.locator(`${pageSel} .segmented[aria-label="Time range"]`).count()) === 0)

  // The workspace's own work is its own scope: the whole workspace's benchmarks aren't shown as its own.
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Workspace’s own work' })
  check("the workspace's own work lists none of the whole workspace's", !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`).count()) === 1 && (await page.locator(`${pageSel} .perf-scenarios`).count()) === 0)))
  await importFile(path.join(FIX, 'baseline.json'))
  check('…and refuses a scenario benchmark there, saying why', !!(await until(async () => (await page.locator('.toast', { hasText: 'not the workspace’s own work' }).count()) >= 1)))
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Whole workspace' })
  await until(async () => (await page.locator(`${pageSel} .perf-scenarios`).count()) === 1)

  // A Performance export against a scenario benchmark: not comparable, and why.
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Now' }).click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  await page.locator(`${pageSel} button`, { hasText: 'Keep current view' }).click()
  await page.locator('.dialog input.input').first().fill('Today, whole workspace')
  await page.locator('.dialog .btn.primary').click()
  await lib.sleep(800)
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'Today, whole workspace' })
  check('an export against a benchmark is not comparable, and says why', !!(await until(async () => /measure different things/.test(await page.locator(`${pageSel} .banner.warn`).innerText().catch(() => '')))))

  // A project's page: a scenario benchmark is refused; its own kept views compare.
  await page.locator('.activitybar button[aria-label="Projects"]').click()
  await page.locator('.sidebar .row', { hasText: 'alpha' }).first().click()
  await page.locator('.tab', { hasText: 'Performance' }).click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  check("a project's Compare lists none of the workspace's", !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`).count()) === 1)))
  await importFile(path.join(FIX, 'baseline.json'))
  check('…and refuses a scenario benchmark, saying where it belongs', !!(await until(async () => (await page.locator('.toast, .notification', { hasText: 'not one of your projects' }).count()) >= 1)))
  for (const label of ['Before', 'After']) {
    await page.locator(`${pageSel} button`, { hasText: 'Keep current view' }).click()
    await page.locator('.dialog input.input').first().fill(label)
    await page.locator('.dialog .btn.primary').click()
    await lib.sleep(800)
  }
  check("…its own kept views compare, per hour recorded", !!(await until(async () => (await page.locator(`${pageSel} .perf-comparison table`).count()) === 1)))
  const alphaList = await inv('benchmarks:list', { kind: 'project', project: 'alpha' })
  check('…kept for alpha only', alphaList.entries.length === 2 && alphaList.entries.every((e) => e.scope.kind === 'project'), JSON.stringify(alphaList.entries.map((e) => e.scope)))
  await shot('project-dark')

  // Light, and narrow.
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller but wrong)' })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(800)
  await shot('failing-light')
  await lib.fitWindow(app, page, { width: 720, height: 900 })
  await lib.sleep(800)
  const overflow = await page.locator(pageSel).evaluate((el) => el.scrollWidth - el.clientWidth)
  check('narrow: the page itself has no sideways scroll', overflow <= 1, String(overflow))
  await shot('narrow-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
