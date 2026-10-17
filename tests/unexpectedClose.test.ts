// Hive closing unexpectedly (#984): the running marker reads back (a damaged one is no marker, bad agent rows are left
// out), and the notice says when Hive was last seen, which agents were running where, what became of them, a crash dump
// and a merge left half done with the folder to check. #987: the marker keeps what the agents' launches had started, each
// process by id and start time (one without either isn't kept), within bounds, and the notice says how many still run.
// #1008: a hive-progress run (a test run left over) is one item of the notice, named by its title.
import { describe, expect, it } from 'vitest'
import { MAX_MARKER_LAUNCHES, MAX_MARKER_PROCESSES, parseRunMarker, projectsOf, resumeFailedLine, stillRunningLine, unexpectedCloseText, type RunningAgent } from '../src/shared/unexpectedClose'
import { setDateStyle } from '../src/shared/dates'
import { groupProgressRuns, progressRunTitle, progressRunsIn, type AgentProcess } from '../src/shared/agentProcesses'

const agent = (name: string, project: string, extra: Partial<RunningAgent> = {}): RunningAgent => ({ workspace: 'D:/ws', projectPath: `D:/ws/${project}`, project, agentId: name.toLowerCase(), agentName: name, provider: 'claude-code', sessionId: `s-${name}`, ...extra })
const lastSeen = '2026-10-17T03:02:56.000Z'
const marker = (over: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, pid: 42, startedAt: '2026-10-17T01:00:00.000Z', lastSeen: '2026-10-17T03:02:56.000Z', hive: '0.9.0', workspaces: ['D:/ws'], agents: [agent('B1', 'hive'), agent('R1', 'amberlight')], ...over })

describe('the running marker (#984)', () => {
  it('reads back what a running Hive wrote', () => {
    const m = parseRunMarker(marker())
    expect(m?.lastSeen).toBe('2026-10-17T03:02:56.000Z')
    expect(m?.agents.map((a) => a.agentName)).toEqual(['B1', 'R1'])
    expect(m?.workspaces).toEqual(['D:/ws'])
  })

  it('is no marker when damaged, of another version or without a time; bad agent rows are left out', () => {
    expect(parseRunMarker('{ not json')).toBeNull()
    expect(parseRunMarker(marker({ version: 2 }))).toBeNull()
    expect(parseRunMarker(marker({ lastSeen: 'yesterday' }))).toBeNull()
    expect(parseRunMarker(marker({ agents: [agent('B1', 'hive'), { agentName: 'no project' }, null, 'x'] }))?.agents.map((a) => a.agentName)).toEqual(['B1'])
  })

  it("keeps what the agents' launches had started: each process by id and start time, within bounds (#987)", () => {
    const proc = (pid: number, label = 'node serve.js', created: unknown = '133000000000000000') => ({ pid, name: 'node.exe', label, created })
    const launch = { projectPath: 'D:/ws/hive', agentId: 'b1', agentName: 'B1', processes: [proc(10), proc(11, 'npm run e2e')] }
    expect(parseRunMarker(marker({ processes: [launch] }))?.processes).toEqual([launch])
    // A marker of #984 (none kept), and bad rows: a process without its start time, or with a pid that can't be one, is
    // left out (it can't be told from a later process with its id); a launch left with none goes.
    expect(parseRunMarker(marker())?.processes).toEqual([])
    const bad = [{ ...launch, processes: [proc(12, 'x', null), proc(-1), proc(1.5), proc(13, 'y', '12ab'), proc(14)] }, { ...launch, agentId: '' }, { ...launch, processes: [proc(15, 'z', '')] }, null, 'x']
    expect(parseRunMarker(marker({ processes: bad }))?.processes).toEqual([{ ...launch, processes: [proc(14)] }])
    const many = Array.from({ length: MAX_MARKER_LAUNCHES + 5 }, (_, i) => ({ ...launch, agentId: `a${i}`, processes: Array.from({ length: MAX_MARKER_PROCESSES + 5 }, (_p, j) => proc(j + 1)) }))
    const read = parseRunMarker(marker({ processes: many }))?.processes ?? []
    expect(read.length).toBe(MAX_MARKER_LAUNCHES)
    expect(read.every((l) => l.processes.length === MAX_MARKER_PROCESSES)).toBe(true)
  })

  it('names each project once, in the order met', () => {
    expect(projectsOf([agent('B1', 'hive'), agent('R1', 'amberlight'), agent('B2', 'hive')])).toEqual(['hive', 'amberlight'])
  })
})

