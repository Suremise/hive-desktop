// The Session tab's Tiles view and focus view (#976). Thirteen agents, three of them running the fake Claude Code
// (fake-claude/): A finished a turn (its reply on its tile), B works, M (the thirteenth) waits for a permission. Tiles: 12 a
// page, so two pages; in the panes' order (Settings → Sessions → Tile order, the default) M is on page 2, highlighted, and
// page 2's button counts it; By urgency puts it first. A tile shows the state's mark, name, provider, status and the start
// of the latest reply. The keyboard: one tab stop in the grid, arrows between tiles, Enter opens the focus view (the agent's
// live pane beside a strip of the others); Esc in the terminal stays the CLI's, Esc outside it (the strip), Ctrl+Alt+Esc,
// the strip's Tiles button and the Tiles toggle go back, the keyboard on the agent's tile. Paging with the page buttons and
// Ctrl+Alt+PageDown; the chip's list opens an agent's focus view; Panes leaves it. Reordering (#993), in the panes'
// order: a tile dragged onto another swaps them, onto a page button goes to that page's end, and Move Agent Left/Right
// (the keys, an override without modifiers, the tile's menu) move the tile the keyboard is on, other shortcuts and chords
// still working there; the order is saved and the panes show it; By urgency, no tile drags. Throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'tilesview-profile')
const ws = path.join(lib.WORK, 'tilesview-ws')
const claudeHome = path.join(lib.WORK, 'tilesview-claude-home')
const alpha = path.join(ws, 'alpha')
const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.fakeClaude(userData, claudeHome, [alpha])
  const { app, page, inv } = await lib.launch({ userData, env: { CLAUDE_CONFIG_DIR: claudeHome, HIVE_API_PORT: lib.port(47825) }, viewport: { width: 1500, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === 'alpha', HUNG_MS)
    // More than the 12 agents a project has by default (#562).
    await inv('advanced:set', 'hive.agents.perProject', 24, 'workspace')
    const ids = {}
    for (const name of NAMES) ids[name] = (await lib.addAgent(inv, alpha, { name })).id
    for (const name of ['A', 'B', 'M']) await inv('session:start', alpha, { agentId: ids[name] })
    for (const name of ['A', 'B', 'M']) await lib.until(async () => ['ready', 'waiting'].includes((await live(ids[name]))?.status), HUNG_MS)
    for (const name of ['A', 'B', 'M']) if ((await live(ids[name]))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, ids[name]), '\r')
    for (const name of ['A', 'B', 'M']) await lib.until(async () => (await live(ids[name]))?.status === 'ready', HUNG_MS)
    const prompts = (name) => lib.fakePrompts(inv, lib.ptyKey(alpha, ids[name]), () => live(ids[name]), { home: claudeHome })
    await prompts('A').type('hello tiles')
    await lib.until(async () => (await live(ids.A))?.replyStart === 'Done: hello tiles', HUNG_MS)
    await prompts('B').type('work 300')
    await lib.until(async () => (await live(ids.B))?.status === 'working', HUNG_MS)
    await prompts('M').type('ask work 300')
    await lib.until(async () => (await live(ids.M))?.status === 'waiting', HUNG_MS)
    await inv('workspace:refresh')

    // --- Panes | Tiles: the grid of tiles, 12 on page 1.
    await page.locator('.view-switch [data-view="tiles"]').click()
    const tileNames = () => page.locator('.agent-tile .tile-name').allInnerTexts().catch(() => [])
    check('Tiles: 12 tiles on page 1, in the panes order', !!(await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join(), HUNG_MS)), (await tileNames()).join())
    check('…all on screen at 1500×900, no scrolling', await page.locator('.agent-tiles').evaluate((el) => el.scrollHeight <= el.clientHeight))
    check('…no terminal drawn for them (none on screen)', (await page.locator('.terminal-host:not(.hidden)').count()) === 0)
    const tile = (name) => page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: new RegExp(`^${name}$`) }) })
    const aTile = await tile('A').evaluate((el) => ({ mark: [...(el.querySelector('.state-mark')?.classList ?? [])].join(' '), provider: el.querySelector('.tile-provider')?.textContent, reply: el.querySelector('.tile-reply')?.textContent }))
    check("A's tile: idle (a ring), Claude Code, the start of its reply", aTile.mark.includes('idle') && aTile.provider === 'Claude Code' && aTile.reply === 'Done: hello tiles', JSON.stringify(aTile))
    check("B's tile: working (its mark)", (await tile('B').locator('.state-mark.working').count()) === 1)
    check("C's tile: Not running", (await tile('C').locator('.tile-status').innerText()) === 'Not running')
    const pageButtons = () => page.locator('.session-toolbar .tile-pages button').evaluateAll((els) => els.map((b) => `${b.childNodes[0].textContent}${b.classList.contains('active') ? '*' : ''}${b.querySelector('.tile-page-count') ? `(${b.querySelector('.tile-page-count').textContent})` : ''}`).join(' '))
    check('two tile pages; page 2 counts M, waiting there', !!(await lib.until(async () => (await pageButtons()) === '1* 2(1)', HUNG_MS)), await pageButtons())
    // The count is said as well as shown: page 2's accessible name, while page 1 is chosen (the badge itself is hidden).
    const pageNames = () => page.locator('.session-toolbar .tile-pages button').evaluateAll((els) => els.map((b) => `${b.getAttribute('aria-label')}${b.getAttribute('aria-current') ? ' (current)' : ''}`).join(' | '))
    check("…page 2's accessible name says so", (await pageNames()) === 'Tile page 1 (current) | Tile page 2, 1 agent waiting for you or stalled', await pageNames())
    check("…in the accessibility tree too", !!(await page.getByRole('button', { name: 'Tile page 2, 1 agent waiting for you or stalled', exact: true }).count()))
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-grid.png') })

    // --- Page 2: M, highlighted where it is.
    await page.locator('.session-toolbar .tile-pages button').nth(1).click()
    check('page 2: M alone, highlighted (waiting)', !!(await lib.until(async () => (await tileNames()).join() === 'M', HUNG_MS)) && (await tile('M').evaluate((el) => el.classList.contains('urgent') && el.classList.contains('waiting'))), (await tileNames()).join())
    check('…page 1 has nothing urgent to count', (await pageButtons()) === '1 2*', await pageButtons())
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+PageDown')
    check('Ctrl+Alt+PageDown: back round to page 1', !!(await lib.until(async () => (await pageButtons()) === '1* 2(1)', HUNG_MS)), await pageButtons())

    // --- The keyboard: one tab stop; arrows move between tiles; Enter opens the focus view.
    const tabStops = () => page.locator('.agent-tile[tabindex="0"]').count()
    check('one tab stop in the grid', (await tabStops()) === 1)
    await tile('A').focus()
    const focusedTile = () => page.evaluate(() => document.activeElement?.closest?.('.agent-tile')?.querySelector('.tile-name')?.textContent ?? null)
    await page.keyboard.press('ArrowRight')
    check('→: B', (await focusedTile()) === 'B', await focusedTile())
    const cols = await page.locator('.agent-tile').evaluateAll((els) => els.filter((e) => e.offsetTop === els[0].offsetTop).length)
    await page.keyboard.press('ArrowDown')
    check(`↓: a row down (${cols} columns)`, (await focusedTile()) === NAMES[1 + cols], await focusedTile())
    await page.keyboard.press('Home')
    check('Home: A', (await focusedTile()) === 'A', await focusedTile())
    await page.keyboard.press('ArrowRight')
    check('…the tab stop follows the keyboard', (await page.locator('.agent-tile[tabindex="0"] .tile-name').innerText()) === 'B')
    await page.keyboard.press('Enter')
    const stripNames = () => page.locator('.tile-strip .tile-strip-item .tile-strip-name').allInnerTexts().catch(() => [])
    const paneName = () => page.locator('.agent-pane .pane-header-bar .agent-name').innerText().catch(() => '')
    const inFocus = async (name) => (await page.locator('.agents-area.shown.tile-focus').count()) === 1 && (await paneName()) === name && (await page.locator('.tile-strip-item.active .tile-strip-name').innerText().catch(() => '')) === name
    check("Enter: B's focus view, its pane beside the strip of all 13", !!(await lib.until(async () => (await inFocus('B')) && (await stripNames()).length === 13, HUNG_MS)), `${await paneName()} ${(await stripNames()).join()}`)
    check("…its live terminal shown, with the keyboard", !!(await lib.until(async () => (await page.locator('.terminal-host:not(.hidden)').count()) === 1 && (await page.evaluate(() => !!document.activeElement?.closest('.terminal-host'))), HUNG_MS)))
    check('…the grid gone, the pages none chosen', (await page.locator('.tile-grid').count()) === 0 && (await pageButtons()) === '1 2(1)', await pageButtons())
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-focus.png') })
    // Esc in the terminal is the CLI's: the focus view stays. Then a letter: keys are handled in order, so once the letter
    // is on the CLI's screen, the window has handled the Esc before it (taken back with Backspace).
    await page.keyboard.press('Escape')
    await page.keyboard.press('q')
    const screen = async () => lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, ids.B)).catch(() => ''))
    check('Esc in the terminal: the CLI has it (and the letter after it)', !!(await lib.until(async () => /\sq\s*$/.test(await screen()), HUNG_MS)), (await screen()).slice(-200))
    check('…still the focus view, the terminal keeping the keyboard', (await inFocus('B')) && (await page.evaluate(() => !!document.activeElement?.closest('.terminal-host'))))
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Control+Alt+Escape')
    check('Ctrl+Alt+Esc (Back to Tiles): the grid, the keyboard on B', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1 && (await focusedTile()) === 'B', HUNG_MS)), String(await focusedTile()))

    // --- The mouse: a tile opens it; the strip switches; Esc outside the terminal, and the Tiles toggle, go back.
    await tile('A').click()
    check("a click: A's focus view", !!(await lib.until(async () => inFocus('A'), HUNG_MS)), await paneName())
    await page.locator('.tile-strip-item', { has: page.locator('.tile-strip-name', { hasText: /^M$/ }) }).click()
    check("the strip's M: M's focus view (on page 2 of the tiles)", !!(await lib.until(async () => inFocus('M'), HUNG_MS)), await paneName())
    await page.locator('.tile-strip-item.active').focus()
    await page.keyboard.press('Escape')
    check('Esc on the strip: the grid on page 2, the keyboard on M', !!(await lib.until(async () => (await tileNames()).join() === 'M' && (await focusedTile()) === 'M', HUNG_MS)), `${(await tileNames()).join()} ${await focusedTile()}`)
    await tile('M').click()
    await lib.until(async () => inFocus('M'), HUNG_MS)
    await page.locator('.view-switch [data-view="tiles"]').click()
    check('the Tiles toggle again: the grid', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1, HUNG_MS)))
    await page.locator('.tile-strip-back').count().then((n) => check('…the strip gone', n === 0))

    // --- The chip's list opens an agent's focus view; Panes leaves it, and Tiles shows the grid again.
    await page.locator('.session-toolbar .summary-chip').click()
    await lib.until(async () => (await lib.menuEntry(page, 'B').count()) === 1, HUNG_MS)
    await lib.menuEntry(page, 'B').click()
    check("the chip's list: B's focus view", !!(await lib.until(async () => inFocus('B'), HUNG_MS)), await paneName())
    await page.locator('.view-switch [data-view="panes"]').click()
    check('Panes: the panes, no strip', !!(await lib.until(async () => (await page.locator('.agents-area.shown:not(.tile-focus)').count()) === 1 && (await page.locator('.tile-strip').count()) === 0, HUNG_MS)))
    await page.locator('.view-switch [data-view="tiles"]').click()
    check('Tiles again: the grid, not the focus view', !!(await lib.until(async () => (await page.locator('.tile-grid').count()) === 1 && (await page.locator('.tile-strip').count()) === 0, HUNG_MS)))

    // --- Tile order By urgency: M (waiting) first, then B (working), then the idle ones in their order.
    await inv('settings:update', { sessions: { tileOrder: 'urgency' } })
    const byUrgency = ['M', 'B', ...NAMES.filter((n) => n !== 'M' && n !== 'B')]
    check('By urgency: M, B, then the others in their order', !!(await lib.until(async () => (await tileNames()).join() === byUrgency.slice(0, 12).join(), HUNG_MS)), (await tileNames()).join())
    check('…nothing urgent on page 2 to count', (await pageButtons()) === '1* 2', await pageButtons())
    await page.screenshot({ path: path.join(lib.WORK, 'tilesview-urgency.png') })
    check('…no tile drags (the order is computed)', (await page.locator('.agent-tile[draggable="true"]').count()) === 0)
    await inv('settings:update', { sessions: { tileOrder: 'panes' } })

    // --- Reordering (#993), Same as panes: tiles drag like pane headers, and the panes follow.
    const saved = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8')).agents.map((a) => a.name).join()
      } catch {
        return '' // being written
      }
    }
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    check('Same as panes again: the tiles drag', !!(await lib.until(async () => (await tileNames()).join() === NAMES.slice(0, 12).join() && (await page.locator('.agent-tile[draggable="true"]').count()) === 12, HUNG_MS)), (await tileNames()).join())
    const at = async (loc) => {
      const b = await loc.boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    // A native drag with the mouse, as swap.cjs drags: press, nudge until the page's dragstart, over each stop in turn
    // (until it shows the drag over it: a tile its drop target, a page button its mark), release, then wait for its end.
    const dragState = () => page.evaluate(() => window.__tileDrag)
    const drag = async (from, stops, shot) => {
      await page.evaluate(() => {
        window.__tileDrag = 'none'
        document.addEventListener('dragstart', () => (window.__tileDrag = 'started'), { once: true })
        document.addEventListener('dragend', () => (window.__tileDrag = 'ended'), { once: true })
      })
      const a = await at(from)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      let dx = 0
      if (!(await lib.until(async () => (await dragState()) !== 'none' || void (await page.mouse.move(a.x + 8 + (dx = 1 - dx), a.y, { steps: 2 })), HUNG_MS))) throw new Error('the drag never started (no dragstart)')
      for (const loc of stops) {
        const b = await at(loc)
        await page.mouse.move(b.x, b.y, { steps: 8 })
        if ((await loc.locator('.tile-drop').count()) > 0) {
          if (!(await lib.until(async () => (await loc.locator('.tile-drop.over').count()) > 0 || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the tile never showed the drag over it')
        } else if (!(await lib.until(async () => (await loc.evaluate((el) => el.classList.contains('drop-target'))) || void (await page.mouse.move(b.x + (dx = 1 - dx), b.y, { steps: 2 })), HUNG_MS))) throw new Error('the page button never showed the drag over it')
      }
      if (shot) await page.screenshot({ path: path.join(lib.WORK, shot) })
      await page.mouse.up()
      // The source can leave the screen (moved to another page): then the drop targets going is the end.
      await lib.until(async () => (await dragState()) === 'ended' || (await page.locator('.tile-drop').count()) === 0, HUNG_MS)
    }
    const order = (names) => names.join()
    await drag(tile('A'), [tile('C')], 'tilesview-drag.png')
    const swapped = ['C', 'B', 'A', ...NAMES.slice(3)]
    check('A dropped on C: they swap, saved in project.json', !!(await lib.until(async () => saved() === order(swapped) && (await tileNames()).join() === order(swapped.slice(0, 12)), HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    check('…the drag has ended: no drop targets left', !!(await lib.until(async () => (await page.locator('.tile-drop, .tile-pages button.drop-target').count()) === 0, HUNG_MS)))
    // Page 2's button: B goes to the end, the grid showing it there.
    await drag(tile('B'), [page.locator('.session-toolbar .tile-pages button').nth(1)])
    const toEnd = ['C', 'A', ...NAMES.slice(3), 'B']
    check("B dropped on page 2's button: last, page 2 shown", !!(await lib.until(async () => saved() === order(toEnd) && (await tileNames()).join() === 'B' && (await pageButtons()).endsWith(' 2*'), HUNG_MS)), `${saved()} / ${(await tileNames()).join()} / ${await pageButtons()}`)
    // The keyboard: Move Agent Left on B's tile takes it to page 1, the keyboard staying on it.
    await tile('B').focus()
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft')
    const left = ['C', 'A', ...NAMES.slice(3, 12), 'B', 'M']
    check('Move Agent Left (Ctrl+Alt+Shift+←) on B: a place left, onto page 1, the keyboard on it', !!(await lib.until(async () => saved() === order(left) && (await tileNames()).join() === order(left.slice(0, 12)) && (await focusedTile()) === 'B', HUNG_MS)), `${saved()} / ${(await tileNames()).join()} / ${await focusedTile()}`)
    // The panes show the same order (three columns: B's page, as B is focused).
    await inv('project:updateConfig', alpha, { layout: 'columns3' })
    await inv('workspace:refresh')
    await page.locator('.view-switch [data-view="panes"]').click()
    const paneNames = () => page.locator('.agent-pane .pane-header-bar .agent-name').allInnerTexts().catch(() => [])
    check('Panes: the same order (K, L, B on its page)', !!(await lib.until(async () => (await paneNames()).join() === 'K,L,B' && (await page.locator('.agents-area.shown:not(.tile-focus)').count()) === 1, HUNG_MS)), (await paneNames()).join())
    // Back in Tiles, B's menu (from the keyboard) moves it back.
    await page.locator('.view-switch [data-view="tiles"]').click()
    await lib.until(async () => (await tile('B').count()) === 1, HUNG_MS)
    await tile('B').focus()
    await page.keyboard.press('Shift+F10')
    await lib.until(async () => (await lib.menuEntry(page, 'Move Right').count()) === 1, HUNG_MS)
    await lib.menuEntry(page, 'Move Right').click()
    check("the tile's menu, Move Right: B a place right, page 2 shown", !!(await lib.until(async () => saved() === order(toEnd) && (await tileNames()).join() === 'B', HUNG_MS)), `${saved()} / ${(await tileNames()).join()}`)
    // Other shortcuts still work from a tile, chords too: Ctrl+K Ctrl+S (Keyboard Shortcuts).
    await tile('B').focus()
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+S')
    check('a chord from a tile: Ctrl+K Ctrl+S opens Keyboard Shortcuts', !!(await lib.until(async () => (await page.locator('.dialog').innerText().catch(() => '')).startsWith('Keyboard Shortcuts'), HUNG_MS)), `${await page.locator('.dialog').count()} dialogs`)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)
    // Move Agent Right bound to F6 (no modifier): on A's tile it moves A, not B (the agent moved last).
    await inv('settings:update', { keybindings: { 'agent.moveRight': 'F6' } })
    await lib.until(async () => (await inv('settings:get')).keybindings['agent.moveRight'] === 'F6', HUNG_MS)
    await page.locator('.session-toolbar .tile-pages button').nth(0).click()
    await lib.until(async () => (await tile('A').count()) === 1, HUNG_MS)
    await tile('A').focus()
    await page.keyboard.press('F6')
    const f6 = ['C', 'D', 'A', ...NAMES.slice(4), 'B']
    check("Move Agent Right on F6, on A's tile: A a place right, the keyboard on it", !!(await lib.until(async () => saved() === order(f6) && (await tileNames()).join() === order(f6.slice(0, 12)) && (await focusedTile()) === 'A', HUNG_MS)), `${saved()} / ${await focusedTile()}`)
    // Bound to a plain arrow, the command wins over moving between tiles: Move Agent Left on ←.
    await inv('settings:update', { keybindings: { 'agent.moveRight': 'F6', 'agent.moveLeft': 'ArrowLeft' } })
    await lib.until(async () => (await inv('settings:get')).keybindings['agent.moveLeft'] === 'ArrowLeft', HUNG_MS)
    await tile('A').focus()
    await page.keyboard.press('ArrowLeft')
    const back = ['C', 'A', ...NAMES.slice(3), 'B']
    check("Move Agent Left on ←, on A's tile: A moves back (not the keyboard to the tile beside it)", !!(await lib.until(async () => saved() === order(back) && (await tileNames()).join() === order(back.slice(0, 12)) && (await focusedTile()) === 'A', HUNG_MS)), `${saved()} / ${await focusedTile()}`)
  } finally {
    await inv('session:stop', alpha).catch(() => undefined)
    await lib.until(async () => (await inv('session:live').catch(() => [])).length === 0, HUNG_MS)
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
