// Text on Hive's amber reads at WCAG AA (4.5:1) in both themes, measured as drawn (computed colours in the window):
// - menus (#362): a hovered or keyboard-chosen entry, and the command palette's chosen row: its label, icon, shortcut
//   and second line on the fill, a greyed entry's label too, and Recent's ✕; on a real context menu (a project's, in
//   the sidebar) with entries of each kind added to it. A session action's entry keeps its own wash (#344);
// - the status bar (#384): its items resting and hovered, a secondary part, and the caution, warning, update and
//   update-ready items (added beside its own); the activity bar's and a project's count badges.
// Throwaway profile and workspace, quiet; no agent is started. Empty Claude Code and Codex homes of its own: Hive looks
// for both CLIs when it starts, and their sign-in checks must never read the user's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'contrast-profile')
const ws = path.join(lib.WORK, 'contrast-ws')
const homes = { CLAUDE_CONFIG_DIR: path.join(lib.WORK, 'contrast-claude-home'), CODEX_HOME: path.join(lib.WORK, 'contrast-codex-home') }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/**
 * In the window: each listed part of an element against the element's own background, as contrast ratios. Colours as
 * computed (rgb(), or color(srgb …) for a mix), a translucent background laid over the nearest one under it.
 */
function measure([selector, parts]) {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (m) {
      const [r, g, b, a = 1] = m[1].split(',').map(Number)
      return [r, g, b, a]
    }
    const s = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c)
    return s ? [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : Number(s[4])] : null
  }
  const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3]))
  const lum = (c) => {
    const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
  }
  const el = document.querySelector(selector)
  if (!el) return null
  // What shows through a translucent background: the nearest ancestor that paints one.
  let under = el.parentElement
  while (under && parse(getComputedStyle(under).backgroundColor)?.[3] === 0) under = under.parentElement
  const panel = under ? parse(getComputedStyle(under).backgroundColor) : [255, 255, 255, 1]
  const bg = over(parse(getComputedStyle(el).backgroundColor), panel)
  const out = { background: bg.map(Math.round) }
  // A part's colour as seen: its alpha times the opacity of it and its parents up to the measured element.
  const seen = (part) => {
    const c = parse(getComputedStyle(part).color)
    for (let n = part; n && n !== el.parentElement; n = n.parentElement) c[3] *= Number(getComputedStyle(n).opacity)
    return over(c, bg)
  }
  for (const p of parts) {
    const part = p === '' ? el : el.querySelector(p)
    out[p || 'label'] = part ? ratio(seen(part), bg) : null
  }
  return out
}

