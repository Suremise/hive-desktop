// Files and Images tabs, driven end to end in a throwaway profile. Never touches the system clipboard.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const scratch = lib.WORK
const userData = path.join(scratch, 'fprofile')
const ws = path.join(scratch, 'fws')
const shots = path.join(scratch, 'fshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const proj = path.join(ws, 'demo')
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true })
  fs.writeFileSync(path.join(proj, rel), text)
}
w('README.md', '# demo\n')
w('src/app.ts', 'export const a = 1\n')
w('src/util.ts', 'export const b = 2\n')
w('.gitignore', 'dist/\n')
w('dist/out.js', 'x')
execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: proj })
w('src/app.ts', 'export const a = 2\n') // modified
w('src/new.ts', 'new\n') // untracked
// Fake session images: one live-ish group, one archived.
const png = lib.samplePng(400, 200)
const ids = ['11111111-aaaa-bbbb-cccc-000000000001', '22222222-aaaa-bbbb-cccc-000000000002']
for (const [i, id] of ids.entries()) {
  const d = path.join(proj, '.hive', 'images', id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, `2026-09-29_10-0${i}-00.png`), png)
  fs.writeFileSync(path.join(d, `2026-09-29_10-0${i}-30.png`), png)
}
fs.writeFileSync(
  path.join(proj, '.hive', 'sessions.json'),
  JSON.stringify({ version: 1, sessions: [
    { id: ids[0], agent: 'claude-code', name: 'Fix the login page', createdAt: '', lastActiveAt: '', archived: false },
    { id: ids[1], agent: 'claude-code', name: 'Old experiment', createdAt: '', lastActiveAt: '', archived: true }
  ] })
)
fs.writeFileSync(path.join(scratch, 'from explorer.txt'), 'dropped')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exists = (rel) => fs.existsSync(path.join(proj, rel))
const results = []
const check = (name, ok) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

;(async () => {
  const env = { ...process.env, HIVE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(800)
  const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)

  await row('src').click()
  await sleep(500)
  await row('src/app.ts').click()
  await sleep(300)
  await page.screenshot({ path: path.join(shots, '1-tree.png') })
  check('git modified colour on src/app.ts', (await row('src/app.ts').locator('.label').getAttribute('class')).includes('git-M'))
  check('untracked colour on src/new.ts', (await row('src/new.ts').locator('.label').getAttribute('class')).includes('git-U'))
  check('dist is dimmed (gitignored)', (await row('dist').getAttribute('class')).includes('ignored'))
  check('.hive is dimmed', (await row('.hive').getAttribute('class')).includes('ignored'))
  check('.git hidden', (await row('.git').count()) === 0)

  // New file with an intermediate folder.
  await page.locator('.files-list .pane-header').getByRole('button', { name: 'New File…' }).click()
  await page.locator('.inline-name').fill('notes/todo.md')
  await page.keyboard.press('Enter')
  await sleep(800)
  check('new file notes/todo.md (from the selected file, so inside src)', exists('src/notes/todo.md'))

  // Rename README.md with F2.
  await row('README.md').click()
  await page.keyboard.press('F2')
  await page.locator('.inline-name').fill('README2.md')
  await page.keyboard.press('Enter')
  await sleep(700)
  check('rename README.md -> README2.md', exists('README2.md') && !exists('README.md'))

  // Copy src/util.ts into dist via Ctrl+C / Ctrl+V.
  await row('src/util.ts').click()
  await page.keyboard.press('Control+C')
  await row('dist').click()
  await page.keyboard.press('Control+V')
  await sleep(700)
  check('copy/paste src/util.ts -> dist/util.ts', exists('dist/util.ts') && exists('src/util.ts'))

  // Cut README2.md into src.
  await row('README2.md').click()
  await page.keyboard.press('Control+X')
  await row('src').click() // collapses src, still the paste target
  await page.keyboard.press('Control+V')
  await sleep(700)
  check('cut/paste README2.md -> src/README2.md', exists('src/README2.md') && !exists('README2.md'))

  // Duplicate via the context menu.
  await row('.gitignore').click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Duplicate' }).click()
  await sleep(700)
  check('duplicate .gitignore -> ".gitignore copy"', exists('.gitignore copy'))

  // Delete (Recycle Bin) with confirmation.
  await row('.gitignore copy').click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Recycle Bin' }).click()
  await lib.until(async () => !exists('.gitignore copy'), 10000)
  check('delete moves ".gitignore copy" to the Recycle Bin', !exists('.gitignore copy'))

  // Internal drag: move src/new.ts onto dist.
  if (!(await row('src/new.ts').count())) await row('src').click()
  await sleep(400)
  await page.evaluate(() => {
    const dt = new DataTransfer()
    const src = document.querySelector('.file-row[data-rel="src/new.ts"]')
    const dst = document.querySelector('.file-row[data-rel="dist"]')
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await sleep(800)
  check('drag src/new.ts onto dist moves it', exists('dist/new.ts') && !exists('src/new.ts'))

  // Drop from Explorer onto the root.
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.id = '__drop'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.setInputFiles('#__drop', path.join(scratch, 'from explorer.txt'))
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(document.getElementById('__drop').files[0])
    const t = document.querySelector('.file-tree')
    t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await sleep(800)
  check('drop from Explorer copies into the project', exists('from explorer.txt'))

  // Live update from outside Hive.
  w('made-outside.txt', 'hi')
  await lib.until(async () => (await row('made-outside.txt').count()) === 1, 10000)
  check('file created outside Hive appears live', (await row('made-outside.txt').count()) === 1)

  // Filter.
  await page.locator('.files-filter input').fill('util')
  await sleep(700)
  await page.screenshot({ path: path.join(shots, '2-filter.png') })
  check('filter finds src/util.ts', (await row('src/util.ts').count()) === 1)
  await page.locator('.files-filter input').fill('')
  await sleep(400)

  await row('src/app.ts').click().catch(() => undefined)
  await row('src').click().catch(() => undefined)
  await sleep(300)
  await row('src/app.ts').click().catch(() => undefined)
  await sleep(300)
  await page.screenshot({ path: path.join(shots, '3-details.png') })

  // Images tab.
  await page.locator('.tab', { hasText: 'Images' }).click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 4, 10000)
  await page.screenshot({ path: path.join(shots, '4-images.png') })
  check('images: 4 thumbnails', (await page.locator('.thumb').count()) === 4)
  check('images: thumbnails load', await page.locator('.thumb img').first().evaluate((i) => i.complete && i.naturalWidth > 0))
  check('images: archived heading', (await page.locator('.images-archived').count()) === 1)
  await page.locator('.thumb').first().click()
  await sleep(600)
  await page.screenshot({ path: path.join(shots, '5-viewer.png') })
  await page.keyboard.press('ArrowRight')
  await sleep(300)
  check('viewer navigates', (await page.locator('.dialog-header h2').innerText()).includes('10-00-00'))
  await page.keyboard.press('Escape')

  // Light theme check of the Files tab.
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(300)
  await inv('settings:update', { appearance: { theme: 'light' } })
  await sleep(800)
  await page.screenshot({ path: path.join(shots, '6-light.png') })

  console.log(results.join('\n'))
  await app.close()
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
