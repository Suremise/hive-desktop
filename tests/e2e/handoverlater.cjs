// The long-conversation notice's hand-over at a good moment (#1057), on fake Claude Code agents. Past Settings →
// Sessions → Warn when a transcript is over, the notice informs and offers what fits what the agent is doing:
// - Idle, on no lane: Hand Over to… (the dialog), as before; the footer's size opens it too.
// - Working: Hand Over After This Card, which queues it (a notice with Cancel Hand-Over; the footer's size shows ⇄ and
//   cancels it; ⋯ has Hand Over After This Card / Cancel Hand-Over). Nothing happens while it works; once its turn is
//   over Hive asks it for a handover and it carries on in a new conversation.
// - The builder of a running lane, idle: Hand Over After This Card too. Queued, it waits while its card is in Review,
//   and while it holds the merge slot after the card has passed; once the slot is released Hive asks it for a handover
//   that says where the loop is, and it carries on in a new conversation.
// Screenshots of the notice in both states, in both themes. The fake CLI can't write a handover with Hive's tools, so
// the test writes it, with the agent's session in its header, once Hive has asked. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'handoverlater-profile')
const ws = path.join(lib.WORK, 'handoverlater-ws')
const claudeHome = path.join(lib.WORK, 'handoverlater-claude-home')
const shots = path.join(lib.WORK, 'handoverlater-shots')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47827))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const hdir = path.join(ws, '.hive', 'shared', 'handovers')
  fs.mkdirSync(hdir, { recursive: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', ...lib.fakeClaude(userData, claudeHome, [alpha]) })
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.sessions = { ...cfg.settings.sessions, transcriptWarnMB: 1 }
  // The Agent API's hand-over (the refusal checked below) is session input.
  cfg.settings.agentApi = { ...cfg.settings.agentApi, allowSessionInput: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.waitForProvider(inv)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = await lib.addAgent(inv, alpha, { name: 'Idle' })
    const busy = await lib.addAgent(inv, alpha, { name: 'Busy' })
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    await lib.addAgent(inv, alpha, { name: 'Checker' })
    for (const a of [idle, busy, builder]) await inv('session:start', alpha, { agentId: a.id })
    const statuses = async () => (await Promise.all([idle, busy, builder].map((a) => live(a.id)))).map((s) => s?.status)
    check('the agents start', !!(await lib.until(async () => (await statuses()).every((s) => s === 'ready'), HUNG_MS, 300)), JSON.stringify(await statuses()))
    const say = async (a, text) => lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), text, { submitted: async () => (await live(a.id))?.status === 'working' })
    const toastOf = (name) => page.locator('.toast', { hasText: `${name}: long conversation` })
    const footerOf = (name) => page.locator('.agent-pane', { has: lib.paneHeader(page, name) }).locator('.pane-footer-bar .foot-transcript')
    const writing = (name) => page.locator('.toast', { hasText: `${name} is writing a handover` })
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
    }
    // The handover the agent is asked for, written as hive_create_handover would (its session in the header).
    const writeHandover = (name, sessionId) =>
      fs.writeFileSync(path.join(hdir, `2026-10-18-alpha-${name.toLowerCase()}.md`), `# ${name}'s work\n\n- **Project:** alpha\n- **Session:** ${sessionId}\n\nCarry on.\n`)
    const api = async (token, method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const make = async (title, column, agent) => (await inv('tasks:create', { title, project: 'alpha', column, agent })).number
    const hiveLog = () => {
      try {
        return fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
      } catch {
        return ''
      }
    }
    const logged = (re) => lib.until(async () => re.test(hiveLog()), HUNG_MS, 200)
    const handOverLines = () => hiveLog().split('\n').filter((l) => /hand-over/.test(l)).slice(-5).join(' | ')
    /** Waits for Hive to ask the agent for its handover, writes it, and waits for its new conversation. */
    const handsOver = async (a, name, first) => {
      const asked = await lib.until(async () => (await writing(name).count()) > 0, HUNG_MS, 200)
      if (asked) writeHandover(name, first)
      const fresh = await lib.until(async () => {
        const s = await live(a.id)
        return s?.sessionId && s.sessionId !== first && s
      }, HUNG_MS, 300)
      return { asked: !!asked, fresh }
    }

    // --- Idle, on no lane: Hand Over to…, as before; the footer's size opens it too.
    await say(idle, 'pad 1200')
    await lib.until(async () => (await live(idle.id))?.status === 'finished', HUNG_MS, 300)
    const idleToast = toastOf('Idle')
    check('idle: the notice says so', !!(await lib.until(async () => (await idleToast.count()) === 1, HUNG_MS, 200)))
    const idleText = await idleToast.innerText().catch(() => '')
    check('…informing, with Hand Over to…', /over 1 MB\): it may slow down/.test(idleText) && /Hand Over to…/.test(idleText) && !/After This Card/.test(idleText), idleText)
    await shoot('notice-idle')
    // The notice kept while the agent joins a lane with its card in Review (round 2): its Hand Over to…, clicked now, is
    // decided now, so it queues a hand-over after that card and ends nothing.
    const nIdle = await make('Idle lane card', 'review', idle.id)
    const idleLane = await api(workspaceToken, 'POST', '/v1/lanes', { project: 'alpha', builder: 'Idle', reviewer: 'Checker', name: 'stale-notice lane', cards: [nIdle] })
    const onLane = await lib.until(async () => (await inv('lanes:list')).some((l) => l.name === 'stale-notice lane'), HUNG_MS, 200)
    check('it joins a lane, its card in Review', idleLane.status === 200 && !!onLane, JSON.stringify(idleLane))
    const idleFirst = (await live(idle.id)).sessionId
    await idleToast.getByRole('button', { name: 'Hand Over to…' }).click()
    const dialog = page.locator('.dialog', { hasText: 'Hand over' })
    const staleQueued = await lib.until(async () => (await live(idle.id))?.handOverAfter, HUNG_MS, 200)
    check("the notice's Hand Over to…, clicked once it is on the lane, queues a hand-over after its card instead", staleQueued?.card === nIdle && (await dialog.count()) === 0 && (await live(idle.id))?.sessionId === idleFirst, JSON.stringify(staleQueued))
    check('…which waits for its card', !!(await logged(new RegExp(`Idle\\W*: queued hand-over waits \\(card, lane on #${nIdle}\\)`))), handOverLines())
    // Hand Over to… (⋯) offers the agent itself only at a good moment: not on the lane's card.
    await lib.agentMenu(page, 'Idle')
    await lib.menuEntry(page, 'Hand Over to…').click()
    check('Hand Over to… opens', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS, 200)))
    const selfChoice = dialog.locator('label.choice', { hasText: 'in a new conversation' })
    // The window learns of the lane a moment after Hive (which refuses the hand-over meanwhile): waited for.
    const offNow = await lib.until(async () => (await selfChoice.locator('input').isDisabled()) && /card loop/.test(await selfChoice.innerText()), HUNG_MS, 200)
    check("…with the agent itself not on offer while it is on the lane's card", !!offNow, await selfChoice.innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS, 200)
    // And the operation itself refuses it: an agent or the Assistant asking through the Agent API gets a 409.
    const refused = await api(workspaceToken, 'POST', '/v1/projects/alpha/handover', { from: 'Idle', to: 'Idle', handover: false })
    check('…and the Agent API refuses handing it over to itself now', refused.status === 409 && (await live(idle.id))?.sessionId === idleFirst, JSON.stringify(refused))
    // The hand-over cancelled (before the lane ends, which would let it go ahead) and the lane ended, the footer's size
    // opens Hand Over to… again, the agent itself chosen.
    await footerOf('Idle').click()
    check('the footer cancels the queued one', !!(await lib.until(async () => !(await live(idle.id))?.handOverAfter, HUNG_MS, 200)))
    await inv('lanes:end', idleLane.body.lane.id, true)
    await lib.until(async () => !(await inv('lanes:list')).some((l) => l.name === 'stale-notice lane' && (l.state === 'active' || l.state === 'paused')), HUNG_MS, 200)
    await footerOf('Idle').click()
    check('…and, off the lane and idle, opens Hand Over to… with the agent itself chosen', !!(await lib.until(async () => (await dialog.count()) === 1 && ((await selfChoice.getAttribute('class')) ?? '').includes('selected'), HUNG_MS, 200)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS, 200)

    // --- Working: Hand Over After This Card, queued until its turn is over.
    const busyFirst = (await live(busy.id)).sessionId
    await say(busy, 'pad 1200 holduntil go-busy')
    const busyToast = toastOf('Busy')
    check('working: the notice says so', !!(await lib.until(async () => (await busyToast.count()) === 1, HUNG_MS, 200)))
    const busyText = await busyToast.innerText().catch(() => '')
    check('…offering Hand Over After This Card, not Hand Over to…', /at a good moment, after this card/.test(busyText) && /Hand Over After This Card/.test(busyText) && !/Hand Over to…/.test(busyText), busyText)
    await shoot('notice-working')
    await busyToast.getByRole('button', { name: 'Hand Over After This Card' }).click()
    check('…which queues it', !!(await lib.until(async () => !!(await live(busy.id))?.handOverAfter, HUNG_MS, 200)), JSON.stringify((await live(busy.id))?.handOverAfter))
    check('…and says so, with Cancel Hand-Over', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'hands over after this card' }).getByRole('button', { name: 'Cancel Hand-Over' }).count()) === 1, HUNG_MS, 200)))
    const busyFoot = footerOf('Busy')
    check("the footer's size shows it is queued", !!(await lib.until(async () => ((await busyFoot.getAttribute('class').catch(() => '')) ?? '').includes('queued'), HUNG_MS, 200)))
    const tip = await lib.hoverTip(page, busyFoot, (t) => /Click to cancel/.test(t))
    check('…its tooltip says when, and that a click cancels it', /once its turn is over/.test(tip) && /Never while it merges/.test(tip), tip)
    await page.mouse.move(5, 5)
    await busyFoot.click()
    check('clicking it cancels it', !!(await lib.until(async () => !(await live(busy.id))?.handOverAfter, HUNG_MS, 200)))
    const menu = await lib.agentMenu(page, 'Busy')
    check('⋯ offers Hand Over After This Card', menu.some((t) => t.startsWith('Hand Over After This Card')), JSON.stringify(menu))
    await lib.menuEntry(page, 'Hand Over After This Card').click()
    check('…which queues it again', !!(await lib.until(async () => !!(await live(busy.id))?.handOverAfter, HUNG_MS, 200)))
    const menu2 = await lib.agentMenu(page, 'Busy')
    check('…and ⋯ then offers Cancel Hand-Over, saying when', menu2.some((t) => t.startsWith('Cancel Hand-Over') && /once its turn is over/.test(t)), JSON.stringify(menu2))
    await page.keyboard.press('Escape')
    const busyWaits = await lib.until(async () => /Busy\W*: queued hand-over waits \(turn\)/.test(fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')), HUNG_MS, 200)
    check('nothing is handed over while it works', !!busyWaits && (await live(busy.id))?.status === 'working' && (await live(busy.id))?.sessionId === busyFirst && (await writing('Busy').count()) === 0)
    fs.writeFileSync(path.join(claudeHome, 'go-busy'), '')
    const b = await handsOver(busy, 'Busy', busyFirst)
    check('once its turn is over, Hive asks it for a handover', b.asked)
    check('…and it carries on in a new conversation', !!b.fresh && !b.fresh.handOverAfter, JSON.stringify(await live(busy.id)))

    // --- On a running lane: after its card, never while it holds the merge slot, and never once the next card has begun.
    const n1 = await make('Lane card one', 'review', builder.id)
    const n2 = await make('Lane card two', 'todo', builder.id)
    const n3 = await make('Lane card three', 'todo', builder.id)
    const started = await api(workspaceToken, 'POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', reviewer: 'Reviewer', name: 'hand-over lane', cards: [n1, n2, n3] })
    check('a lane starts', started.status === 200, JSON.stringify(started))
    const laneNow = async () => (await inv('lanes:list')).find((l) => l.name === 'hand-over lane')
    const builderFirst = (await live(builder.id)).sessionId
    await say(builder, 'pad 1200')
    await lib.until(async () => (await live(builder.id))?.status === 'finished', HUNG_MS, 300)
    const laneToast = toastOf('Builder')
    check('in a lane: the notice says so', !!(await lib.until(async () => (await laneToast.count()) === 1, HUNG_MS, 200)))
    const laneText = await laneToast.innerText().catch(() => '')
    check('…offering Hand Over After This Card although it is idle', /Hand Over After This Card/.test(laneText) && !/Hand Over to…/.test(laneText), laneText)
    await laneToast.getByRole('button', { name: 'Hand Over After This Card' }).click()
    const queued = await lib.until(async () => (await live(builder.id))?.handOverAfter, HUNG_MS, 200)
    check('…which queues it after its card', queued?.card === n1 && !!queued?.lane, JSON.stringify(queued))
    // Its own token, from its launch, to hold the merge slot as an agent merging does.
    const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const token = launches.find((l) => l.sessionId === builderFirst)?.env?.HIVE_API_TOKEN
    const claim = await api(token, 'POST', '/v1/projects/alpha/merge-slot/claim', { cards: [n1], timeoutSeconds: 0 })
    check('it holds the merge slot', !!(await lib.until(async () => !!(await live(builder.id))?.mergeSlot, HUNG_MS, 200)), JSON.stringify(claim))
    // The card through review, the lane on its next card: still not while it merges.
    await inv('tasks:update', n1, { column: 'passed' })
    check('its card passes and the lane goes on to the next', !!(await lib.until(async () => (await laneNow())?.current === n2, HUNG_MS, 200)))
    // Hive's log says when it has looked at the queued hand-over again with the lane on its next card (a line each time why it waits changes).
    const waited = await logged(new RegExp(`Builder\\W*: queued hand-over waits \\(merging, lane on #${n2}\\)`))
    check('…but it is not handed over while it holds the merge slot', !!waited && !!(await live(builder.id))?.handOverAfter && (await live(builder.id))?.sessionId === builderFirst && (await writing('Builder').count()) === 0, handOverLines())
    // The next card begun meanwhile (round 2): in Review by the time the slot is released, so that card's end is the boundary.
    await inv('tasks:update', n2, { column: 'review' })
    check('the next card is in Review', !!(await lib.until(async () => (await laneNow())?.cards.find((c) => c.number === n2)?.column === 'review', HUNG_MS, 200)))
    const released = await api(token, 'POST', '/v1/projects/alpha/merge-slot/release', {})
    check('it releases the slot', released.status === 200, JSON.stringify(released))
    const moved = await logged(new RegExp(`Builder\\W*: queued hand-over now after card ${n2} `))
    const movedTo = await lib.until(async () => (await live(builder.id))?.handOverAfter?.card === n2, HUNG_MS, 200)
    check('…so the hand-over waits for the end of that card, not part-way through it', !!moved && !!movedTo && (await live(builder.id))?.sessionId === builderFirst && (await writing('Builder').count()) === 0, handOverLines())
    await inv('tasks:update', n2, { column: 'passed' })
    const askedAt = await lib.until(async () => (await writing('Builder').count()) > 0, HUNG_MS, 200)
    const asked = await lib.until(async () => /through review/.test(lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, builder.id)).catch(() => ''))), HUNG_MS, 300)
    check('once it passes (the next card not begun), Hive asks it for a handover that says where the loop is', !!askedAt && !!asked)
    // Round 3: the moment lost while it writes its handover. It takes the merge slot after Hive asked: the handover written
    // then, its conversation is not ended, and the hand-over is queued again.
    const asks = () => (hiveLog().match(/Builder\W*: handing over \(/g) ?? []).length
    const lost = () => (hiveLog().match(/Builder\W*: the moment was lost while it wrote its handover/g) ?? []).length
    check('(Hive has asked once)', asks() === 1, handOverLines())
    const claim2 = await api(token, 'POST', '/v1/projects/alpha/merge-slot/claim', { cards: [n3], timeoutSeconds: 0 })
    check('it takes the merge slot while it writes its handover', !!(await lib.until(async () => !!(await live(builder.id))?.mergeSlot, HUNG_MS, 200)), JSON.stringify(claim2))
    writeHandover('Builder', builderFirst)
    check('…so, the handover written, its conversation is not ended: the hand-over is queued again', !!(await lib.until(async () => lost() === 1 && !!(await live(builder.id))?.handOverAfter, HUNG_MS, 200)) && (await live(builder.id))?.sessionId === builderFirst, handOverLines())
    check('…and the notice says so', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'while it wrote its handover' }).count()) > 0, HUNG_MS, 200)))
    // The slot released, Hive asks again; this time the next card begins while it writes: not ended either.
    await api(token, 'POST', '/v1/projects/alpha/merge-slot/release', {})
    check('the slot released, Hive asks again', !!(await lib.until(async () => asks() === 2, HUNG_MS, 200)), handOverLines())
    await inv('tasks:update', n3, { column: 'doing' })
    check('the next card begins', !!(await lib.until(async () => (await laneNow())?.cards.find((c) => c.number === n3)?.column === 'doing', HUNG_MS, 200)))
    writeHandover('Builder', builderFirst)
    check('…so, the handover written, its conversation is not ended either', !!(await lib.until(async () => lost() === 2 && !!(await live(builder.id))?.handOverAfter, HUNG_MS, 200)) && (await live(builder.id))?.sessionId === builderFirst, handOverLines())
    check('…and the queue now waits for that card', !!(await lib.until(async () => (await live(builder.id))?.handOverAfter?.card === n3, HUNG_MS, 200)), JSON.stringify((await live(builder.id))?.handOverAfter))
    // Its card passed, the lane has no card left (its merge due): once the lane has ended, the hand-over goes ahead.
    await inv('tasks:update', n3, { column: 'passed' })
    check('every card passed: it waits for the lane to end', !!(await logged(/Builder\W*: queued hand-over waits \(lane-end/)), handOverLines())
    await inv('lanes:end', started.body.lane.id)
    check('the lane ended, Hive asks a third time', !!(await lib.until(async () => asks() === 3, HUNG_MS, 200)), handOverLines())
    writeHandover('Builder', builderFirst)
    const fresh = await lib.until(async () => {
      const s = await live(builder.id)
      return s?.sessionId && s.sessionId !== builderFirst && s
    }, HUNG_MS, 300)
    check('…and it carries on in a new conversation', !!fresh, JSON.stringify(await live(builder.id)))
    const rec = (await inv('session:list', alpha)).find((s) => s.id === fresh?.sessionId)
    check('…linked to the old one', rec?.handedOverFrom === builderFirst, JSON.stringify(rec && { from: rec.handedOverFrom }))
    console.log(`screenshots: ${shots}`)
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
