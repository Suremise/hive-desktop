// Screenshot cases for the `panes` area (#799): the agents' panes with their toolbar and footers (running, finished,
// stopped, watching), a terminal whose process exited, and a project's agents table, reached for the i18nshots route
// (#756's design, section 4) with locale-independent means only: IPC, the Agent API, command ids and structural hooks
// (data-agent, classes), never English text. See tests/e2e/i18nshots.cjs for the case format and ctx.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** The live sessions of the case's agents (null where none). */
const liveOf = async (ctx, agents) => {
  const live = await ctx.inv('session:live')
  return agents.map((a) => live.find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === a.id) ?? null)
}

/** Waits until each agent's session is in one of these states (null: none). */
async function until(ctx, agents, ok, what) {
  if (!(await ctx.lib.until(async () => (await liveOf(ctx, agents)).every(ok), ctx.hungMs))) throw new Error(`${what}: ${JSON.stringify((await liveOf(ctx, agents)).map((s) => s?.status ?? null))}`)
}

/** The agents' tab: One has finished a turn, Two is ready, Three never started (its pane offers to start it). */
async function panes(ctx) {
  const { page, inv, lib, agents, project } = ctx
  const [one, two] = agents
  for (const a of [one, two]) await inv('session:start', project, { agentId: a.id })
  await until(ctx, [one, two], (s) => s?.status === 'ready', 'One and Two did not start')
  await ctx.command('project.tab.session')
  const prompts = lib.fakePrompts(inv, lib.ptyKey(project, one.id), async () => (await liveOf(ctx, [one]))[0], { home: ctx.claudeHome })
  if (!(await prompts.over(await prompts.type('hello')))) throw new Error("One's turn did not end")
  await shown(ctx, page.locator('.session-toolbar'), 'the session toolbar')
  await shown(ctx, page.locator('.pane-footer-bar'), "the panes' footers")
  return null
}

/** A pane whose agent stopped: its terminal says its process exited, and its footer offers to start it again. */
async function stopped(ctx) {
  const { page, inv, agents, project } = ctx
  const two = agents[1]
  await inv('session:stop', project, two.id)
  await until(ctx, [two], (s) => !s || s.status === 'stopped' || s.status === 'exited', "Two didn't stop")
  await shown(ctx, page.locator('.agent-pane'), 'the panes')
  return null
}

/** A project's agents as a table: the sidebar's project status, hovered. */
async function agentsTable(ctx) {
  const { page } = ctx
  // Show Projects toggles the sidebar when it already shows the projects: only when it doesn't.
  if (!(await page.locator('.project-status').count())) await ctx.command('view.projects')
  const status = await shown(ctx, page.locator('.project-status'), "the project's agents status")
  await status.first().hover()
  return (await shown(ctx, page.locator('table.agents-table'), "the project's agents table")).first()
}

/** Stops One and goes back to the agents' tab. */
async function closeAgentsTable(ctx) {
  const { page, inv, agents, project } = ctx
  await page.mouse.move(0, 0)
  await inv('session:stop', project, agents[0].id)
  await until(ctx, [agents[0]], (s) => !s || s.status === 'stopped' || s.status === 'exited', "One didn't stop")
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'panes',
  screens: [
    { name: 'panes', open: panes },
    { name: 'stopped', open: stopped },
    { name: 'agents-table', open: agentsTable, close: closeAgentsTable }
  ]
}
