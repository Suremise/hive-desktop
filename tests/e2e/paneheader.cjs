// An agent pane's header at every width: its buttons labelled, icons or only in ⋯, each fully inside its own box and
// the header, apart from each other, whatever the Merge… count (none, •, 1, 12, 1234), the agent's name, branch and
// card, running or stopped, in one or two columns, at 100% and 125% zoom. The mode follows the width both ways:
// shrinking and growing, the sidebar, the layout, the count changing, and a header hidden while the width changed.
// Compact's spinner turns for the whole compaction (after the dialog closes) and stops when it finishes, fails or is
// cancelled, with no second compaction meanwhile. The agents run the fake Claude Code (fake-claude/). Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const userData = path.join(lib.WORK, 'paneheader-profile')
const ws = path.join(lib.WORK, 'paneheader-ws')
const claudeHome = path.join(lib.WORK, 'paneheader-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const LABELS_FROM = 620
const ICONS_FROM = 340
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Git in the test repositories, waiting out the Hive under test's own git (lib.git, #199).
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a])

/**
 * `n` commits on top of a worktree's branch, each changing n.txt (fast-import: a four-digit count in a moment; empty
 * commits would count as merged already), and the worktree's files brought up to date.
 */
function commits(wt, n) {
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const head = git(wt, 'rev-parse', 'HEAD').trim()
  let s = ''
  for (let i = 0; i < n; i++) {
    const msg = `c${i}`
    const text = `${i}\n`
    s += `commit refs/heads/${branch}\ncommitter t <t@t> ${1700000000 + i} +0000\ndata ${msg.length}\n${msg}\n${i === 0 ? `from ${head}\n` : ''}M 644 inline n.txt\ndata ${text.length}\n${text}\n`
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: wt, input: s })
  git(wt, 'reset', '-q', '--hard', 'HEAD')
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47908), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const HEIGHT = 850
  let viewport = 1400
  await lib.fitWindow(app, page, { width: viewport, height: HEIGHT })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

  await page.getByText('alpha', { exact: true }).first().click()
  // A running worktree agent with a long name, branch and card, and a stopped one beside it.
  const long = await lib.addAgent(inv, alpha, { name: 'Agent with a rather long name', location: 'new-worktree' })
  const other = await lib.addAgent(inv, alpha, { name: 'Three', location: 'new-worktree' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, long.worktree.path, other.worktree.path].map((p) => p.toLowerCase())))
  await inv('tasks:create', { title: 'A card with a long title that takes up a lot of the header', project: 'alpha', agent: long.id, column: 'doing' })
  await inv('session:start', alpha, { agentId: long.id })
  check('the agent starts', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  const key = lib.ptyKey(alpha, long.id)
  let turns = 0
  const turn = async () => {
    turns++
    await inv('pty:write', key, `turn ${turns}`)
    await lib.sleep(300)
    await inv('pty:write', key, '\r')
    await until(async () => String(await inv('pty:buffer', key)).includes(`Done: turn ${turns}`), 15000)
    await until(async () => (await live(long.id))?.status === 'finished', 15000)
  }
  await turn()
  await page.getByRole('button', { name: 'Two columns' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 2, 5000)

  const header = (a) => page.locator('.pane-header-bar', { has: page.locator('.agent-name', { hasText: a.name }) })
  /** The header's mode, its width and everything wrong with its layout. */
  const inspect = (a) =>
    header(a).evaluate((h) => {
      const box = h.getBoundingClientRect()
      const bad = []
      const inside = (r, o, what) => {
        if (r.width === 0) return
        if (r.left < o.left - 0.5 || r.right > o.right + 0.5) bad.push(`${what} ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(o.left)}..${Math.round(o.right)}`)
      }
      if (h.scrollWidth > h.clientWidth) bad.push(`header content ${h.scrollWidth} wider than ${h.clientWidth}`)
      const controls = [...h.querySelectorAll(':scope > .tip-wrap > .pane-btn, :scope > .tip-wrap > .icon-btn')]
      let prev = null
      for (const b of controls) {
        const name = b.getAttribute('aria-label') || 'More'
        const r = b.getBoundingClientRect()
        inside(r, box, name)
        if (b.scrollWidth > b.clientWidth) bad.push(`${name}: content ${b.scrollWidth} wider than ${b.clientWidth}`)
        for (const part of b.querySelectorAll('.codicon, .btn-count, span')) inside(part.getBoundingClientRect(), r, `${name}'s ${part.className || 'label'}`)
        const count = b.querySelector('.btn-count')
        if (count && count.scrollWidth > count.clientWidth) bad.push(`${name}'s count is cut`)
        if (prev && r.left < prev.right) bad.push(`${name} overlaps the control before it`)
        prev = r
      }
      // The agent's details end before the first control.
      const first = controls[0]?.getBoundingClientRect()
      for (const d of h.querySelectorAll('.agent-name, .agent-branch, .pane-status, .card-chip')) {
        const r = d.getBoundingClientRect()
        if (first && r.width > 0 && r.right > first.left + 0.5) bad.push(`${d.className} runs under the controls`)
      }
      const buttons = [...h.querySelectorAll('.pane-btn')]
      const mode = !buttons.length ? 'menu' : buttons.some((b) => !b.classList.contains('icon-only')) ? 'labels' : 'icons'
      return { width: h.clientWidth, mode, bad, count: h.querySelector('[aria-label="Merge…"] .btn-count')?.textContent ?? '' }
    })
  /** A picture of both headers. */
  const shot = async (file) => {
    const box = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.pane-header-bar')].map((h) => h.getBoundingClientRect())
      return { x: Math.min(...r.map((b) => b.left)), y: Math.min(...r.map((b) => b.top)), width: Math.max(...r.map((b) => b.right)) - Math.min(...r.map((b) => b.left)), height: 34 }
    })
    for (const k of Object.keys(box)) box[k] *= zoom
    await page.screenshot({ path: path.join(lib.WORK, file), clip: box })
  }
  const expected = (w) => (w >= LABELS_FROM ? 'labels' : w >= ICONS_FROM ? 'icons' : 'menu')
  let zoom = 1
  /** Sizes the page so the first header is `target` CSS pixels wide. */
  const widthTo = async (target) => {
    for (let i = 0; i < 8; i++) {
      const w = (await inspect(long)).width
      if (w === target) return true
      viewport = Math.max(200, Math.round(viewport + (target - w) * zoom * 2))
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      await lib.sleep(120)
    }
    for (let i = 0; i < 40; i++) {
      const w = (await inspect(long)).width
      if (w === target) return true
      viewport += w < target ? 1 : -1
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      await lib.sleep(60)
    }
    return (await inspect(long)).width === target
  }
  let shownCount = ''
  /** Both headers at their mode for their width, showing the count (unless only in ⋯), with nothing out of place. */
  const fits = async (what) => {
    await lib.sleep(150)
    for (const a of [long, other]) {
      const r = await inspect(a)
      const countOk = r.mode === 'menu' || !a.worktree || r.count === shownCount
      check(`${what}: ${a.name === 'Three' ? 'stopped' : 'running'} agent's header is ${expected(r.width)} at ${r.width}px and fits`, r.mode === expected(r.width) && !r.bad.length && countOk, `${r.mode}; count ${r.count}; ${r.bad.join('; ')}`)
    }
  }
  /** Sets both agents' unmerged work: n commits, • for an uncommitted file alone, 0 for none. */
  const setCount = async (n) => {
    const base = git(alpha, 'rev-parse', 'HEAD').trim()
    for (const a of [long, other]) {
      git(a.worktree.path, 'reset', '-q', '--hard', base)
      fs.rmSync(path.join(a.worktree.path, 'dirty.txt'), { force: true })
      if (n === '•') fs.writeFileSync(path.join(a.worktree.path, 'dirty.txt'), 'x')
      else if (n) commits(a.worktree.path, n)
      await inv('agents:branchStatus', alpha, a.id)
    }
    shownCount = n ? String(n) : ''
    const ahead = typeof n === 'number' ? n : 0
    const dirty = n === '•' ? 1 : 0
    const told = await until(async () => {
      const all = await inv('agents:branchStatuses')
      return [long, other].every((a) => {
        const st = all.find((b) => b.agentId === a.id)?.status
        return st?.ahead === ahead && st?.dirty === dirty
      })
    }, 8000)
    await lib.sleep(300)
    return !!told
  }

  // Every count at both boundaries and just under them.
  for (const n of [0, '•', 1, 12, 1234]) {
    check(`the Merge… count shows ${n || 'nothing'}`, await setCount(n))
    for (const w of [LABELS_FROM, LABELS_FROM - 1, ICONS_FROM, ICONS_FROM - 1]) {
      check(`header sized to ${w}px`, await widthTo(w))
      await fits(`count ${n || 'none'}, ${w}px`)
      if (n === 1234 && w !== ICONS_FROM) await shot(`paneheader-${w}-1234.png`)
    }
  }
  await widthTo(ICONS_FROM)
  await shot('paneheader-icons-1234.png')
  await widthTo(900)
  await shot('paneheader-900-1234.png')

  // Shrinking and growing across both boundaries, with the count changing in each mode.
  for (const [w, n] of [[900, 12], [500, 12], [300, 1], [500, 1234], [900, 1234], [500, '•'], [900, 0], [339, 3], [620, 3]]) {
    await widthTo(w)
    check(`count ${n} at ${w}px`, await setCount(n))
    await fits(`resized to ${w}px, count ${n}`)
  }

  // Hidden while the width changes: another project is shown, the window grows, alpha comes back.
  await widthTo(500)
  await fits('before hiding')
  check('its count shows', (await inspect(long)).count === shownCount)
  await page.getByText('beta', { exact: true }).first().click()
  await until(async () => !(await header(long).isVisible().catch(() => false)), 5000)
  viewport += 600
  await page.setViewportSize({ width: viewport, height: HEIGHT })
  await lib.sleep(300)
  await page.getByText('alpha', { exact: true }).first().click()
  await until(() => header(long).isVisible(), 5000)
  await fits('shown again after growing while hidden')
  check('and it is labelled again', (await inspect(long)).mode === 'labels')

  // The sidebar: hiding it widens the panes, showing it narrows them again.
  await widthTo(LABELS_FROM - 40)
  const before = (await inspect(long)).mode
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+B')
  await until(async () => (await inspect(long)).width > LABELS_FROM, 3000)
  await fits('sidebar hidden')
  await page.keyboard.press('Control+B')
  await until(async () => (await inspect(long)).width < LABELS_FROM, 3000)
  await fits('sidebar shown again')
  check('the sidebar round trip restores icons', before === 'icons' && (await inspect(long)).mode === 'icons', before)

  // One column: the focused header gets the whole width.
  await header(long).locator('.agent-name').click()
  await page.getByRole('button', { name: 'One at a time' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 1, 5000)
  const single = await header(long).evaluate((h) => ({ w: h.clientWidth, labelled: [...h.querySelectorAll('.pane-btn')].some((b) => !b.classList.contains('icon-only')) }))
  check('one column: labelled at its full width', single.w >= LABELS_FROM && single.labelled, JSON.stringify(single))
  await page.getByRole('button', { name: 'Two columns' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 2, 5000)
  await fits('two columns again')

  // Display scaling: the same boundaries in CSS pixels at 125%, with the widest count.
  await setCount(1234)
  zoom = 1.25
  await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
  await lib.sleep(400)
  for (const w of [LABELS_FROM, ICONS_FROM, 900]) {
    check(`125%: header sized to ${w}px`, await widthTo(w))
    await fits(`125%, ${w}px`)
  }
  await shot('paneheader-125.png')
  zoom = 1
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await setCount(0)

  // Compact's spinner, in both modes.
  const compactBtn = header(long).getByRole('button', { name: 'Compact' })
  /** Whether Compact's icon is the spinner and turns: a running animation whose angle changes. */
  const spinning = () =>
    compactBtn.evaluate(async (b) => {
      const i = b.querySelector('.codicon')
      const angle = () => {
        const m = new DOMMatrix(getComputedStyle(i).transform)
        return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI)
      }
      const running = i.getAnimations().some((a) => a.playState === 'running')
      const a1 = angle()
      await new Promise((r) => setTimeout(r, 230))
      return { loading: i.classList.contains('codicon-loading'), running, turned: angle() !== a1 }
    })
  const rects = () => header(long).evaluate((h) => [...h.querySelectorAll('.pane-btn, .icon-btn')].map((b) => `${b.getAttribute('aria-label') || 'More'}:${Math.round(b.getBoundingClientRect().width)}`).join(' '))
  const idleIcon = async () => (await compactBtn.locator('.codicon-fold').count()) === 1 && !(await spinning()).running
  const compactVia = async (focus) => {
    await compactBtn.click()
    const dialog = page.locator('[role=dialog]', { hasText: 'Compact alpha' })
    await until(() => dialog.isVisible(), 3000)
    await dialog.locator('textarea').fill(focus)
    await dialog.getByRole('button', { name: 'Compact', exact: true }).click()
    return !!(await until(async () => (await dialog.count()) === 0, 30000))
  }
  const LONG_FOCUS = `hold 6 ${'keep the header decisions, the merge badge findings and the open questions; drop the test runs. '.repeat(9)}`
  for (const w of [900, 500]) {
    await widthTo(w)
    await turn()
    check(`${w}px: Compact shows its fold icon and is still`, await idleIcon())
    const sizes = await rects()
    check(`${w}px: the dialog closes after a long focus is entered`, await compactVia(LONG_FOCUS))
    check(`${w}px: the agent is compacting`, !!(await until(async () => (await live(long.id))?.statusMessage === 'Compacting the conversation…', 5000)))
    await until(async () => (await spinning()).running, 3000)
    const s1 = await spinning()
    check(`${w}px: after the dialog closes, Compact's spinner turns`, s1.loading && s1.running && s1.turned, JSON.stringify(s1))
    await lib.sleep(2000) // A fixed wait on purpose: this checks the spinner is still turning 2 s later, so the time is the point.
    const s2 = await spinning()
    check(`${w}px: and is still turning 2 s later`, s2.loading && s2.running && s2.turned, JSON.stringify(s2))
    check(`${w}px: Compact is disabled meanwhile`, await compactBtn.isDisabled())
    await compactBtn.hover({ force: true })
    check(`${w}px: its tooltip says it is compacting`, !!(await until(async () => (await page.locator('.tip').filter({ hasText: 'Compacting the conversation…' }).count()) > 0, 3000)))
    await page.mouse.move(5, 400)
    check(`${w}px: no button changed size`, (await rects()) === sizes, `${sizes} → ${await rects()}`)
    await fits(`${w}px while compacting`)
    // No second compaction: the button does nothing, the shortcut's dialog can't send, Hive refuses.
    await compactBtn.click({ force: true })
    await lib.sleep(300)
    check(`${w}px: clicking the disabled button opens nothing`, (await page.locator('[role=dialog]', { hasText: 'Compact alpha' }).count()) === 0)
    const again = await inv('session:compact', alpha, 'again', long.id).then(() => 'sent', (e) => String(e.message ?? e))
    check(`${w}px: a second compaction is refused`, again.includes('already compacting'), again)
    check(`${w}px: the agent is ready once it has compacted`, !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
    check(`${w}px: and Compact is the still fold icon again`, !!(await until(idleIcon, 3000)))
  }
  const boundaries = fs.readdirSync(path.join(claudeHome, 'projects'), { recursive: true }).filter((f) => f.endsWith('.jsonl'))
  const compactions = boundaries.map((f) => fs.readFileSync(path.join(claudeHome, 'projects', f), 'utf8').split('"compact_boundary"').length - 1).reduce((x, y) => x + y, 0)
  check('exactly one compaction ran each time', compactions === 2, String(compactions))

  // A compaction that fails: the spinner stops.
  await turn()
  check('a failing compaction is sent', await compactVia('compactfail hold 2'))
  check('it spins while it runs', !!(await until(async () => (await spinning()).running, 3000)))
  check('after the failure the agent is ready', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  check('and Compact is still', !!(await until(idleIcon, 3000)))

  // Cancelled by stopping the agent: no spinner, and Resume is offered.
  await turn()
  check('a long compaction is sent', await compactVia('hold 30'))
  check('it spins', !!(await until(async () => (await spinning()).running, 3000)))
  await inv('session:stop', alpha, long.id)
  check('stopped mid-compaction: the header offers Resume', !!(await until(() => header(long).getByRole('button', { name: 'Resume', exact: true }).isVisible(), 10000)))
  check('and has no spinner', (await header(long).locator('.codicon-loading').count()) === 0)
  await fits('stopped after a cancelled compaction')

  // Restarted: Compact is still, and a compaction with nothing to compact ends by itself.
  await header(long).getByRole('button', { name: 'New Session' }).click()
  check('a new session starts', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  check('Compact is still in the new session', !!(await until(async () => (await compactBtn.locator('.codicon-fold').count()) === 1, 3000)))
  await inv('session:compact', alpha, '', long.id)
  check('nothing to compact: it ends by itself, and Compact is still', !!(await until(async () => (await live(long.id))?.status === 'ready' && (await compactBtn.locator('.codicon-loading').count()) === 0, 8000)))

  await inv('session:stop', alpha, long.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
