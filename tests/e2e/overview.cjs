// Overview tab: the session details' agent picker and the compaction history, a data table (#124): pages, rows per
// page, a trigger filter and a text filter (no matches: Clear filters), sorting by a header, and a row opening its
// compaction in the Sessions tab at its divider; a compaction after a big turn says so (#154). In a throwaway profile
// and workspace. Transcripts are Hive backups (.hive/sessions); no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'oprofile')
const ws = path.join(scratch, 'ows')
const shots = path.join(scratch, 'oshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const proj = path.join(ws, 'demo')
const sessDir = path.join(proj, '.hive', 'sessions')
fs.mkdirSync(sessDir, { recursive: true })
lib.enableProviders(userData)

const A = '33333333-aaaa-bbbb-cccc-000000000001' // many compactions
const B = '44444444-aaaa-bbbb-cccc-000000000002' // one, after a turn with a big output (#154)
const usage = (n) => ({ input_tokens: 5, cache_read_input_tokens: n, cache_creation_input_tokens: 100, output_tokens: 50 })
function transcript(id, compactions, big = false) {
  const out = []
  for (let i = 0; i <= compactions; i++) {
    const at = new Date(Date.UTC(2026, 8, 29, 8, i)).toISOString()
    out.push({ type: 'user', timestamp: at, message: { role: 'user', content: `Step ${i}` } })
    // The big turn: 116,144 in, 72,443 out (mostly thinking), then compacted at 189,560, as in the Amiga session.
    const u = big && i === 0 ? { input_tokens: 3, cache_read_input_tokens: 110000, cache_creation_input_tokens: 6141, output_tokens: 72443 } : usage(1000 + i)
    out.push({ type: 'assistant', requestId: `${id}-${i}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done ${i}.` }], usage: u } })
    if (i < compactions) {
      out.push({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted', compactMetadata: { trigger: i === 0 ? 'auto' : 'manual', preTokens: big && i === 0 ? 189560 : 100000 + i * 1000, postTokens: 9000 } })
      out.push({ type: 'user', isCompactSummary: true, timestamp: at, message: { role: 'user', content: `Summary of part ${i}` } })
    }
  }
  fs.writeFileSync(path.join(sessDir, `${id}.jsonl`), out.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
transcript(A, 25)
transcript(B, 1, true)

const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`)

;(async () => {
  const { app, page, inv } = await lib.launch({ userData })
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.openWorkspace(inv, page, ws)
  const alpha = await lib.addAgent(inv, proj, { name: 'Alpha' })
  const beta = await lib.addAgent(inv, proj, { name: 'Beta' })
  const t = '2026-09-29T09:00:00.000Z'
  fs.writeFileSync(
    path.join(proj, '.hive', 'sessions.json'),
    JSON.stringify({ version: 1, sessions: [
      { id: A, agent: 'claude-code', agentId: alpha.id, name: 'Alpha work', createdAt: t, lastActiveAt: t, archived: false },
      { id: B, agent: 'claude-code', agentId: beta.id, name: 'Beta work', createdAt: t, lastActiveAt: '2026-09-29T10:00:00.000Z', archived: false }
    ] })
  )
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Overview' }).click()
  const head = page.locator('.session-head')
  await head.waitFor({ timeout: 15000 })
  await lib.sleep(500)

  const picker = head.locator('select')
  check('the session details have an agent picker', (await picker.count()) === 1)
  check('it starts on the focused agent', (await picker.inputValue()) === alpha.id, await picker.inputValue())
  check("it shows that agent's session", /Alpha work/.test(await head.textContent()), await head.textContent())
  const table = page.locator('.compaction-history')
  const rows = table.locator('tbody tr:not(.table-no-match)')
  const paging = table.locator('.table-paging')
  const pagingText = async () => ((await paging.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  // 25 compactions, ten to a page: newest first, three pages.
  check('the first page: ten rows, newest first', (await rows.count()) === 10 && /manual/.test(await rows.first().textContent()), String(await rows.count()))
  check('small turns are not flagged as explaining a compaction', (await table.locator('.compaction-turn').count()) === 0)
  check('"1–10 of 25" and "Page 1 of 3"', /1–10 of 25/.test(await pagingText()) && /Page 1 of 3/.test(await pagingText()), await pagingText())
  check('the date column is sorted, newest first', (await table.locator('th[aria-sort]').count()) === 1 && (await table.locator('th[aria-sort="descending"]').innerText()).startsWith('WHEN'), await table.locator('th[aria-sort]').innerText().catch(() => ''))
  await table.locator('button[aria-label="Next page"]').click()
  check('Next: page 2', /11–20 of 25/.test(await pagingText()) && /Page 2 of 3/.test(await pagingText()), await pagingText())
  await table.locator('button[aria-label="Last page"]').click()
  check('Last: page 3, the oldest (auto) last', (await rows.count()) === 5 && /auto/.test(await rows.last().textContent()) && /Page 3 of 3/.test(await pagingText()), await pagingText())
  await page.locator('.scroll-page').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.screenshot({ path: path.join(shots, '1-alpha.png') })
  await table.locator('button[aria-label="First page"]').click()
  check('First: back to page 1', /Page 1 of 3/.test(await pagingText()), await pagingText())
  // Rows per page: 20, remembered for the table.
  await paging.locator('select').selectOption('20')
  check('20 rows per page: two pages', (await rows.count()) === 20 && /Page 1 of 2/.test(await pagingText()), await pagingText())
  check('…remembered for this table', !!(await lib.until(async () => (await inv('ui:get'))?.panes?.['table-rows:compactions'] === 20, 3000)))
  // A filter goes back to page 1 (it may have fewer pages).
  await table.locator('button[aria-label="Next page"]').click()
  check('on page 2', /Page 2 of 2/.test(await pagingText()), await pagingText())
  await table.locator('input[aria-label="Filter When"]').fill('2026')
  check('changing a filter goes back to page 1', !!(await lib.until(async () => /Page 1 of 2/.test(await pagingText()), 3000)), await pagingText())
  await table.locator('input[aria-label="Filter When"]').fill('')
  // Filters: a trigger, then text with no match (Clear filters).
  await table.locator('select[aria-label="Filter Trigger"]').selectOption('auto')
  check('filtered to auto: the one row, on one page (no paging)', (await rows.count()) === 1 && (await paging.count()) === 0)
  await table.locator('select[aria-label="Filter Trigger"]').selectOption('')
  await table.locator('input[aria-label="Filter When"]').fill('nothing like a date')
  check('no matches: says so, offering Clear filters', (await rows.count()) === 0 && /No rows match the filters/.test(await table.locator('.table-no-match').innerText()))
  await table.locator('.table-no-match button', { hasText: 'Clear filters' }).click()
  check('Clear filters brings every row back', (await rows.count()) === 20 && (await table.locator('input[aria-label="Filter When"]').inputValue()) === '')
  // Sorting by a header: Before, ascending (the auto compaction freed the least).
  await table.locator('th button', { hasText: 'Before' }).click()
  check('a click on Before sorts by it, biggest first', (await table.locator('th[aria-sort="descending"]').innerText()).startsWith('BEFORE') && /124k/i.test(await rows.first().textContent()), await rows.first().textContent())
  await table.locator('th button', { hasText: 'Before' }).click()
  check('again: smallest first', (await table.locator('th[aria-sort="ascending"]').count()) === 1 && /auto/.test(await rows.first().textContent()), await rows.first().textContent())
  await page.screenshot({ path: path.join(shots, '1b-sorted-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await page.screenshot({ path: path.join(shots, '1b-sorted-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // A row opens its compaction in the Sessions tab, at its divider with the summary open; from the keyboard too.
  check('rows are buttons for the keyboard, saying what they open', (await rows.first().getAttribute('tabindex')) === '0' && /^Open the auto compaction of .* in the transcript$/.test((await rows.first().getAttribute('aria-label')) ?? ''), await rows.first().getAttribute('aria-label'))
  await rows.first().focus()
  await page.keyboard.press('Enter')
  const divider = page.locator('.tx-compaction.open')
  check('Enter on the row opens the Sessions tab at that compaction, its summary open', !!(await lib.until(async () => (await page.locator('.tab.active', { hasText: 'Sessions' }).count()) === 1 && (await divider.count()) === 1, 10000)) && /Summary of part 0/.test(await divider.innerText().catch(() => '')), await divider.innerText().catch(() => ''))
  check('…in view', await divider.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight }))
  await page.screenshot({ path: path.join(shots, '1c-transcript.png') })
  await page.locator('.tab', { hasText: 'Overview' }).click()
  await head.waitFor({ timeout: 10000 })

  await picker.selectOption(beta.id)
  await lib.sleep(300)
  check("picking another agent shows its session", /Beta work/.test(await head.textContent()), await head.textContent())
  check('with its own compactions', (await rows.count()) === 1, String(await rows.count()))
  // The compaction that followed a big turn says so (#154): the context showed 116k, the turn added 72k.
  const note = rows.first().locator('.compaction-turn')
  check('a compaction after a big turn says "turn added 72.4k output"', /turn added 72\.4k output/i.test((await note.innerText().catch(() => '')) ?? ''), await rows.first().innerText())
  await note.hover()
  check('…and on hover, how it got there', !!(await lib.until(async () => /added 72\.4k of output \(thinking included\) to the 116k the context showed before it, so it reached 190k/i.test((await page.locator('.tip').last().innerText().catch(() => '')) ?? ''), 3000)), await page.locator('.tip').last().innerText().catch(() => ''))
  await page.mouse.move(5, 5)
  await page.screenshot({ path: path.join(shots, '2-beta.png') })

  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => !r.startsWith('PASS')) ? 1 : 0)
})().catch(async (e) => {
  console.log(results.join('\n'))
  console.error('ERROR', e)
  process.exit(1)
})
