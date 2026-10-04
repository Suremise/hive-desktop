// Overview tab: the session details' agent picker and the compaction history pane, in a throwaway
// profile and workspace. Transcripts are Hive backups (.hive/sessions); no agent is started.
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
const B = '44444444-aaaa-bbbb-cccc-000000000002' // one
const usage = (n) => ({ input_tokens: 5, cache_read_input_tokens: n, cache_creation_input_tokens: 100, output_tokens: 50 })
function transcript(id, compactions) {
  const out = []
  for (let i = 0; i <= compactions; i++) {
    const at = new Date(Date.UTC(2026, 8, 29, 8, i)).toISOString()
    out.push({ type: 'user', timestamp: at, message: { role: 'user', content: `Step ${i}` } })
    out.push({ type: 'assistant', requestId: `${id}-${i}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done ${i}.` }], usage: usage(1000 + i) } })
    if (i < compactions) out.push({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted', compactMetadata: { trigger: i === 0 ? 'auto' : 'manual', preTokens: 100000 + i * 1000, postTokens: 9000 } })
  }
  fs.writeFileSync(path.join(sessDir, `${id}.jsonl`), out.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
transcript(A, 15)
transcript(B, 1)

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
  const rows = page.locator('.compaction-history tbody tr')
  check('every compaction is listed', (await rows.count()) === 15, String(await rows.count()))
  check('newest first', /manual/.test(await rows.first().textContent()) && /auto/.test(await rows.last().textContent()))
  const pane = page.locator('.compaction-history')
  const scrolls = await pane.evaluate((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY === 'auto')
  check('a long history scrolls in its own pane', scrolls)
  await pane.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await lib.sleep(200)
  const sticky = await pane.evaluate((el) => {
    const th = el.querySelector('th').getBoundingClientRect()
    return Math.abs(th.top - el.getBoundingClientRect().top) < 3
  })
  check('its header stays in view', sticky)
  await page.locator('.scroll-page').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.screenshot({ path: path.join(shots, '1-alpha.png') })

  await picker.selectOption(beta.id)
  await lib.sleep(300)
  check("picking another agent shows its session", /Beta work/.test(await head.textContent()), await head.textContent())
  check('with its own compactions', (await rows.count()) === 1, String(await rows.count()))
  await page.screenshot({ path: path.join(shots, '2-beta.png') })

  await app.close()
  console.log(results.join('\n'))
  process.exit(results.some((r) => !r.startsWith('PASS')) ? 1 : 0)
})().catch(async (e) => {
  console.log(results.join('\n'))
  console.error('ERROR', e)
  process.exit(1)
})
