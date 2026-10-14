// Screenshot cases for the `agents` area (#800): Add Agent…, Agent Settings (with its model picker and permission
// modes), the permission mode menu, and the Start New (All) and Remove All confirmations with their agents tables,
// reached for the i18nshots route (#756's design, section 4) with locale-independent means only: IPC, command ids and
// structural hooks (data-agent, classes), never English text. See tests/e2e/i18nshots.cjs for the case format and ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Escape until nothing of `selector` is left (a dialog, a menu). */
async function dismiss(ctx, selector, what) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator(selector).count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error(`${what} didn't close`)
}

const DIALOG = '.dialog[role="dialog"]'
const closeDialog = (what) => (ctx) => dismiss(ctx, DIALOG, what)

/** Add Agent…: its provider, where it works, its model and mode. */
async function addAgent(ctx) {
  await ctx.command('project.tab.session')
  await ctx.command('agent.addWith', ctx.project)
  return (await shown(ctx, ctx.page.locator(DIALOG), 'the Add Agent dialog')).last()
}

/** Agent Settings for One: its name, role, model (the picker) and permission mode. */
async function agentSettings(ctx) {
  await ctx.command('agent.settings', ctx.project, ctx.agents[0].id)
  return (await shown(ctx, ctx.page.locator(DIALOG), 'the Agent Settings dialog')).last()
}

/**
 * The permission mode menu, from a pane footer's mode chip (it shows whether or not the agent runs; the project
 * header's badge, which Switch Permission Mode… opens from, only while one does).
 */
async function modeMenu(ctx) {
  const { page } = ctx
  const chip = await shown(ctx, page.locator('.pane-footer-bar .mode-badge'), "a pane footer's mode chip")
  await chip.first().click()
  return (await shown(ctx, page.locator('.menu[role="menu"]'), 'the permission mode menu')).first()
}

/** Start New (All)'s confirmation: the agents table with what happens to each. */
async function startNewAll(ctx) {
  await ctx.command('session.startNewAll')
  return (await shown(ctx, ctx.page.locator(DIALOG).filter({ has: ctx.page.locator('table.agents-table') }), "Start New (All)'s confirmation")).last()
}

/** Remove All's confirmation: the agents table with what happens to each. */
async function removeAll(ctx) {
  await ctx.command('session.removeAll')
  return (await shown(ctx, ctx.page.locator(DIALOG).filter({ has: ctx.page.locator('table.agents-table') }), "Remove All's confirmation")).last()
}

module.exports = {
  area: 'agents',
  screens: [
    { name: 'add-agent', open: addAgent, close: closeDialog('the Add Agent dialog') },
    { name: 'agent-settings', open: agentSettings, close: closeDialog('the Agent Settings dialog') },
    { name: 'mode-menu', open: modeMenu, close: (ctx) => dismiss(ctx, '.menu[role="menu"]', 'the permission mode menu') },
    { name: 'start-new-all', open: startNewAll, close: closeDialog("Start New (All)'s confirmation") },
    { name: 'remove-all', open: removeAll, close: closeDialog("Remove All's confirmation") }
  ]
}
