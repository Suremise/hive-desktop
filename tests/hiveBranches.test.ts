// Worktree branches as hive/<workspace>/<project>/<agent> (#703): git's ref rules for the workspace's and project's parts
// (spaces, odd characters, "..", ".lock", very long names; what comes out is a branch git takes), the agent read from a
// branch in either form (hive/<agent> from before, the full form only for this workspace and project), and the branches
// Add Agent may find an unused worktree on.
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { branchSpace, hiveBranch, hiveBranchNumber, oldHiveBranch, refPart, reusableBranches } from '../src/shared/hiveBranches'

/** Whether git takes `name` as a branch name. */
const gitTakes = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('the full form', () => {
  const home = { workspace: 'HIVE', project: 'amberlight' }

  it("is hive/<workspace>/<project>/<agent>: the folders' names as they are, the agent's slug", () => {
    expect(hiveBranch(home, 'AMB1')).toBe('hive/HIVE/amberlight/amb1')
    expect(hiveBranch({ workspace: 'My Work', project: 'web app' }, 'Builder 2')).toBe('hive/My-Work/web-app/builder-2')
    expect(oldHiveBranch('AMB1')).toBe('hive/amb1')
  })

  it("applies git's ref rules to the workspace's and project's parts, so git always takes the branch", () => {
    const odd = ['a b', 'a..b', 'x.lock', '.hidden', 'trailing.', 'tilde~caret^colon:', 'q?star*[br', 'back\\slash', 'at@{x}', '@', '---', '...', 'Ümlaut café', 'emoji 🐝', 'tab\there', 'x'.repeat(200), 'a.lock.lock', '-lead', 'end-']
    for (const name of odd) {
      const part = refPart(name, 'workspace')
      expect(part.length).toBeGreaterThan(0)
      expect(part.length).toBeLessThanOrEqual(40)
      expect(part).not.toMatch(/\.\.|^[.-]|[.-]$|\.lock$|[\s~^:?*[\\@{}]/i)
      expect(gitTakes(hiveBranch({ workspace: name, project: name }, name))).toBe(true)
    }
    expect([refPart('a..b', 'w'), refPart('x.lock', 'w'), refPart('a.lock.lock', 'w'), refPart('---', 'w'), refPart('Ümlaut café', 'w')]).toEqual(['a.b', 'x', 'a', 'w', 'mlaut-caf'])
  })
})

describe("a branch Hive made for an agent", () => {
  const home = { workspace: 'HIVE', project: 'amberlight' }

  it('is recognised in either form: hive/<slug> from before as Hive made it, and the full form here, case aside', () => {
    expect(hiveBranchNumber('hive/amb1', home, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/amb1-2', home, 'AMB1')).toBe(2)
    expect(hiveBranchNumber('hive/HIVE/amberlight/amb1', home, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/hive/Amberlight/amb1-3', home, 'amb1')).toBe(3)
    // In a workspace part numbered past a branch from before (branchSpace): still this workspace's.
    expect(hiveBranchNumber('hive/HIVE-2/amberlight/amb1', home, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/My-Work/web-app/b1', { workspace: 'My Work', project: 'web app' }, 'B1')).toBe(0)
  })

  it("from before, by its slug exactly as Hive made it then: B--1 had hive/b--1 (round 2: not the new rules' b-1)", () => {
    expect(oldHiveBranch('B--1')).toBe('hive/b--1')
    expect(hiveBranchNumber('hive/b--1', home, 'B--1')).toBe(0)
    expect(hiveBranchNumber('hive/b--1-2', home, 'B--1')).toBe(2)
    expect(hiveBranchNumber('hive/b-1', home, 'B--1')).toBeNull()
    // The full form uses the new rules: B--1's part is b-1.
    expect(hiveBranch(home, 'B--1')).toBe('hive/HIVE/amberlight/b-1')
    expect(hiveBranchNumber('hive/HIVE/amberlight/b-1', home, 'B--1')).toBe(0)
  })

  it("isn't another agent's, another workspace's or project's (two workspaces in one repository), or a branch not Hive's", () => {
    for (const b of ['hive/OTHER/amberlight/amb1', 'hive/HIVE/other/amb1', 'hive/HIVEX/amberlight/amb1', 'feature/amb1', 'hive/HIVE/amb1', 'hive/a/b/c/d', 'main', 'hive', 'hive/amb10', 'hive/HIVE/amberlight/amb1-x']) expect(hiveBranchNumber(b, home, 'AMB1')).toBeNull()
  })

  it("Add Agent's new worktree on an agent's full-form branch may find the branch Hive made for that name before; any other only itself", () => {
    expect(reusableBranches('hive/HIVE/amberlight/amb1', home, 'AMB1')).toEqual(['hive/HIVE/amberlight/amb1', 'hive/amb1'])
    expect(reusableBranches('hive/HIVE/amberlight/b-1', home, 'B--1')).toEqual(['hive/HIVE/amberlight/b-1', 'hive/b--1'])
    // Without the name, or for another agent's or workspace's branch: only itself.
    expect(reusableBranches('hive/HIVE/amberlight/amb1', home)).toEqual(['hive/HIVE/amberlight/amb1'])
    expect(reusableBranches('hive/HIVE/amberlight/amb2', home, 'AMB1')).toEqual(['hive/HIVE/amberlight/amb2'])
    expect(reusableBranches('hive/OTHER/amberlight/amb1', home, 'AMB1')).toEqual(['hive/OTHER/amberlight/amb1'])
    expect(reusableBranches('feature/x', home, 'X')).toEqual(['feature/x'])
  })
})

describe('the workspace part in a repository with branches from before (#703 round 2)', () => {
  const home = { workspace: 'ws', project: 'alpha' }
  it("is the workspace's own, unless hive/<workspace> or hive/<workspace>/<project> is a branch (case aside): then numbered", () => {
    expect(branchSpace(home, ['main', 'hive/b1', 'hive/ws/alpha/b1'])).toBe('ws')
    expect(branchSpace(home, ['main', 'hive/ws'])).toBe('ws-2')
    expect(branchSpace(home, ['hive/WS', 'hive/ws-2/alpha'])).toBe('ws-3')
    expect(branchSpace({ workspace: 'HIVE', project: 'amberlight' }, ['hive/hive'])).toBe('HIVE-2')
    expect(hiveBranch({ ...home, space: branchSpace(home, ['hive/ws']) }, 'New')).toBe('hive/ws-2/alpha/new')
  })
})
