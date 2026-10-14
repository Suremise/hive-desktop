// Screenshot cases for the `git` area (#804): the Git tab without a repository and its Initialise dialog, History
// (commits and tags), Branches & remotes (upstream, branches, remotes, worktrees, commit identity), its forms, the
// failed-load and failed-refresh notes, the status bar's tooltip and the .hive notice with its Untrack dialog, reached
// for the i18nshots route (#756's design, section 4) with locale-independent means only: git run on the project, IPC
// failures (HIVE_TEST_FAIL_IPC), command ids and structural hooks (data-section, data-action, data-git-*, classes),
// never English text. See tests/e2e/i18nshots.cjs for ctx.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed open`)
}

/** Closes the dialog on top with its Cancel (the first subtle button, whatever its words). */
async function cancelDialog(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
}

/** Makes calls on an IPC channel fail: the next one (`*1`), or all until failing(ctx, ''): tests/e2e/README.md. */
const failing = (ctx, calls) => ctx.app.evaluate((_, c) => {
  process.env.HIVE_TEST_FAIL_IPC = c
}, calls)

/** git in the project, with an identity of its own for the commits these cases make (never the machine's config). */
const git = (ctx, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: ctx.project, env: ctx.lib.baseEnv(), stdio: 'pipe', encoding: 'utf8' })

const gitView = (ctx) => ctx.page.locator('.git-view').first()
const section = async (ctx, id, hook, what) => {
  await ctx.page.locator(`.git-sections [data-section="${id}"]`).first().click()
  return shown(ctx, ctx.page.locator(hook), what)
}

/**
 * The project as a repository with history, once per window (the files area's cases made it one, with a first commit;
 * it is made here if they didn't run): a second commit and a tag, a branch, a remote it tracks (a bare repository
 * beside the workspace) with a commit to push, and an unused worktree.
 */
function seedRepo(ctx) {
  const dir = ctx.project
  if (fs.existsSync(path.join(dir, 'CHANGES.md'))) return
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(ctx, 'init', '-q', '-b', 'main')
    git(ctx, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  fs.writeFileSync(path.join(dir, 'CHANGES.md'), '# Changes\n')
  git(ctx, 'add', 'CHANGES.md')
  git(ctx, 'commit', '-qm', 'Add the change log')
  git(ctx, 'tag', '-a', 'v1.0.0', '-m', 'First release')
  git(ctx, 'branch', 'feature/greeting')
  const origin = path.join(path.dirname(ctx.workspace), `${path.basename(ctx.workspace)}-origin.git`)
  if (!fs.existsSync(origin)) execFileSync('git', ['init', '-q', '--bare', origin], { env: ctx.lib.baseEnv(), stdio: 'pipe' })
  git(ctx, 'remote', 'add', 'origin', origin)
  git(ctx, 'push', '-q', '-u', 'origin', 'HEAD')
  fs.writeFileSync(path.join(dir, 'CHANGES.md'), '# Changes\n\n- A greeting\n')
  git(ctx, 'commit', '-qam', 'Note the greeting')
  git(ctx, 'worktree', 'add', '-q', path.join(path.dirname(ctx.workspace), `${path.basename(ctx.workspace)}-wt`), '-b', 'spare')
}

/** The Git tab of a project that isn't a repository: its .git set aside while the screen shows. */
async function gitSetup(ctx) {
  seedRepo(ctx)
  fs.renameSync(path.join(ctx.project, '.git'), path.join(ctx.project, '.git-aside'))
  await ctx.command('project.tab.changes')
  await shown(ctx, ctx.page.locator('[data-git-setup]'), 'the Git tab without a repository')
  return gitView(ctx)
}

/** Its Initialise dialog: what it will do, the starter .gitignore, and the identity git lacks here. */
async function initDialog(ctx) {
  await ctx.page.locator('[data-git-setup] [data-git-init]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('[data-git-init-form]') }).last(), 'the Initialise dialog')
}

/** Its Cancel, and the repository back. */
async function closeInit(ctx) {
  await cancelDialog(ctx)
  fs.renameSync(path.join(ctx.project, '.git-aside'), path.join(ctx.project, '.git'))
  // The tab reads git again when the window gets focus (as after using a terminal).
  await ctx.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await gone(ctx, ctx.page.locator('[data-git-setup]'), 'the Git tab without a repository')
}

/** History when it couldn't be read: said in its place, with Retry. */
async function historyFailed(ctx) {
  await failing(ctx, 'git:history*1')
  await section(ctx, 'history', '.git-view .load-failed', "History's failed load")
  return gitView(ctx)
}

/** Its Retry (the next read works). */
async function retryHistory(ctx) {
  await ctx.page.locator('.git-view .load-failed button').first().click()
  await gone(ctx, ctx.page.locator('.git-view .load-failed'), "History's failed load")
}

/** History: the commits and tags. */
async function history(ctx) {
  await section(ctx, 'history', '[data-git-history] [data-tag]', 'History with its tag')
  return gitView(ctx)
}

/** Create tag's form. */
async function tagForm(ctx) {
  await ctx.page.locator('[data-action="create-tag"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.git-form') }).last(), 'the Create tag form')
}

