// Git itself missing, too old or failing (#346): never read as "not a repository", and never as merged, clean or
// nothing to lose. Git is hidden from this test process's own PATH (never the machine's), which every git call Hive
// makes inherits.
import { execFileSync } from 'child_process'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { GIT_MIN, compareGitVersions, gitFixText, gitOldText, gitProblemText, gitStateOf, gitUnusable, parseGitVersion } from '../src/shared/gitTool'
import { checkGit, gitOnPath, gitProblem, gitTool, setGitToolForTests } from '../src/main/gitTool'
import { git, gitStatus } from '../src/main/git'
import { branchStatus, createWorktree, removeCheckedWorktree, worktreeCheck } from '../src/main/worktrees'
import { ensureHiveExcluded } from '../src/main/hiveVcs'
import { tempDir, tempRoot } from './tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const PATH = process.env.PATH
let root = ''

afterEach(() => {
  process.env.PATH = PATH
  setGitToolForTests({ state: 'unknown' })
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** This process's PATH without the folders holding git (node stays). */
function hideGit(): void {
  process.env.PATH = (PATH ?? '')
    .split(delimiter)
    .filter((d) => d && !gitOnPath({ PATH: d }))
    .join(delimiter)
}

/** A repository on main with one worktree, `hive/wt`, merged and clean (removable while git runs). */
async function project(): Promise<{ p: string; wt: { path: string; branch: string; base: string } }> {
  root = tempDir('hive-gittool-')
  const p = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', p)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  run(p, 'add', '-A')
  run(p, 'commit', '-qm', 'base')
  const wt = { path: join(root, 'wt'), branch: 'hive/wt', base: 'main' }
  await createWorktree(p, wt.path, wt.branch, 'main')
  return { p, wt }
}

describe('git versions', () => {
  it('reads the version git gives, Git for Windows suffix and all', () => {
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toBe('2.45.1')
    expect(parseGitVersion('git version 2.38.0')).toBe('2.38.0')
    expect(parseGitVersion('something else')).toBeNull()
    expect(compareGitVersions('2.9.0', '2.38')).toBeLessThan(0)
    expect(compareGitVersions('2.38.0', GIT_MIN)).toBe(0)
  })

  it('below 2.38 is old; below 2.17 nothing of Hive runs, so it is a problem like a missing git', () => {
    expect(gitStateOf('2.45.1')).toBe('ok')
    expect(gitStateOf('2.37.9')).toBe('old')
    expect(gitUnusable({ state: 'old', version: '2.30.0' })).toBe(false)
    expect(gitUnusable({ state: 'old', version: '2.16.0' })).toBe(true)
    expect(gitUnusable({ state: 'missing' })).toBe(true)
    expect(gitUnusable({ state: 'ok', version: '2.45.0' })).toBe(false)
    expect(gitProblemText({ state: 'missing' })).toBe("Git isn't installed (or isn't on Hive's PATH)")
    expect(gitProblemText({ state: 'old', version: '2.16.0' })).toMatch(/too old/)
    expect(gitProblemText({ state: 'unknown' })).toBeNull()
    expect(gitFixText({ state: 'missing' })).toMatch(/Install Git for Windows/)
    expect(gitOldText('2.26.0')).toMatch(/keep the branches/)
    expect(gitOldText('2.37.0')).not.toMatch(/keep the branches/)
  })
})

describe('git found', () => {
  it('checks the version and where it is', async () => {
    const t = await checkGit()
    expect(t.state === 'ok' || t.state === 'old').toBe(true)
    expect(t.version).toMatch(/^\d+\.\d+/)
    expect(t.path).toMatch(/git\.(exe|com)$/i)
  })
})

describe('git missing', () => {
  it('is missing, not a failed command: no exit code 1 that reads as "no"', async () => {
    const { p } = await project()
    hideGit()
    const r = await git(p, ['check-ignore', '-q', '--no-index', '--', '.hive/'])
    expect(r).toMatchObject({ ok: false, missing: true, code: -1 })
    expect(gitTool().state).toBe('missing')
    expect(gitProblem()).toBe("Git isn't installed (or isn't on Hive's PATH)")
    expect((await checkGit()).state).toBe('missing')
  })

  it('a missing working folder is not a missing git', async () => {
    const r = await git(join(tempRoot(), 'hive-gittool-no-such-folder'), ['status'])
    expect(r.missing).toBeUndefined()
    expect(gitTool().state).not.toBe('missing')
  })

  it('the Changes tab hears git is missing, not that the folder is no repository', async () => {
    const { p } = await project()
    hideGit()
    expect(await gitStatus(p)).toMatchObject({ isRepo: false, gitProblem: "Git isn't installed (or isn't on Hive's PATH)" })
  })

  it('never removable, never merged, never clean: the worktree and its branch stay', async () => {
    const { p, wt } = await project()
    const check = await worktreeCheck(p, wt)
    expect(check.removable).toBe(true)
    hideGit()
    expect(await worktreeCheck(p, wt)).toMatchObject({ removable: false, reason: "Git isn't installed (or isn't on Hive's PATH)" })
    await expect(branchStatus(p, wt)).rejects.toThrow(/isn't installed/)
    // A check made while git ran, applied once it can't: nothing goes.
    expect((await removeCheckedWorktree(p, wt, check)).deleted).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
    process.env.PATH = PATH
    expect(run(p, 'branch', '--format=%(refname:short)')).toMatch(/hive\/wt/)
  })

  it('.hive is still excluded by the line Hive writes, marked unconfirmed', async () => {
    const { p } = await project()
    hideGit()
    expect(await ensureHiveExcluded(p)).toMatchObject({ excluded: true, unconfirmed: true })
  })

  it('a git call that runs again clears it', async () => {
    const { p } = await project()
    hideGit()
    await git(p, ['status'])
    expect(gitTool().state).toBe('missing')
    process.env.PATH = PATH
    await git(p, ['status'])
    expect(gitTool().state).not.toBe('missing')
    expect(gitProblem()).toBeNull()
  })
})

describe('git failing', () => {
  it('a branch git cannot count is not "nothing to merge"', async () => {
    const { p, wt } = await project()
    await expect(branchStatus(p, { ...wt, branch: 'hive/gone' })).rejects.toThrow(/Git couldn't check hive\/gone/)
  })

  it('a worktree whose status fails is not clean, and not removable', async () => {
    const { p, wt } = await project()
    // A damaged index: git status fails there.
    writeFileSync(join(p, '.git', 'worktrees', 'wt', 'index'), 'not an index')
    await expect(branchStatus(p, wt)).rejects.toThrow(/Git couldn't check hive\/wt/)
    const c = await worktreeCheck(p, wt)
    expect(c.removable).toBe(false)
    expect(gitProblem()).toBeNull()
  })
})
