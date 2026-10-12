// The Git view (#607): a project folder's branch, upstream and ahead/behind (as of the last fetch: never fetched by
// itself), remotes, history, tags and identity, and the user's actions on them, against real git with local bare
// repositories as remotes (never a real remote). Switching branch and pulling are refused while an agent works in the
// folder or the merge slot is held; actions take only a project folder, never a worktree; a push is never forced.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { aheadBehindText, folderBusy, gitStatusText, identityProblem, identityWarnings, isNoReplyEmail, redactRemoteUrl, remoteNameProblem, remoteUrlProblem, type GitRepoSummary } from '../src/shared/gitRepo'
import type { MergeSlotInfo } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-gitrepo-')
const proj = join(base, 'ws', 'proj')
const remote = join(base, 'remote.git')
const other = join(base, 'other')
/** A project folder inside another repository (a workspace kept in git). */
const outer = join(base, 'outer')
const nested = join(outer, 'nested')

/** The project's agents, and their sessions' status by agent id. */
let agents: { id: string; name: string; worktree?: { path: string; branch: string; base: string } }[] = []
let live: Record<string, string> = {}
let slots: MergeSlotInfo[] = []
const asUser = vi.fn((_p: string, _b: string, fn: () => Promise<unknown>) => fn())

vi.mock('../src/main/workspace', () => ({
  workspace: {
    assertProject: (p: string) => {
      if (![proj, nested].some((x) => x.toLowerCase() === p.toLowerCase())) throw new Error(`Not a project in the open workspace: ${p}`)
      return p
    },
    projectConfig: async () => ({ version: 2, agents })
  },
  workspaceOf: () => ({ refresh: async () => ({}) })
}))
vi.mock('../src/main/sessions', () => ({ sessions: { liveFor: (_p: string, id: string) => (live[id] ? { status: live[id] } : null) } }))
vi.mock('../src/main/mergeSlotHost', () => ({ mergeSlots: { list: () => slots, asUser } }))
vi.mock('../src/main/branchWatch', () => ({ checkProject: async () => undefined }))

const repo = await import('../src/main/gitRepo')

// Real git work, not a wait: each test runs a few dozen git commands, slow under a full unit run's load.
vi.setConfig({ testTimeout: 60_000 })

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', `add ${file}`)
}

beforeAll(() => {
  mkdirSync(proj, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  // No global identity in unit tests (noGlobalGit.ts): the repository's own, as Hive's annotated tags need one.
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  commit(proj, 'a.txt')
  git(proj, 'remote', 'add', 'origin', remote)
  git(proj, 'push', '-q', '-u', 'origin', 'main')
  execFileSync('git', ['clone', '-q', remote, other])
})

beforeEach(() => {
  agents = []
  live = {}
  slots = []
  asUser.mockClear()
})

describe('the summary', () => {
  it('names the branch, its upstream and how far apart they are as of the last fetch, never fetching itself', async () => {
    const s = await repo.repoSummary(proj)
    expect(s).toMatchObject({ isRepo: true, branch: 'main', state: null, remotes: ['origin'], upstream: { name: 'origin/main', remote: 'origin', ahead: 0, behind: 0 } })
    expect(gitStatusText(s)).toBe('main · origin · ↑0 ↓0')
    // Someone else pushes: nothing changes here until the user fetches.
    commit(other, `o${Date.now()}.txt`)
    git(other, 'push', '-q', 'origin', 'main')
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ behind: 0 })
    await repo.fetchAll(proj)
    const after = await repo.repoSummary(proj)
    expect(after.upstream).toMatchObject({ ahead: 0, behind: 1 })
    expect(after.fetchedAt).toBeGreaterThan(0)
  })

  it('says a folder without git is no repository, and a detached HEAD by its commit', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(await repo.repoSummary(plain)).toMatchObject({ isRepo: false, branch: null })
    const head = git(proj, 'rev-parse', '--short', 'HEAD')
    const detached = join(base, 'detached')
    git(proj, 'worktree', 'add', '-q', '--detach', detached, 'HEAD')
    const s = await repo.repoSummary(detached)
    expect(s).toMatchObject({ isRepo: true, branch: null, head, upstream: null })
    expect(gitStatusText(s)).toBe(`detached at ${head}`)
    git(proj, 'worktree', 'remove', '--force', detached)
  })

  it("shows a project inside another repository as that repository's, and changes nothing of it", async () => {
    mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', outer])
    commit(outer, 'outer.txt')
    const s = await repo.repoSummary(nested)
    expect(s).toMatchObject({ isRepo: true, branch: 'main', parentRepo: outer })
    await expect(repo.createBranch(nested, 'x')).rejects.toThrow(`This project is inside the git repository in ${outer}`)
    await expect(repo.addRemote(nested, 'origin', remote)).rejects.toThrow(/inside the git repository/)
    expect(git(outer, 'branch', '--list', 'x')).toBe('')
    expect((await repo.repoSummary(proj)).parentRepo).toBeUndefined()
  })
})