describe('the notice (#984)', () => {
  setDateStyle({ date: 'ymd', time: '24h' })

  it('says when, what was running where, and that nothing was resumed', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive'), agent('R1', 'amberlight')], dump: false, merges: [] }, null)
    expect(text).toMatch(/^Hive was last seen on .+ at .+\. 2 agents were running in hive and amberlight\. Nothing was resumed\.$/)
    expect(text).not.toMatch(/crash dump/)
  })

  it('with no agents, says so and nothing about resuming', () => {
    expect(unexpectedCloseText({ lastSeen, agents: [], dump: false, merges: [] }, null)).toMatch(/^Hive was last seen on .+\. No agents were running\.$/)
  })

  it('with the setting on, says how many were resumed and which could not', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive'), agent('R1', 'hive')], dump: false, merges: [] }, { resumed: ['B1'], failed: [{ name: 'R1', error: 'Codex is turned off' }] })
    expect(text).toMatch(/One agent was running in hive\.|2 agents were running in hive\./)
    expect(text).toMatch(/One was resumed, as Settings → Sessions says\. One couldn't resume: R1 \(Codex is turned off\)\.$/)
    expect(text).not.toMatch(/Nothing was resumed/)
    expect(resumeFailedLine({ resumed: [], failed: [{ name: 'A', error: 'x' }, { name: 'B', error: 'y' }] })).toBe("2 couldn't resume: A (x) and B (y).")
  })

  it('names a crash dump, and each merge left half done with the folder it was in', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: true, merges: [{ agentName: 'HB5', branch: 'feature/090-session', cards: [977], folder: 'D:/wt/hb5' }, { agentName: 'HB2', branch: 'main', cards: [], folder: 'D:/ws/hive' }] }, null)
    expect(text).toContain('Hive kept a crash dump of it: Help → Copy Diagnostics names it.')
    expect(text).toContain('HB5 was merging feature/090-session (#977): check D:/wt/hb5 for a merge left half done (git status there) before the next merge.')
    expect(text).toContain('HB2 was merging main: check D:/ws/hive for a merge left half done')
  })

  it("says how many processes the agents started still run, and what they are (#987)", () => {
    const proc = (pid: number, label: string) => ({ pid, name: 'node.exe', label, created: '1' })
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: [proc(1, 'npm run e2e'), proc(2, 'node serve.js'), proc(3, 'npm run e2e')] }, null)
    expect(text).toMatch(/Nothing was resumed\. 3 processes the agents started are still running: 2 × npm run e2e, node serve\.js\.$/)
    expect(stillRunningLine([proc(1, 'node serve.js')])).toBe('One process the agents started is still running: node serve.js.')
    expect(unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: [] }, null)).not.toMatch(/still running/)
  })
})

