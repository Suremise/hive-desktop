// The agent footer's context: tokens only until the CLI reports the context window, then tokens and percentage
// ("20 · 2%"); in a narrow footer only the percentage. Its tooltip ends with "Click to view compaction history".
// The agent is the fake Claude Code, whose "window N" makes its status line report an N-token window. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'ctxpercent-profile')
const ws = path.join(lib.WORK, 'ctxpercent-ws')
const claudeHome = path.join(lib.WORK, 'ctxpercent-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47905), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Counter' })
  const key = lib.ptyKey(alpha, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))
  const send = async (text) => {
    await inv('pty:write', key, text)
    await lib.sleep(100)
    await inv('pty:write', key, '\r')
    await until(async () => (await live())?.status === 'finished', 10000)
  }
  const footer = page.locator('.pane-footer-bar').first()
  const ctxItem = footer.locator('.pane-foot-item', { has: page.locator('.codicon-dashboard') })
  const text = () => ctxItem.innerText().catch(() => '')

  await send('hello')
  check('without a known window: tokens only', !!(await until(async () => /^\s*\d+(\.\d)?k? ctx$/.test(await text()), 8000)), await text())
  await send('hello again window 1000')
  check('once the CLI reports it: tokens and percentage', !!(await until(async () => /^\s*\d+ ·\s+\d+%$/.test(await text()), 8000)), await text())
  const [tokens, pct] = (await text()).trim().match(/(\d+) ·\s+(\d+)%/)?.slice(1).map(Number) ?? []
  check('the percentage is of that window', pct === Math.round((tokens / 1000) * 100), `${tokens} tokens, ${pct}%`)
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-1-wide.png') })

  // --- Its tooltip ends with an empty line, then what a click does (#121).
  await ctxItem.hover()
  const tip = page.locator('.tip .ctx-tip')
  await until(async () => (await tip.count()) === 1, 5000)
  const lines = (await tip.innerText().catch(() => '')).split('\n')
  check('the tooltip: the context, an empty line, then "Click to view compaction history"', /^Context: \d/.test(lines[0] ?? '') && lines.length >= 3 && lines.at(-2) === '' && lines.at(-1) === 'Click to view compaction history', JSON.stringify(lines))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-tip-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-tip-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(5, 5)

  // --- A narrow footer keeps the percentage.
  // Narrowed until the context gives up its tokens (after the transcript size: footerfit has the whole order). The
  // tokens stay in the text for screen readers, at no width.
  const shows = () => ctxItem.evaluate((el) => ({ tokens: el.querySelector('.ctx-tokens')?.clientWidth ?? -1, ctx: el.querySelector('.ctx-text')?.clientWidth ?? -1 }))
  let narrow = await shows()
  for (let w = 700; w >= 150 && !(narrow.tokens === 0 && narrow.ctx > 0); w -= 10) {
    await footer.evaluate((el, px) => (el.style.width = `${px}px`), w)
    await lib.sleep(60)
    narrow = await shows()
  }
  check('narrow: only the percentage', narrow.tokens === 0 && narrow.ctx > 0, JSON.stringify(narrow))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-2-narrow.png') })
  await footer.evaluate((el) => (el.style.width = ''))

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