;(async () => {
  for (const d of [userData, ws, ...Object.values(homes)]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  for (const d of Object.values(homes)) fs.mkdirSync(d, { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: homes, viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const shot = (name, clip) => page.screenshot({ path: path.join(lib.WORK, `contrast-${name}.png`), ...(clip ? { clip } : {}) })
  /** Every listed part reaches 4.5:1 (a part that isn't there doesn't count). */
  const allAA = (r) => !!r && Object.entries(r).every(([k, v]) => k === 'background' || v === null || v >= 4.5)

  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    // A real menu: the project's, in the sidebar. Then entries of each kind beside its own, drawn by the same rules.
    await page.mouse.move(5, 5)
    await page.locator('.project-row', { hasText: 'demo' }).first().click({ button: 'right' })
    const menu = page.locator('.menu').first()
    check(`${theme}: the project's menu opens`, !!(await lib.until(async () => (await menu.count()) === 1, 5000)))
    await menu.evaluate((m) => {
      const add = (cls, html) => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = html
        m.appendChild(d)
        return d
      }
      add('menu-item two-line probe-detail', '<i class="codicon codicon-history"></i><span class="menu-text"><span class="menu-label">A session</span><span class="menu-detail">2 hours ago · cache expired</span></span><span class="menu-key">Ctrl+R</span>')
      add('menu-item muted two-line probe-muted', '<i class="codicon codicon-circle-filled"></i><span class="menu-text"><span class="menu-label">Open in Builder</span><span class="menu-detail">open in Builder — click to show it</span></span>')
      add('menu-item recent-item probe-recent', '<i class="codicon codicon-folder"></i><span>work</span><span class="menu-key">2 projects</span><button class="recent-remove"><i class="codicon codicon-close"></i></button>')
      add('menu-item act-resume probe-action', '<i class="codicon codicon-debug-continue"></i><span class="menu-text"><span class="menu-label">Resume</span><span class="menu-detail">the last session</span></span>')
    })
    const parts = ['', '.codicon', '.menu-key', '.menu-detail', '.menu-label']
    // Hovered: one of the menu's own plain entries (not a session action's), then each added one.
    const plain = menu.locator('.menu-item', { hasText: 'Project Settings' })
    await plain.evaluate((d) => d.setAttribute('data-probe', 'own'))
    await plain.hover()
    await lib.sleep(150)
    const own = await page.evaluate(measure, ['.menu [data-probe="own"]', ['', '.codicon']])
    check(`${theme}: a hovered entry's label and icon reach 4.5:1`, !!own && own.label >= 4.5 && own['.codicon'] >= 4.5, JSON.stringify(own))
    for (const [probe, what, want] of [
      ['.probe-detail', 'label, icon, shortcut and second line', parts],
      ['.probe-muted', "a greyed entry's label and second line", ['.menu-label', '.menu-detail', '.codicon']],
      ['.probe-recent', "a Recent entry's name, note and ✕", ['', '.menu-key', '.recent-remove']],
      ['.probe-action', "a session action's label and second line, on its own wash", ['.menu-label', '.menu-detail', '.codicon']]
    ]) {
      await page.locator(probe).hover()
      await lib.sleep(150)
      const r = await page.evaluate(measure, [`.menu ${probe}`, want])
      const low = r && Object.entries(r).filter(([k, v]) => k !== 'background' && v !== null && v < 4.5)
      check(`${theme}: hovered, ${what} reach 4.5:1`, !!r && low.length === 0, JSON.stringify(r))
      if (probe === '.probe-detail') await shot(`${theme}-menu-hover`)
    }
    // Chosen from the keyboard (.active): the same fill.
    await page.mouse.move(5, 5)
    await page.locator('.probe-detail').evaluate((d) => d.classList.add('active'))
    const active = await page.evaluate(measure, ['.menu .probe-detail', parts])
    check(`${theme}: chosen from the keyboard, every part reaches 4.5:1`, !!active && Object.entries(active).every(([k, v]) => k === 'background' || v === null || v >= 4.5), JSON.stringify(active))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await menu.count()) === 0, 3000)

    // The command palette's chosen row: its label, category and shortcut.
    await page.keyboard.press('Control+Shift+P')
    const row = page.locator('.palette-item.active')
    check(`${theme}: the palette opens with a chosen row`, !!(await lib.until(async () => (await row.count()) === 1, 5000)))
    const pal = await page.evaluate(measure, ['.palette-item.active', ['', '.cat', 'kbd']])
    check(`${theme}: the palette's chosen row reaches 4.5:1 (label, category, shortcut)`, !!pal && Object.entries(pal).every(([k, v]) => k === 'background' || v === null || v >= 4.5), JSON.stringify(pal))
    await shot(`${theme}-palette`)
    await page.keyboard.press('Escape')
    await lib.sleep(200)

    // The status bar (#384): one of its own items, resting and hovered; then items of each kind added beside them.
    const bar = page.locator('.statusbar')
    const item = bar.locator('.status-item:not(.warn):not(.caution):not(.update-item)').first()
    await item.evaluate((d) => d.setAttribute('data-probe', 'status'))
    await page.mouse.move(5, 5)
    await lib.sleep(150)
    const rest = await page.evaluate(measure, ['.statusbar [data-probe="status"]', ['']])
    check(`${theme}: a status bar item reaches 4.5:1`, allAA(rest), JSON.stringify(rest))
    await item.hover()
    await lib.sleep(150)
    const hovered = await page.evaluate(measure, ['.statusbar [data-probe="status"]', ['']])
    check(`${theme}: hovered, a status bar item reaches 4.5:1`, allAA(hovered), JSON.stringify(hovered))
    await page.mouse.move(5, 5)
    await bar.evaluate((b) => {
      const add = (cls, html) => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = html
        b.appendChild(d)
      }
      add('status-item probe-sub', '<i class="codicon codicon-pulse"></i><span>Claude Code</span><span class="status-sub">5h 55%</span>')
      add('status-item caution probe-caution', '<i class="codicon codicon-bell"></i><span>2 need you</span>')
      add('status-item warn probe-warn', '<i class="codicon codicon-warning"></i><span>Git</span>')
      add('status-item update-item probe-update', '<i class="codicon codicon-cloud-download"></i><span>Update 40%</span>')
      add('status-item update-item ready probe-ready', '<i class="codicon codicon-arrow-circle-up"></i><span>Restart to update</span>')
    })
    for (const [probe, what, want] of [
      ['.probe-sub', 'a secondary part', ['', '.status-sub']],
      ['.probe-caution', 'a caution item', ['', '.codicon']],
      ['.probe-warn', 'a warning item', ['', '.codicon']],
      ['.probe-update', 'an update item', ['', '.codicon']],
      ['.probe-ready', 'an update-ready item', ['', '.codicon']]
    ]) {
      const r = await page.evaluate(measure, [`.statusbar ${probe}`, want])
      check(`${theme}: ${what} in the status bar reaches 4.5:1`, allAA(r), JSON.stringify(r))
      // Hovered too: these keep their own background.
      await page.locator(probe).hover()
      await lib.sleep(120)
      const h = await page.evaluate(measure, [`.statusbar ${probe}`, want])
      check(`${theme}: hovered, ${what} in the status bar reaches 4.5:1`, allAA(h), JSON.stringify(h))
    }
    await page.mouse.move(5, 5)
    await lib.sleep(120)
    const vp = page.viewportSize()
    await shot(`${theme}-statusbar`, { x: 0, y: vp.height - 60, width: vp.width, height: 60 })

    // The count badges: the activity bar's and a project's (#384), added where Hive shows them.
    await page.evaluate(() => {
      const a = document.querySelector('.activitybar .activity-btn')
      const s = document.createElement('span')
      s.className = 'activity-badge probe-activity'
      s.textContent = '3'
      a?.appendChild(s)
      const project = document.querySelector('.project-row')
      const n = document.createElement('span')
      n.className = 'project-need-count probe-need'
      n.textContent = '2'
      project?.appendChild(n)
    })
    for (const [probe, what] of [['.probe-activity', "the activity bar's count"], ['.probe-need', "a project's needs-you count"]]) {
      const r = await page.evaluate(measure, [probe, ['']])
      check(`${theme}: ${what} reaches 4.5:1`, allAA(r), JSON.stringify(r))
    }
    await shot(`${theme}-badges`, { x: 0, y: 0, width: 340, height: 240 })
    await page.evaluate(() => document.querySelectorAll('.probe-sub, .probe-caution, .probe-warn, .probe-update, .probe-ready, .probe-activity, .probe-need').forEach((e) => e.remove()))
  }

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
