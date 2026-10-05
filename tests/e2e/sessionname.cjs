// A running session's name in its agent's footer: the start time until it has a name, renames from the footer
// and with /rename (the latest wins), a /rename made before a resume carried over, and the name giving way
// first in a narrow pane. The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'sessionname-profile')
const ws = path.join(lib.WORK, 'sessionname-ws')
const claudeHome = path.join(lib.WORK, 'sessionname-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47898), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const key = lib.ptyKey(alpha, agent.id)
  /** Types a line in the agent's terminal; a prompt waits for its turn to end. */
  const type = async (text, prompt = true) => {
    await inv('pty:write', key, text)
    await lib.sleep(300)
    await inv('pty:write', key, '\r')
    if (!prompt) return
    await until(async () => (await live())?.status === 'finished', 15000)
  }
  const records = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'sessions.json'), 'utf8')).sessions
  const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  const st = await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 15000)))
  const header = page.locator('.pane-header-bar', { hasText: 'Writer' })
  const footer = page.locator('.agent-pane', { has: header }).locator('.pane-footer-bar')
  const tag = footer.locator('.session-tag')
  const text = async () => (await tag.count() ? (await tag.innerText()).trim() : '')
  check('the name is in the footer, not the header', !!(await until(async () => (await tag.count()) === 1, 8000)) && (await header.locator('.session-tag').count()) === 0)
  // Hive's automatic name is "alpha · <date>": the footer shows only the start time.
  const auto = records().find((r) => r.id === st.sessionId)?.name ?? ''
  check('Hive named it automatically and passed that to Claude Code', auto.startsWith('alpha · ') && launches().at(-1).opts['--name'] === auto, auto)
  check('until it has a name, the footer shows when it started', /^\d{1,2}[:.]\d{2}/.test(await text()) && !/alpha/.test(await text()), await text())
  await type('turn 1')
  const ctx = footer.locator('.pane-foot-item', { hasText: 'ctx' })
  check('it sits right, before the context', !!(await until(async () => (await ctx.count()) === 1, 8000)) && (await tag.boundingBox()).x < (await ctx.boundingBox()).x && (await tag.boundingBox()).x > (await footer.boundingBox()).width / 3)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-1-start.png') })

  // Right-click → Rename… in the footer.
  await tag.click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Rename…' }).click()
  const dialog = page.locator('[role=dialog]', { hasText: 'Rename session' })
  // The dialog fills in the current name just after it opens: typing before that would add to it.
  await until(async () => (await dialog.count()) === 1 && (await dialog.locator('input').inputValue()) !== '', 3000)
  await dialog.locator('input').fill('Docs pass')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  check('renamed from the footer', !!(await until(async () => (await text()) === 'Docs pass', 5000)), await text())
  const rec = () => records().find((r) => r.id === st.sessionId)
  check('Hive keeps the name, and what Claude Code called it then', rec().name === 'Docs pass' && rec().titleAtRename === auto, JSON.stringify(rec()))

  // /rename in Claude Code after it: the newer name wins.
  await type('/rename Guide only', false)
  check('a /rename after it wins', !!(await until(async () => (await text()) === 'Guide only', 10000)), await text())
  // The Sessions tab shows the same name.
  await tag.click()
  const row = page.locator('.session-row.selected')
  check('the Sessions tab shows it too', !!(await until(async () => /Guide only/.test(await row.innerText().catch(() => '')), 8000)), await row.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-2-sessions.png') })
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.sleep(500)

  // Renamed in Hive again: Hive's is the newer.
  await inv('session:rename', alpha, st.sessionId, 'Final docs')
  check('a Hive rename after that wins again', !!(await until(async () => (await text()) === 'Final docs', 5000)), await text())

  // A /rename, then the session stops and is resumed: Hive takes the name rather than passing its own back.
  await type('/rename Release notes', false)
  check('the /rename shows', !!(await until(async () => (await text()) === 'Release notes', 10000)), await text())
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)
  await inv('session:start', alpha, { agentId: agent.id, resumeId: st.sessionId })
  await until(async () => (await live())?.status === 'ready', 15000)
  check('resumed with the CLI name passed back', launches().at(-1).opts['--name'] === 'Release notes', launches().at(-1).opts['--name'])
  check('Hive keeps it as the session name', rec().name === 'Release notes', rec().name)
  check('and the footer still shows it', !!(await until(async () => (await text()) === 'Release notes', 8000)), await text())

  // Narrow: the name gives way first, down to its icon; the context stays whole.
  await inv('session:rename', alpha, st.sessionId, 'A rather long session name that cannot possibly fit in a narrow pane')
  await until(async () => /rather long/.test(await text()), 5000)
  await lib.fitWindow(app, page, { width: 760, height: 700 })
  await lib.sleep(800)
  const fits = (loc) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  const name = tag.locator('.session-tag-text')
  check('the name is cut short', !(await fits(name)))
  check('the context stays whole', await fits(ctx))
  check('the icon stays', (await tag.locator('.codicon').first().boundingBox())?.width > 0)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-3-narrow.png') })

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
