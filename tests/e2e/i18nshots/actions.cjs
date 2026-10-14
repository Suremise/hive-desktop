// Screenshot cases for the `actions` area (#801): confirmations and prompts the window's actions raise (Stop Session,
// Archive Session and Start New, Save Agents as Template), reached for the i18nshots route (#756's design, section 4)
// with locale-independent means only: IPC, command ids and structural hooks (classes), never English text. See
// tests/e2e/i18nshots.cjs for the case format and ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

const DIALOG = '.dialog[role="dialog"]'

/** Escape until no dialog is left. */
async function closeDialog(ctx) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator(DIALOG).count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the dialog didn't close")
}

/** One's live session (null: none). */
const liveOne = async (ctx) => (await ctx.inv('session:live')).find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === ctx.agents[0].id) ?? null

/** Stop Session's confirmation (Settings → Sessions: confirm before stopping, on by default), for One running. */
async function stopSession(ctx) {
  const { inv, lib, agents, project } = ctx
  await inv('session:start', project, { agentId: agents[0].id })
  if (!(await lib.until(async () => (await liveOne(ctx))?.status === 'ready', ctx.hungMs))) throw new Error(`One did not start: ${JSON.stringify((await liveOne(ctx))?.status ?? null)}`)
  await ctx.command('project.tab.session')
  await ctx.command('agent.show', project, agents[0].id)
  await ctx.command('session.stop')
  return (await shown(ctx, ctx.page.locator(DIALOG), "Stop Session's confirmation")).last()
}

/** Archive Session and Start New's confirmation, for One's running session. */
async function archiveSession(ctx) {
  await ctx.command('session.archive')
  return (await shown(ctx, ctx.page.locator(DIALOG), "Archive Session's confirmation")).last()
}

/** Save Agents as Template: its name prompt. */
async function saveTemplate(ctx) {
  await ctx.command('template.save')
  return (await shown(ctx, ctx.page.locator(DIALOG), "Save Agents as Template's prompt")).last()
}

/** Closes the prompt and stops One. */
async function closeSaveTemplate(ctx) {
  const { inv, lib, agents, project } = ctx
  await closeDialog(ctx)
  await inv('session:stop', project, agents[0].id)
  if (!(await lib.until(async () => { const s = await liveOne(ctx); return !s || s.status === 'stopped' || s.status === 'exited' }, ctx.hungMs))) throw new Error("One didn't stop")
}

module.exports = {
  area: 'actions',
  screens: [
    { name: 'stop-session', open: stopSession, close: closeDialog },
    { name: 'archive-session', open: archiveSession, close: closeDialog },
    { name: 'save-template', open: saveTemplate, close: closeSaveTemplate }
  ]
}
