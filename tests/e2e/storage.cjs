// Project Settings → Storage and Clean Up…, on fixtures: a project with archived sessions old and recent (some the
// "CLI" still has, one it lost), a session that isn't archived, images of each, of a deleted session and of launches
// (one running), and a worktree. Storage shows their sizes, Settings → Workspace links to it, the preview lists exactly
// what goes, Clean Up moves exactly that to the Recycle Bin, and the Overview's totals don't change (also after the
// CLI's copy goes). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (the fake Claude Code's transcripts).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'storage-profile')
const ws = path.join(lib.WORK, 'storage-ws')
const claudeHome = path.join(lib.WORK, 'storage-claude-home')
const alpha = path.join(ws, 'alpha')
const hive = path.join(alpha, '.hive')
const cliDir = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
/** A folder's size the way Storage counts it: files only, links not followed. */
const sizeOf = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false })
  if (!st) return 0
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0)
}

const id = (n) => `5707a9e0-0000-4000-8000-00000000000${n}`
const OLD_CLI = id(1) // archived 200 days ago; the CLI has it
const OLD_GONE = id(2) // archived 200 days ago; the CLI lost it
const RECENT = id(3) // archived 10 days ago
const OPEN = id(4) // not archived, 200 days ago
const DELETED = id(5) // deleted: only its images are left
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const transcript = (sid, n) =>
  [
    { type: 'user', sessionId: sid, timestamp: ago(200), message: { role: 'user', content: `Task ${n}` } },
    { type: 'assistant', sessionId: sid, requestId: `r${n}`, timestamp: ago(200), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done ${n}.` }], usage: { input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 100, output_tokens: 50 * n } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  // The fixtures: Hive's backups (archive, sessions), the CLI's copies, and images.
  const sessions = [
    { id: OLD_CLI, name: 'Old with CLI copy', archived: true, days: 200, cli: true, n: 1 },
    { id: OLD_GONE, name: 'Old, CLI lost it', archived: true, days: 200, cli: false, n: 2 },
    { id: RECENT, name: 'Recent archived', archived: true, days: 10, cli: true, n: 3 },
    { id: OPEN, name: 'Not archived', archived: false, days: 200, cli: true, n: 4 }
  ]
  for (const s of sessions) {
    write(path.join(hive, s.archived ? 'archive' : 'sessions', `${s.id}.jsonl`), transcript(s.id, s.n))
    if (s.cli) write(path.join(cliDir, `${s.id}.jsonl`), transcript(s.id, s.n))
    write(path.join(hive, 'images', s.id, 'shot.png'), lib.samplePng(40 + s.n * 10, 30))
  }
  write(path.join(hive, 'images', DELETED, 'shot.png'), lib.samplePng(90, 60))
  write(path.join(hive, 'images', 'run-deadbeef', 'early.png'), lib.samplePng(70, 50))
  write(
    path.join(hive, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: sessions.map((s) => ({ id: s.id, agent: 'claude-code', name: s.name, createdAt: ago(s.days + 1), lastActiveAt: ago(s.days), archived: s.archived })),
      deleted: [DELETED]
    })
  )

  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47908), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // A running launch (its early images folder must stay) and a worktree agent (its folder is counted).
  const live = await lib.addAgent(inv, alpha, { name: 'Live' })
  await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  await inv('session:start', alpha, { agentId: live.id })
  const state = await until(async () => (await inv('session:live')).find((s) => s.agentId === live.id && s.status === 'ready'), 20000)
  check('the live agent is running', !!state)
  const runDir = path.join(hive, 'images', `run-${state?.runId}`)
  write(path.join(runDir, 'pending.png'), lib.samplePng(30, 30))
  const liveImages = state?.sessionId ? path.join(hive, 'images', state.sessionId) : null
  if (liveImages) write(path.join(liveImages, 'now.png'), lib.samplePng(20, 20))

  const totals = async () => {
    const u = await inv('workspace:usage')
    const items = u.projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase())?.items ?? []
    // The fixtures' sessions only (the live one grows as it runs).
    const ours = items.filter((i) => sessions.some((s) => s.id === i.id))
    return JSON.stringify(['outputTokens', 'inputTokens', 'cacheReadTokens', 'requests'].map((k) => ours.reduce((n, i) => n + (i.usage?.[k] ?? 0), 0)))
  }
  const before = await totals()
  check('the fixtures count in the totals', before === JSON.stringify([500, 100, 10000, 4]), before)

  // Storage: the sizes.
  const st = await inv('storage:project', alpha, true)
  check('Storage: transcript backups', st.sessions === sizeOf(path.join(hive, 'sessions')), `${st.sessions} vs ${sizeOf(path.join(hive, 'sessions'))}`)
  check('Storage: archive', st.archive === sizeOf(path.join(hive, 'archive')) && st.archive > 0, `${st.archive}`)
  check('Storage: images', st.images === sizeOf(path.join(hive, 'images')), `${st.images} vs ${sizeOf(path.join(hive, 'images'))}`)
  check('Storage: the worktree', st.worktrees.length === 1 && st.worktrees[0].agent === 'Tree' && st.worktrees[0].bytes === sizeOf(st.worktrees[0].path) && st.worktrees[0].bytes > 0, JSON.stringify(st.worktrees))
  check('Storage: the total', st.total === st.sessions + st.archive + st.images + st.worktrees[0]?.bytes)

  // Settings → Workspace lists the project and the Assistant, and its Storage link opens the project's page.
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  const wsTable = page.locator('.storage-table').first()
  check('Settings → Workspace lists alpha', !!(await until(async () => (await wsTable.locator('tr', { hasText: 'alpha' }).count()) > 0)))
  check('… and the Hive Assistant', (await wsTable.locator('tr', { hasText: 'Hive Assistant' }).count()) === 1)
  await wsTable.locator('tr', { hasText: 'alpha' }).getByRole('button', { name: 'Storage' }).click()
  const group = page.locator('.settings-group', { has: page.locator('h2', { hasText: /^Storage$/ }) })
  check('the link opens Project Settings → Storage', !!(await until(async () => (await group.locator('.storage-table').count()) > 0)))
  check('the page shows the backups row', (await group.locator('tr', { hasText: 'Transcript backups' }).count()) === 1)
  check("… and the worktree's", (await group.locator('tr', { hasText: "Tree's worktree" }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'storage-page.png') })

  // Clean Up…: the default (old archived sessions' images), then every option.
  await group.getByRole('button', { name: 'Clean Up…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean Up alpha' })
  const rows = () => dialog.locator('.cleanup-preview tr').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
  const norm = (list) => list.map((p) => path.relative(hive, p).replace(/\\/g, '/')).sort()
  const want = (list) => JSON.stringify([...list].sort())
  const previewIs = async (list) => (await until(async () => want(norm(await rows())) === want(list), 5000)) || norm(await rows())
  let got = await previewIs([`images/${OLD_CLI}`, `images/${OLD_GONE}`])
  check("by default: old archived sessions' images", got === true, JSON.stringify(got))
  await dialog.locator('label.choice', { hasText: 'Images of deleted sessions' }).locator('input').check()
  await dialog.locator('label.choice', { hasText: "Hive's backups of archived sessions" }).locator('input[type=checkbox]').check()
  got = await previewIs([`images/${OLD_CLI}`, `images/${OLD_GONE}`, `images/${DELETED}`, 'images/run-deadbeef', `archive/${OLD_CLI}.jsonl`])
  check('orphan images (not the running launch’s) and the backup the CLI still has', got === true, JSON.stringify(got))
  check('no warning before the last-copies option', (await dialog.locator('.banner.danger').count()) === 0)
  await dialog.locator('label.choice', { hasText: 'the CLI no longer has' }).locator('input').check()
  got = await previewIs([`images/${OLD_CLI}`, `images/${OLD_GONE}`, `images/${DELETED}`, 'images/run-deadbeef', `archive/${OLD_CLI}.jsonl`, `archive/${OLD_GONE}.jsonl`])
  check('the last copy of the session the CLI lost', got === true, JSON.stringify(got))
  check('… with a warning that it cannot be resumed or read', ((await dialog.locator('.banner.danger').textContent()) ?? '').includes("can't be resumed or read"))
  // A shorter age takes the recent session's images and backup too; back to 90 leaves them out again.
  await dialog.getByLabel('Image age in days').fill('5')
  got = await previewIs([`images/${OLD_CLI}`, `images/${OLD_GONE}`, `images/${RECENT}`, `images/${DELETED}`, 'images/run-deadbeef', `archive/${OLD_CLI}.jsonl`, `archive/${OLD_GONE}.jsonl`])
  check('the days field changes what is listed', got === true, JSON.stringify(got))
  await dialog.getByLabel('Image age in days').fill('90')
  const listed = [`images/${OLD_CLI}`, `images/${OLD_GONE}`, `images/${DELETED}`, 'images/run-deadbeef', `archive/${OLD_CLI}.jsonl`, `archive/${OLD_GONE}.jsonl`]
  got = await previewIs(listed)
  check('back to 90 days', got === true, JSON.stringify(got))
  const button = dialog.getByRole('button', { name: /to the Recycle Bin/ })
  check('the button says how much goes', /Move 6 items \(.+\) to the Recycle Bin/.test((await button.textContent()) ?? ''), await button.textContent())
  await page.screenshot({ path: path.join(lib.WORK, 'storage-cleanup.png') })
  const everything = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f)))
  const keptBefore = everything(hive).filter((p) => !listed.some((l) => p.toLowerCase().startsWith(path.join(hive, l).toLowerCase())))
  await button.click()
  check('the dialog closes', !!(await until(async () => (await dialog.count()) === 0, 15000)))

  // Exactly what was listed went; everything else stayed.
  check('the listed files are gone', listed.every((l) => !fs.existsSync(path.join(hive, l))), listed.filter((l) => fs.existsSync(path.join(hive, l))).join(', '))
  const missing = keptBefore.filter((p) => !p.endsWith('sessions.json') && !p.endsWith('.bak') && !fs.existsSync(p))
  check('nothing else went', missing.length === 0, missing.join(', '))
  check("the running launch's images stayed", fs.existsSync(path.join(runDir, 'pending.png')))
  check('the recent and not-archived sessions kept their backups', fs.existsSync(path.join(hive, 'archive', `${RECENT}.jsonl`)) && fs.existsSync(path.join(hive, 'sessions', `${OPEN}.jsonl`)))
  check("the CLI's transcripts are untouched", [OLD_CLI, RECENT, OPEN].every((s) => fs.existsSync(path.join(cliDir, `${s}.jsonl`))))
  check('the worktree is untouched', fs.existsSync(st.worktrees[0].path) && sizeOf(st.worktrees[0].path) === st.worktrees[0].bytes)

  // The lost session is deleted like Delete Session; the other keeps its record.
  const file = JSON.parse(fs.readFileSync(path.join(hive, 'sessions.json'), 'utf8'))
  check('the session the CLI lost is deleted', !file.sessions.some((s) => s.id === OLD_GONE) && file.deleted.includes(OLD_GONE) && file.deletedUsage.some((k) => k.id === OLD_GONE))
  check('the session the CLI still has stays, with its usage kept', file.sessions.find((s) => s.id === OLD_CLI)?.keptUsage?.outputTokens === 50)
  const list = await inv('session:list', alpha)
  check('the Sessions tab no longer lists the lost one', !list.some((s) => s.id === OLD_GONE) && list.some((s) => s.id === OLD_CLI))
  check('the totals are unchanged', (await totals()) === before, `${await totals()} vs ${before}`)

  // The CLI drops its copy later: the totals still count it.
  fs.rmSync(path.join(cliDir, `${OLD_CLI}.jsonl`))
  check("… also after the CLI's copy goes", (await totals()) === before, `${await totals()} vs ${before}`)

  // Storage shows the smaller sizes.
  const after = await inv('storage:project', alpha, true)
  check('Storage measures again after Clean Up', after.archive === sizeOf(path.join(hive, 'archive')) && after.images === sizeOf(path.join(hive, 'images')) && after.total < st.total)

  await inv('session:stop', alpha, live.id).catch(() => undefined)
  await app.close().catch(() => undefined)
  console.log(failed ? `${failed} check(s) failed` : 'All storage checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
