// Workspace Overview: totals across projects for a period, the table by project, the stacked chart (a tile a day),
// the board strip and the hidden-project note. Transcripts are Hive backups (.hive/sessions) dated relative to today; no
// agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'wsoverview-profile')
const ws = path.join(lib.WORK, 'wsoverview-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)

const day = 86_400_000
let n = 0
/** A project with one session: a request on each of the given days ago, with this many output tokens each. */
function project(name, requests) {
  const dir = path.join(ws, name, '.hive', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const id = `55555555-aaaa-bbbb-cccc-${String(++n).padStart(12, '0')}`
  const lines = []
  let last = 0
  for (const [daysAgo, out] of requests) {
    const t = Date.now() - daysAgo * day
    last = Math.max(last, t)
    const at = new Date(t).toISOString()
    lines.push({ type: 'user', timestamp: at, message: { role: 'user', content: 'Go' } })
    lines.push({ type: 'assistant', requestId: `${id}-${daysAgo}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: out } } })
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const at = new Date(last).toISOString()
  fs.writeFileSync(path.join(ws, name, '.hive', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id, agent: 'claude-code', name: `${name} work`, createdAt: at, lastActiveAt: at, archived: false }] }))
}
// 7 days: alpha 2,410 (today and 3 days ago), beta 2,105 (today); gamma only 20 days ago (5,105).
project('alpha', [[0, 50], [3, 150]])
project('beta', [[0, 1000]])
project('gamma', [[20, 4000]])
project('delta', [[0, 99999]])

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
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  // delta is hidden: left out, with a note.
  await inv('project:remove', path.join(ws, 'delta'), 'hide')
  await inv('tasks:create', { title: 'Plan', project: 'alpha' })
  await inv('tasks:create', { title: 'Check', project: 'beta', column: 'review' })

  await page.keyboard.press('Control+Shift+O')
  const head = page.locator('h1', { hasText: 'Workspace Overview' })
  check('Ctrl+Shift+O opens the Workspace Overview', !!(await until(async () => (await head.count()) === 1)))
  const rows = page.locator('.ws-projects tbody tr')
  check('it lists each project and not the hidden one', !!(await until(async () => (await rows.count()) === 3)), String(await rows.count()))
  const names = async () => (await rows.locator('td:first-child').allInnerTexts()).map((s) => s.trim())
  check('7 days is the default, biggest first', JSON.stringify(await names()) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(await names()))
  const tokens = page.locator('.card', { hasText: 'Tokens' }).first().locator('.value')
  check('the summary adds up every project in the period', (await tokens.innerText()) === '4.5k', await tokens.innerText())
  check('the chart is stacked by project, with a legend', JSON.stringify(await page.locator('.stack-legend > span').allInnerTexts().then((x) => x.map((s) => s.trim()))) === JSON.stringify(['alpha', 'beta']), JSON.stringify(await page.locator('.stack-legend > span').allInnerTexts()))
  // Every day is a tile of its own (as in the Performance chart), a day without tokens too: the same visible background.
  await page.mouse.move(5, 5)
  const tiles = await page.locator('.daily-chart:visible .daily-col').evaluateAll((cols) => cols.map((c) => ({ bg: getComputedStyle(c).backgroundColor, empty: !c.querySelector('.stack-part'), w: c.getBoundingClientRect().width })))
  check('each of the 7 days is a tile with the same visible background, empty days too', tiles.length === 7 && tiles.some((t) => t.empty) && tiles.every((t) => t.bg === tiles[0].bg && t.w > 0) && !/rgba\(0, 0, 0, 0\)|transparent/.test(tiles[0].bg), JSON.stringify(tiles))
  check('the hidden project is noted', (await page.locator('.hint', { hasText: "1 hidden or removed project isn't counted" }).count()) === 1)
  check('the board strip shows the cards', /1\s*Todo/.test(await page.locator('.board-strip').innerText()) && /1\s*Waiting for review/.test(await page.locator('.board-strip').innerText()), await page.locator('.board-strip').innerText())
  check('the sidebar lists the projects', (await page.locator('.sidebar .row', { hasText: 'gamma' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'wsoverview.png') })

  await page.locator('.segmented button', { hasText: 'All time' }).click()
  check('All time counts older work too', !!(await until(async () => (await tokens.innerText()) === '9.6k', 3000)), await tokens.innerText())
  check('and re-sorts the table', !!(await until(async () => (await names())[0] === 'gamma', 3000)), JSON.stringify(await names()))
  await page.locator('.ws-projects th', { hasText: 'Project' }).click()
  check('a column header sorts by it', JSON.stringify(await names()) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(await names()))

  await rows.filter({ hasText: 'beta' }).click()
  const opened = await until(async () => (await page.locator('.tab.active', { hasText: 'Overview' }).count()) === 1 && (await page.locator('.project-header, .project-title').first().innerText().catch(() => '')).includes('beta'), 5000)
  check("a project's row opens its Overview", !!opened)
  await page.screenshot({ path: path.join(lib.WORK, 'wsoverview-project.png') })

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
