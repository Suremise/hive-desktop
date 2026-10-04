// A worktree agent's unmerged work on its Merge… button and agent tab: none at first, the count once a turn
// ends with a commit on its branch, gone after the merge, and • for uncommitted files alone. The agent runs the
// fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const userData = path.join(lib.WORK, 'unmerged-profile')
const ws = path.join(lib.WORK, 'unmerged-ws')
const claudeHome = path.join(lib.WORK, 'unmerged-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString()

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  git(alpha, 'config', 'user.email', 't@t')
  git(alpha, 'config', 'user.name', 't')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...process.env, HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CLAUDE_CONFIG_DIR: claudeHome }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

  await page.getByText('alpha', { exact: true }).first().click()
  const two = await lib.addAgent(inv, alpha, { name: 'Two', location: 'new-worktree' })
  const wt = two.worktree.path
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), wt.toLowerCase()]))
  await inv('session:start', alpha, { agentId: two.id })
  check('the agent starts in its worktree', !!(await until(async () => (await live(two.id))?.status === 'ready', 15000)))

  /** A prompt to the agent, and the end of its turn. */
  let turns = 0
  const turn = async () => {
    turns++
    await inv('pty:write', lib.ptyKey(alpha, two.id), `turn ${turns}`)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, two.id), '\r')
    await until(async () => String(await inv('pty:buffer', lib.ptyKey(alpha, two.id))).includes(`Done: turn ${turns}`), 15000)
    await until(async () => (await live(two.id))?.status === 'finished', 15000)
  }
  const merge = page.locator('.pane-header-bar').getByRole('button', { name: 'Merge…' })
  const count = async () => ((await merge.locator('.btn-count').count()) ? await merge.locator('.btn-count').innerText() : '')
  const tabBadge = async () => ((await page.locator('.agent-tab .agent-unmerged').count()) ? await page.locator('.agent-tab .agent-unmerged').innerText() : '')
  const highlighted = async () => /\bsuggest\b/.test((await merge.getAttribute('class')) ?? '')

  await turn()
  await lib.sleep(2500) // A fixed wait on purpose: this checks that no count appears after a turn that changed nothing.
  check('nothing to merge: Merge… is plain', (await count()) === '' && !(await highlighted()) && (await tabBadge()) === '', `${await count()} ${await tabBadge()}`)

  // The agent commits on its branch during a turn: the count shows once the turn ends.
  fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'b')
  await turn()
  check('a commit shows on Merge… once the turn ends', !!(await until(async () => (await count()) === '1', 8000)), await count())
  check('Merge… is highlighted', await highlighted())
  check('and the tab shows ↑1', (await tabBadge()) === '1' && (await page.locator('.agent-tab .agent-unmerged .codicon-arrow-up').count()) === 1, await tabBadge())
  await merge.hover()
  const tip = page.locator('.tip').filter({ hasText: 'not merged' })
  check('its tooltip says what is unmerged', !!(await until(async () => (await tip.count()) > 0, 3000)))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-1-commit.png') })
  await page.mouse.move(5, 400)

  // Merged: the count goes.
  const r = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Merge Two', cleanup: false })
  check('the merge succeeds', r.ok, JSON.stringify(r))
  check('after the merge Merge… is plain again', !!(await until(async () => (await count()) === '' && (await tabBadge()) === '', 8000)), `${await count()} ${await tabBadge()}`)

  // Uncommitted files alone: a dot.
  fs.writeFileSync(path.join(wt, 'c.ts'), 'export const c = 3\n')
  await turn()
  check('uncommitted files alone show •', !!(await until(async () => (await count()) === '•' && (await tabBadge()) === '•', 8000)), `${await count()} ${await tabBadge()}`)
  const st = (await inv('agents:branchStatuses')).find((b) => b.agentId === two.id)?.status
  check('the window was told the counts', st?.ahead === 0 && st?.dirty === 1, JSON.stringify(st))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-2-dirty.png') })

  // A squash merge that keeps the worktree: the branch's commits aren't in master, but their changes are.
  const sq = await inv('agents:merge', alpha, two.id, { squash: true, message: 'Squash Two', cleanup: false })
  check('the squash merge succeeds', sq.ok, JSON.stringify(sq))
  check('git still counts the commit as not merged', git(alpha, 'rev-list', '--count', `master..${two.worktree.branch}`).trim() !== '0')
  check('but after a squash merge Merge… is plain again', !!(await until(async () => (await count()) === '' && (await tabBadge()) === '', 8000)), `${await count()} ${await tabBadge()}`)
  // New work on top of it counts again.
  fs.writeFileSync(path.join(wt, 'd.ts'), 'export const d = 4\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'd')
  await turn()
  check('new work after a squash merge shows again', !!(await until(async () => (await count()) !== '' && (await highlighted()), 8000)), await count())

  // The Merge dialog: Merge and keeping the worktree are the defaults; Squash offers to move the branch.
  await merge.click()
  const dialog = page.locator('[role=dialog]', { hasText: "Merge Two's work" })
  await until(async () => (await dialog.locator('input[type=radio]').count()) === 2, 5000)
  const choice = (name) => dialog.locator('label.choice', { hasText: name }).locator('input[type=radio]')
  const remove = dialog.locator('label', { hasText: 'Remove the worktree' }).locator('input[type=checkbox]')
  const move = dialog.locator('label', { hasText: /^\s*Move hive\// }).locator('input[type=checkbox]')
  check('the dialog defaults to Merge', (await choice('Merge').first().isChecked()) && !(await choice('Squash').isChecked()))
  check('and keeps the worktree', !(await remove.isChecked()))
  check('Merge has no branch move', (await move.count()) === 0)
  await choice('Squash').check()
  check('Squash offers to move the branch, ticked', (await move.count()) === 1 && (await move.isChecked()))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-3-dialog.png') })
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click()
  check('the dialog closes after the squash', !!(await until(async () => (await dialog.count()) === 0, 8000)))
  check('the branch was moved onto the squash commit', git(alpha, 'rev-list', '--count', `master..${two.worktree.branch}`).trim() === '0' && git(wt, 'rev-parse', 'HEAD').trim() === git(alpha, 'rev-parse', 'master').trim())
  check('and Merge… is plain', !!(await until(async () => (await count()) === '', 8000)), await count())
  fs.writeFileSync(path.join(wt, 'e.ts'), 'export const e = 5\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'e')
  await turn()
  check('the next task counts only its own commit', !!(await until(async () => (await count()) === '1', 8000)), await count())
  const next = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Merge Two again', cleanup: false })
  check('and merges cleanly', next.ok && fs.existsSync(path.join(alpha, 'e.ts')), JSON.stringify(next))
  check('the worktree and agent are still there', fs.existsSync(wt) && (await page.locator('.agent-tab', { hasText: 'Two' }).count()) === 1)

  // Not while the agent is in the middle of a task: Merge… is disabled (its count still shows), and Hive refuses.
  fs.writeFileSync(path.join(wt, 'f.ts'), 'export const f = 6\n')
  await inv('pty:write', lib.ptyKey(alpha, two.id), 'work 6')
  await lib.sleep(300)
  await inv('pty:write', lib.ptyKey(alpha, two.id), '\r')
  check('the agent is working', !!(await until(async () => (await live(two.id))?.status === 'working', 8000)))
  check('Merge… is disabled while it works', !!(await until(() => merge.isDisabled(), 3000)))
  await merge.hover({ force: true })
  check('its tooltip says why', !!(await until(async () => (await page.locator('.tip').filter({ hasText: 'Two is working. Merge once it has finished.' }).count()) > 0, 3000)))
  await page.mouse.move(5, 400)
  const busy = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Mid-task', cleanup: false }).then(() => 'merged', (e) => String(e.message ?? e))
  check('a merge while it works is refused', busy.includes('Two is working'), busy)
  check('and nothing was committed', git(wt, 'status', '--porcelain').includes('f.ts'))
  await until(async () => (await live(two.id))?.status === 'finished', 15000)
  check('Merge… is enabled again once it has finished', !!(await until(async () => !(await merge.isDisabled()), 5000)))

  await inv('session:stop', alpha, two.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
