// About dialog licence links, the License / Third-Party Notices docs pages, and Help → Copy Diagnostics (redacted preview, copied to a fake clipboard). Throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'about-profile')
fs.rmSync(userData, { recursive: true, force: true })
// A log with a secret and the home folder in it, for Copy Diagnostics to take out.
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true })
fs.writeFileSync(path.join(userData, 'logs', 'hive.log'), `2026-10-02T09:00:00.000Z [INFO] [test] token=SECRETVALUE123 at ${path.join(require('os').homedir(), 'x')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  const env = { ...process.env, HIVE_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await sleep(2000)
  // Setup dialog may show on a fresh profile; close any modal first.
  await page.keyboard.press('Escape'); await sleep(300)
  await page.evaluate(() => window.hive.invoke('app:info')) // warm
  await page.keyboard.press('F1'); await sleep(600)
  await page.locator('.split-list .row', { hasText: 'About Hive' }).click(); await sleep(500)
  check('About shows MIT link', await page.locator('.about-licence a', { hasText: 'MIT License' }).isVisible())
  await page.screenshot({ path: path.join(scratch, 'about-1.png') })
  await page.locator('.about-licence a', { hasText: 'MIT License' }).click(); await sleep(600)
  check('License page opens', (await page.locator('.scroll-page').innerText()).includes('Permission is hereby granted'))
  await page.locator('.scroll-page a', { hasText: 'third-party notices' }).click(); await sleep(800)
  const text = await page.locator('.scroll-page').innerText()
  check('Notices page opens via link', text.includes('Third-party notices') && text.includes('monaco-editor') && text.includes('@xterm/xterm'))
  await page.screenshot({ path: path.join(scratch, 'about-2-notices.png') })
  // Not clicked: it would open the file in the real browser. The file it opens is next to electron.exe.
  check('Chromium licence file exists next to the exe', fs.existsSync(path.join(lib.ROOT, 'node_modules/electron/dist/LICENSES.chromium.html')))
  // --- Help → Copy Diagnostics: a redacted preview, copied as shown (a fake clipboard in the page).
  await page.keyboard.press('Escape'); await sleep(300)
  await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t) => { window.__copied = t } } }) })
  await page.locator('.menubar .menubar-item', { hasText: 'Help' }).click()
  await sleep(300)
  await page.getByText('Copy Diagnostics…', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Copy Diagnostics' })
  const preview = dialog.locator('.diagnostics-preview')
  let shown = ''
  for (let i = 0; i < 50 && !/### Log/.test(shown); i++) { await sleep(200); shown = await preview.innerText().catch(() => '') }
  check('Copy Diagnostics shows a preview', /## Hive diagnostics/.test(shown) && /### Coding agents/.test(shown) && /### Counts/.test(shown) && /### Log \(last 50 lines\)/.test(shown), shown.slice(0, 200))
  check('with the secret and home folder taken out', !shown.includes('SECRETVALUE123') && shown.includes('token=<redacted>') && !shown.toLowerCase().includes(require('os').homedir().toLowerCase()))
  await page.screenshot({ path: path.join(scratch, 'about-3-diagnostics.png') })
  await dialog.getByRole('button', { name: 'Copy' }).click(); await sleep(400)
  check('Copy copies exactly what was shown', ((await page.evaluate(() => window.__copied)) || '').trim() === shown.trim())
  check('and closes the dialog', (await dialog.count()) === 0)
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
