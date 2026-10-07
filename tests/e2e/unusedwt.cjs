// Unused worktrees (#353): an agent removed with "Keep worktree and branch" leaves its worktree, said once in a notice
// whose Review opens the project Overview at "Unused worktrees (n)". A merged, clean one is removed there with its branch;
// one with unmerged work shows its commits, has no plain Remove, offers Give to an agent… (Add Agent on Existing
// worktree, that one chosen) and Remove anyway… (a danger confirm naming what goes). The Changes tab says so only while
// one holds work; Storage has a line for them; the Agent API's project status counts them for the Assistant (no way
// to remove them). Deleting a template whose worktree agents left worktrees says so once. Without git, nothing is
// removed. A throwaway repository with worktree agents added through Hive (not started), fake Claude Code configured,
// throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'unusedwt-profile')
const ws = path.join(lib.WORK, 'unusedwt-ws')
const repo = path.join(ws, 'repo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The run context's PATH for a test copy without the folders that hold git. */
function pathWithoutGit() {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (env[key] ?? '')
    .split(path.delimiter)
    .filter((d) => d && !['git.exe', 'git.com'].some((g) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), g))))
    .join(path.delimiter)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(repo)
  const main = lib.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  await app.evaluate(({ shell }) => {
    const fsm = process.getBuiltinModule('fs')
    shell.trashItem = async (p) => fsm.rmSync(p, { force: true })
  })
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `unusedwt-${name}.png`) })
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.sleep(300)
  }
  const toasts = async (re) => (await page.locator('.toast').allInnerTexts()).filter((t) => re.test(t)).length
  const branches = () => lib.git(repo, ['branch', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean)

  // Three worktree agents; Ahead commits work of its own.
  const merged = await lib.addAgent(inv, repo, { name: 'Merged', location: 'new-worktree' })
  const ahead = await lib.addAgent(inv, repo, { name: 'Ahead', location: 'new-worktree' })
  const claudette = await lib.addAgent(inv, repo, { name: 'Claudette', location: 'new-worktree' })
  fs.writeFileSync(path.join(ahead.worktree.path, 'work.txt'), 'work\n')
  lib.git(ahead.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  lib.git(ahead.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Unmerged work'])
  await inv('templates:save', repo, 'workspace', 'Trio', false)
  check('three worktree agents, and none unused yet', (await inv('worktrees:unused', repo)).worktrees.length === 0)

  // --- Remove Merged from its tab, keeping its worktree: one notice, with Review.
  await page.getByText('repo', { exact: true }).first().click()
  await page.locator('.agent-tab', { hasText: 'Merged' }).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Remove Agent…' }).click()
  await page.locator('.dialog').getByRole('button', { name: 'Keep worktree and branch' }).click()
  const keptToast = /Merged's worktree is kept/
  check('removing it keeping its worktree says so once', !!(await lib.until(async () => (await toasts(keptToast)) === 1, 10000)), String(await toasts(keptToast)))
  await inv('agents:remove', repo, ahead.id, { deleteWorktree: false })
  await lib.sleep(500)
  check('…once only', (await toasts(keptToast)) === 1)

  // --- Review: the Overview's section.
  await page.locator('.toast', { hasText: keptToast }).getByRole('button', { name: 'Review unused worktrees' }).click()
  const section = page.locator('.unused-worktrees')
  check('Review opens the Overview at Unused worktrees (2)', !!(await lib.until(async () => (await section.count()) === 1 && /Unused worktrees\s*2/.test(await section.locator('h2').innerText()), 10000)), await section.innerText().catch(() => ''))
  const row = (wt) => section.locator(`.unused-wt[data-path="${wt.worktree.path.replace(/\\/g, '\\\\')}"]`)
  const mergedRow = row(merged)
  const aheadRow = row(ahead)
  check(`the merged one: "Merged into ${main} · clean", with Remove`, (await mergedRow.innerText()).includes(`Merged into ${main} · clean`) && (await mergedRow.getByRole('button', { name: 'Remove', exact: true }).count()) === 1, await mergedRow.innerText().catch(() => ''))
  check(`the unmerged one: "1 commit not on ${main}", its last commit, no plain Remove`, (await aheadRow.innerText()).includes(`1 commit not on ${main}`) && (await aheadRow.innerText()).includes('Unmerged work') && (await aheadRow.getByRole('button', { name: 'Remove', exact: true }).count()) === 0, await aheadRow.innerText().catch(() => ''))
  check('…Give to an agent… and Remove anyway…', (await aheadRow.getByRole('button', { name: 'Give to an agent…' }).count()) === 1 && (await aheadRow.getByRole('button', { name: 'Remove anyway…' }).count()) === 1)
  check('sizes are measured', !!(await lib.until(async () => /\d+(\.\d+)? (B|KB|MB)/.test(await mergedRow.innerText()), 15000)), await mergedRow.innerText())
  check('Remove all merged (1)…', (await section.getByRole('button', { name: 'Remove all merged (1)…' }).count()) === 1)
  await section.scrollIntoViewIfNeeded()
  await shot('overview-dark')
  await theme('light')
  await shot('overview-light')
  await theme('dark')

  // --- The Changes tab: the notice, only while one holds work.
  await page.locator('.tab', { hasText: 'Changes' }).click()
  const notice = page.locator('.unused-work-notice')
  check('Changes says an unused worktree has work not on main', !!(await lib.until(async () => (await notice.count()) === 1, 8000)) && (await notice.innerText()).includes(`1 unused worktree has work that isn't on ${main}`), await notice.innerText().catch(() => ''))
  await shot('changes')
  await notice.getByText('Review').click()
  check('…its Review goes to the Overview section', !!(await lib.until(async () => (await section.count()) === 1, 8000)))

  // --- Storage: a line for them.
  const st = await inv('storage:project', repo, true)
  check('Storage counts them', (st.unusedWorktrees ?? []).length === 2 && st.unusedWorktrees.every((w) => w.bytes > 0), JSON.stringify(st.unusedWorktrees))

  // --- The Assistant's view: counts, no way to remove.
  const api = await inv('api:info')
  const status = await fetch(`${api.url}/v1/projects/repo`, { headers: { Authorization: `Bearer ${api.token}` } }).then((r) => r.json())
  check('project status counts them for the Assistant', JSON.stringify(status.unusedWorktrees) === JSON.stringify({ count: 2, merged: 1 }), JSON.stringify(status.unusedWorktrees))

  // --- Remove the merged one: folder and branch.
  await mergedRow.getByRole('button', { name: 'Remove', exact: true }).click()
  check('Remove deletes the merged one and its branch', !!(await lib.until(async () => (await mergedRow.count()) === 0 && !fs.existsSync(merged.worktree.path), 10000)) && !branches().includes(merged.worktree.branch), JSON.stringify(branches()))

  // --- The unmerged one: plain removal refused; Give to an agent…; Remove anyway….
  const refused = await inv('worktrees:removeUnused', repo, ahead.worktree.path, {})
  check('a plain removal of the unmerged one is refused', refused.deleted === false && /1 commit not merged/.test(refused.reason ?? '') && fs.existsSync(ahead.worktree.path), JSON.stringify(refused))
  await aheadRow.getByRole('button', { name: 'Give to an agent…' }).click()
  const add = page.locator('.dialog', { hasText: 'Add an agent' })
  await lib.until(async () => (await add.count()) === 1, 5000)
  // Chosen once git has listed the project's worktrees (the dialog asks as it opens).
  const select = add.locator('.choice', { hasText: 'Existing worktree' }).locator('select')
  const chosen = (await lib.until(async () => (await select.inputValue().catch(() => '')) || null, 8000)) ?? ''
  check('Give to an agent… opens Add Agent on Existing worktree, that one chosen', (await add.locator('.choice.selected', { hasText: 'Existing worktree' }).count()) === 1 && chosen.toLowerCase() === ahead.worktree.path.toLowerCase(), chosen)
  await shot('give')
  await page.keyboard.press('Escape')
  await lib.until(async () => (await add.count()) === 0, 3000)
  await aheadRow.getByRole('button', { name: 'Remove anyway…' }).click()
  const danger = page.locator('.dialog', { hasText: 'Remove the worktree anyway?' })
  await lib.until(async () => (await danger.count()) === 1, 5000)
  check('Remove anyway… names what goes', (await danger.innerText()).includes(`1 commit on ${ahead.worktree.branch} not on ${main}`), await danger.innerText())
  await shot('anyway')
  // Changed while the question is open: confirming removes nothing, and says why in the dialog.
  fs.writeFileSync(path.join(ahead.worktree.path, 'later.txt'), 'written after the question')
  await danger.getByRole('button', { name: 'Remove Anyway' }).click()
  check('a worktree changed while the question was open is kept, saying why', !!(await lib.until(async () => /changed since you were shown/.test(await danger.innerText().catch(() => '')), 8000)) && fs.existsSync(path.join(ahead.worktree.path, 'later.txt')), await danger.innerText().catch(() => ''))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await danger.count()) === 0, 3000)
  await aheadRow.getByRole('button', { name: 'Remove anyway…' }).click()
  await lib.until(async () => (await danger.count()) === 1, 5000)
  check('asked again, it names the new file too', (await danger.innerText()).includes('2 uncommitted files') || (await danger.innerText()).includes('1 uncommitted file'), await danger.innerText())
  await danger.getByRole('button', { name: 'Remove Anyway' }).click()
  check('…and removes it, branch too (the branch goes just after the folder)', !!(await lib.until(async () => !fs.existsSync(ahead.worktree.path) && !branches().includes(ahead.worktree.branch), 10000)), JSON.stringify([fs.existsSync(ahead.worktree.path), branches(), (await page.locator('.toast').allInnerTexts()).join(' | ')]))
  check('the section goes with the last of them', !!(await lib.until(async () => (await section.count()) === 0, 8000)))
  await page.locator('.tab', { hasText: 'Changes' }).click()
  // The tab loads its list first; the notice would be there by then.
  await lib.until(async () => (await page.locator('.split-list .pane-header', { hasText: 'Changes' }).count()) === 1, 8000)
  await lib.sleep(500)
  check('…and the Changes notice', (await notice.count()) === 0)

  // --- Deleting the template whose worktree agent left one: said once.
  await inv('agents:remove', repo, claudette.id, { deleteWorktree: false })
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Show Templates')
  await page.keyboard.press('Enter')
  await page.locator('.sidebar .template-row[aria-label="Trio"]').click()
  await page.locator('.main-area > .tab-body .template-detail [aria-label="Delete template"]').click()
  await page.locator('.dialog', { hasText: 'Delete "Trio"?' }).getByRole('button', { name: 'Delete' }).click()
  const hint = /1 unused worktree in repo/
  check('deleting the template says its worktree agents left one, once', !!(await lib.until(async () => (await toasts(hint)) === 1, 10000)), (await page.locator('.toast').allInnerTexts()).join(' | '))
  check('…and touches no worktree', fs.existsSync(claudette.worktree.path))
  await lib.sleep(500)
  check('…once only', (await toasts(hint)) === 1)
  await app.close()

  // --- Without git: nothing is removed.
  ;({ app, page, inv } = await lib.launch({ userData, env: { PATH: pathWithoutGit() } }))
  await lib.openWorkspace(inv, page, ws)
  const nogit = await inv('worktrees:unused', repo)
  check('without git, the list says why instead', nogit.worktrees.length === 0 && /Git isn't installed/.test(nogit.gitProblem ?? ''), JSON.stringify(nogit))
  const kept = await inv('worktrees:removeUnused', repo, claudette.worktree.path, {})
  const preview = await inv('worktrees:removalPreview', repo, claudette.worktree.path).then(() => 'offered', (e) => String(e?.message ?? e))
  const keptAnyway = await inv('worktrees:removeUnused', repo, claudette.worktree.path, { force: 'any-token' })
  check('…and nothing is removed, Remove or Remove anyway (nothing to confirm without git)', !kept.deleted && !keptAnyway.deleted && /isn't installed/.test(preview) && fs.existsSync(claudette.worktree.path), JSON.stringify([kept, keptAnyway, preview]))
  await app.close()

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
