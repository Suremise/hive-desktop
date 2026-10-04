// Image paste (Ctrl+V), drag-and-drop, and the ended-session bar, in a throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'profile')
const ws = path.join(scratch, 'ws')
const shots = path.join(scratch, 'shots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })

;(async () => {
  lib.enableProviders(userData)
  const env = { ...process.env, HIVE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: lib.ELECTRON,
    args: [lib.ROOT],
    cwd: lib.ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const proj = path.join(ws, 'demo')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)

  // A fake clipboard holding a PNG, in the app only: the real clipboard is never read or written.
  const png = await page.screenshot({ path: path.join(shots, 'source.png'), clip: { x: 0, y: 0, width: 400, height: 200 } })
  await app.evaluate(async ({ clipboard }, b64) => {
    const bytes = Buffer.from(b64, 'base64')
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([bytes], { type: 'image/png' }) }]
  }, png.toString('base64'))
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => undefined } })
  })

  await page.locator('.terminal-host').first().click()
  await page.keyboard.press('Control+V')
  await lib.until(async () => (await inv('pty:buffer', lib.ptyKey(proj, agent.id))).split('.png').length - 1 >= 1, 10000) // the pasted image's path in the terminal
  await page.screenshot({ path: path.join(shots, '1-ctrl-v.png') })

  // Drop a real file: setInputFiles gives a path-backed File.
  const dropSrc = path.join(scratch, 'drop me.png')
  fs.writeFileSync(dropSrc, png)
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.id = '__drop'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.setInputFiles('#__drop', dropSrc)
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(document.getElementById('__drop').files[0])
    const host = document.querySelector('.terminal-host')
    host.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await lib.until(async () => (await inv('pty:buffer', lib.ptyKey(proj, agent.id))).split('.png').length - 1 >= 2, 10000) // and the dropped one's
  await page.screenshot({ path: path.join(shots, '2-drop.png') })


  const imgDir = path.join(proj, '.hive', 'images', st.sessionId)
  console.log('saved images:', fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : 'none')

  // Ended bar: clear the input first so nothing is sent, then stop.
  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await page.screenshot({ path: path.join(shots, '3-ended.png') })
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
