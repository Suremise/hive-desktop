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
  await sleep(600)
  const dlg = await page.locator('.dialog').last().innerText().catch(() => '')
  check('note: save asks when the file changed on disk', /changed on disk/.test(dlg), dlg.slice(0, 120))
  await page.locator('.dialog .btn', { hasText: 'Cancel' }).last().click()
  await sleep(400)
  check("note: cancelling keeps the agent's version", read(note) === '# Plan\nAGENT\n')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await sleep(600)
  await page.locator('.dialog .btn', { hasText: 'Overwrite' }).last().click()
  await sleep(600)
  check('note: Overwrite saves my version', read(note).includes('DRAFT-1'))
  await typeAtEnd('DRAFT-2 ')

  // An MCP server saved without its final newline (Hive adds one) saves again without a false conflict.
  await openServer()
  await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Backspace')
  await sleep(300)
  check('mcp: removing the final newline is an edit', (await toolbar.innerText()).includes('●'))
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await sleep(600)
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
  await sleep(800)
  const quit = await page.locator('.dialog').last().innerText().catch(() => '')
  check('quit: lists the unsaved note and server', /plan\.md/.test(quit) && /demo\.json/.test(quit), quit.replace(/\s+/g, ' ').slice(0, 200))
  const exited = new Promise((r) => app.process().once('exit', () => r(true)))
  await page.getByRole('button', { name: 'Save and quit' }).click()
  check('quit: Hive quits after saving', await Promise.race([exited, sleep(8000).then(() => false)]))
  check('quit: the note was saved', read(note).includes('DRAFT-2'))
  check('quit: the server was saved', read(server) !== '{ "command": "node", "args": [] }\n' && !!JSON.parse(read(server)))
  // Hive has quit (that was the test): Playwright may already have let go of it, so asking about it can throw.
  await app.close().catch(() => undefined)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