describe('pull and push', () => {
  it('pulls by fast-forward only, and refuses a branch that has diverged without changing it', async () => {
    commit(other, `p${Date.now()}.txt`)
    git(other, 'push', '-q', 'origin', 'main')
    expect(await repo.pull(proj)).toMatch(/^Pulled \d+ commits? from origin\/main\.$/)
    expect(git(proj, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'main'))
    expect(await repo.pull(proj)).toBe('main is up to date with origin/main.')
    // Both sides move on: no merge here.
    commit(other, `q${Date.now()}.txt`)
    git(other, 'push', '-q', 'origin', 'main')
    commit(proj, `mine${Date.now()}.txt`)
    const before = git(proj, 'rev-parse', 'HEAD')
    await expect(repo.pull(proj)).rejects.toThrow(/have diverged \(1 commit here, 1 there\)/)
    expect(git(proj, 'rev-parse', 'HEAD')).toBe(before)
    // Nor is a push forced over theirs.
    await expect(repo.push(proj)).rejects.toThrow(/push was refused \(Hive never forces a push\)/)
    git(proj, 'reset', '-q', '--hard', 'origin/main')
  })

  it('pushes to the upstream, and sets one for a branch that has none', async () => {
    commit(proj, `push${Date.now()}.txt`)
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ ahead: 1 })
    expect(await repo.push(proj)).toBe('Pushed main to origin/main.')
    expect(git(remote, 'rev-parse', 'main')).toBe(git(proj, 'rev-parse', 'HEAD'))
    expect(await repo.createBranch(proj, 'feature/x')).toBe('Created feature/x and switched to it.')
    expect(gitStatusText(await repo.repoSummary(proj))).toBe('feature/x · no upstream')
    expect(await repo.push(proj, 'origin')).toBe('Pushed feature/x to origin/feature/x.')
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ name: 'origin/feature/x', ahead: 0, behind: 0 })
    await repo.switchBranch(proj, 'main')
  })
})

