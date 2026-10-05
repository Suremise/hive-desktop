// Performance: the activity bar's view and a project's tab, from a known saved metrics file (no agent is started).
// Ranges and their trend, the scope (whole workspace, the workspace's own work, one project) and role filters, a
// project's tab holding only its project, reading it adds nothing, a scope switched while a slow query is still out
// (the late reply isn't shown), the empty and not-recording states, Export (plain and sanitized) and screenshots at
// two widths in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'performance-profile')
const ws = path.join(lib.WORK, 'performance-ws')
const out = path.join(lib.WORK, 'performance-export.json')
for (const d of [userData, ws, out]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)
for (const p of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(ws, p), { recursive: true })

const HOUR = 3_600_000
const BOUNDS = 14
const timed = (count, ms) => {
  const histogram = Array(BOUNDS).fill(0)
  // 1, 2, 5, 10, 20, 50, 100, 200, 500 ms…: put each in its bucket.
  const bounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
  const i = bounds.findIndex((b) => ms <= b)
  histogram[i < 0 ? BOUNDS - 1 : i] = count
  return { count, totalMs: count * ms, maxMs: ms, histogram }
}
const apiSeries = (route, role, outcome, count, ms = 8) => ({ route, method: route.includes(':n') ? 'GET' : 'GET', role, outcome, ...timed(count, ms), requestBytes: count * 20, responseBytes: count * 900 })
const mcpSeries = (tool, count, chars) => ({ tool, role: 'agent', mode: 'compact', outcome: 'ok', ...timed(count, 4), chars: count * chars, bytes: count * chars })
const launch = (provider, launches) => ({ provider, role: 'agent', launches, guidanceBytes: launches * 3000, guidanceChars: launches * 3000, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, personaBytes: 0, personaChars: 0, skills: launches * 6, skillCatalogBytes: launches * 1200, skillBytes: launches * 40000, skillsNotDelivered: 0, skillsUnmeasured: 0 })
const part = (api = [], mcp = [], guidance = []) => ({ api: Object.fromEntries(api.map((s, i) => [String(i), s])), mcp: Object.fromEntries(mcp.map((s, i) => [String(i), s])), guidance: Object.fromEntries(guidance.map((s, i) => [String(i), s])), catalog: {} })
const now = Date.now()
const hourStart = (t) => Math.floor(t / HOUR) * HOUR
const bucket = (start, projects, workspace = part()) => ({ start, span: 'hour', projects, workspace, skills: { scans: timed(3, 40), sharedScans: 1, hits: 30, misses: 4, invalidations: 1, tooLarge: 0, files: 40, bytes: 120000, headerBytes: 4000, entries: 60 }, dropped: 0, droppedBy: {} })
// The last 24 hours: alpha 30 requests (3 failed), beta 12, the workspace's own 5 (scripts); 3 days ago alpha 100 more.
const buckets = [
  bucket(hourStart(now - 3 * 24 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 100)]) }),
  bucket(hourStart(now - 5 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 20), apiSeries('/v1/tasks/:n', 'agent', 'server-error', 3, 300)], [mcpSeries('hive_list_tasks', 10, 600), mcpSeries('hive_read_task', 4, 2500)], [launch('claude-code', 2)]) }),
  bucket(hourStart(now - 1 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 7)]), beta: part([apiSeries('/v1/tasks', 'agent', 'ok', 12)], [mcpSeries('hive_list_tasks', 2, 600)], [launch('codex', 1)]) }, part([apiSeries('/v1/tasks', 'api', 'ok', 5)]))
]
fs.mkdirSync(path.join(ws, '.hive', 'metrics'), { recursive: true })
// One loss Hive couldn't attribute to a project (its bookkeeping was full), in alpha's hour.
Object.assign(buckets[1], { dropped: 1, droppedBy: { '\u0000untracked': 1 } })
// Observed: around the older work, then the last day with a 4-hour gap (Hive closed) 10 to 6 hours ago.
const observed = [
  [now - 3 * 24 * HOUR - HOUR, now - 3 * 24 * HOUR + 2 * HOUR],
  [now - 26 * HOUR, now - 10 * HOUR],
  [now - 6 * HOUR, now - 60_000]
]
fs.writeFileSync(path.join(ws, '.hive', 'metrics', 'metrics.json'), JSON.stringify({ version: 1, buckets, observed, evictedThrough: now - 5 * 24 * HOUR }))

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` (${extra})` : ''}`)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const card = (title) => page.locator('.performance-page:visible .card', { hasText: title }).first().locator('.value')
  const requests = () => card('API requests').innerText().catch(() => '')
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `performance-${name}.png`) })
  // Export: the save dialog answered in main, to a test path; each export read back.
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, out)
  const exported = async (modifiers = []) => {
    fs.rmSync(out, { force: true })
    await page.locator('.performance-page:visible button', { hasText: 'Export' }).click({ modifiers })
    const text = await until(async () => fs.existsSync(out) && fs.readFileSync(out, 'utf8'))
    return text ? { text, json: JSON.parse(text) } : null
  }
  const trendRequests = (e) => e.json.report.trend.reduce((n, p) => n + p.requests, 0)

  await page.locator('.activitybar button[aria-label="Performance"]').click()
  check('the activity bar opens Performance', !!(await until(async () => (await page.locator('.performance-page:visible h1', { hasText: 'Performance' }).count()) === 1)))
  check('24 hours by default: the workspace is every project and its own work', !!(await until(async () => (await requests()) === '47')), await requests())
  const bars = page.locator('.perf-trend .daily-col')
  check('an hourly trend with every hour of the range', (await bars.count()) === 25, String(await bars.count()))
  check('the tools table is sorted by characters', (await page.locator('.table-wrap').first().locator('tbody tr td:first-child').allInnerTexts()).join() === 'hive_read_task,hive_list_tasks', (await page.locator('.table-wrap').first().locator('tbody tr td:first-child').allInnerTexts()).join())
  check('the skill service is shown for the workspace', (await page.locator('h2', { hasText: 'Skill service' }).count()) === 1)
  check('the 24 hours don’t reach history removed for space', !/removed to keep/.test(await page.locator('.perf-coverage').innerText()))
  check('coverage: how long Hive was recording, and the gap', /Recorded for \d+ h/.test(await page.locator('.perf-coverage').innerText()), await page.locator('.perf-coverage').innerText())
  check('…the unrecorded hours are hatched in the trend, not shown as zero', (await page.locator('.perf-trend .daily-col.unobserved').count()) >= 3, String(await page.locator('.perf-trend .daily-col.unobserved').count()))
  check('the guidance table has each part', /Core\|Project\|Role\|Persona/i.test((await page.locator('.table-wrap th').allInnerTexts()).join('|')), (await page.locator('.table-wrap th').allInnerTexts()).join('|'))
  check('cancelled requests are shown apart from failures', /cancelled/.test(await page.locator('.performance-page:visible .card', { hasText: 'API requests' }).innerText()))
  await shot('wide-dark')

  await page.locator('.performance-page:visible .segmented button', { hasText: '7 days' }).click()
  check('7 days adds the older work, with a daily trend', !!(await until(async () => (await requests()) === '147')) && (await bars.count()) === 8, `${await requests()} ${await bars.count()}`)
  check('…and says history Hive removed for space is unavailable', /removed to keep the metrics file under its size limit/.test(await page.locator('.perf-coverage').innerText()), await page.locator('.perf-coverage').innerText())
  await page.locator('.performance-page:visible .segmented button', { hasText: '24 hours' }).click()
  await until(async () => (await requests()) === '47')

  // Reading it adds nothing: Refresh shows the same.
  await page.locator('.performance-page:visible button[aria-label="Refresh"]').click()
  await lib.sleep(800)
  check('reading the page adds nothing to it', (await requests()) === '47', await requests())

  await page.locator('.sidebar .row', { hasText: 'alpha' }).click()
  check("the sidebar's project: only its work", !!(await until(async () => (await requests()) === '30')), await requests())
  check('…named in the header', (await page.locator('.perf-scope').innerText()).includes('alpha'))
  check('…and no skill service (shared by the workspace)', (await page.locator('h2', { hasText: 'Skill service' }).count()) === 0)
  check("…with the warning that some losses couldn't be attributed, as on its tab", /couldn’t be attributed/.test(await page.locator('.perf-coverage').innerText()))
  await page.locator('.sidebar .row', { hasText: 'Workspace’s own work' }).click()
  check("the workspace's own work", !!(await until(async () => (await requests()) === '5')), await requests())
  const ownFile = await exported()
  check("…its trend and its export are its own too (no project's)", ownFile && trendRequests(ownFile) === 5 && Object.keys(ownFile.json.report.projects).length === 0 && ownFile.json.filters.own === true, ownFile && JSON.stringify({ t: trendRequests(ownFile), p: Object.keys(ownFile.json.report.projects), f: ownFile.json.filters }))
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  await until(async () => (await requests()) === '47')
  await page.locator('select[aria-label="Who did the work"]').selectOption('api')
  check('the role filter: scripts only', !!(await until(async () => (await requests()) === '5')), await requests())
  const scriptsFile = await exported()
  check('…in the trend and the export too, with the filter named', scriptsFile && trendRequests(scriptsFile) === 5 && scriptsFile.json.filters.role === 'api' && scriptsFile.json.report.trend.every((p) => p.launches === 0), scriptsFile && JSON.stringify(scriptsFile.json.filters))
  check('…and what the filter can’t narrow is said', /shared: not per role or provider/.test(await page.locator('.perf-coverage').innerText()))
  await page.locator('select[aria-label="Who did the work"]').selectOption('all')

  // A scope switched while the last query is slow: the late answer for the old scope is never shown.
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = 'metrics:query=2500*1'
  })
  await page.locator('.sidebar .row', { hasText: 'alpha' }).click()
  await lib.sleep(300)
  await page.locator('.sidebar .row', { hasText: 'beta' }).click()
  check('a scope switched during a slow query shows the new scope', !!(await until(async () => (await requests()) === '12')), await requests())
  await lib.sleep(3000) // A fixed wait on purpose: the slowed answer for the old choice arrives later, and this checks it doesn't replace the new one.
  check("…and the old scope's late reply doesn't replace it", (await requests()) === '12', await requests())
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = ''
  })

  await page.locator('.sidebar .row', { hasText: 'gamma' }).click()
  check('a project with nothing recorded says so', !!(await until(async () => (await page.locator('.perf-empty').count()) === 1)))
  await shot('empty')

  // Export of the whole workspace: plain, then sanitized.
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  await until(async () => (await requests()) === '47')
  const plain = (await exported())?.json
  check('Export saves the report with its schema, version, units, coverage and trend', plain && plain.schema === 'hive-metrics/1' && plain.app.version && plain.units.bytes && plain.coverage.observedMs > 0 && plain.report.trend.length === 25 && 'alpha' in plain.report.projects, JSON.stringify(plain).slice(0, 200))
  const clean = (await exported(['Shift']))?.text
  check('Shift+Export leaves out project names and the workspace path', clean && !/alpha|beta|performance-ws/.test(clean) && JSON.parse(clean).sanitized === true, clean && clean.slice(0, 200))

  // A project's tab: only its project, no scope choice.
  await page.locator('.activitybar button[aria-label="Projects"]').click()
  await page.locator('.sidebar .row', { hasText: 'beta' }).first().click()
  await page.locator('.tab', { hasText: 'Performance' }).click()
  check("a project's Performance tab shows only its project", !!(await until(async () => (await requests()) === '12')), await requests())
  check('…with no scope choice and agents as the only role', (await page.locator('select[aria-label="Scope"]').count()) === 0 && (await page.locator('select[aria-label="Who did the work"] option').count()) === 2)
  await shot('tab')

  // Not recording: a banner, and what was recorded is still shown.
  await inv('settings:update', { sessions: { recordPerformance: false } })
  await page.locator('.performance-page:visible button[aria-label="Refresh"]').click()
  check('not recording: a banner says so, the numbers stay', !!(await until(async () => (await page.locator('.perf-banner').count()) === 1)) && (await requests()) === '12')
  await inv('settings:update', { sessions: { recordPerformance: true } })

  // Light theme, and a narrow window.
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(800)
  await shot('wide-light')
  await lib.fitWindow(app, page, { width: 720, height: 900 })
  await lib.sleep(800)
  const overflow = await page.locator('.performance-page:visible').evaluate((el) => el.scrollWidth - el.clientWidth)
  check('narrow: the page itself has no sideways scroll', overflow <= 1, String(overflow))
  await shot('narrow-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.sleep(800)
  await shot('narrow-dark')

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
