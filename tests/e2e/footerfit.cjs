// An agent's footer short of room (#217): its items give up their text for their icon in turn, each before its text
// would be cut (the session's is always just its icon; then the transcript size, the context's tokens, the whole
// context), then the permission mode's label shortens (its icon and caret stay), and only then is the cost cut off at
// the right. Narrowed a few pixels at a time, a Claude Code agent's footer (priced, so it has a cost) and a Codex
// agent's ("Approve for me", its longest label), at 100% and 125% zoom: nothing overlaps, every step comes in that
// order and widening brings the text back. Screenshots of each step in both themes. The agents are the fake Claude
// Code and the fake Codex. Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'footerfit-profile')
const ws = path.join(lib.WORK, 'footerfit-ws')
const claudeHome = path.join(lib.WORK, 'footerfit-claude-home')
const codexHome = path.join(lib.WORK, 'footerfit-codex-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
  return v
}

/** In the page: narrows the agent's footer from `from` (null: its pane's width) to `to` px, `step` at a time, and says what it shows at each width. */
function sweep([agent, from, to, step]) {
  const r = (x) => x.getBoundingClientRect()
  const el = [...document.querySelectorAll('.agent-pane')].filter((p) => p.querySelector('.pane-header-bar')?.textContent.includes(agent)).map((p) => p.querySelector('.pane-footer-bar')).find((f) => f && f.getBoundingClientRect().width > 0)
  if (!el) return [{ w: -1, fit: -1, overlaps: ['no footer shown for ' + agent + ': ' + [...document.querySelectorAll('.agent-pane')].map((p) => p.querySelector('.pane-header-bar')?.textContent + '=' + Math.round(p.querySelector('.pane-footer-bar')?.getBoundingClientRect().width ?? -1)).join(', ')] }]
  el.style.width = ''
  from = from ?? Math.floor(r(el).width)
  const full = (x) => !!x && x.clientWidth > 0 && x.scrollWidth <= x.clientWidth + 1
  const gone = (x) => !x || x.clientWidth === 0
  const read = () => {
    const fb = r(el)
    const items = [...el.children].filter((k) => !k.classList.contains('grow') && r(k).width > 0)
    const overlaps = []
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const [a, b] = [r(items[i]), r(items[j])]
        if (a.right > b.left + 0.5 && b.right > a.left + 0.5) overlaps.push(`${items[i].textContent.trim() || i} / ${items[j].textContent.trim() || j}`)
      }
    const size = el.querySelector('.size-text')
    const ctx = el.querySelector('.ctx-text')
    const tokens = el.querySelector('.ctx-tokens')
    const chip = el.querySelector('.mode-chip')
    const label = chip?.querySelector('.mode-label')
    const cost = items.find((k) => /\$/.test(k.textContent))
    return {
      w: Math.round(fb.width),
      fit: Number(el.dataset.fit ?? 0),
      size: !size ? null : full(size) ? 'full' : gone(size) ? 'icon' : 'cut',
      ctx: !ctx ? null : gone(ctx) ? 'icon' : !full(ctx) ? 'cut' : tokens && gone(tokens) ? 'pct' : tokens && !full(tokens) ? 'cut' : 'full',
      label: !label ? null : full(label) ? 'full' : 'cut',
      labelWidth: label ? label.clientWidth : 0,
      chipIcons: !chip || [...chip.querySelectorAll('.codicon')].every((i) => r(i).width > 0 && r(i).left >= r(chip).left - 0.5 && r(i).right <= Math.min(r(chip).right, fb.right) + 0.5),
      cost: !cost ? null : r(cost).right <= fb.right + 0.5 ? 'shown' : 'cut',
      overlaps
    }
  }
  const wait = () => new Promise((res) => setTimeout(res, 25))
  return (async () => {
    const out = []
    for (let w = from; step > 0 ? w <= to : w >= to; w += step) {
      el.style.width = `${w}px`
      await wait()
      let s = read()
      // A level change renders again: wait until it settles.
      for (let i = 0; i < 5; i++) {
        await wait()
        const again = read()
        if (JSON.stringify(again) === JSON.stringify(s)) break
        s = again
      }
      out.push(s)
    }
    el.style.width = ''
    return out
  })()
}