describe('switching branch', () => {
  it('switches to a local branch, and to a remote one as a new branch tracking it', async () => {
    git(other, 'fetch', '-q')
    git(other, 'checkout', '-q', '-b', 'theirs', 'origin/main')
    commit(other, `t${Date.now()}.txt`)
    git(other, 'push', '-q', '-u', 'origin', 'theirs')
    git(other, 'checkout', '-q', 'main')
    await repo.fetchAll(proj)
    expect((await repo.repoInfo(proj)).remoteBranches).toContain('origin/theirs')
    expect(await repo.switchBranch(proj, 'origin/theirs')).toBe('Switched to theirs, tracking origin/theirs.')
    expect((await repo.repoSummary(proj)).upstream?.name).toBe('origin/theirs')
    expect(await repo.switchBranch(proj, 'main')).toBe('Switched to main.')
    expect(asUser).toHaveBeenCalledWith(proj, 'theirs', expect.any(Function))
    await expect(repo.switchBranch(proj, 'nope')).rejects.toThrow("There's no branch nope.")
  })

  it('is refused while an agent works in the project folder or the merge slot is held, saying why', async () => {
    agents = [{ id: 'a1', name: 'B1' }]
    live = { a1: 'working' }
    await expect(repo.switchBranch(proj, 'feature/x')).rejects.toThrow('B1 is working in the project folder: switch branches once it has finished.')
    await expect(repo.pull(proj)).rejects.toThrow('B1 is working in the project folder: pull once it has finished.')
    // Idle, it may.
    live = { a1: 'idle' }
    slots = [{ project: proj, branch: 'main', holder: { id: 'h', kind: 'agent', agentId: 'a2', name: 'B2', cards: [], since: 0, until: 0, taken: true }, waiting: [] }]
    await expect(repo.createBranch(proj, 'other')).rejects.toThrow('B2 holds the merge slot for main: create and switch to a branch once that merge is done.')
    expect(git(proj, 'branch', '--list', 'other')).toBe('')
    // Creating one without switching moves nothing.
    expect(await repo.createBranch(proj, 'other', true)).toMatch(/^Created other at /)
    expect(git(proj, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    // An agent working in its own worktree doesn't hold the folder.
    slots = []
    agents = [{ id: 'a3', name: 'B3', worktree: { path: join(base, 'wt'), branch: 'hive/b3', base: 'main' } }]
    live = { a3: 'working' }
    expect(await repo.switchBranch(proj, 'other')).toBe('Switched to other.')
    await repo.switchBranch(proj, 'main')
  })

  it("never switches to a branch another worktree has, and takes no worktree for the project folder", async () => {
    const wt = join(base, 'agentwt')
    git(proj, 'worktree', 'add', '-q', '-b', 'hive/b4', wt, 'main')
    const info = await repo.repoInfo(proj)
    expect(info.worktrees.map((w) => w.branch)).toContain('hive/b4')
    expect(info.branches.find((b) => b.name === 'hive/b4')?.worktree).toBeTruthy()
    await expect(repo.switchBranch(proj, 'hive/b4')).rejects.toThrow(/checked out in another worktree/)
    // Agents' worktrees are read-only here: no action takes one.
    await expect(repo.createTag(wt, 'v0', '')).rejects.toThrow(/Not a project/)
    await expect(repo.switchBranch(wt, 'main')).rejects.toThrow(/Not a project/)
    git(proj, 'worktree', 'remove', '--force', wt)
  })
})

describe('remotes, tags, history and identity', () => {
  it('adds a remote and changes its URL, hiding a password in what it shows', async () => {
    const second = join(base, 'second.git')
    execFileSync('git', ['init', '-q', '--bare', second])
    expect(await repo.addRemote(proj, 'backup', second)).toBe('Added backup.')
    await expect(repo.addRemote(proj, '-x', second)).rejects.toThrow(/letters, digits/)
    await expect(repo.addRemote(proj, 'backup', second)).rejects.toThrow(/already exists/)
    await repo.setRemoteUrl(proj, 'backup', 'https://me:secret@example.com/r.git')
    const info = await repo.repoInfo(proj)
    expect(info.remotes.find((r) => r.name === 'backup')).toEqual({ name: 'backup', fetchUrl: 'https://•••@example.com/r.git', pushUrl: 'https://•••@example.com/r.git' })
    await repo.setRemoteUrl(proj, 'backup', second)
  })

  it('tags the commit, annotated with a message, pushes the tag when asked, and lists commits and tags', async () => {
    const head = git(proj, 'rev-parse', '--short', 'HEAD')
    expect(await repo.createTag(proj, 'v1.0', 'First', 'origin')).toBe(`Tagged ${head} v1.0 and pushed it to origin.`)
    expect(git(remote, 'tag', '--list')).toContain('v1.0')
    expect(await repo.createTag(proj, 'light', '')).toBe(`Tagged ${head} light.`)
    await expect(repo.createTag(proj, 'bad name', '')).rejects.toThrow("bad name isn't a valid tag name.")
    const h = await repo.repoHistory(proj)
    expect(h.commits.length).toBeGreaterThan(1)
    expect(h.commits[0]).toMatchObject({ short: head })
    expect(h.commits[0].refs).toContain('tag: v1.0')
    expect(h.tags.find((t) => t.name === 'v1.0')).toMatchObject({ annotated: true, subject: 'First', commit: head })
    expect(h.tags.find((t) => t.name === 'light')).toMatchObject({ annotated: false, commit: head })
  })

  it("sets this repository's identity, and removes it so the global one applies", async () => {
    expect(await repo.setIdentity(proj, 'Dev', '1+dev@users.noreply.github.com')).toBe("Set this repository's commit identity.")
    let info = await repo.repoInfo(proj)
    expect(info.identity.local).toEqual({ name: 'Dev', email: '1+dev@users.noreply.github.com' })
    expect(info.identity.effective.email).toBe('1+dev@users.noreply.github.com')
    await expect(repo.setIdentity(proj, 'Dev', 'not-an-email')).rejects.toThrow("That isn't an email address")
    await repo.setIdentity(proj, '', '')
    info = await repo.repoInfo(proj)
    expect(info.identity.local).toEqual({})
    // No global identity in tests (noGlobalGit.ts): commits would fail, and the section says so.
    expect(identityWarnings(info.identity, info.remotes)[0]).toMatch(/no user\.name or user\.email/)
  })
})

describe('what the window says', () => {
  const s = (over: Partial<GitRepoSummary>): GitRepoSummary => ({ isRepo: true, branch: 'main', head: 'abc1234', state: null, upstream: null, remotes: [], fetchedAt: null, ...over })

  it('puts the branch, remote and counts in the status bar', () => {
    expect(gitStatusText(s({ upstream: { name: 'origin/main', remote: 'origin', ahead: 2, behind: 0 }, remotes: ['origin'] }))).toBe('main · origin · ↑2 ↓0')
    expect(gitStatusText(s({ remotes: ['origin'] }))).toBe('main · no upstream')
    expect(gitStatusText(s({}))).toBe('main')
    expect(gitStatusText(s({ branch: null, state: 'rebase' }))).toBe('detached at abc1234 · rebasing')
    expect(gitStatusText(s({ isRepo: false }))).toBe('')
    expect(aheadBehindText({ ahead: 1, behind: 1, gone: true })).toBe('upstream gone')
  })

  it('says why the folder is busy: an agent at work in it, then the merge slot', () => {
    expect(folderBusy([{ name: 'B1', status: 'idle' }], [], 'switch')).toBeNull()
    expect(folderBusy([{ name: 'B1', status: 'waiting' }], [], 'pull')).toBe('B1 is waiting for your answer in the project folder: pull once it has finished.')
    expect(folderBusy([], [{ branch: 'main', holder: null, byUser: true, waiting: [] }], 'switch')).toBe('Your merge into main is running: switch branches once it is done.')
    expect(folderBusy([], [{ branch: 'main', holder: null, waiting: ['B2', 'B3'] }], 'pull')).toBe('B2, B3 are waiting for the merge slot for main: pull once those merges are done.')
  })

  it('hides passwords in URLs, and warns of a personal email on commits that go to GitHub', () => {
    expect(redactRemoteUrl('https://user:ghp_x@github.com/a/b.git')).toBe('https://•••@github.com/a/b.git')
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(isNoReplyEmail('123+me@users.noreply.github.com')).toBe(true)
    const github = [{ fetchUrl: 'git@github.com:a/b.git', pushUrl: 'git@github.com:a/b.git' }]
    const me = { local: {}, global: { name: 'Me', email: 'me@example.com' }, effective: { name: 'Me', email: 'me@example.com' } }
    expect(identityWarnings(me, github)).toEqual([expect.stringContaining('show me@example.com to anyone')])
    expect(identityWarnings(me, [{ fetchUrl: 'https://gitlab.com/a/b.git', pushUrl: 'https://gitlab.com/a/b.git' }])).toEqual([])
    expect(identityWarnings({ ...me, effective: { name: 'Me', email: '1+me@users.noreply.github.com' } }, github)).toEqual([])
  })

  it('checks what the forms send', () => {
    expect(remoteNameProblem('origin')).toBeNull()
    expect(remoteNameProblem('-x')).not.toBeNull()
    expect(remoteUrlProblem('--upload-pack=x')).not.toBeNull()
    expect(remoteUrlProblem('C:\\repos\\r.git')).toBeNull()
    expect(identityProblem('A\nB', '')).not.toBeNull()
    expect(identityProblem('', '')).toBeNull()
  })
})
