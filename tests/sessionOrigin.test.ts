// The Sessions tab's "where it ran, whose it was": from what the session recorded, never from which agent has its name
// or worktree now.
import { describe, expect, it } from 'vitest'
import { sessionOrigin } from '../src/shared/sessionOrigin'

const P = 'C:\\ws\\alpha'
const WT = 'C:\\ws\\.hive-worktrees\\alpha\\coder'

describe('sessionOrigin', () => {
  it('labels the project folder and a worktree, with the agent as it is named now', () => {
    const agents = [{ id: 'a-1', name: 'Coder' }, { id: 'a-2', name: 'Reviewer' }]
    expect(sessionOrigin(P, agents, { source: 'hive', agentId: 'a-1', agentName: 'Old name' })?.label).toBe('Coder · Project folder')
    // The project folder in other case, as Windows may record it.
    expect(sessionOrigin(P, agents, { source: 'hive', agentId: 'a-1', cwd: P.toUpperCase() })?.location).toBe('Project folder')
    const wt = sessionOrigin(P, agents, { source: 'hive', agentId: 'a-2', cwd: WT, branch: 'hive/reviewer' })
    expect(wt?.label).toBe('Reviewer · Worktree · hive/reviewer')
    expect(wt?.detail).toContain(`Ran in ${WT}`)
    expect(wt?.detail).toContain('a-2')
  })

  it("an agent added later with the same name or worktree isn't the one that ran it", () => {
    const replacement = [{ id: 'a-new', name: 'Coder' }]
    expect(sessionOrigin(P, replacement, { source: 'hive', agentId: 'a-old', agentName: 'Coder', cwd: WT, branch: 'hive/coder' })?.label).toBe('Coder (removed) · Worktree · hive/coder')
    // Recorded before names were: no name is made up.
    const old = sessionOrigin(P, replacement, { source: 'hive', agentId: 'a-old' })
    expect(old?.label).toBe('Removed agent · Project folder')
    expect(old?.detail).toContain('has since been removed')
  })

  it('without a recorded agent (adopted, or from 0.1): the location only', () => {
    const o = sessionOrigin(P, [{ id: 'a-1', name: 'Coder' }], { source: 'hive' })
    expect(o?.agent).toBeNull()
    expect(o?.label).toBe('Project folder')
  })

  it('a worktree with no branch recorded: its folder', () => {
    expect(sessionOrigin(P, [], { source: 'hive', cwd: WT })?.location).toBe('Worktree · coder')
  })

  it('a session started outside Hive claims no agent', () => {
    expect(sessionOrigin(P, [{ id: 'a-1', name: 'Coder' }], { source: 'external', agentId: 'a-1' })).toBeNull()
  })
})