/** Everything wrong with a narrowing sweep (widest first): an item cut, a step out of order, an overlap. */
function problems(states, { hasSize, hasCtx, hasCost }) {
  const bad = []
  let prev = null
  for (const s of states) {
    const at = `${s.w}px`
    if (s.overlaps.length) bad.push(`${at}: overlap ${s.overlaps.join(', ')}`)
    if (s.size === 'cut' || s.ctx === 'cut') bad.push(`${at}: an item's text cut (size ${s.size}, context ${s.ctx})`)
    if (prev && s.fit < prev.fit) bad.push(`${at}: steps back (${prev.fit} → ${s.fit})`)
    if (hasSize && (s.fit >= 1 ? s.size !== 'icon' : s.size !== 'full')) bad.push(`${at}: level ${s.fit} but size ${s.size}`)
    if (hasCtx && s.fit < 2 && s.ctx !== 'full') bad.push(`${at}: level ${s.fit} but context ${s.ctx}`)
    if (hasCtx && s.fit === 3 && s.ctx !== 'icon') bad.push(`${at}: level 3 but context ${s.ctx}`)
    if (s.label === 'cut' && s.fit < 3 && (hasSize || hasCtx)) bad.push(`${at}: the mode's label shortens before the items give way (level ${s.fit})`)
    if (hasCost && s.cost === 'cut' && s.labelWidth > 1) bad.push(`${at}: the cost is cut while the mode still has ${s.labelWidth}px of label`)
    if (s.cost !== 'cut' && !s.chipIcons) bad.push(`${at}: the mode's icon or caret is cut`)
    prev = s
  }
  return bad
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47916), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.waitForProvider(inv, 'codex')
  // A price for the fake model, so the Claude Code agent has a cost.
  await inv('settings:setProviderPrices', 'claude-code', { 'claude-fake': { input: 1000, cachedInput: 100, cacheWrite: 1000, output: 1000 } })
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const claude = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const codex = await lib.addAgent(inv, alpha, { name: 'Checker', provider: 'codex', permissionMode: 'approve-for-me' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
  check('both agents start', !!(await until(async () => (await live(claude.id))?.status === 'ready' && (await live(codex.id))?.status === 'ready', 25000)))
  const key = lib.ptyKey(alpha, claude.id)
  await inv('pty:write', key, 'hello window 1000')
  await lib.sleep(100)
  await inv('pty:write', key, '\r')
  await until(async () => (await live(claude.id))?.status === 'finished', 10000)

  const footerOf = (name) => page.locator('.agent-pane:visible', { has: page.locator('.pane-header-bar', { hasText: name }) }).locator('.pane-footer-bar')
  const cf = footerOf('Writer')
  // Every item there: the session's icon, the context with its percentage, the transcript size and the cost.
  const ready = await until(async () => {
    const t = await cf.innerText().catch(() => '')
    return /\d+%/.test(t) && /\d+(\.\d+)? (B|KB)/.test(t) && /≈\$/.test(t) && (await cf.locator('.session-tag').count()) === 1
  }, 20000)
  check("the Claude Code agent's footer has every item", !!ready, await cf.innerText().catch(() => ''))
  check("the Codex agent's footer says Approve for me", /Approve for me/.test(await footerOf('Checker').innerText().catch(() => '')), await footerOf('Checker').innerText().catch(() => ''))
  // One agent at a time, so each footer has the pane's whole width to give up, at 125% too.
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  /** Shows the agent (one at a time). */
  const show = async (name, tag) => {
    await page.locator('.agent-tab', { hasText: name }).click()
    const shown = await until(async () => (await footerOf(name).count()) === 1 && ((await footerOf(name).boundingBox())?.width ?? 0) > 0, 5000)
    if (!shown) await page.screenshot({ path: path.join(lib.WORK, `footerfit-show-${tag}.png`) })
    await lib.sleep(300)
  }

  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.sleep(600)
    const z = `${zoom * 100}%`
    // Claude Code: every step.
    await show('Writer', 'claude')
    const states = await page.evaluate(sweep, ['Writer', null, 120, -3])
    check(`${z}: Claude Code footer: every step in order, nothing cut early, nothing overlapping`, !problems(states, { hasSize: true, hasCtx: true, hasCost: true }).length, problems(states, { hasSize: true, hasCtx: true, hasCost: true }).slice(0, 6).join('; '))
    const first = (fit) => states.find((s) => s.fit === fit)
    check(`${z}: …starts with everything in full`, states[0].fit === 0 && states[0].size === 'full' && states[0].ctx === 'full' && states[0].label === 'full' && states[0].cost === 'shown', JSON.stringify(states[0]))
    check(`${z}: …then the transcript size is its icon, the rest in full`, !!first(1) && first(1).ctx === 'full' && first(1).label === 'full' && first(1).cost === 'shown', JSON.stringify(first(1)))
    check(`${z}: …then the context its percentage, the rest in full`, !!first(2) && first(2).ctx === 'pct' && first(2).label === 'full' && first(2).cost === 'shown', JSON.stringify(first(2)))
    check(`${z}: …then the context its icon, the mode and cost in full`, !!first(3) && first(3).ctx === 'icon' && first(3).label === 'full' && first(3).cost === 'shown', JSON.stringify(first(3)))
    const labelCut = states.find((s) => s.label === 'cut')
    check(`${z}: …then the mode's label shortens, its icon and caret stay, the cost still shown`, !!labelCut && labelCut.chipIcons && labelCut.cost === 'shown', JSON.stringify(labelCut))
    check(`${z}: …and only very narrow is the cost cut off`, states.at(-1).cost === 'cut' && states.at(-1).labelWidth <= 1, JSON.stringify(states.at(-1)))
    // Widening brings the text back, step by step.
    const back = await page.evaluate(sweep, ['Writer', 120, states[0].w, 8])
    check(`${z}: widening brings each back`, back.at(-1).fit === 0 && back.at(-1).size === 'full' && back.at(-1).ctx === 'full' && back.every((s, i) => i === 0 || s.fit <= back[i - 1].fit), JSON.stringify(back.at(-1)))
    // Codex: its longest label shortens before anything is cut off.
    await show('Checker', 'codex')
    const cx = await page.evaluate(sweep, ['Checker', null, 100, -3])
    const cxBad = problems(cx, { hasSize: cx.some((s) => s.size), hasCtx: cx.some((s) => s.ctx), hasCost: cx.some((s) => s.cost) })
    check(`${z}: Codex footer: in order, nothing overlapping, its icon and caret always shown`, !cxBad.length, cxBad.slice(0, 6).join('; '))
    // A level flipping back and forth on a rounding edge would loop until React gives up (the window's error view).
    check(`${z}: the window survives every width (no render loop)`, (await page.locator('.error-boundary').count()) === 0 && (await page.locator('.agent-tab').count()) === 2)
    check(`${z}: …"Approve for me" in full when there is room, shortened when not`, cx[0].label === 'full' && cx.some((s) => s.label === 'cut' && s.chipIcons), JSON.stringify(cx.find((s) => s.label === 'cut')))
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.sleep(400)

  // Screenshots of each step, both themes.
  await show('Writer', 'claude')
  const all = await page.evaluate(sweep, ['Writer', null, 120, -3])
  const widthFor = (pred) => all.find(pred)?.w
  const shots = [
    ['0-full', (s) => s.fit === 0],
    ['1-size', (s) => s.fit === 1],
    ['2-pct', (s) => s.fit === 2],
    ['3-ctx', (s) => s.fit === 3 && s.label === 'full'],
    ['4-label', (s) => s.label === 'cut' && s.cost === 'shown']
  ]
  const widths = []
  for (const [, pred] of shots) widths.push(widthFor(pred))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    for (let i = 0; i < shots.length; i++) {
      if (!widths[i]) continue
      await cf.evaluate((el, w) => (el.style.width = `${w}px`), widths[i])
      await lib.sleep(250)
      const box = await cf.boundingBox()
      await page.screenshot({ path: path.join(lib.WORK, `footerfit-${shots[i][0]}-${theme}.png`), clip: { x: box.x, y: box.y - 4, width: Math.max(box.width, 200), height: box.height + 8 } })
    }
    await cf.evaluate((el) => (el.style.width = ''))
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  for (const a of [claude, codex]) await inv('session:stop', alpha, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
