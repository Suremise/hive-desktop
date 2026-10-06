// Antivirus scanning of the workspace (#316), on fixtures only: HIVE_TEST_ANTIVIRUS stands in for every PowerShell call
// (the read-only probe and the elevated add, remove and check, on a simulated exclusion list), and
// HIVE_TEST_ANTIVIRUS_LOG records them, so this suite never reads or changes the machine's Defender settings. The
// workspace's folders (resolved absolute paths, the worktrees folder only once it exists, the test area for a dev
// build); Settings → Workspace's status; Add and Remove asking for exactly the folders shown, Add skipping one the
// user had already excluded and Remove leaving it, a change refused when the folders changed after the user was asked;
// a run whose list wasn't read staying unknown; a declined prompt, a policy block, another antivirus, ReFS only a
// maybe and a trusted Dev Drive only from the administrator check, not Windows; Performance's line; the suggestion once
// when several agents run, again when a worktree agent adds its folder, never after "Don't ask again"; and a test copy
// without a fixture refusing to touch Defender. Screenshots in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'antivirus-profile')
const ws = path.join(lib.WORK, 'antivirus-ws')
const alpha = path.join(ws, 'alpha')
const trees = `${ws}.worktrees`
const fixture = path.join(lib.WORK, 'antivirus-fixture.json')
const callLog = path.join(lib.WORK, 'antivirus-calls.log')
for (const d of [userData, ws, trees, fixture, callLog]) fs.rmSync(d, { recursive: true, force: true })
lib.gitProject(alpha)
const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'antivirus-claude-home'), [alpha])

