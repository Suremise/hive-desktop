// What only the real Claude Code can show, from suites whose Hive-side checks run the fake (#195): no prompt is sent.
// - A session starts in a worktree agent's worktree (agents checks the rest of worktree agents with the fake).
// - A relaunch with a changed setting (Restart session after a new effort) is taken by Claude Code, bringing the same
//   session back (restart checks Hive's side with the fake).
// - The Assistant's launch is taken by Claude Code in the workspace folder, asking for Auto, with Haiku. Whether Claude
//   Code runs Haiku in Auto depends on its version and the account (#129): its initialize reply says (supportsAutoMode).
//   Hive must show the mode the session really runs in, whichever that is, and warn exactly when Auto isn't offered:
//   Auto when it says Haiku takes Auto, else Manual (2.1.286 and 2.1.289 run it in Manual); either when it doesn't say
//   (assistant checks the rest with the fake).
// Each wait on the CLI is a lib.cliStep: a usage limit, sign-in or network failure there makes the suite a SKIP.
// Dev build, throwaway profile and workspace, the user's own signed-in Claude Code.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'claude-real-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test sessions (#174).
const ws = path.join(lib.WORK, 'claude-real-ws')
const wtRoot = `${ws}.worktrees`
const proj = path.join(ws, 'demo')
const home = path.join(ws, '.hive', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, wtRoot]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj, { 'README.md': '# Demo\n' })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47925) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  await page.getByText('demo', { exact: true }).first().click()
  const live = async (host, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === id)
  const ready = (host, id, ms = 60000) => lib.until(async () => (await live(host, id))?.status === 'ready', ms, 400)
  const stop = async (host, id) => {
    await inv('session:stop', host, id)
    await lib.until(async () => !(await live(host, id)), 20000)
  }
  /** Hive's last launch line for a session key (its log marks the key and ids as the user's text: found by their parts). */
  const launchLine = (key) => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => / spawn \W?session:/.test(l) && l.toLowerCase().includes(key)).pop() ?? ''

  // --- A session in a worktree.
  const reviewer = await inv('agents:add', proj, { location: 'new-worktree', name: 'Reviewer' })
  const wtPath = reviewer.worktree?.path ?? ''
  await inv('session:start', proj, { agentId: reviewer.id })
  await lib.cliStep('a session starts in the worktree', { session: lib.ptyKey(proj, reviewer.id) }, async () => {
    await lib.acceptClaudeTrust(inv, proj, reviewer.id, 30000)
    check('Claude Code starts in a worktree agent', !!(await ready(proj, reviewer.id)), (await live(proj, reviewer.id))?.status)
  })
  const l = await live(proj, reviewer.id)
  check('…in its worktree', !!wtPath && path.resolve(l?.cwd ?? '').toLowerCase() === path.resolve(wtPath).toLowerCase(), `${l?.cwd} vs ${wtPath}`)
  await stop(proj, reviewer.id)

  // --- Restart session with a new effort: Claude Code takes the relaunch, the same session.
  // The project's only agent, so its pane (where Restart session is offered) is the one on screen.
  const agent = await lib.soloAgent(inv, proj, { name: 'Coder' })
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { agentId: agent.id, name: 'restart test' })
  await lib.cliStep('a session starts', { session: lib.ptyKey(proj, agent.id) }, async () => {
    await lib.acceptClaudeTrust(inv, proj, agent.id, 30000)
    check('Claude Code starts in the project', !!(await ready(proj, agent.id)), (await live(proj, agent.id))?.status)
  })
  await inv('project:updateConfig', proj, { providers: { 'claude-code': { effort: 'low' } } })
  await inv('workspace:refresh')
  const restart = page.getByRole('button', { name: 'Restart session' })
  check('a new effort offers Restart session', !!(await lib.until(async () => (await restart.count()) > 0, 10000)))
  await restart.first().click()
  await lib.cliStep('the relaunch with the new effort', { session: lib.ptyKey(proj, agent.id) }, async () => {
    check('Claude Code takes the relaunch', !!(await lib.until(async () => (await restart.count()) === 0 && (await live(proj, agent.id))?.status === 'ready', 60000, 400)), (await live(proj, agent.id))?.status)
  })
  const relaunch = launchLine(`#${agent.id.toLowerCase()}`)
  // Nothing typed yet, Claude Code has no transcript to resume: Hive starts the same session id again (--session-id);
  // the fake writes one at once, so restart sees the --resume path.
  check('…which was launched with the new effort, for the same session', relaunch.includes('"--effort","low"') && new RegExp(`"--(session-id|resume)","\\W?${st.sessionId}\\W?"`).test(relaunch), relaunch.slice(0, 300))
  check('…and brought the same conversation back', (await live(proj, agent.id))?.sessionId === st.sessionId, (await live(proj, agent.id))?.sessionId)
  await stop(proj, agent.id)

  // --- The Assistant with Haiku: launched asking for Auto; what Claude Code runs it in, and what Hive shows and says.
  const claude = (await inv('provider:info'))['claude-code']
  const autoOffered = claude?.catalog?.models.find((m) => m.value === 'haiku')?.supportsAuto
  console.log(`Claude Code ${claude?.version}: Haiku ${autoOffered === undefined ? "doesn't say whether it takes" : autoOffered ? 'takes' : "doesn't take"} Auto`)
  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: 'haiku' } } } })
  await inv('session:start', home, { agentId: 'assistant' })
  await lib.cliStep('the Assistant starts', { session: lib.ptyKey(home, 'assistant') }, async () => {
    await lib.acceptClaudeTrust(inv, home, 'assistant', 30000)
    check('Claude Code takes the Assistant’s launch', !!(await ready(home, 'assistant')), (await live(home, 'assistant'))?.status)
  })
  const a = await live(home, 'assistant')
  check('…in the workspace folder', a?.cwd.toLowerCase() === ws.toLowerCase(), a?.cwd)
  check('…asking for Auto, with Haiku', launchLine('assistant#assistant').includes('"--permission-mode","auto"') && launchLine('assistant#assistant').includes('"--model","haiku"'))
  const expected = autoOffered === true ? ['auto'] : autoOffered === false ? ['manual'] : ['auto', 'manual']
  await lib.cliStep('Claude Code shows its mode', { session: lib.ptyKey(home, 'assistant') }, async () => {
    await lib.until(async () => expected.includes((await live(home, 'assistant'))?.permissionMode), 15000)
    const mode = (await live(home, 'assistant'))?.permissionMode
    check(`with Haiku, Hive shows the mode Claude Code runs it in (${expected.join(' or ')}, as it says)`, expected.includes(mode), mode)
  })
  // The warning matches what this Claude Code says: there exactly when Auto isn't offered (a guess when it doesn't say).
  await page.keyboard.press('Control+,')
  await lib.sleep(500)
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).first().click()
  await lib.sleep(500)
  const caveat = await page.locator('.mode-caveat', { hasText: 'Auto with Haiku' }).allInnerTexts()
  const caveatRight = autoOffered === true ? !caveat.length : autoOffered === false ? caveat.length === 1 && /doesn't offer Auto with Haiku.*runs in Manual/.test(caveat[0]) : caveat.length === 1
  check("Settings → Assistant warns about Auto with Haiku exactly when Claude Code says it isn't offered", caveatRight, JSON.stringify(caveat))
  await stop(home, 'assistant')

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
