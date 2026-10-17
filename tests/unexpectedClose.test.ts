// Hive closing unexpectedly (#984): the running marker reads back (a damaged one is no marker, bad agent rows are left
// out), and the notice says when Hive was last seen, which agents were running where, what became of them, a crash dump
// and a merge left half done with the folder to check.
import { describe, expect, it } from 'vitest'
import { parseRunMarker, projectsOf, resumeFailedLine, unexpectedCloseText, type RunningAgent } from '../src/shared/unexpectedClose'
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
})
