// The Assistant panel's status line and "Done by the Assistant" (#312, #399). The header has no status dot. Under it,
// "Status: …" with the Assistant's own status icon (its mark, in the status's colour, the agent's dot on it) says what the
// Assistant is doing: Not running, Idle, Working, Waiting for you (the attention colour), and a card watch's cards as the
// app's card chips (their column's colour) that open the card, with the watch's end, and Hive's own approval cards
// (stopping a busy agent) as "Waiting for your approval" in the attention colour until answered; the header no longer
// says it a second time. Between the status line and the workspace, what it has done: the last 3 (rows of one height, a
// setting's with Revert too), Show all scrolling every one inside the same height (nothing moves), Show fewer back at the
// top, and its header folding it away so the terminal gets the room (and refits); the fold is remembered for the
// workspace, across a restart. A project in the workspace list folds to one line (its dot and how many run), with the
// keyboard too, remembered across a restart. Screenshots in both themes, wide and narrow. The Assistant runs the fake
// Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistantpanel-profile')
const ws = path.join(lib.WORK, 'assistantpanel-ws')
const claudeHome = path.join(lib.WORK, 'assistantpanel-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(path.join(ws, 'alpha'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), path.join(ws, 'alpha').toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // Setting changes (with Revert) among what it does.
  cfg.settings.assistant = { ...cfg.settings.assistant, changeSettings: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47920), CLAUDE_CONFIG_DIR: claudeHome })

  let app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  let page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  let inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const key = lib.ptyKey(home, 'assistant')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const panel = () => page.locator('.assistant-panel')
  const status = () => panel().locator('.assistant-status')
  const statusText = async () => (await status().locator('.assistant-status-text').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const tone = async () => status().getAttribute('data-tone').catch(() => null)
  const type = async (text) => {
    await inv('pty:write', key, text)
    await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
    await inv('pty:write', key, '\r')
  }
  // Its turn over (a card watch keeps it watching).
  const idle = async () => !!(await lib.until(async () => ['ready', 'finished', 'watching'].includes((await live())?.status), 30000))
  const box = async (sel) => (await panel().locator(sel).first().boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const shots = async (name) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.sleep(300) // on purpose: the theme's colours settle
      await page.screenshot({ path: path.join(lib.WORK, `assistantpanel-${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }

  // --- Not running: the status line says so, once.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.until(async () => (await panel().locator('.assistant-header').count()) === 1, 5000)
  check('a status line under the header says it isn’t running', (await statusText()) === 'Status: Not running' && (await tone()) === 'off', `${await statusText()} / ${await tone()}`)
  check('…and the header doesn’t say it again, nor has a status dot', (await panel().locator('.assistant-header .pane-status').count()) === 0 && !(await panel().locator('.assistant-header').innerText()).includes('Not running') && (await panel().locator('.assistant-header .dot').count()) === 0)
  const mark = () => status().locator('.assistant-mark')
  check('…the status line starts with the Assistant’s own status icon, stopped', (await mark().count()) === 1 && (await mark().getAttribute('data-status')) === 'stopped' && (await mark().locator('svg').count()) === 1 && (await mark().locator('.dot.stopped').count()) === 1)
  check('nothing done yet: no “Done by the Assistant”', (await panel().locator('.assistant-actions').count()) === 0)

  // --- Idle, working, waiting for you.
  await panel().locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('started and idle: “Status: Idle”', !!(await lib.until(async () => (await statusText()) === 'Status: Idle' && (await tone()) === 'calm', 20000)), await statusText())
  check('…its icon idle, outlined', ['ready', 'finished', 'idle'].includes(await mark().getAttribute('data-status')) && (await mark().locator('.fill').evaluate((el) => getComputedStyle(el).opacity)) === '0')
  await type('work 4')
  check('working: “Status: Working”', !!(await lib.until(async () => (await statusText()) === 'Status: Working' && (await tone()) === 'busy', 5000)), await statusText())
  check('…its icon working, filled, with the working dot', (await mark().getAttribute('data-status')) === 'working' && (await mark().locator('.fill').evaluate((el) => getComputedStyle(el).opacity)) !== '0' && (await mark().locator('.dot.working').count()) === 1)
  await idle()
  await type('ask then work 5')
  check('asking for permission: “Status: Waiting for you”, in the attention colour', !!(await lib.until(async () => (await statusText()) === 'Status: Waiting for you' && (await tone()) === 'attention', 8000)), await statusText())
  // The attention colour (--attention-fg, the warning colour's AA shade, #399), as computed for an element of that
  // colour, against the line's own; and the text's contrast on what is really behind it (the line's tint over the
  // panel), as drawn: both composited on a canvas.
  const attentionColour = async () =>
    status().evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--attention-fg)'
      document.body.appendChild(probe)
      const want = getComputedStyle(probe).color
      probe.remove()
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d')
      const paint = (...colours) => {
        for (const c of colours) {
          ctx.fillStyle = c
          ctx.fillRect(0, 0, 1, 1)
        }
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const back = paint(getComputedStyle(el.closest('.assistant-panel')).backgroundColor, getComputedStyle(el).backgroundColor)
      const text = paint(getComputedStyle(el).color)
      const lum = (rgb) => rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0)
      const [hi, lo] = [lum(back), lum(text)].sort((x, y) => y - x)
      return { got: getComputedStyle(el).color, want, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }
    })
  /** The attention colour and its contrast in both themes (AA for its 12 px text: 4.5:1). */
  const attentionAA = async () => {
    const out = {}
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.sleep(300) // on purpose: the theme's colours settle
      out[theme] = await attentionColour()
    }
    return out
  }
  const colours = await attentionAA()
  check('…in the attention colour, with AA contrast on its tint in both themes', Object.values(colours).every((c) => c.got === c.want && c.ratio >= 4.5), JSON.stringify(colours))
  await shots('waiting')
  await idle()

  // --- What it did: under the footer, the last 3, Show all scrolls inside the same height.
  // Newest first they are: a card, two setting changes (with Revert, a taller button), then three cards.
  const task = (t) => `hive hive_create_task {"project":"alpha","title":"${t}"}`
  await type([task('First thing'), task('Second thing'), task('Third thing'), 'skill tune-settings', 'hive hive_update_setting {"id":"sessions.transcriptWarnMB","value":50}', 'hive hive_update_setting {"id":"sessions.transcriptWarnMB","value":60}', task('Sixth thing')].join(' then '))
  await idle()
  const section = panel().locator('.assistant-actions')
  check('six changes: “Done by the Assistant (6)”', !!(await lib.until(async () => /Done by the Assistant\s*\(6\)/i.test(await section.locator('.assistant-actions-head').innerText().catch(() => '')), 10000)), await section.innerText().catch(() => ''))
  const order = await page.evaluate(() => {
    const at = (sel) => document.querySelector(`.assistant-panel ${sel}`)?.getBoundingClientRect().top ?? -1
    return { status: at('.assistant-status'), actions: at('.assistant-actions'), workspace: at('.assistant-overview'), terminal: at('.assistant-terminal'), inOverview: !!document.querySelector('.assistant-overview .assistant-action') }
  })
  check('…between the status line and the workspace, above the terminal', order.status >= 0 && order.status < order.actions && order.actions < order.workspace && order.workspace < order.terminal && !order.inOverview, JSON.stringify(order))
  const rows = section.locator('.assistant-action')
  const texts = async () => (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))
  check('…the last 3, newest first: a card and two settings with Revert', (await rows.count()) === 3 && (await texts())[0].includes('Sixth thing') && (await section.locator('.assistant-revert').count()) === 2, JSON.stringify(await texts()))
  const heights = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10))
  check('…every row the same height, with or without Revert', new Set(heights).size === 1, JSON.stringify(heights))
  const list = section.locator('.show-all-list')
  const folded3 = (await list.boundingBox()).height
  const term3 = await box('.assistant-terminal')
  await section.getByRole('button', { name: /Show all 6/ }).click()
  await lib.until(async () => (await rows.count()) === 6, 3000)
  const all = await list.evaluate((el) => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight }))
  check('Show all: every one, scrolling inside the same height', (await rows.count()) === 6 && Math.abs(all.height - folded3) <= 1 && all.scroll > all.client, `${JSON.stringify(all)} vs ${folded3}`)
  const termAll = await box('.assistant-terminal')
  check('…so the terminal keeps its size', Math.abs(termAll.height - term3.height) <= 1, `${term3.height} → ${termAll.height}`)
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await shots('all')
  await section.getByRole('button', { name: 'Show fewer' }).click()
  check('Show fewer: the last 3 again, at the top', !!(await lib.until(async () => (await rows.count()) === 3, 3000)) && (await list.evaluate((el) => el.scrollTop)) === 0)
  const fewer = { list: (await list.boundingBox()).height, term: (await box('.assistant-terminal')).height }
  check('…the list and the terminal the same size as before', Math.abs(fewer.list - folded3) <= 1 && Math.abs(fewer.term - term3.height) <= 1, `${JSON.stringify(fewer)} vs ${folded3}, ${term3.height}`)
  const inside = await list.evaluate((el) => {
    const b = el.getBoundingClientRect()
    return [...el.querySelectorAll('.assistant-revert')].every((r) => {
      const x = r.getBoundingClientRect()
      return x.top >= b.top - 0.5 && x.bottom <= b.bottom + 0.5
    })
  })
  check('…each Revert whole inside the list, not cut off', inside)
  await section.locator('.assistant-revert').first().click()
  check('…and Revert works', !!(await lib.until(async () => (await section.locator('.assistant-action', { hasText: 'You reverted' }).count()) >= 1, 5000)))

  // --- The fold: the header folds it all away, and the terminal gets the room (refitted, not clipped).
  const head = section.locator('.assistant-actions-head')
  check('the header is a button saying it is open', (await head.evaluate((el) => el.tagName)) === 'BUTTON' && (await head.getAttribute('aria-expanded')) === 'true')
  // The terminal's drawn screen (xterm draws on a canvas here): taller once it has refitted to more rows.
  const rowsOf = async () => Math.round((await panel().locator('.assistant-terminal .xterm-screen').boundingBox())?.height ?? 0)
  const before = { term: await box('.assistant-terminal'), rows: await rowsOf() }
  await head.focus()
  await page.keyboard.press('Enter')
  check('Enter folds it to its header', !!(await lib.until(async () => (await head.getAttribute('aria-expanded')) === 'false' && (await rows.count()) === 0, 3000)))
  await lib.sleep(500) // on purpose: the terminal refits after its box changes
  const after = { term: await box('.assistant-terminal'), rows: await rowsOf() }
  check('…the terminal gets the room', after.term.height > before.term.height + 40, `${before.term.height} → ${after.term.height}`)
  check('…and refits to it: more rows (a taller screen)', after.rows > before.rows + 30, `${before.rows} → ${after.rows}`)
  const fits = await page.evaluate(() => {
    const t = document.querySelector('.assistant-panel .assistant-terminal')?.getBoundingClientRect()
    const s = document.querySelector('.assistant-panel .assistant-terminal .xterm-screen')?.getBoundingClientRect()
    return !!t && !!s && s.bottom <= t.bottom + 1 && s.right <= t.right + 1
  })
  check('…inside its box, nothing clipped', fits)
  await shots('folded')

  // --- Hive's own question its action waits on (stopping a busy agent): waiting for your approval, until answered.
  // Its task is "work 60", spelled with a JSON escape so the fake Assistant doesn't take it as its own "work 60".
  await type('hive hive_add_agent {"project":"alpha","name":"Fixer","prompt":"w\\u006frk 60"}')
  const alpha = path.join(ws, 'alpha')
  const fixerLive = async () => (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && x.agentName === 'Fixer')
  check('an agent of alpha is busy', !!(await lib.until(async () => (await fixerLive())?.status === 'working', 30000)))
  // Its row in the workspace list is backed in its status's colour (#399), its activity in the text colour (AA).
  const fixerRow = panel().locator('.assistant-agent', { hasText: 'Fixer' })
  check('…its row in the workspace list has the working wash', !!(await lib.until(async () => (await fixerRow.getAttribute('data-status').catch(() => null)) === 'working' && (await fixerRow.evaluate((el) => el.classList.contains('row-wash'))), 5000)))
  const textColours = await fixerRow.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--fg)'
    document.body.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return { got: getComputedStyle(el.querySelector('.assistant-agent-status')).color, want, backing: getComputedStyle(el, '::before').backgroundColor }
  })
  check('…its activity in the text colour, over a tint', textColours.got === textColours.want && textColours.backing !== 'rgba(0, 0, 0, 0)', JSON.stringify(textColours))
  await idle()
  await type('hive hive_stop_agent {"project":"alpha","agent":"Fixer"}')
  const card = panel().locator('.assistant-question', { hasText: 'Stop Fixer in alpha?' })
  check('stopping it asks the user on a card', !!(await lib.until(async () => (await card.count()) === 1, 15000)))
  check('…and the status line says the Assistant waits for your approval', !!(await lib.until(async () => (await statusText()) === 'Status: Waiting for your approval: Stop Fixer in alpha?' && (await tone()) === 'attention', 5000)), `${await statusText()} / ${await tone()}`)
  const approvalColour = await attentionAA()
  check('…in the attention colour, AA in both themes', Object.values(approvalColour).every((c) => c.got === c.want && c.ratio >= 4.5), JSON.stringify(approvalColour))
  await shots('approval')
  await card.locator('button', { hasText: "Don't stop" }).click()
  check('answered: the card goes and the status line is back to normal', !!(await lib.until(async () => (await card.count()) === 0 && !/approval/.test(await statusText()) && (await tone()) !== 'attention', 15000)), `${await statusText()} / ${await tone()}`)
  await idle()
  const fixer = await fixerLive()
  if (fixer) await inv('session:stop', alpha, fixer.agentId)

  // --- A card watch: its cards as chips that open the card, and until when.
  await type('hive hive_wait_for_tasks {"cards":[1,2],"wake":true,"column":"review","limitMinutes":90}')
  check('watching: “Status: Waiting for #1 #2 → Review (watch until …)” (chips side by side)', !!(await lib.until(async () => /^Status: Waiting for #1 #2 → Review \(watch until \d{1,2}:\d{2}( [AP]M)?\)$/.test(await statusText()) && (await tone()) === 'calm', 15000)), await statusText())
  const chips = status().locator('.card-chip')
  check('…each card the app’s card chip', (await chips.count()) === 2 && (await chips.first().locator('.codicon').count()) === 1)
  const tint = await chips.first().evaluate((el) => ({ colored: el.classList.contains('colored'), column: el.dataset.column, col: el.style.getPropertyValue('--col') }))
  check('…tinted with its column’s colour', tint.colored && tint.column === 'todo' && !!tint.col, JSON.stringify(tint))
  await status().locator('.card-chip', { hasText: '#2' }).click()
  const dialog = page.locator('.dialog', { hasText: '#2' })
  check('…that opens its card', !!(await lib.until(async () => (await dialog.count()) === 1, 5000)))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.dialog').count()) === 0, 3000)

  // --- Narrow: the line is cut short with "…", the whole of it in its tooltip.
  const edge = await page.locator('.assistant-panel > .pane-resizer').boundingBox()
  await page.mouse.move(edge.x + 3, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + 60, edge.y + 200, { steps: 5 })
  await page.mouse.move(edge.x + 125, edge.y + 200, { steps: 5 })
  await page.mouse.up()
  await lib.sleep(600)
  const cut = await status().locator('.assistant-status-text').evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }))
  check('narrow: the status line is cut short with “…”', cut.cut && cut.ellipsis === 'ellipsis', JSON.stringify(cut))
  await status().locator('.assistant-status-text').hover()
  check('…its tooltip has the whole line', !!(await lib.until(async () => /Status: Waiting for #1, #2 → Review \(watch until/.test((await page.locator('.tip:visible').allInnerTexts()).join(' ')), 3000)))
  await page.mouse.move(0, 0)
  await head.click()
  await lib.until(async () => (await rows.count()) === 3, 3000)
  await shots('narrow')
  await head.click()
  await lib.until(async () => (await head.getAttribute('aria-expanded')) === 'false', 3000)
  await page.locator('.assistant-panel > .pane-resizer').dblclick()

  // --- A project in the workspace list folds to one line: its dot and how many run (Enter on its chevron too).
  await inv('project:setActive', alpha, true).catch(() => undefined)
  const project = panel().locator('.assistant-project[data-project="alpha"]')
  const fold = project.locator('.assistant-project-fold')
  check('a project’s chevron says it is open', (await fold.getAttribute('aria-expanded')) === 'true' && (await project.locator('.assistant-agent').count()) >= 1)
  await fold.focus()
  await page.keyboard.press('Enter')
  check('Enter folds the project to one line', !!(await lib.until(async () => (await fold.getAttribute('aria-expanded')) === 'false' && (await project.locator('.assistant-agent').count()) === 0, 3000)))
  const summary = (await project.locator('.assistant-project-summary').innerText().catch(() => '')).trim()
  check('…its name, its dot and how many agents run', /^(\d+ running|not running)$/.test(summary) && (await project.locator('.assistant-project-summary .dot').count()) === 1 && (await project.locator('.assistant-project-name').innerText()).trim() === 'alpha', summary)
  check('…in one line', (await project.locator('.assistant-project-head').boundingBox()).height <= 22)
  await shots('project-folded')

  // --- After a restart: still folded (once it has done something again; the list is the running Hive's).
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await app.close()
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.until(async () => (await panel().count()) === 1, 10000)
  if ((await panel().count()) === 0) {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+I')
  }
  await lib.until(async () => (await panel().locator('.assistant-header').count()) === 1, 5000)
  await panel().locator('.assistant-header').getByRole('button', { name: /Resume|Start/ }).first().click()
  await idle()
  await type('hive hive_create_task {"project":"alpha","title":"After the restart"}')
  await idle()
  const again = panel().locator('.assistant-actions')
  check('after a restart, “Done by the Assistant” is still folded', !!(await lib.until(async () => (await again.count()) === 1, 10000)) && (await again.locator('.assistant-actions-head').getAttribute('aria-expanded')) === 'false' && (await again.locator('.assistant-action').count()) === 0)
  const alphaAgain = panel().locator('.assistant-project[data-project="alpha"]')
  check('…and so is the project', (await alphaAgain.locator('.assistant-project-fold').getAttribute('aria-expanded')) === 'false' && (await alphaAgain.locator('.assistant-agent').count()) === 0)
  await alphaAgain.locator('.assistant-project-fold').press(' ')
  check('Space unfolds it again', !!(await lib.until(async () => (await alphaAgain.locator('.assistant-project-fold').getAttribute('aria-expanded')) === 'true' && (await alphaAgain.locator('.assistant-agent').count()) >= 1, 3000)))

  // --- Its mark where the Assistant is listed: its run in the Progress panel (reported with its own token, as
  // hive-progress would), the Workspace Overview's running row, and the hidden panel's strip.
  const tokens = path.join(userData, 'assistant-api')
  const token = JSON.parse(fs.readFileSync(path.join(tokens, fs.readdirSync(tokens)[0]), 'utf8')).token
  const started = await fetch(`http://127.0.0.1:${env.HIVE_API_PORT}/v1/progress`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Checking the panel' }) })
  check('the Assistant reports a run', started.status === 200, String(started.status))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+P')
  check('…and the Progress panel shows it with the Assistant’s mark', !!(await lib.until(async () => (await page.locator('.progress-panel .progress-run', { hasText: 'Checking the panel' }).locator('.assistant-mark').count()) === 1, 8000)))
  await page.keyboard.press('Control+Alt+P')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+O')
  const running = page.locator('.running-row', { hasText: 'Assistant' })
  check('the Workspace Overview’s running Assistant has its status icon', !!(await lib.until(async () => (await running.locator('.assistant-mark[data-status]').count()) === 1, 8000)))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const rail = page.locator('.assistant-rail')
  check('hidden, the strip shows its status icon', !!(await lib.until(async () => (await rail.locator('.assistant-mark[data-status]').count()) === 1, 5000)) && (await rail.locator('.assistant-mark').getAttribute('aria-label'))?.startsWith('The Assistant'))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
