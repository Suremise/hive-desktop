// Worktree branches as hive/<workspace>/<project>/<agent> (#703): git's ref rules for the workspace's and project's parts
// (spaces, odd characters, "..", ".lock", very long names; what comes out is a branch git takes), the agent read from a
// branch in either form (hive/<agent> from before, the full form only for this workspace and project), and the branches
// Add Agent may find an unused worktree on.
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { hiveBranch, hiveBranchAgent, oldHiveBranch, refPart, reusableBranches } from '../src/shared/hiveBranches'

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

describe('the agent of a branch Hive made', () => {
  const home = { workspace: 'HIVE', project: 'amberlight' }

  it('reads either form: hive/<agent> from before, and the full form for this workspace and project, case aside', () => {
    expect(hiveBranchAgent('hive/amb1', home)).toBe('amb1')
    expect(hiveBranchAgent('hive/amb1-2', home)).toBe('amb1-2')
    expect(hiveBranchAgent('hive/HIVE/amberlight/amb1', home)).toBe('amb1')
    expect(hiveBranchAgent('hive/hive/Amberlight/amb1-3', home)).toBe('amb1-3')
    expect(hiveBranchAgent('hive/My-Work/web-app/b1', { workspace: 'My Work', project: 'web app' })).toBe('b1')
  })

  it("is null for another workspace's or project's branch (two workspaces in one repository), or one that isn't Hive's", () => {
    for (const b of ['hive/OTHER/amberlight/amb1', 'hive/HIVE/other/amb1', 'feature/amb1', 'hive/HIVE/amb1', 'hive/a/b/c/d', 'main', 'hive']) expect(hiveBranchAgent(b, home)).toBeNull()
  })

  it("Add Agent's new worktree on the full form may find the same agent's from before; any other branch only itself", () => {
    expect(reusableBranches('hive/HIVE/amberlight/amb1', home)).toEqual(['hive/HIVE/amberlight/amb1', 'hive/amb1'])
    expect(reusableBranches('hive/OTHER/amberlight/amb1', home)).toEqual(['hive/OTHER/amberlight/amb1'])
    expect(reusableBranches('hive/amb1', home)).toEqual(['hive/amb1'])
    expect(reusableBranches('feature/x', home)).toEqual(['feature/x'])
  })
})
