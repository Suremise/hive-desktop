// Add MCP Server from File (#550), in the window: a .json definition and a .zip of a server folder are added from the
// MCP view's button (the file picker stubbed), the dialog showing what each runs before it is added; both appear turned
// off with what they run shown; a name in use asks to replace it or choose another; enabling a server asks first,
// showing what it runs, and a new session then gets it (the fake Claude Code's --mcp-config). Throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')

const userData = path.join(lib.WORK, 'mcpfile-profile')
const ws = path.join(lib.WORK, 'mcpfile-ws')
const proj = path.join(ws, 'demo')
const dump = path.join(lib.WORK, 'mcpfile-dump')
const home = path.join(lib.WORK, 'mcpfile-claude-home')
const mcpDir = path.join(ws, '.hive', 'mcp')
const shots = path.join(lib.WORK, 'mcpfile-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, dump, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(dump, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  fs.writeFileSync(path.join(dump, 'github.json'), JSON.stringify({ description: 'GitHub issues', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }))
  const notes = { description: 'Notes', command: 'node', args: ['${HIVE_MCP_DIR}/notes/server.js'], env: { NOTES_DIR: 'C:\\notes' } }
  fs.writeFileSync(path.join(dump, 'notes.zip'), zipSync({ 'notes/hive-mcp.json': strToU8(JSON.stringify(notes)), 'notes/server.js': strToU8('// notes server') }))
  const env = lib.fakeClaude(userData, home, [proj])
  const { app, page, inv } = await lib.launch({ userData, env })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const shot = (name) => page.screenshot({ path: path.join(shots, `mcpfile-${name}.png`) })
  const pick = (file) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, file)
  const servers = () => inv('mcp:list')
  const server = async (name) => (await servers()).find((m) => m.name === name)
  const dialog = (title) => page.getByRole('dialog', { name: title })
  const addButton = page.getByRole('button', { name: 'Add MCP Server from File (.json or .zip)…' })
  // The server's row in the MCP view, by its whole name ("notes", not "notes-2").
  const row = (name) => page.locator('.pane-body .row', { has: page.locator('.label', { hasText: new RegExp(`^${name}\\s*$`) }) })

  await page.keyboard.press('Control+Shift+M')
  check('the MCP view has Add MCP Server from File', !!(await lib.until(async () => (await addButton.count()) === 1)))

  // --- A .json definition: the dialog shows what it runs, named after the file; added turned off.
  await pick(path.join(dump, 'github.json'))
  await addButton.click()
  const add = dialog('Add MCP Server from File')
  check('the dialog opens', !!(await lib.until(async () => (await add.count()) === 1)))
  const said = await add.innerText()
  check('it shows the command it runs', said.includes('Runs: npx -y @modelcontextprotocol/server-github'), said)
  check('and its environment by name, a reference as itself', said.includes('Environment: GITHUB_TOKEN=${GITHUB_TOKEN}'), said)
  check('and says it is added turned off', /added turned off/.test(said), said)
  check("the name is the file's", (await add.locator('input').inputValue()) === 'github')
  await shot('1-json-dialog')
  await add.getByRole('button', { name: 'Add' }).click()
  check('it is added', !!(await lib.until(async () => !!(await server('github')))))
  check('turned off', (await server('github'))?.globallyEnabled === false)
  check('its row shows it off', !!(await lib.until(async () => (await row('github').getByRole('switch').getAttribute('aria-checked')) === 'false')))
  const runs = page.getByLabel('What it runs')
  check("its view shows what it runs", !!(await lib.until(async () => (await runs.innerText().catch(() => '')).includes('Runs: npx -y @modelcontextprotocol/server-github'))))
  await shot('2-json-added')

  // --- A .zip of a server folder: unpacked to .hive/mcp/notes/, its definition from hive-mcp.json, turned off.
  await pick(path.join(dump, 'notes.zip'))
  await addButton.click()
  await lib.until(async () => (await add.count()) === 1)
  const zipSaid = await add.innerText()
  check('the zip shows what it runs', zipSaid.includes('Runs: node ${HIVE_MCP_DIR}/notes/server.js') && zipSaid.includes('NOTES_DIR (set)'), zipSaid)
  check('and that its file goes in a folder of its own', /with its file in a folder of its own/.test(zipSaid), zipSaid)
  await add.getByRole('button', { name: 'Add' }).click()
  check('the zip is added, turned off', !!(await lib.until(async () => (await server('notes'))?.globallyEnabled === false)))
  check("its code is in .hive/mcp/notes", fs.existsSync(path.join(mcpDir, 'notes', 'server.js')))

  // --- The same name again: Replace or Choose Another Name; another name moves its folder references.
  await pick(path.join(dump, 'notes.zip'))
  await addButton.click()
  await lib.until(async () => (await add.count()) === 1)
  await add.getByRole('button', { name: 'Add' }).click()
  const clash = dialog('Replace notes?')
  check('a name in use asks', !!(await lib.until(async () => (await clash.count()) === 1)))
  await shot('3-clash')
  await clash.getByRole('button', { name: 'Choose Another Name' }).click()
  check('Choose Another Name asks for the name again', !!(await lib.until(async () => (await add.count()) === 1)))
  await add.locator('input').fill('notes-2')
  await add.getByRole('button', { name: 'Add' }).click()
  check('it is added under the new name', !!(await lib.until(async () => !!(await server('notes-2')))))
  check('running its own folder', (await server('notes-2'))?.def?.args?.[0] === '${HIVE_MCP_DIR}/notes-2/server.js' && fs.existsSync(path.join(mcpDir, 'notes-2', 'server.js')))
  check('and the first is untouched', (await server('notes'))?.def?.args?.[0] === '${HIVE_MCP_DIR}/notes/server.js')

  // --- Enabling asks first, showing what it runs; a new session then gets it, and not the servers left off.
  await row('notes').getByRole('switch').click()
  const enable = dialog('Enable notes?')
  check('enabling asks first', !!(await lib.until(async () => (await enable.count()) === 1)), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
  check('showing what it runs', (await enable.innerText()).includes('Runs: node ${HIVE_MCP_DIR}/notes/server.js'))
  await shot('4-enable')
  await enable.getByRole('button', { name: 'Enable' }).click()
  check('it is enabled', !!(await lib.until(async () => (await server('notes'))?.globallyEnabled === true)))
  const agent = await lib.addAgent(inv, proj, { name: 'User' })
  await inv('session:start', proj, { agentId: agent.id })
  const launched = await lib.until(async () => {
    const lines = fs.existsSync(path.join(home, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(home, 'fake-launches.jsonl'), 'utf8').trim().split('\n') : []
    const l = lines.map((x) => JSON.parse(x)).find((x) => x.opts?.['--mcp-config'] && x.cwd.toLowerCase() === proj.toLowerCase())
    return l && fs.existsSync(l.opts['--mcp-config']) ? JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers : null
  }, 30000)
  check('a new session gets the enabled server', !!launched?.notes, JSON.stringify(Object.keys(launched ?? {})))
  check('running its code from the workspace', String(launched?.notes?.args?.[0] ?? '').replace(/\\/g, '/').toLowerCase() === `${mcpDir.replace(/\\/g, '/')}/notes/server.js`.toLowerCase(), JSON.stringify(launched?.notes))
  check('and not the servers left off', !launched?.github && !launched?.['notes-2'])
  await inv('session:stop', proj, agent.id)

  // --- Deleting a server added from a .zip takes its folder too (to the test copy's trash).
  await inv('mcp:delete', 'notes-2')
  check("deleting it moves its folder too", !fs.existsSync(path.join(mcpDir, 'notes-2')) && !fs.existsSync(path.join(mcpDir, 'notes-2.json')))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
