// Image paste (Ctrl+V) and drag-and-drop into an agent's terminal: each image's path reaches the CLI's input line, a
// pasted one saved with the session; and the ended-session bar. The agent runs the fake Claude Code (fake-claude/, #195),
// which shows what is typed as Claude Code does. Throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'image-profile')
const ws = path.join(scratch, 'image-ws')
const shots = path.join(scratch, 'image-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })

;(async () => {
  const claude = lib.fakeClaude(userData, path.join(scratch, 'image-claude-home'), [path.join(ws, 'demo')])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claude })
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
  check('the session starts', !!(await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)))
  const typed = async () => (await inv('pty:buffer', lib.ptyKey(proj, agent.id))).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  /** The images' paths on the CLI's input line: copies Hive keeps with the session (.hive/images/<session>/…). */
  const images = async () => [...new Set([...(await typed()).matchAll(/[\\/]\.hive[\\/]images[\\/][^\s"]+?\.png/gi)].map((m) => m[0]))]

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
  const pasted = (await lib.until(async () => (await images()).length >= 1, 10000)) ? (await images())[0] : null
  check("Ctrl+V: the pasted image's path reaches the CLI's input line", !!pasted, (await typed()).slice(-300))
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
  check("a dropped image's path reaches it too (a copy kept with the session)", !!(await lib.until(async () => (await images()).length >= 2, 10000)), (await typed()).slice(-300))
  await page.screenshot({ path: path.join(shots, '2-drop.png') })


  const imgDir = path.join(proj, '.hive', 'images', st.sessionId)
  const saved = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []
  const shown = (await images()).map((p) => path.basename(p))
  check('both are saved with the session, as the paths say', saved.length === 2 && shown.every((f) => saved.includes(f)) && pasted?.toLowerCase().includes(st.sessionId.toLowerCase()), JSON.stringify({ saved, shown }))

  // Ended bar: clear the input first so nothing is sent, then stop.
  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  check('the ended bar shows once it stops', !!(await lib.until(async () => (await page.locator('.session-ended').count()) === 1, 10000)))
  await page.screenshot({ path: path.join(shots, '3-ended.png') })
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
