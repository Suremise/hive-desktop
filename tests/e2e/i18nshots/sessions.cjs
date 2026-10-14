// Screenshot cases for the `sessions` area (#802): the Sessions tab with its list of sessions (grouped by provider and
// agent) and one session's transcript open, and a session's menu, reached for the i18nshots route (#756's design,
// section 4) with locale-independent means only: IPC, command ids and structural hooks (data-key, classes), never
// English text. The panes cases before it leave sessions to list (One and Three said hello). See
// tests/e2e/i18nshots.cjs for the case format and ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** A session's row in the list (data-key "s:<id>"). */
const sessionRow = (page) => page.locator('[data-key^="s:"]').first()

/** The Sessions tab, a session chosen: its list, the transcript's header and its turns. */
async function sessions(ctx) {
  const { page } = ctx
  await ctx.command('project.tab.sessions')
  const row = await shown(ctx, sessionRow(page), "the Sessions tab's sessions")
  await row.first().click()
  await shown(ctx, page.locator('.tx-head'), "the session's transcript")
  return null
}

/** A session's menu (right-click on its row). */
async function sessionMenu(ctx) {
  const { page } = ctx
  await sessionRow(page).click({ button: 'right' })
  return (await shown(ctx, page.locator('.menu[role="menu"]'), "a session's menu")).first()
}

/** Closes the menu and goes back to the agents' tab. */
async function closeMenu(ctx) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator('.menu[role="menu"]').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the session's menu didn't close")
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'sessions',
  screens: [
    { name: 'sessions', open: sessions },
    { name: 'session-menu', open: sessionMenu, close: closeMenu }
  ]
}
