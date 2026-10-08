// Hive's updater against a local fake release feed (generic provider): automatic check + download,
// status bar states, update dialog, manual download, skip, auto-check off, errors, dev-build
// disabled state, Restart and Update through the quit flow (test mode never installs anything).
// Throwaway profiles; the download cache is %LOCALAPPDATA%\hive-test-updater (deleted before/after), or
// hive-test-updater-<k> for a runner in e2e lane k (lanes.mjs), so runners at once don't share it.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto')
const scratch = lib.WORK
const lane = /[\\/]lanes[\\/](\d+)[\\/]update(?:-\d+)?$/.exec(scratch)?.[1]
const cacheName = lane ? `hive-test-updater-${lane}` : 'hive-test-updater'
const cache = path.join(process.env.LOCALAPPDATA, cacheName)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }

// --- fake release server
let release = null // { version, file: Buffer, notes }
let downloads = 0
const server = http.createServer(async (req, res) => {
  if (!release) { res.writeHead(404); return res.end('Not Found') }
  const name = `Hive-Setup-${release.version}.exe`
  if (req.url.startsWith('/latest.yml')) {
    const sha512 = crypto.createHash('sha512').update(release.file).digest('base64')
    res.writeHead(200, { 'Content-Type': 'text/yaml' })
    return res.end(`version: ${release.version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${release.file.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-09-30T10:00:00.000Z'\nreleaseNotes: |\n${release.notes.split('\n').map((l) => '  ' + l).join('\n')}\n`)
  }
  if (req.url === `/${name}`) {
    downloads++
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': release.file.length })
    // Slow enough to see progress.
    for (let i = 0; i < release.file.length; i += 256 * 1024) {
      res.write(release.file.subarray(i, i + 256 * 1024))
      await sleep(130)
    }
    return res.end()
  }
  res.writeHead(404); res.end('Not Found')
})

async function launch(profile, extraEnv = {}) {
  const env = lib.hiveEnv({ HIVE_USER_DATA: path.join(scratch, profile), HIVE_UPDATE_CACHE: cacheName, ...extraEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  await page.keyboard.press('Escape') // first-run setup dialog, if any
  return { app, page, inv: (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a]) }
}
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250) } return false }
const statusText = (page) => page.locator('.statusbar .status-item').last().innerText()
const log = (profile) => { try { return fs.readFileSync(path.join(scratch, profile, 'logs', 'hive.log'), 'utf8') } catch { return '' } }

