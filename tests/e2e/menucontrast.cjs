// Menu selection contrast (#362): a hovered or keyboard-chosen menu entry, and the command palette's chosen row, read at
// WCAG AA (4.5:1) in both themes: its label, icon, shortcut and second line on the fill, a greyed entry's label too, and
// Recent's ✕. Measured as drawn (computed colours in the window), on a real context menu (a project's, in the sidebar)
// with entries of each kind added to it, and on the palette. A session action's entry keeps its own wash (#344).
// Throwaway profile and workspace, quiet; no agent is started. Empty Claude Code and Codex homes of its own: Hive looks
// for both CLIs when it starts, and their sign-in checks must never read the user's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'menucontrast-profile')
const ws = path.join(lib.WORK, 'menucontrast-ws')
const homes = { CLAUDE_CONFIG_DIR: path.join(lib.WORK, 'menucontrast-claude-home'), CODEX_HOME: path.join(lib.WORK, 'menucontrast-codex-home') }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/**
 * In the window: each listed part of an element against the element's own background, as contrast ratios. Colours as
 * computed (rgb(), or color(srgb …) for a mix), a translucent background laid over the menu's.
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
  const panel = parse(getComputedStyle(el.closest('.menu, .palette') ?? document.body).backgroundColor)
  const bg = over(parse(getComputedStyle(el).backgroundColor), panel)
  const out = { background: bg.map(Math.round) }
  for (const p of parts) {
    const part = p === '' ? el : el.querySelector(p)
    out[p || 'label'] = part ? ratio(over(parse(getComputedStyle(part).color), bg), bg) : null
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
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `menucontrast-${name}.png`) })

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
  }

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
