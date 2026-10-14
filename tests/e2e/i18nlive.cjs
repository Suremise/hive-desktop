// A change of language while the window is open (#795): the command palette, already open, relabels its rows without
// a keystroke, and Settings → Keyboard Shortcuts keeps its clashes by command, not by label: a language change gives
// no command a clash with itself, and two commands whose names translate alike still show a real clash. The window is
// sent language-changed as main sends it, with a small catalogue of test translations. Throwaway profile.
const lib = require('./lib.cjs')
const path = require('path')

const HUNG_MS = 15000
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(ok ? 'PASS' : 'FAIL', name, extra)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData: path.join(lib.WORK, 'i18nlive-profile') })
  try {
    const command = (id, ...args) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args })
    const base = (await inv('app:info')).language
    /** The window shown in a test language, as main sends a change of language. */
    const speak = (code, messages) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: { ...base, code, locale: code, messages } })

    // The palette, open, in English.
    await command('palette.show')
    const paletteRow = page.locator('.palette .palette-item[data-command="palette.show"]')
    check('the palette lists the command in English', !!(await lib.until(async () => /Show All Commands/.test(await paletteRow.innerText().catch(() => '')), HUNG_MS)))
    // Another language while it is open: the row follows, nothing typed.
    await speak('de', { 'shell.command.palette.show': 'Alle Befehle zeigen', 'shell.category.view': 'Ansicht' })
    check('the open palette relabels its rows in the new language', !!(await lib.until(async () => (await paletteRow.innerText().catch(() => '')).includes('Ansicht: Alle Befehle zeigen'), HUNG_MS)), await paletteRow.innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.palette').count()) === 0, HUNG_MS)

    // Settings → Keyboard Shortcuts, back in English.
    await speak('en', {})
    await command('settings.keybindings')
    const row = (id) => page.locator('.kb-table tbody tr', { has: page.locator('.kb-id', { hasText: new RegExp(`^${id.replace('.', '\\.')}$`) }) })
    const warnings = (id) => row(id).locator('.kb-warn').count()
    check('the editor lists the commands', !!(await lib.until(async () => (await row('palette.show').count()) === 1, HUNG_MS)))
    check('no clash for Show All Commands to start with', (await warnings('palette.show')) === 0)
    // A change of language: the clashes, kept by command, don't change.
    await speak('de', { 'shell.command.palette.show': 'Alle Befehle zeigen' })
    check('its row is relabelled', !!(await lib.until(async () => (await row('palette.show').innerText()).includes('Alle Befehle zeigen'), HUNG_MS)))
    check('…and gives it no clash with itself', (await warnings('palette.show')) === 0)

    // Two commands named alike in a language, sharing a shortcut: a real clash, still shown.
    await speak('de', { 'shell.command.palette.show': 'Gleich', 'shell.command.project.goto': 'Gleich' })
    await inv('settings:setKeybinding', 'project.goto', 'Mod+Shift+P')
    check('two commands with the same name and shortcut both show the clash', !!(await lib.until(async () => (await warnings('palette.show')) === 1 && (await warnings('project.goto')) === 1, HUNG_MS)), JSON.stringify([await warnings('palette.show'), await warnings('project.goto')]))
    await inv('settings:setKeybinding', 'project.goto', null)
    check('and none once the shortcut is taken off again', !!(await lib.until(async () => (await warnings('palette.show')) === 0, HUNG_MS)))
  } catch (e) {
    check('the suite ran', false, String(e?.stack ?? e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