;(async () => {
  for (const d of ['upd-a', 'upd-b', 'upd-c', 'upd-d']) fs.rmSync(path.join(scratch, d), { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const feed = `http://127.0.0.1:${server.address().port}/`
  release = { version: '9.1.1', file: crypto.randomBytes(6 * 1024 * 1024), notes: "## What's new\n\n- Faster **everything**\n- A new thing" }

  // 1. Defaults: automatic check finds 9.1.1 and downloads it.
  let { app, page, inv } = await launch('upd-a', { HIVE_UPDATE_FEED: feed, HIVE_UPDATE_DELAY: '1500' })
  const sawDownloading = await waitFor(async () => /Downloading Hive 9.1.1/.test(await statusText(page)), 15000)
  check('status bar shows the download', sawDownloading)
  await page.screenshot({ path: path.join(scratch, 'upd-1-downloading.png') })
  let maxPct = 0
  const ready = await waitFor(async () => {
    const s = await inv('update:state')
    if (s.status === 'downloading') maxPct = Math.max(maxPct, s.progress?.percent ?? 0)
    return s.status === 'ready'
  }, 30000)
  check('progress reported while downloading', maxPct > 10 && maxPct <= 100, `max ${Math.round(maxPct)}%`)
  check('update downloaded and verified', ready && downloads === 1, `downloads ${downloads}`)
  check('status bar: restart to update', /Restart to update to 9.1.1/.test(await statusText(page)), await statusText(page))
  check('toast offers Restart and Update', await page.locator('.toast', { hasText: 'Hive 9.1.1 is ready' }).count() === 1)
  check('install mode auto logged', /install auto/.test(log('upd-a')))
  await page.locator('.statusbar .update-item').click(); await sleep(500)
  const dlg = page.locator('.dialog', { hasText: 'Update Ready' })
  check('dialog shows version and notes', (await dlg.innerText()).includes('Hive 9.1.1 is ready to install') && (await dlg.locator('.update-notes strong').innerText()) === 'everything')
  check('dialog has Restart and Update', await dlg.locator('button', { hasText: 'Restart and Update' }).count() === 1)
  await page.screenshot({ path: path.join(scratch, 'upd-2-ready.png') })
  await dlg.locator('button', { hasText: 'Later' }).click(); await sleep(300)
  // Tray and palette commands exist
  // About shows the status row
  await page.evaluate(() => window.hive.invoke('app:info'))
  // Restart and Update goes through the quit flow; test mode quits without installing.
  const closed = new Promise((r) => app.process().once('exit', r))
  await inv('update:install')
  await Promise.race([closed, sleep(10000)])
  check('Restart and Update quits (test mode: no install)', /Test mode: would install 9.1.1 and restart/.test(log('upd-a')))

  // 2. Manual download, and install mode manual.
  fs.mkdirSync(path.join(scratch, 'upd-b'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'upd-b', 'config.json'), JSON.stringify({ version: 1, settings: { updates: { downloadAutomatically: false, install: 'manual' } } }))
  fs.rmSync(cache, { recursive: true, force: true }); downloads = 0
  ;({ app, page, inv } = await launch('upd-b', { HIVE_UPDATE_FEED: feed, HIVE_UPDATE_DELAY: '1500' }))
  await waitFor(async () => (await inv('update:state')).status === 'available')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that nothing downloads by itself (the feed answers after 1.5 s), which no condition can show.
  check('not downloaded automatically', (await inv('update:state')).status === 'available' && downloads === 0)
  check('status bar: available', /Hive 9.1.1 available/.test(await statusText(page)), await statusText(page))
  check('install mode manual logged', /download manual, install manual/.test(log('upd-b')))
  await page.locator('.statusbar .update-item').click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'upd-3-available.png') })
  await page.locator('.dialog button', { hasText: 'Download' }).click()
  check('Download from the dialog', await waitFor(async () => (await inv('update:state')).status === 'ready', 30000) && downloads === 1)
  await page.keyboard.press('Escape')
  // Skip: a newer version, found by a manual check, skipped; the next automatic check ignores it.
  release = { ...release, version: '9.1.2', notes: '- Even more' }
  await app.close()
  ;({ app, page, inv } = await launch('upd-b', { HIVE_UPDATE_FEED: feed, HIVE_UPDATE_DELAY: '600000' }))
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.hive.invoke('update:check'))
  let st = await inv('update:state')
  check('manual check finds 9.1.2', st.status === 'available' && st.version === '9.1.2', JSON.stringify({ s: st.status, v: st.version }))
  await inv('update:skip', '9.1.2')
  st = await inv('update:state')
  check('skip hides it', st.status === 'up-to-date' && st.skipped === true)
  await app.close()
  ;({ app, page, inv } = await launch('upd-b', { HIVE_UPDATE_FEED: feed, HIVE_UPDATE_DELAY: '1000' }))
  await waitFor(async () => ['up-to-date', 'available'].includes((await inv('update:state')).status))
  st = await inv('update:state')
  check('automatic check ignores the skipped version', st.status === 'up-to-date' && st.skipped === true, st.status)
  check('status bar plain', /^\s*Hive Dev \d+\.\d+\.\d+/.test(await statusText(page)), await statusText(page))
  // Manual check still offers it (marked skipped)
  st = await inv('update:check')
  check('manual check still shows a skipped version', st.status === 'available' && st.skipped === true)
  await app.close()

  // 3. Automatic checks off: nothing happens at startup; manual check works.
  fs.mkdirSync(path.join(scratch, 'upd-c'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'upd-c', 'config.json'), JSON.stringify({ version: 1, settings: { updates: { checkAutomatically: false } } }))
  ;({ app, page, inv } = await launch('upd-c', { HIVE_UPDATE_FEED: feed, HIVE_UPDATE_DELAY: '1000' }))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that no check starts by itself, which no condition can show.
  check('no automatic check when off', (await inv('update:state')).status === 'idle')
  // Settings → Updates renders
  await page.keyboard.press('Control+,'); await sleep(600)
  await page.locator('.settings-nav .row', { hasText: 'Updates' }).click(); await sleep(400)
  const settingsText = await page.locator('.settings').innerText()
  check('Settings → Updates has the four options', ['Check for updates automatically', 'Download updates automatically', 'Install updates', 'Include pre-releases'].every((t) => settingsText.includes(t)))
  await page.screenshot({ path: path.join(scratch, 'upd-4-settings.png') })
  // 4. Errors: no release published (404).
  release = null
  await page.locator('.settings button', { hasText: 'Check Now' }).click(); await lib.until(async () => (await inv('update:state')).status === 'error', 10000)
  st = await inv('update:state')
  check('404 → "no release published yet"', st.status === 'error' && /No release of Hive has been published yet/.test(st.error), st.error)
  check('error dialog shown', await page.locator('.dialog', { hasText: 'No release of Hive has been published yet' }).count() === 1)
  await page.screenshot({ path: path.join(scratch, 'upd-5-error.png') })
  await app.close()

  // 5. A dev build without a feed: updates disabled.
  ;({ app, page, inv } = await launch('upd-d'))
  st = await inv('update:state')
  check('dev build: disabled', st.status === 'disabled' && /installed app/.test(st.error))
  await page.keyboard.press('F1'); await sleep(400)
  await page.locator('.split-list .row', { hasText: 'About Hive' }).click(); await sleep(400)
  check('About shows the update status', /installed app/.test(await page.locator('.about-update').innerText()))
  await page.screenshot({ path: path.join(scratch, 'upd-6-about.png') })
  await app.close()

  server.close()
  // The download cache is outside hive-test (no housekeeping there), so it goes, but never at the cost of a suite whose
  // checks passed (#324): lib.tidyUp retries a held file a few times, then leaves it for the next run's clear.
  lib.tidyUp(cache)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); lib.tidyUp(cache); process.exit(1) })
