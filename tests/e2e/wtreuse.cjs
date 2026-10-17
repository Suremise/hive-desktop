// Adding an agent with a worktree reuses a matching unused worktree (#456). An unused, merged worktree hive/b4 is in
// Hive's worktrees folder and main has moved on: Add Agent named B4 on New worktree says it reuses that folder, brought
// up to main; adding gets B4 that folder at main's commit (no hive/b4-2), and a notice says "Reused hive/b4, brought up
// to main at …". An unused hive/held with a commit of its own: New worktree says it holds work and offers to reuse it,
// which picks Existing worktree with it; adding keeps its commit, and the notice says so. An unused, merged hive/xa added
// with the window in the pseudo-locale: its notice is in the window's language, not English (#844). Screenshots in both themes.
// Throwaway repository, profile and workspace; quiet; no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'wtreuse-profile')
const ws = path.join(lib.WORK, 'wtreuse-ws')
const repo = path.join(ws, 'repo')
const trees = path.join(`${ws}.worktrees`, 'repo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a]).trim()
const commit = (cwd, file) => {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-qm', file)
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(repo)
  git(repo, 'branch', '-M', 'main')
  // Unused worktrees as an agent removed with "Keep worktree and branch" leaves them: b4 merged, held with work.
  const b4 = path.join(trees, 'b4')
  const held = path.join(trees, 'held')
  git(repo, 'worktree', 'add', '-q', '-b', 'hive/b4', b4, 'main')
  git(repo, 'worktree', 'add', '-q', '-b', 'hive/held', held, 'main')
  git(repo, 'worktree', 'add', '-q', '-b', 'hive/xa', path.join(trees, 'xa'), 'main')
  commit(held, 'held.txt')
  const heldTip = git(held, 'rev-parse', 'HEAD')
  commit(repo, 'later.txt')
  const mainTip = git(repo, 'rev-parse', 'main')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `wtreuse-${name}.png`) })
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? '')) === t, HUNG_MS)
  }
  const agents = async () => (await inv('workspace:refresh')).projects.find((p) => same(p.path, repo))?.agents ?? []
  await page.getByText('repo', { exact: true }).first().click()

  const dialog = page.locator('.dialog', { hasText: 'Add an agent' })
  const openDialog = async () => {
    // The session toolbar's + Add ▾ (#975), with agents or without.
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    await lib.until(async () => (await dialog.count()) === 1, 5000)
    await dialog.locator('label', { hasText: 'Start a session now' }).locator('input').uncheck()
  }

  // --- B4 on New worktree: the dialog says it reuses hive/b4, brought up to main.
  await openDialog()
  await dialog.locator('input.input').first().fill('B4')
  await dialog.locator('.choice', { hasText: 'New worktree' }).click()
  const reuse = dialog.locator('[data-worktree-match="reuse"]')
  check('New worktree named B4 says it reuses hive/b4, brought up to main', !!(await lib.until(async () => (await reuse.count()) === 1, 8000)) && /Reuses .*b4.*hive\/b4.*merged into main and clean, so Hive brings it up to main/.test(await reuse.innerText()), await dialog.innerText())
  await shot('reuse-dark')
  await theme('light')
  await shot('reuse-light')
  await theme('dark')
  await dialog.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const added = await lib.until(async () => (await agents()).find((a) => a.name === 'B4'), 15000)
  check('B4 works in hive/b4\'s folder', !!added && same(added.worktree?.path ?? '', b4) && added.worktree?.branch === 'hive/b4', JSON.stringify(added?.worktree))
  check("…at main's commit", git(b4, 'rev-parse', 'HEAD') === mainTip)
  check('…and no hive/b4-2 was made', !git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/).includes('hive/b4-2'))
  const note = page.locator('.toast', { hasText: 'worktree reused' })
  check('a notice says "Reused hive/b4, brought up to main at …"', !!(await lib.until(async () => (await note.count()) === 1, 5000)) && (await note.innerText()).includes(`Reused hive/b4, brought up to main at ${mainTip.slice(0, 7)}`), await page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))

  // --- Held on New worktree: it holds work, so Hive offers to reuse it (keeping its work) or makes a new one.
  await openDialog()
  await dialog.locator('input.input').first().fill('Held')
  await dialog.locator('.choice', { hasText: 'New worktree' }).click()
  const offer = dialog.locator('[data-worktree-match="held"]')
  check('New worktree named Held says its unused worktree holds work (1 commit not merged into main)', !!(await lib.until(async () => (await offer.count()) === 1, 8000)) && (await offer.innerText()).includes('1 commit not merged into main'), await dialog.innerText())
  await shot('held-dark')
  await theme('light')
  await shot('held-light')
  await theme('dark')
  await offer.getByText('reuse it (it keeps its work)').click()
  const existing = dialog.locator('.choice', { hasText: 'Existing worktree' })
  check('…and its offer picks Existing worktree with it', !!(await lib.until(async () => (await existing.locator('input[type="radio"]').isChecked()) && same(await existing.locator('select').inputValue(), held), HUNG_MS)))
  await dialog.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const heldAgent = await lib.until(async () => (await agents()).find((a) => a.name === 'Held'), 15000)
  check('Held works in it, its commit kept', !!heldAgent && same(heldAgent.worktree?.path ?? '', held) && git(held, 'rev-parse', 'HEAD') === heldTip, JSON.stringify(heldAgent?.worktree))
  const kept = page.locator('.toast', { hasText: 'Reused hive/held as it is' })
  check('…and a notice says it keeps its work', !!(await lib.until(async () => (await kept.count()) === 1, 5000)), await page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))

  // --- XA on New worktree, added with the window in the pseudo-locale (#844): the notice is in the window's language.
  await openDialog()
  await dialog.locator('input.input').first().fill('XA')
  await dialog.locator('.choice', { hasText: 'New worktree' }).click()
  check('New worktree named XA says it reuses hive/xa', !!(await lib.until(async () => (await reuse.count()) === 1, 8000)), await dialog.innerText())
  // As main sends it when the language setting changes (HIVE_LANG pins the run's language, so not through Settings).
  const info = (await inv('app:info')).language
  await app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', e), { type: 'language-changed', language: { ...info, code: 'en-XA', messages: {} } })
  const addXa = page.locator('.dialog .btn.primary', { has: page.locator('.codicon-add') })
  check('…and the dialog follows the pseudo-locale', !!(await lib.until(async () => /^\[.*\]$/.test((await addXa.innerText()).trim()), HUNG_MS)), await addXa.innerText())
  await addXa.click()
  check("XA works in hive/xa's folder", !!(await lib.until(async () => (await agents()).find((a) => a.name === 'XA' && a.worktree?.branch === 'hive/xa'), 15000)))
  const xaNote = page.locator('.toast', { hasText: 'hive/xa' })
  const xaText = async () => ((await xaNote.count()) === 1 ? await xaNote.innerText() : '')
  check('…and its notice is in the pseudo-locale, not English', !!(await lib.until(async () => /\[[^\]]*hive\/xa[^\]]*\]/.test(await xaText()), 5000)) && !/reused/i.test(await xaText()), await page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))
  await shot('pseudo-notice-dark')

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