describe('a hive-progress run left running is one item, named by its title (#1008)', () => {
  const wrapper = String.raw`"C:\Program Files\Hive\Hive.exe" "C:\Program Files\Hive\resources\app.asar.unpacked\out\main\hive-progress.js" --title "e2e: 196 suites in hb2" -- npm run e2e -- --all`

  it('reads the title from the hive-progress command line, else the command; any other process has none', () => {
    expect(progressRunTitle(wrapper)).toBe('e2e: 196 suites in hb2')
    expect(progressRunTitle('"C:/Hive/Hive.exe" "C:/x/hive-progress.js" -- npx vitest run')).toBe('npx vitest run')
    expect(progressRunTitle(String.raw`"C:/Hive/Hive.exe" C:\x\hive-progress.js --title "  " -- node "C:\wt\tests\e2e\run.mjs"`)).toBe('node run.mjs')
    // A --title after the command's -- is the command's own.
    expect(progressRunTitle('Hive.exe hive-progress.js -- tool --title nope')).toBe('tool --title nope')
    expect(progressRunTitle('node C:/wt/tests/e2e/run.mjs --title x')).toBeUndefined()
    expect(progressRunTitle('node not-hive-progress.js.bak')).toBeUndefined()
  })

  // hive-progress (10) → cmd (11) → runner (12) → a test copy (13); a node of its own (20); 14 names 10 as parent but
  // started before it (a later process took a dead parent's id): not the run's.
  const p = (pid: number, parent: number, created: string, label: string, run?: string): AgentProcess => ({ pid, parent, created, name: 'x.exe', label, ...(run ? { run } : {}) })
  const tree = [p(10, 1, '100', 'Hive hive-progress.js', 'e2e: 196 suites in hb2'), p(11, 10, '101', 'cmd /c npm run e2e'), p(12, 11, '102', 'node run.mjs'), p(13, 12, '103', 'electron .'), p(20, 1, '100', 'node serve.js'), p(14, 10, '99', 'node older.js')]

  it('groups a run with everything below it, by parent and start time', () => {
    const { runs, rest } = groupProgressRuns(tree)
    expect(runs.map((g) => [g.title, g.root.pid, g.top.pid, g.processes.map((x) => x.pid)])).toEqual([['e2e: 196 suites in hb2', 10, 10, [10, 11, 12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([20, 14])
  })

  it('…with the shell that ran the hive-progress command above it, which is its tree’s top; not a shell that ran something else', () => {
    const shell = p(5, 2, '90', 'cmd /d /s /c "hive-progress --title e2e -- npm run e2e"')
    const agentShell = p(2, 1, '80', 'bash -c "npm run dev"')
    const { runs, rest } = groupProgressRuns([agentShell, shell, ...tree.map((x) => (x.pid === 10 ? { ...x, parent: 5 } : x))])
    expect(runs.map((g) => [g.root.pid, g.top.pid, g.processes.map((x) => x.pid).sort((a, b) => a - b)])).toEqual([[10, 5, [5, 10, 11, 12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([2, 20, 14])
  })

  it('keeps a run whose own process has ended, from what was kept; lists only what still runs', () => {
    const running = tree.filter((x) => [12, 13, 20].includes(x.pid))
    const { runs, rest } = progressRunsIn(running, tree)
    expect(runs.map((g) => [g.root.pid, g.processes.map((x) => x.pid)])).toEqual([[10, [12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([20])
    expect(progressRunsIn(tree.filter((x) => x.pid === 20), tree).runs).toEqual([])
  })

  it('the notice counts every process, and names the run once', () => {
    const running = tree.filter((x) => x.pid !== 14)
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: running, kept: tree }, null)
    expect(text).toMatch(/5 processes the agents started are still running: e2e: 196 suites in hb2 \(4 processes\), node serve\.js\.$/)
    expect(stillRunningLine(tree.filter((x) => x.pid === 12), tree)).toBe('One process the agents started is still running: e2e: 196 suites in hb2 (1 process).')
  })

  it("the marker keeps each process's parent and run title; bad ones are left out", () => {
    const procs = [{ pid: 10, created: '100', name: 'Hive.exe', label: 'Hive hive-progress.js', parent: 1, run: 'e2e: 196 suites in hb2' }, { pid: 12, created: '102', name: 'node.exe', label: 'node run.mjs', parent: -3, run: 7 }]
    const m = parseRunMarker(marker({ processes: [{ projectPath: 'D:/ws/hive', agentId: 'b1', agentName: 'B1', processes: procs }] }))
    expect(m?.processes[0].processes).toEqual([
      { pid: 10, created: '100', name: 'Hive.exe', label: 'Hive hive-progress.js', parent: 1, run: 'e2e: 196 suites in hb2' },
      { pid: 12, created: '102', name: 'node.exe', label: 'node run.mjs' }
    ])
  })
})