/** Branches & remotes: the branch and its upstream, branches, remotes, the worktree and the commit identity. */
async function branches(ctx) {
  await section(ctx, 'branches', '[data-git-branches] [data-git-upstream]', 'Branches & remotes with its upstream')
  await shown(ctx, ctx.page.locator('[data-git-branches] [data-worktree-row]'), 'the worktrees')
  return gitView(ctx)
}

/** A refresh that failed while Branches & remotes stays on screen: the note over it, with Retry. */
async function branchesRefreshFailed(ctx) {
  // Every read fails until close, so a read the window starts meanwhile can't take the one failure.
  await failing(ctx, 'git:info')
  await ctx.page.locator('[data-git-branches] [data-action="reload-branches"]').first().click()
  await shown(ctx, ctx.page.locator('.git-view .load-stale'), "the failed refresh's note")
  return gitView(ctx)
}

async function retryBranches(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.git-view .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.git-view .load-stale'), "the failed refresh's note")
}

/** New branch's form. */
async function newBranch(ctx) {
  await ctx.page.locator('[data-action="new-branch"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the New branch form')
}

/** Add a remote's form. */
async function addRemote(ctx) {
  await ctx.page.locator('[data-action="add-remote"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.git-form') }).last(), 'the Add a remote form')
}

/** Commit identity's form. */
async function identityForm(ctx) {
  await ctx.page.locator('[data-action="set-identity"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.git-form') }).last(), 'the commit identity form')
}

/** The status bar's git item, with its tooltip. */
async function statusBar(ctx) {
  const item = await shown(ctx, ctx.page.locator('[data-git-status]').first(), "the status bar's git item")
  await ctx.page.mouse.move(5, 5)
  await item.hover()
  await shown(ctx, ctx.page.locator('.tip:visible'), "its tooltip")
  return null
}

/** The .hive notice in Project Settings: a file in .hive committed to git. */
async function hiveNotice(ctx) {
  const { page, inv, project } = ctx
  await page.mouse.move(5, 5)
  fs.mkdirSync(path.join(project, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(project, '.hive', 'committed.txt'), 'by mistake\n')
  git(ctx, 'add', '-f', '.hive/committed.txt')
  git(ctx, 'commit', '-qm', 'Commit a file in .hive')
  await inv('workspace:refresh')
  await ctx.command('project.tab.settings')
  return shown(ctx, page.locator('.hive-vcs-notice').first(), 'the .hive notice')
}

/** Its Untrack… asks first, listing the files. */
async function untrackDialog(ctx) {
  await ctx.page.locator('.hive-vcs-notice button.primary').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the Untrack dialog')
}

/** Its Cancel, and back to the Session tab for the next area's cases. */
async function closeLast(ctx) {
  await cancelDialog(ctx)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'git',
  screens: [
    { name: 'git-setup', open: gitSetup },
    { name: 'init-dialog', open: initDialog, close: closeInit },
    { name: 'history-failed', open: historyFailed, close: retryHistory },
    { name: 'history', open: history },
    { name: 'tag-form', open: tagForm, close: cancelDialog },
    { name: 'branches', open: branches },
    { name: 'branches-refresh-failed', open: branchesRefreshFailed, close: retryBranches },
    { name: 'new-branch-form', open: newBranch, close: cancelDialog },
    { name: 'add-remote-form', open: addRemote, close: cancelDialog },
    { name: 'identity-form', open: identityForm, close: cancelDialog },
    { name: 'status-bar', open: statusBar },
    { name: 'hive-notice', open: hiveNotice },
    { name: 'untrack-dialog', open: untrackDialog, close: closeLast }
  ]
}
