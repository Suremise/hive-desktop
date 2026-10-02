import { describe, expect, it } from 'vitest'
import { branchSummary, inbox, needsYou } from '../src/shared/inbox'
import type { AgentBranchStatus, AgentInfo, LiveSessionState, ProjectInfo, SessionStatus } from '../src/shared/types'

const live = (status: SessionStatus, statusSince: string, unseen = false, extra: Partial<LiveSessionState> = {}): LiveSessionState =>
  ({ provider: 'claude-code', runId: 'r', projectPath: '', agentId: '', cwd: '', sessionId: '', status, statusSince, unseen, startedAt: '', launchSignature: '', ...extra }) as LiveSessionState

const agent = (id: string, l: LiveSessionState | null, worktree = false): AgentInfo =>
  ({ id, name: id, live: l, restartNeeded: false, resume: null, ...(worktree ? { worktree: { path: `C:/wt/${id}`, branch: `hive/${id}`, base: 'main' } } : {}) }) as AgentInfo

const project = (name: string, agents: AgentInfo[]): ProjectInfo => ({ name, path: `C:/ws/${name}`, agents }) as ProjectInfo

const work = (ahead: number, dirty: number): AgentBranchStatus => ({ branch: 'hive/x', base: 'main', into: 'main', ahead, dirty, diff: { files: 3, insertions: 120, deletions: 40 } })

describe('attention inbox', () => {
  it('needs you: waiting (seen or not) and finished unseen, not finished seen or working', () => {
    expect(needsYou(live('waiting', 't', false))).toBe(true)
    expect(needsYou(live('finished', 't', true))).toBe(true)
    expect(needsYou(live('finished', 't', false))).toBe(false)
    expect(needsYou(live('working', 't', true))).toBe(false)
    expect(needsYou(null)).toBe(false)
  })

  it('lists them across projects and the Assistant, oldest first', () => {
    const a = project('alpha', [agent('one', live('finished', '2026-10-02T10:05:00Z', true)), agent('two', live('working', '2026-10-02T09:00:00Z'))])
    const b = project('beta', [agent('three', live('waiting', '2026-10-02T10:01:00Z', false, { statusMessage: 'Allow Bash?' }))])
    const assistant = project('assistant', [agent('assistant', live('finished', '2026-10-02T10:03:00Z', true))])
    const box = inbox([a, b], assistant, () => null)
    expect(box.needYou.map((i) => `${i.projectName}/${i.agentId}/${i.kind}`)).toEqual(['beta/three/waiting', 'Hive Assistant/assistant/finished', 'alpha/one/finished'])
    expect(box.needYou[0].message).toBe('Allow Bash?')
    expect(box.needYou[1].assistant).toBe(true)
  })

  it('to review: idle worktree agents with unmerged work, not counted with those that need you', () => {
    const p = project('alpha', [
      agent('done', live('finished', '2026-10-02T10:00:00Z', false), true),
      agent('stopped', null, true),
      agent('busy', live('working', '2026-10-02T10:00:00Z'), true),
      agent('clean', live('finished', '2026-10-02T10:00:00Z'), true),
      agent('unseen', live('finished', '2026-10-02T10:00:00Z', true), true),
      agent('folder', live('finished', '2026-10-02T10:00:00Z'))
    ])
    const branches: Record<string, AgentBranchStatus> = { done: work(2, 0), stopped: work(0, 1), busy: work(1, 0), clean: work(0, 0), unseen: work(1, 0), folder: work(1, 0) }
    const box = inbox([p], null, (_path, id) => branches[id])
    expect(box.toReview.map((i) => i.agentId)).toEqual(['done', 'stopped'])
    // An unseen finish is listed once, with those that need you, and still carries its work.
    expect(box.needYou.map((i) => i.agentId)).toEqual(['unseen'])
    expect(box.needYou[0].branch?.ahead).toBe(1)
  })

  it('sums up a branch', () => {
    expect(branchSummary(work(2, 1))).toBe('3 files, +120 −40 · 2 commits, 1 uncommitted file')
    expect(branchSummary({ ...work(1, 0), diff: undefined })).toBe('1 commit')
  })
})

describe('merging a worktree agent', () => {
  it('waits until the agent is between tasks', async () => {
    const { mergeBlocked } = await import('../src/shared/defaults')
    expect(mergeBlocked('Two', 'working')).toBe('Two is working. Merge once it has finished.')
    expect(mergeBlocked('Two', 'starting')).toContain('is working')
    expect(mergeBlocked('Two', 'waiting')).toBe('Two is waiting for your answer. Merge once it has finished.')
    expect(mergeBlocked('Two', 'background')).toContain('background tasks')
    for (const s of ['finished', 'ready', 'stopped', null, undefined] as const) expect(mergeBlocked('Two', s)).toBeNull()
  })
})
