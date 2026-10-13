// Copying from a GitHub Copilot pane (#736). Copilot tracks the mouse and selects text itself; Ctrl+C on its selection
// copies it with an OSC 52 write to the terminal, which Hive's terminal dropped (Copilot said "copied to clipboard" and
// the clipboard kept what it had). The real Copilot CLI, offline against the scripted stand-in model
// (fake-copilot-api.cjs), in a folder it already trusts: a drag over its reply and Ctrl+C put the text on the clipboard.
// An OSC 52 read is never answered (the clipboard isn't read) and a write from a terminal the user isn't using is
// refused, both logged. Shift+drag still makes Hive's own selection, and Ctrl+C copies that without reaching Copilot.
// The clipboard is stubbed in the page: never the real one. Copilot runs in a home of the suite's own with the GitHub
// CLI's login hidden: never the user's ~/.copilot or gh sign-in. Skipped where Copilot isn't installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'copilotcopy-profile')
const ws = path.join(lib.WORK, 'copilotcopy-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'copilotcopy-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'copilotcopy-api.jsonl')
const TEXT = 'SELECTME alpha beta gamma delta'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  lib.gitProject(proj, { 'a.ts': 'probe\n' })
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47831), ...copilotTestEnv(api, copilotDir) })
  // The folder is trusted already (as "Yes, and remember this folder" saves it): Copilot goes straight to its prompt.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [proj] }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const hiveLog = path.join(userData, 'logs', 'hive.log')
  const logged = (re) => {
    try {
      return re.test(fs.readFileSync(hiveLog, 'utf8'))
    } catch {
      return false
    }
  }
  try {
    await lib.fitWindow(app, page, { width: 1200, height: 800 })
    await lib.appReady(page)
    // The clipboard, stubbed: what was written, and how often it was read. The window's focus too, as the test says, not
    // as Windows allows (a quiet test window never takes the OS focus): window.__focused, with its blur and focus events.
    await page.evaluate(() => {
      window.__copied = []
      window.__reads = 0
      window.__focused = true
      document.hasFocus = () => window.__focused
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => (window.__reads++, ''), writeText: async (t) => void window.__copied.push(t) } })
    })
    const copied = () => page.evaluate(() => window.__copied)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => { const i = (await inv('provider:info')).copilot; return i && !i.checking ? i : null }, 60000, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (${info?.source ?? '?'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop', provider: 'copilot', location: 'project' })
    const key = lib.ptyKey(proj, a.id)
    const live = async () => (await inv('session:live')).find((l) => l.agentId === a.id)
    const status = async () => (await live())?.status
    const screen = async () => lib.plainText(await inv('pty:buffer', key).catch(() => ''))
    const textAt = (text) => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [key, text])
    const output = (data) => page.evaluate(([k, d]) => window.__hiveTerminalOutput(k, d), [key, data])
    const hiveSelection = () => page.evaluate((k) => window.__hiveTerminalSelection(k), key)

    await inv('session:start', proj, { agentId: a.id })
    check('Copilot is ready', !!(await lib.until(async () => (await status()) === 'ready', 60000, 200)), await status())
    const sent = await lib.sendPrompt(inv, key, `say ${TEXT}`, { submitted: async () => ['working', 'finished'].includes(await status()) })
    check('the prompt is taken', sent > 0, await status())
    check('the turn finishes', !!(await lib.until(async () => (await status()) === 'finished', 60000, 200)), await status())

    // Where the text is: the middle of its first character, and a character's width from two words' positions.
    const at = await lib.until(async () => {
      const [s, al, d] = [await textAt(TEXT), await textAt('alpha beta'), await textAt('delta')]
      return s && al && d && s.y === d.y ? { s, d, w: (al.x - s.x) / 9 } : null
    }, HUNG_MS, 200)
    check('the reply is on screen', !!at, JSON.stringify(at))
    const drag = async (shift) => {
      await page.mouse.move(at.s.x - at.w / 2 + 1, at.s.y)
      if (shift) await page.keyboard.down('Shift')
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(at.s.x + ((at.d.x + 6 * at.w - at.s.x) * i) / 8, at.s.y)
      await page.mouse.up()
      if (shift) await page.keyboard.up('Shift')
    }

    // 1. Copilot's own selection: a drag (reported to Copilot, which tracks the mouse), then Ctrl+C. Copilot copies with
    // an OSC 52 write; the terminal is in use (focused, a key just now), so the text reaches the clipboard.
    const copiedOnScreen = (await screen()).split('copied to clipboard').length
    await drag(false)
    check("the drag makes Copilot's selection, not Hive's", (await hiveSelection()) === '', JSON.stringify(await hiveSelection()))
    await page.keyboard.press('Control+c')
    const got = await lib.until(async () => ((await copied()).length ? await copied() : null), HUNG_MS, 100)
    check("Ctrl+C on Copilot's selection puts its text on the clipboard (OSC 52)", JSON.stringify(got) === JSON.stringify([TEXT]), JSON.stringify(got))
    check('Copilot says it copied', !!(await lib.until(async () => (await screen()).split('copied to clipboard').length > copiedOnScreen, HUNG_MS, 100)))
    check('the agent was not interrupted', (await status()) === 'finished', await status())
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-1-copied.png') })

    // 2. A read (what a program asks to get the clipboard back) is never answered, even from the terminal in use.
    await page.mouse.click(at.s.x, at.s.y + 4 * at.w)
    check('a read request is parsed', await output('\x1b]52;c;?\x07'))
    check('…and logged as refused', !!(await lib.until(() => logged(/OSC 52 clipboard read refused \(read\)/), HUNG_MS, 100)))
    check('…without reading the clipboard', (await page.evaluate(() => window.__reads)) === 0, await page.evaluate(() => window.__reads))

    // 3. A write from a terminal the user isn't using (the focus elsewhere) changes nothing.
    await page.evaluate(() => document.activeElement?.blur())
    check('a write request is parsed', await output(`\x1b]52;c;${Buffer.from('not asked for').toString('base64')}\x07`))
    check('…and logged as refused', !!(await lib.until(() => logged(/OSC 52 clipboard write refused \(not-in-use\)/), HUNG_MS, 100)))
    check('…leaving the clipboard as it was', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))

    // 3b. The pane keeps the focus but the window loses it (the user went to another app, just after a click in the pane):
    // a write is refused, and still is once the window is back without new input; a click in the pane then allows one.
    // A write's outcome is settled once xterm has parsed it (the handler and the stub's push run as it parses).
    const writeB64 = (t) => output(`]52;c;${Buffer.from(t).toString('base64')}`)
    const setFocus = (f) => page.evaluate((focused) => {
      window.__focused = focused
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }, f)
    const inPane = () => page.evaluate((k) => !!document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.contains(document.activeElement), key)
    await page.mouse.click(at.s.x, at.s.y + 4 * at.w)
    check('a click focuses the pane', !!(await lib.until(inPane, HUNG_MS, 100)))
    await setFocus(false)
    check('the window lost the focus, the pane kept it', await inPane())
    await writeB64('background overwrite')
    check('…a write is refused', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))
    await setFocus(true)
    await writeB64('no fresh input')
    check('back in the window without new input, a write is still refused', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))
    await page.mouse.click(at.s.x, at.s.y + 4 * at.w)
    await writeB64('after a click')
    check('…and taken after a click in the pane', JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click']), JSON.stringify(await copied()))

    // 4. Shift+drag: Hive's own selection, whatever Copilot does with the mouse; Ctrl+C copies it and Copilot never
    // sees the key (no new "copied to clipboard", no interrupt).
    const before = (await screen()).split('copied to clipboard').length
    const n = (await copied()).length
    await drag(true)
    const selected = await lib.until(async () => ((await hiveSelection())?.includes(TEXT) ? await hiveSelection() : null), HUNG_MS, 100)
    check("Shift+drag makes Hive's selection", !!selected, JSON.stringify(await hiveSelection()))
    await page.keyboard.press('Control+c')
    const hive = await lib.until(async () => ((await copied()).length > n ? await copied() : null), HUNG_MS, 100)
    check("Ctrl+C copies Hive's selection", !!hive && hive[n].includes(TEXT), JSON.stringify(hive))
    // Copilot takes its input in order: once it has answered a prompt typed after the Ctrl+C, a Ctrl+C it got would show.
    const since = (await live())?.statusSince
    const turnOver = async () => { const l = await live(); return l?.status === 'finished' && l.statusSince !== since }
    const next = await lib.sendPrompt(inv, key, 'say AFTERCOPY', { submitted: async () => (await status()) === 'working' || (await turnOver()) })
    check('the next prompt is answered', next > 0 && !!(await lib.until(turnOver, 60000, 200)), await status())
    check('…and Copilot got no Ctrl+C', (await screen()).split('copied to clipboard').length === before && (await copied()).length === n + 1, JSON.stringify(await copied()))
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-4-shift.png') })

    await inv('session:stop', proj, a.id).catch(() => {})
    await lib.until(async () => !(await live()), 30000, 200)
  } finally {
    await app.close().catch(() => {})
    await api.close()
  }
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.error(e)
  console.log('FAIL the suite threw')
  process.exit(1)
})
