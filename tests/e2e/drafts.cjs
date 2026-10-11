// Unsaved edits outside the Files tab (shared notes, MCP servers): kept when the view changes, a save won't
// silently overwrite a file changed on disk (an agent's edit), and quitting asks about them and saves them.
// Dev build, throwaway profile and workspace; no agents are started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'drafts-profile')
const ws = path.join(lib.WORK, 'drafts-ws')
const note = path.join(ws, '.hive', 'shared', 'plan.md')
const server = path.join(ws, '.hive', 'mcp', 'demo.json')
const sleep = lib.sleep
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const read = (f) => fs.readFileSync(f, 'utf8')

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47896) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.appReady(page)
  await page.evaluate((folder) => window.hive.invoke('workspace:open', folder), ws)
  await sleep(800)
  fs.writeFileSync(note, '# Plan\n')
  fs.mkdirSync(path.dirname(server), { recursive: true })
  fs.writeFileSync(server, '{ "command": "node", "args": [] }\n')
  await page.evaluate(() => window.hive.invoke('workspace:refresh'))

  const toolbar = page.locator('.split-main .editor-toolbar').first()
  const typeAtEnd = async (text) => {
    await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
    await sleep(400)
  }
  const openNote = async () => {
    await page.keyboard.press('Control+Shift+H')
    await sleep(600)
    await page.locator('.row', { hasText: 'plan.md' }).first().click()
    await lib.until(async () => ((await page.locator('.row', { hasText: 'plan.md' }).first().getAttribute('class')) ?? '').includes('selected'), 10000)
  }
  const openServer = async () => {
    await page.keyboard.press('Control+Shift+M')
    await sleep(600)
    await page.locator('.row', { hasText: 'demo' }).first().click()
    await lib.until(async () => ((await page.locator('.row', { hasText: 'demo' }).first().getAttribute('class')) ?? '').includes('selected'), 10000)
  }

  // A note's edits survive going to another view and back.
  await openNote()
  await toolbar.locator('button[aria-label="Edit"]').click()
  await sleep(600)
  await typeAtEnd('DRAFT-1 ')
  await openServer()
  await openNote()
  check('note: unsaved edits kept after changing view', (await page.locator('.split-main .monaco').first().innerText()).includes('DRAFT-1'))
  check('note: still marked unsaved', (await toolbar.innerText()).includes('●'))

  // Changed on disk meanwhile (as an agent would): Save asks before overwriting, Cancel keeps the disk's version.
  fs.writeFileSync(note, '# Plan\nAGENT\n')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  const dialogText = () => page.locator('.dialog').last().innerText().catch(() => '')
  const dlg = (await lib.until(async () => {
    const text = await dialogText()
    return /changed on disk/.test(text) ? text : null
  })) ?? (await dialogText())
  check('note: save asks when the file changed on disk', /changed on disk/.test(dlg), dlg.slice(0, 120))
  await page.locator('.dialog .btn', { hasText: 'Cancel' }).last().click()
  await sleep(400)
  check("note: cancelling keeps the agent's version", read(note) === '# Plan\nAGENT\n')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await sleep(600)
  await page.locator('.dialog .btn', { hasText: 'Overwrite' }).last().click()
  check('note: Overwrite saves my version', await lib.until(() => read(note).includes('DRAFT-1')))
  await typeAtEnd('DRAFT-2 ')

  // An MCP server saved without its final newline (Hive adds one) saves again without a false conflict.
  await openServer()
  await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Backspace')
  await sleep(300)
  check('mcp: removing the final newline is an edit', (await toolbar.innerText()).includes('●'))
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await lib.until(() => read(server) === '{ "command": "node", "args": [] }\n')
  check('mcp: saved with a final newline', read(server) === '{ "command": "node", "args": [] }\n', JSON.stringify(read(server)))
  await typeAtEnd(' ')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await sleep(600)
  check('mcp: saving again is no conflict', (await page.locator('.dialog').count()) === 0 && read(server).trimEnd() === '{ "command": "node", "args": [] }' && read(server) !== '{ "command": "node", "args": [] }\n', JSON.stringify(read(server)))

  // An MCP server's edits are kept the same way.
  await typeAtEnd(' ')
  await openNote()
  await openServer()
  check('mcp: unsaved edits kept after changing view', (await toolbar.innerText()).includes('●'))

  // Quitting lists both and saves them.
  await page.evaluate(() => window.hive.invoke('app:quit'))
  const quit = (await lib.until(async () => {
    const text = await dialogText()
    return /plan\.md/.test(text) && /demo\.json/.test(text) ? text : null
  })) ?? (await dialogText())
  check('quit: lists the unsaved note and server', /plan\.md/.test(quit) && /demo\.json/.test(quit), quit.replace(/\s+/g, ' ').slice(0, 200))
  // Hive's part (saving both, then app.quit) and the process's exit are waited for separately (#424): the limits only
  // bound a hang, since a loaded machine stretches both (#563).
  const quitting = await lib.quitWatch(app)
  const clicked = Date.now()
  await page.getByRole('button', { name: 'Save and quit' }).click()
  const quits = !!(await quitting.untilDecided(30000)) && (await quitting.gone(30000))
  check('quit: Hive quits after saving', quits, quitting.timings(clicked))
  console.log(`quit: ${quitting.timings(clicked)}`)
  check('quit: the note was saved', read(note).includes('DRAFT-2'))
  check('quit: the server was saved', read(server) !== '{ "command": "node", "args": [] }\n' && !!JSON.parse(read(server)))
  // Hive has quit (that was the test): Playwright may already have let go of it, so asking about it can throw.
  await app.close().catch(() => undefined)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
