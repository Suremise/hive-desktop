// In-app banners (#157): while a Hive window is focused, an agent finishing or waiting is a banner in it, not a
// Windows notification; a finished banner closes after its seconds (kept while hovered), a waiting one stays until the
// agent moves on; clicking one shows its project; × dismisses; the position setting places them; Show nothing and
// Windows notification; Show banners for This project; with Hive in the background, a Windows notification as before;
// and a profile from before (onlyWhenUnfocused off) is moved to Show in Hive. The test copy runs quiet and records the
// Windows notifications it would show (HIVE_TEST_NOTIFY_LOG); the window's focus is stubbed (Windows won't give a
// background app the focus). Fake Claude Code; throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright-core')

const userData = path.join(lib.WORK, 'banners-profile')
const ws = path.join(lib.WORK, 'banners-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const claudeHome = path.join(lib.WORK, 'banners-claude-home')
const notifyLog = path.join(lib.WORK, 'banners-notify.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, beta, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.rmSync(notifyLog, { force: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  // A profile from 0.3.x, with "Only when Hive is in the background" off.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.version = 5
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { onlyWhenUnfocused: false, chimeEnabled: false, desktopNotifications: true, notifyOnFinished: true, notifyOnWaiting: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47927), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_QUIET: '1', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])

  const n0 = (await inv('settings:get')).notifications
  check('a profile from before is moved to Show in Hive, the old setting gone', n0.whileFocused === 'inApp' && !('onlyWhenUnfocused' in n0) && n0.bannerPosition === 'top-center' && n0.bannerSeconds === 6 && n0.waitingBannerStays === true, JSON.stringify(n0))
  // Shorter banners, so the suite doesn't wait 6 s for each.
  await inv('settings:update', { notifications: { bannerSeconds: 2 } })

  await lib.openWorkspace(inv, page, ws)
  const one = await lib.addAgent(inv, alpha, { name: 'One' })
  const two = await lib.addAgent(inv, beta, { name: 'Two' })
  const live = async (proj, a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === a.id)
  for (const [p, a] of [[alpha, one], [beta, two]]) await inv('session:start', p, { agentId: a.id })
  check('both agents start', !!(await lib.until(async () => (await live(alpha, one))?.status === 'ready' && (await live(beta, two))?.status === 'ready', 25000)))
  const send = async (p, a, text) => {
    await inv('pty:write', lib.ptyKey(p, a.id), text)
    await lib.sleep(100)
    await inv('pty:write', lib.ptyKey(p, a.id), '\r')
  }
  const turnEnds = (p, a) => lib.until(async () => (await live(p, a))?.status === 'finished', 20000)

  // The window's focus, as the test says (and the events Hive listens for).
  const setFocus = (on) =>
    app.evaluate(({ BrowserWindow }, f) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isFocused = () => f
      w.emit(f ? 'focus' : 'blur')
    }, on)
  const osNotes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification')
  const banners = () => page.locator('.notice-banner')
  const bannerTitles = () => banners().allInnerTexts()
  const showProject = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')).includes(name), 5000)
  }

  // --- Focused: a finished agent is a banner at the top centre, not a Windows notification.
  await setFocus(true)
  await showProject('beta')
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  check('a finished agent: a banner in the window', !!(await lib.until(async () => (await bannerTitles()).some((t) => /alpha finished/.test(t)), 10000)), JSON.stringify(await bannerTitles()))
  check('…at the top centre', (await page.locator('.notice-banners.at-top-center').count()) === 1)
  check('…and no Windows notification', osNotes().length === 0, JSON.stringify(osNotes()))
  await page.screenshot({ path: path.join(lib.WORK, 'banners-1-finished.png') })
  check('a finished banner closes after its seconds', !!(await lib.until(async () => (await banners().count()) === 0, 6000)))

  // --- Kept while hovered.
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  await banners().first().hover()
  await lib.sleep(3500) // A fixed wait on purpose: longer than the banner's 2 s, to show it does NOT close while hovered.
  check('…but not while the pointer is on it', (await banners().count()) === 1)
  await page.mouse.move(650, 600)
  check('…and closes once it moves away', !!(await lib.until(async () => (await banners().count()) === 0, 6000)))

  // --- Clicking one shows its project.
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  await banners().first().click()
  check('clicking a banner shows its project, and closes it', !!(await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')).includes('alpha'), 5000)) && (await banners().count()) === 0)

  // --- × dismisses without going to the project.
  await showProject('beta')
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  await banners().first().locator('.notice-close').click()
  check('× dismisses it, and stays on the project shown', (await banners().count()) === 0 && (await page.locator('.project-header h1').innerText()).includes('beta'))

  // --- From the keyboard (#175): the project's button, Enter opens it; Tab to ×, Space dismisses. DOM focus only
  // (element.focus() and keys sent to the page): the test window never takes the OS focus.
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  const openBtn = page.getByRole('button', { name: /^Show the project: .*alpha finished/ })
  check('a banner has a button to show its project, named for it', (await openBtn.count()) === 1, JSON.stringify(await bannerTitles()))
  check('…and keeps its live role', (await page.locator('.notice-banner[role="status"]').count()) === 1)
  // Reached by the keyboard (Shift+Tab from ×), so it shows the focus ring as Tab would.
  await page.locator('.notice-close').focus()
  await page.keyboard.press('Shift+Tab')
  check('…reached with the keyboard', await page.evaluate(() => document.activeElement?.classList.contains('notice-open') ?? false))
  await page.screenshot({ path: path.join(lib.WORK, 'banners-2-keyboard.png'), clip: { x: 300, y: 0, width: 700, height: 160 }, animations: 'disabled' })
  await lib.sleep(3500) // A fixed wait on purpose: longer than the banner's 2 s, to show it does NOT close while focused.
  check('…it stays open while it has the focus', (await banners().count()) === 1)
  await page.keyboard.press('Enter')
  check('Enter on it shows the project, and closes it', !!(await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')).includes('alpha'), 5000)) && (await banners().count()) === 0)
  await showProject('beta')
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  await page.locator('.notice-open').focus()
  await page.keyboard.press('Tab')
  check('Tab moves from it to ×', await page.evaluate(() => document.activeElement?.classList.contains('notice-close') ?? false))
  await page.keyboard.press('Space')
  check('…and Space there dismisses it, staying on the project shown', !!(await lib.until(async () => (await banners().count()) === 0, 3000)) && (await page.locator('.project-header h1').innerText()).includes('beta'))
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.until(async () => (await banners().count()) === 1, 10000)
  await page.locator('.notice-open').focus()
  await page.locator('.notice-open').evaluate((el) => el.blur())
  check('a focused banner closes once the focus leaves it', !!(await lib.until(async () => (await banners().count()) === 0, 6000)))

  // --- Waiting: stays until the agent moves on (it finishes after 8 s here).
  await send(alpha, one, 'ask work 8')
  check('an agent waiting for you: a banner', !!(await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 1, 10000)), JSON.stringify(await bannerTitles()))
  await lib.sleep(3500) // A fixed wait on purpose: longer than the 2 s a finished banner stays, to show a waiting one does NOT close.
  check('…that stays while it waits', (await page.locator('.notice-banner.waiting').count()) === 1)
  await turnEnds(alpha, one)
  check('…and closes once it is no longer waiting', !!(await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 0, 8000)))
  check('no Windows notification for any of them', osNotes().length === 0, JSON.stringify(osNotes()))
  await lib.until(async () => (await banners().count()) === 0, 6000)

  // --- More than fit: five waiting for you are all kept ("+1 more" shows the fifth), and finished ones never push
  // a waiting one out. Sent to the window as main sends them.
  const sendEvent = (e) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), e)
  const waitingNotice = (i) => ({ type: 'notice', notice: { id: `w${i}`, kind: 'waiting', title: `Waiting ${i}`, body: 'Allow Bash?', projectPath: alpha, agentId: `agent-${i}` } })
  for (let i = 1; i <= 5; i++) await sendEvent(waitingNotice(i))
  check('five waiting: four show, and "+1 more"', !!(await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 4 && /\+1 more/.test((await page.locator('.notice-more').textContent().catch(() => '')) ?? ''), 5000)), JSON.stringify(await bannerTitles()))
  await page.locator('.notice-more').click()
  check('…which shows the fifth: none was dropped', !!(await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 5, 5000)) && (await bannerTitles()).some((t) => /Waiting 1\b/.test(t)), JSON.stringify(await bannerTitles()))
  await page.screenshot({ path: path.join(lib.WORK, 'banners-3-five-waiting.png') })
  for (let i = 1; i <= 4; i++) await sendEvent({ type: 'notice', notice: { id: `f${i}`, kind: 'finished', title: `Finished ${i}`, body: 'Done.', projectPath: alpha } })
  await lib.sleep(500)
  check('four finished after them: all five waiting are still there', (await page.evaluate(() => document.querySelectorAll('.notice-banner.waiting').length + Number((document.querySelector('.notice-more')?.textContent ?? '').replace(/\D/g, '') || 0))) >= 5)
  await lib.until(async () => (await page.locator('.notice-banner.finished').count()) === 0, 8000)
  for (let i = 1; i <= 5; i++) await sendEvent({ type: 'notice-resolved', projectPath: alpha, agentId: `agent-${i}` })
  check('answered: each waiting banner goes', !!(await lib.until(async () => (await banners().count()) === 0 && (await page.locator('.notice-more').count()) === 0, 5000)), JSON.stringify(await bannerTitles()))
  // Set to close like the others: the newest four are kept, and they close after their seconds.
  await inv('settings:update', { notifications: { waitingBannerStays: false } })
  for (let i = 6; i <= 10; i++) await sendEvent(waitingNotice(i))
  check('waiting banners set to close: the newest four, and no "+more"', !!(await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 4, 5000)) && (await page.locator('.notice-more').count()) === 0)
  check('…which close after their seconds', !!(await lib.until(async () => (await banners().count()) === 0, 8000)))
  await inv('settings:update', { notifications: { waitingBannerStays: true } })

  // --- More than fit in the window: the stack scrolls inside it, and the oldest can be reached and handled.
  const tall = async (position, from) => {
    await inv('settings:update', { notifications: { bannerPosition: position } })
    for (let i = 0; i < 12; i++) await sendEvent({ type: 'notice', notice: { id: `t${from + i}`, kind: 'waiting', title: `Tall ${from + i}`, body: 'Allow Bash to run this command?\nnpm run e2e -- --all --build --record\nin the alpha project', projectPath: alpha, agentId: `tall-${from + i}` } })
    await lib.until(async () => (await page.locator('.notice-more').count()) === 1, 5000)
    await page.locator('.notice-more').click()
    await lib.until(async () => (await page.locator('.notice-banner.waiting').count()) === 12, 5000)
    const box = await page.evaluate(() => {
      const el = document.querySelector('.notice-banners')
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: innerHeight, scrolls: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY }
    })
    check(`${position}: twelve waiting, expanded, stay inside the window and scroll`, box.top >= 0 && box.bottom <= box.height && box.scrolls && box.overflow === 'auto', JSON.stringify(box))
    // The oldest: scrolled to and dismissed with a real click.
    const oldest = page.locator('.notice-banner', { hasText: `Tall ${from}` })
    await oldest.locator('.notice-close').click({ timeout: 5000 })
    check(`${position}: the oldest can be reached and dismissed`, !!(await lib.until(async () => (await page.locator('.notice-banner', { hasText: `Tall ${from}` }).count()) === 0, 5000)))
    // The next oldest: its project opened by clicking it.
    await showProject('beta')
    await page.locator('.notice-banner', { hasText: `Tall ${from + 1}` }).locator('.notice-title').click({ timeout: 5000 })
    check(`${position}: …and another clicked to open its project`, !!(await lib.until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')).includes('alpha'), 5000)))
    await page.screenshot({ path: path.join(lib.WORK, `banners-4-tall-${position}.png`) })
    for (let i = 0; i < 12; i++) await sendEvent({ type: 'notice-resolved', projectPath: alpha, agentId: `tall-${from + i}` })
    await lib.until(async () => (await banners().count()) === 0, 5000)
  }
  await tall('top-center', 100)
  await tall('bottom-right', 200)
  await inv('settings:update', { notifications: { bannerPosition: 'top-center' } })

  // --- Position.
  await inv('settings:update', { notifications: { bannerPosition: 'bottom-right' } })
  await send(beta, two, 'go work 1')
  await turnEnds(beta, two)
  check('the position setting places them (bottom right)', !!(await lib.until(async () => (await page.locator('.notice-banners.at-bottom-right .notice-banner').count()) === 1, 10000)))
  await page.screenshot({ path: path.join(lib.WORK, 'banners-2-bottom-right.png') })
  await lib.until(async () => (await banners().count()) === 0, 6000)
  await inv('settings:update', { notifications: { bannerPosition: 'top-center' } })

  // --- Show banners for This project: another project's finish shows nothing at all.
  await inv('settings:update', { notifications: { bannerScope: 'project' } })
  await showProject('beta')
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.sleep(4500) // A fixed wait on purpose: the finish group (3 s) and a banner's time, to show nothing comes.
  check('This project: another project\'s finish shows no banner, and no Windows notification', (await banners().count()) === 0 && osNotes().length === 0, JSON.stringify(osNotes()))
  await send(beta, two, 'go work 1')
  await turnEnds(beta, two)
  check('…its own project\'s does', !!(await lib.until(async () => (await bannerTitles()).some((t) => /beta finished/.test(t)), 10000)))
  await lib.until(async () => (await banners().count()) === 0, 6000)
  await inv('settings:update', { notifications: { bannerScope: 'all' } })

  // --- While Hive is focused: Windows notification, and Show nothing.
  await inv('settings:update', { notifications: { whileFocused: 'windows' } })
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  check('set to Windows notification: one while focused, no banner', !!(await lib.until(() => osNotes().some((n) => /alpha finished/.test(n.title)), 10000)) && (await banners().count()) === 0, JSON.stringify(osNotes()))
  const before = osNotes().length
  await inv('settings:update', { notifications: { whileFocused: 'nothing' } })
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  await lib.sleep(4500) // A fixed wait on purpose: the finish group (3 s), to show nothing comes.
  check('Show nothing: no banner, no Windows notification', (await banners().count()) === 0 && osNotes().length === before)
  await inv('settings:update', { notifications: { whileFocused: 'inApp' } })

  // --- Hive in the background: a Windows notification, as before.
  await setFocus(false)
  await send(alpha, one, 'go work 1')
  await turnEnds(alpha, one)
  check('in the background: a Windows notification, no banner', !!(await lib.until(() => osNotes().length > before, 10000)) && (await banners().count()) === 0, JSON.stringify(osNotes()))

  for (const [p, a] of [[alpha, one], [beta, two]]) await inv('session:stop', p, a.id).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
