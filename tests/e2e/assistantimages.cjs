// The Hive Assistant view (#243): its sections are Modes, Conversations and Images; Images shows the screenshots
// pasted into its conversations (its home's .hive/images), grouped by conversation, in the project Images tab's grid
// and viewer; a group's name opens that conversation's transcript in the conversations tree (#239's), and a group can
// be moved to the Recycle Bin at once. "Show Assistant Images" is a command. Modes' New Mode… (a prompt opened from a
// button) takes Enter once: the mode is made, or the error shown, and no dialog is left open (#355). Fixtures only
// (nothing runs): a conversation record, its transcript (Hive's copy) and two images. Dev build, throwaway profile and
// workspace, quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistantimages-profile')
const ws = path.join(lib.WORK, 'assistantimages-ws')
const home = path.join(ws, '.hive', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const conv = '0f5c2a8e-3333-4444-8555-666677770001'
const at = (h) => new Date(Date.UTC(2026, 9, 5, h, 0, 0)).toISOString()

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'api'), { recursive: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47927), CLAUDE_CONFIG_DIR: path.join(lib.WORK, 'assistantimages-claude-home') })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // A past conversation of the Assistant, with two pasted images.
  const file = path.join(home, '.hive', 'sessions.json')
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'))
  sessions.sessions.push({ id: conv, agent: 'claude-code', name: 'Planning the week', createdAt: at(9), lastActiveAt: at(10), archived: false, agentId: 'assistant', agentName: 'Assistant' })
  fs.writeFileSync(file, JSON.stringify(sessions, null, 2))
  const transcript = [
    { type: 'user', sessionId: conv, timestamp: at(9), message: { role: 'user', content: 'What should the agents do this week?' } },
    { type: 'assistant', sessionId: conv, requestId: 'r1', timestamp: at(9), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Start with the tray icon.' }], usage: { input_tokens: 10, output_tokens: 20 } } }
  ]
  fs.mkdirSync(path.join(home, '.hive', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hive', 'sessions', `${conv}.jsonl`), transcript.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const imgDir = path.join(home, '.hive', 'images', conv)
  fs.mkdirSync(imgDir, { recursive: true })
  for (const n of ['2026-10-05T09-10-00.png', '2026-10-05T09-20-00.png']) fs.writeFileSync(path.join(imgDir, n), lib.samplePng())

  // --- The view: Modes, Conversations, Images.
  await page.locator('.activity-btn[aria-label="Hive Assistant"]').click()
  await lib.until(async () => (await page.locator('.assistant-summary').count()) > 0, 10000)
  const sections = (await page.locator('.sidebar .section-header').allTextContents()).map((t) => t.replace(/\d+$/, '').trim())
  check('sections in order: Modes, Conversations, Images', JSON.stringify(sections) === JSON.stringify(['Modes', 'Conversations', 'Images']), JSON.stringify(sections))

  // --- New Mode…: Enter in its prompt (a real key press: keydown, keypress, keyup) never opens it again (#355).
  const newMode = async (name) => {
    await page.locator('button[aria-label="New Mode…"]').click()
    const field = page.locator('.dialog input.input')
    await lib.until(async () => (await field.count()) === 1 && (await field.evaluate((el) => el === document.activeElement)), 5000)
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
    await lib.sleep(500) // on purpose: a dialog opened again by the same key press would be on screen by now
  }
  await newMode('Enter Test')
  check('Enter in New Mode… makes the mode', !!(await lib.until(async () => fs.existsSync(path.join(ws, '.hive', 'personas', 'enter-test.md')), 5000)))
  check('…and leaves no dialog open', (await page.locator('.dialog').count()) === 0, String(await page.locator('.dialog').count()))
  await newMode('Enter Test')
  check('Enter with a name already used shows why', !!(await lib.until(async () => (await page.getByText('There is already a mode called').count()) > 0, 5000)))
  check('…and leaves no dialog open either', (await page.locator('.dialog').count()) === 0, String(await page.locator('.dialog').count()))
  // The confirming Enter released in another window (Hive loses the focus, its keyup never comes here): the next
  // Enters here aren't held back. A field of the test's own, typed into with real key presses.
  await page.locator('button[aria-label="New Mode…"]').click()
  await lib.until(async () => (await page.locator('.dialog input.input').count()) === 1 && (await page.locator('.dialog input.input').evaluate((el) => el === document.activeElement)), 5000)
  await page.keyboard.type('Blur Test')
  await page.keyboard.down('Enter')
  check('Enter held down makes the mode, with no dialog left open', !!(await lib.until(async () => fs.existsSync(path.join(ws, '.hive', 'personas', 'blur-test.md')) && (await page.locator('.dialog').count()) === 0, 5000)))
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.evaluate(() => {
    const t = document.createElement('textarea')
    t.id = 'enter-probe'
    document.body.appendChild(t)
    t.focus()
  })
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const typed = await page.evaluate(() => document.getElementById('enter-probe').value)
  check('after its release was lost to another window, the next Enters type as usual', typed === '\n\n', JSON.stringify(typed))
  await page.evaluate(() => document.getElementById('enter-probe').remove())

  // --- Images: the conversation's group, with its name, in the Images grid.
  await page.locator('.row', { hasText: 'All Images' }).click()
  const group = page.locator('.image-group', { hasText: 'Planning the week' })
  await lib.until(async () => (await group.locator('.thumb').count()) === 2, 10000)
  check("the pasted images show, under their conversation's name", (await group.locator('.thumb').count()) === 2)
  check('the toolbar counts them by conversation', /2 in 1 conversation\b/.test(await page.locator('.images-toolbar').innerText()), await page.locator('.images-toolbar').innerText())
  const desc = await page.locator('.images-desc').innerText().catch(() => '')
  check('a line says what the view holds', desc === 'Images pasted or dropped into the Assistant, by conversation.', desc)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantimages-1-images.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await page.screenshot({ path: path.join(lib.WORK, 'assistantimages-1-images-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await group.locator('.thumb').first().click()
  await lib.until(async () => (await page.locator('.image-viewer').count()) > 0, 5000)
  check('an image opens in the viewer', (await page.locator('.image-viewer img').count()) > 0)
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.image-viewer').count()) === 0, 3000)

  // --- A group's name opens its conversation in the conversations tree.
  await group.locator('.image-group-name').click()
  await lib.until(async () => /Planning the week/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')), 10000)
  check("the group's name opens that conversation's transcript", /Planning the week/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')))
  check('the conversations are the tree (by provider)', (await page.locator('.sessions-tree .session-branch-provider').count()) === 1 && (await page.locator('.sessions-tree .session-row.selected', { hasText: 'Planning the week' }).count()) === 1)
  check('the Conversations row is the one selected', (await page.locator('.sidebar .row.selected', { hasText: 'All Conversations' }).count()) === 1)

  // --- The command.
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Show Assistant Images')
  await lib.until(async () => (await page.locator('.palette-item', { hasText: 'Show Assistant Images' }).count()) > 0, 3000)
  await page.keyboard.press('Enter')
  await lib.until(async () => (await group.count()) > 0, 5000)
  check('"Show Assistant Images" shows them', (await group.count()) === 1)

  // --- A group to the Recycle Bin at once.
  await group.locator('[aria-label^="Delete This Conversation"]').click()
  await page.locator('.dialog-footer button', { hasText: /^Move to Recycle Bin$/ }).click()
  await lib.until(async () => (await page.locator('.images-page').count()) === 0, 8000)
  check('the group goes, and the view says there are none', /No images yet/.test(await page.locator('.empty-state').first().innerText().catch(() => '')))
  check('its images are gone from its home', !fs.existsSync(imgDir) || fs.readdirSync(imgDir).length === 0)
  check('the conversation itself stays', fs.existsSync(path.join(home, '.hive', 'sessions', `${conv}.jsonl`)))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantimages-2-empty.png') })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