const drive = path.parse(ws).root[0].toUpperCase()
const DEFENDER_ON = 397568
const probe = (over = {}) => ({
  defender: { antivirus: true, realTime: true, mode: 'Normal' },
  exclusions: ['N/A: Must be an administrator to view exclusions'],
  perfMode: 1,
  products: [{ name: 'Windows Defender', state: DEFENDER_ON }],
  volumes: [{ drive, fs: 'NTFS' }],
  ...over
})
const setFixture = (f) => fs.writeFileSync(fixture, JSON.stringify(f))
const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const changes = (kind) => calls().filter((c) => c.call !== 'probe' && (!kind || c.call === kind))

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` (${extra})` : ''}`)
}

;(async () => {
  const root = fs.realpathSync.native((fs.mkdirSync(ws, { recursive: true }), ws))
  const tests = fs.realpathSync.native(path.join(process.env.LOCALAPPDATA, 'hive-test'))
  // The user had already excluded the workspace itself (as administrator rights see Defender's list).
  setFixture({ probe: probe(), elevated: { exclusions: [root] } })
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_TEST_ANTIVIRUS: fixture, HIVE_TEST_ANTIVIRUS_LOG: callLog, ...claude }, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `antivirus-${name}.png`) })

  // The folders: the workspace and (a dev build) the test area, resolved; no worktrees folder yet.
  let s = await inv('antivirus:status', true)
  check('Defender with real-time protection, its list hidden: slowed, each folder unknown', s.scan === 'defender' && s.realTime === true && s.slowed && s.paths.every((p) => p.state === 'unknown' && !p.unsafe), JSON.stringify(s))
  check('the folders: the workspace and the test area, as resolved absolute paths; no worktrees folder until it exists', JSON.stringify(s.paths.map((p) => [p.kind, p.path])) === JSON.stringify([['workspace', root], ['tests', tests]]) && s.paths.every((p) => /^[A-Z]:\\/.test(p.path) && !/[%$]/.test(p.path)), JSON.stringify(s.paths))

  // Settings → Workspace: the status and the folders.
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  const panel = page.locator('.antivirus')
  check('Settings → Workspace shows it', !!(await lib.until(async () => /real-time protection is on/.test(await panel.innerText().catch(() => '')), 10000)))
  const rows = panel.locator('.antivirus-folders tbody tr')
  const rowText = async (i) => (await rows.nth(i).innerText()).replace(/\s+/g, ' ')
  check('…each folder with its state and Dev Drive', (await rows.count()) === 2 && /Unknown/.test(await rowText(0)) && /\bno\b/.test(await rowText(0)), await panel.innerText())
  await panel.scrollIntoViewIfNeeded()
  await shot('unknown-dark')

  const dialog = page.locator('.dialog', { hasText: 'Stop Defender scanning these folders?' })
  const add = async () => {
    await panel.getByRole('button', { name: 'Add Exclusions…' }).click()
    await lib.until(async () => (await dialog.count()) === 1, 5000)
  }

  // A run whose list wasn't read afterwards: nothing claimed, the folders stay unknown.
  setFixture({ probe: probe(), elevated: { exclusions: [root], error: 'Something went wrong', unlisted: true } })
  await add()
  await dialog.locator('.btn.primary').click()
  check('a failed run that couldn’t read Defender’s list: said, and the folders stay unknown (never “Scanned”)', !!(await lib.until(async () => /refused the change/.test(await panel.innerText()), 5000)) && (await rows.allInnerTexts()).every((t) => /Unknown/.test(t)) && !(await inv('antivirus:status', false)).paths.some((p) => p.addedByHive), await panel.innerText())

  // Defender's list redacted even with administrator rights: which exclusions exist can't be known, so nothing
  // changes; and its "N/A" answer, from Add or from a check, never counts as a list.
  setFixture({ probe: probe(), elevated: { exclusions: [root], redacted: true } })
  const requestedBefore = changes('add-requested').length
  await add()
  await dialog.locator('.btn.primary').click()
  check('a redacted list before Add: nothing changed, said, and the folders stay unknown', !!(await lib.until(async () => /couldn’t be read even with administrator rights|couldn't be read even with administrator rights/.test(await panel.innerText()), 5000)) && (await rows.allInnerTexts()).every((t) => /Unknown/.test(t)) && changes('add-requested').length === requestedBefore, await panel.innerText())
  await panel.getByRole('button', { name: 'Check with Administrator Rights…' }).click()
  check('…and a redacted administrator check keeps them unknown', !!(await lib.until(async () => /couldn’t be read afterwards/.test(await panel.innerText()), 5000)) && (await rows.allInnerTexts()).every((t) => /Unknown/.test(t)) && (await inv('antivirus:status', false)).exclusionsFrom === null, await panel.innerText())

  // Consent is for the folders shown: a folder appearing while the dialog is open refuses the change.
  setFixture({ probe: probe(), elevated: {} })
  const before = changes().length
  await add()
  check('Add asks first, listing the folders and the trade-off', (await dialog.innerText()).includes(root) && (await dialog.innerText()).includes(tests) && /node_modules/.test(await dialog.innerText()))
  check('…one folder per line, each whole in its own row (#347)', JSON.stringify(await dialog.locator('.dialog-list li').allInnerTexts()) === JSON.stringify([root, tests]), JSON.stringify(await dialog.locator('.dialog-list li').allInnerTexts()))
  await shot('add-dialog-dark')
  fs.mkdirSync(trees, { recursive: true })
  await dialog.locator('.btn.primary').click()
  check('the folders changed while asking (a worktrees folder appeared): refused, nothing elevated', !!(await lib.until(async () => /folders changed since you were asked/.test(await panel.innerText()), 5000)) && changes().length === before, JSON.stringify(changes().slice(before)))
  fs.rmSync(trees, { recursive: true, force: true })

  // Add: exactly the folders shown; the elevated script asks only for those the user hadn't excluded.
  await panel.getByRole('button', { name: 'Check Again' }).click()
  await lib.sleep(300)
  const adds = changes('add').length
  await add()
  await dialog.locator('.btn.primary').click()
  check('…one elevated call, for exactly the folders shown', !!(await lib.until(async () => changes('add').length === adds + 1, 10000)) && JSON.stringify(changes('add').at(-1).paths) === JSON.stringify([root, tests]), JSON.stringify(changes()))
  check('…asking Defender only for the one not already excluded', JSON.stringify(changes('add-requested').at(-1)?.paths) === JSON.stringify([tests]), JSON.stringify(changes('add-requested')))
  check('…both shown excluded, as read with administrator rights', !!(await lib.until(async () => /no longer scans this folder/.test(await panel.innerText()) && (await rows.allInnerTexts()).every((t) => /Excluded/.test(t)), 5000)) && /with administrator rights/.test(await panel.innerText()), await panel.innerText())
  s = await inv('antivirus:status', false)
  check('…only the one Hive added is Hive’s', JSON.stringify(s.paths.map((p) => p.addedByHive)) === JSON.stringify([false, true]) && s.slowed === false, JSON.stringify(s.paths))
  await shot('added-dark')

  // Remove: only what Hive added; the user's own exclusion stays.
  await panel.getByRole('button', { name: 'Remove Hive’s Exclusions…' }).click()
  const removeDialog = page.locator('.dialog', { hasText: 'Remove the exclusions Hive added?' })
  await lib.until(async () => (await removeDialog.count()) === 1, 5000)
  check('Remove lists only the folder Hive added, on its own line', JSON.stringify(await removeDialog.locator('.dialog-list li').allInnerTexts()) === JSON.stringify([tests]) &&!(await removeDialog.innerText()).split('\n').some((l) => l.trim() === root), await removeDialog.innerText())
  await removeDialog.locator('.btn.primary').click()
  check('…one elevated call, for it alone', !!(await lib.until(async () => changes('remove').length === 1, 10000)) && JSON.stringify(changes('remove')[0].paths) === JSON.stringify([tests]), JSON.stringify(changes('remove')))
  check('…the user’s exclusion stays: the workspace excluded, the test area scanned again', !!(await lib.until(async () => /Excluded/.test(await rowText(0)) && /Scanned/.test(await rowText(1)), 5000)), await panel.innerText())

  // A declined prompt and a policy block change nothing and say so.
  setFixture({ probe: probe(), elevated: { cancelled: true } })
  await add()
  await dialog.locator('.btn.primary').click()
  check('a declined administrator prompt: nothing changed, and it says so', !!(await lib.until(async () => /prompt was declined/.test(await panel.innerText()), 5000)) && !(await inv('antivirus:status', false)).paths.some((p) => p.addedByHive))
  setFixture({ probe: probe(), elevated: { policy: true } })
  await add()
  await dialog.locator('.btn.primary').click()
  check('a policy keeping local exclusions from applying: said, not counted as added', !!(await lib.until(async () => /organisation/.test(await panel.innerText()), 5000)) && !(await inv('antivirus:status', false)).paths.some((p) => p.addedByHive), await panel.innerText())

  // Another antivirus, ReFS and a Dev Drive, not Windows.
  const checkAgain = async () => {
    await panel.getByRole('button', { name: 'Check Again' }).click()
    await lib.sleep(400)
  }
  setFixture({ probe: probe({ defender: { antivirus: true, realTime: true, mode: 'Passive Mode' }, products: [{ name: 'Windows Defender', state: 393472 }, { name: 'Norton Security', state: 266240 }] }) })
  await checkAgain()
  check('another antivirus: named, and nothing offered', !!(await lib.until(async () => /Another antivirus is active \(Norton Security\)/.test(await panel.innerText()), 5000)) && (await panel.getByRole('button', { name: 'Add Exclusions…' }).count()) === 0)
  setFixture({ probe: probe({ volumes: [{ drive, fs: 'ReFS' }], perfMode: 0 }), elevated: { devDrives: { [drive]: 'This is a trusted developer volume.\r\n' } } })
  await checkAgain()
  check('ReFS: only a maybe, still slowed', !!(await lib.until(async () => /maybe \(ReFS\)/.test(await rowText(1)), 5000)) && (await inv('antivirus:status', false)).slowed === true, await panel.innerText())
  await panel.getByRole('button', { name: 'Check with Administrator Rights…' }).click()
  check('the administrator check confirms a trusted Dev Drive: with performance mode on, not slowed', !!(await lib.until(async () => /yes, trusted/.test(await rowText(1)), 5000)) && (await inv('antivirus:status', false)).slowed === false, await panel.innerText())
  setFixture({ probe: probe({ volumes: [{ drive, fs: 'ReFS' }], perfMode: 1 }) })
  await checkAgain()
  check('…performance mode off: scanned like any other drive', (await inv('antivirus:status', false)).slowed === true)
  setFixture({ platform: 'other' })
  await checkAgain()
  check('not Windows: nothing to check', !!(await lib.until(async () => /Only Windows/.test(await panel.innerText()), 5000)))

  // Overlapping probes: one started before the worktrees folder appeared doesn't answer a request made after it, and
  // finishing later doesn't replace the newer answer.
  setFixture({ probe: probe(), elevated: {}, probeDelayMs: 2500 })
  const slow = inv('antivirus:status', true)
  await lib.sleep(400) // A fixed wait on purpose: the slow probe must be under way before the folder appears.
  fs.mkdirSync(trees, { recursive: true })
  setFixture({ probe: probe(), elevated: {} })
  const hasTrees = (st) => st.paths.some((p) => p.kind === 'worktrees')
  const fresh = await inv('antivirus:status', false)
  check('a request after the worktrees folder appeared gets a probe of its own, with it', hasTrees(fresh), JSON.stringify(fresh.paths))
  const old = await slow
  check('…the slow one answers its own question (without it)', !hasTrees(old), JSON.stringify(old.paths))
  check('…and, finishing later, doesn’t replace the newer answer', hasTrees(await inv('antivirus:status', false)))
  fs.rmSync(trees, { recursive: true, force: true })

  // Performance says when scanning slows the workspace, and links to the status.
  setFixture({ probe: probe({ volumes: [{ drive, fs: 'NTFS' }] }), elevated: {} })
  await checkAgain()
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  const line = page.locator('.performance-page:visible .perf-antivirus')
  check('Performance says Defender scans the workspace', !!(await lib.until(async () => (await line.count()) === 1, 10000)))
  await line.locator('a').click()
  check('…linking to the status', !!(await lib.until(async () => (await page.locator('.antivirus').count()) === 1, 5000)))

  // The suggestion: once when several agents run; again when a worktree agent adds its folder; never after "Don't ask again".
  const toast = page.locator('.toast', { hasText: 'Defender is scanning this workspace' })
  const a1 = await lib.addAgent(inv, alpha, { name: 'One' })
  const a2 = await lib.addAgent(inv, alpha, { name: 'Two' })
  const ours = [a1.id, a2.id]
  const live = async () => (await inv('session:live')).filter((x) => ours.includes(x.agentId) && x.status === 'ready').length
  const startBoth = async () => {
    for (const a of [a1, a2]) await inv('session:start', alpha, { agentId: a.id })
    await lib.until(async () => (await live()) === 2, 20000)
  }
  const stopBoth = async () => {
    for (const a of [a1, a2]) await inv('session:stop', alpha, a.id).catch(() => undefined)
    await lib.until(async () => (await inv('session:live')).filter((x) => ours.includes(x.agentId)).length === 0, 15000)
  }
  const closeToast = () => toast.locator('button[aria-label="Close"], button[aria-label="Dismiss"], .toast-close').first().click().catch(() => undefined)
  await startBoth()
  check('two agents running: the suggestion, once', !!(await lib.until(async () => (await toast.count()) === 1, 10000)))
  await shot('suggestion-dark')
  await lib.sleep(1500) // A fixed wait on purpose: checks that no second suggestion comes.
  check('…not twice', (await toast.count()) === 1)
  check('…and not again for the same folders', (await inv('antivirus:suggestion')) === null)
  await closeToast()
  await lib.until(async () => (await toast.count()) === 0, 5000)
  // While they run, a worktree agent makes the worktrees folder: suggested again, without anything asking for a status.
  await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  check('a worktree agent adds the worktrees folder: suggested again', !!(await lib.until(async () => (await toast.count()) === 1, 15000)))
  s = await inv('antivirus:status', false)
  check('…the worktrees folder is in the set', s.paths.some((p) => p.kind === 'worktrees' && p.path === fs.realpathSync.native(trees)), JSON.stringify(s.paths))
  await toast.getByRole('button', { name: 'Don’t Ask Again' }).click()
  await stopBoth()
  // Something else changes the folders to offer; after Don't Ask Again nothing is suggested anyway.
  setFixture({ probe: probe({ exclusions: [tests] }), elevated: {} })
  await inv('antivirus:status', true)
  await startBoth()
  await lib.sleep(2500) // A fixed wait on purpose: checks that no suggestion comes.
  check('after Don’t Ask Again: never again for this workspace', (await toast.count()) === 0 && (await inv('antivirus:suggestion')) === null)
  await stopBoth()

  // Light theme.
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.until(async () => (await page.locator('.antivirus').count()) === 1, 5000)
  await page.locator('.antivirus').scrollIntoViewIfNeeded()
  await lib.sleep(500)
  await shot('light')
  // The Add dialog in a narrow window: each folder still on its own line, a long one wrapping inside itself (#347).
  setFixture({ probe: probe(), elevated: {} })
  await panel.getByRole('button', { name: 'Check Again' }).click()
  await lib.until(async () => (await rows.allInnerTexts()).every((t) => /Unknown/.test(t)), 5000)
  const offered = (await inv('antivirus:prepare', 'add')).paths
  await add()
  await lib.fitWindow(app, page, { width: 560, height: 700 })
  await lib.sleep(300)
  const narrow = await dialog.locator('.dialog-list li').evaluateAll((li) => li.map((l) => ({ text: l.textContent, top: l.getBoundingClientRect().top })))
  check('narrow window: still one folder per row, in order', narrow.length >= 2 && JSON.stringify(narrow.map((l) => l.text)) === JSON.stringify(offered) && narrow.every((l, i) => i === 0 || l.top > narrow[i - 1].top), JSON.stringify({ narrow, offered }))
  await shot('add-dialog-light-narrow')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await lib.fitWindow(app, page, { width: 1400, height: 950 })
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // A test copy without a fixture never asks Defender, and refuses to change it.
  const callsBefore = calls().length
  await app.evaluate(() => {
    delete process.env.HIVE_TEST_ANTIVIRUS
  })
  s = await inv('antivirus:status', true)
  const refused = await inv('antivirus:prepare', 'add').then(() => null, (e) => String(e.message ?? e))
  check('without a fixture, a test copy never asks Defender and refuses changes', s.scan === 'test-copy' && !!refused && calls().length === callsBefore, `${s.scan} ${refused}`)

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
