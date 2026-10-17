// Hive closing unexpectedly (#984): the running marker reads back (a damaged one is no marker, bad agent rows are left
// out), and the notice says when Hive was last seen, which agents were running where, what became of them, a crash dump
// and a merge left half done with the folder to check. #987: the marker keeps what the agents' launches had started, each
// process by id and start time (one without either isn't kept), within bounds, and the notice says how many still run.
import { describe, expect, it } from 'vitest'
import { MAX_MARKER_LAUNCHES, MAX_MARKER_PROCESSES, parseRunMarker, projectsOf, resumeFailedLine, stillRunningLine, unexpectedCloseText, type RunningAgent } from '../src/shared/unexpectedClose'
import { setDateStyle } from '../src/shared/dates'

const agent = (name: string, project: string, extra: Partial<RunningAgent> = {}): RunningAgent => ({ workspace: 'D:/ws', projectPath: `D:/ws/${project}`, project, agentId: name.toLowerCase(), agentName: name, provider: 'claude-code', sessionId: `s-${name}`, ...extra })
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
  const lastSeen = '2026-10-17T03:02:56.000Z'

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
