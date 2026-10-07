// Unused worktrees (#353): the git worktrees of a project no agent works in, each checked with #291's merged-and-clean
// check. Listed: only worktrees git lists for the project, that exist, that no agent uses and that aren't the project.
// Remove deletes a merged, clean one with its branch, checked again then; Remove anyway (forced) only what the user was
// shown it would lose, refused once it changed; neither for a worktree an agent works in, one being removed, or one git
// doesn't list; nothing at all without git (#346). A deleted template's worktree agents' worktrees are found by name.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { holdsWork, lostByRemoving, templateWorktreesHint, unusedState, unusedWorkNotice } from '../src/shared/unusedWorktrees'
import type { UnusedWorktree } from '../src/shared/types'

const base = mkdtempSync(join(tmpdir(), 'hive-unusedwt-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => rmSync(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
/** Makes a git command fail as git would (exit 128) while set: what Hive can't check it never offers to remove. */
let failing: ((args: string[]) => boolean) | null = null
vi.mock('../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/git')>()
  const failed = (): ReturnType<typeof real.git> => Promise.resolve({ out: '', ok: false, buf: Buffer.alloc(0), err: 'fatal: injected failure', code: 128 })
  return { ...real, git: ((cwd, args, ...rest) => (failing?.(args) ? failed() : real.git(cwd, args, ...rest))) as typeof real.git }
})

const { PREVIEW_MS, removalPreview, removeUnusedWorktree, unusedWorktreeCounts, unusedWorktrees, unusedWorktreesNamed } = await import('../src/main/unusedWorktrees')
const { createWorktree } = await import('../src/main/worktrees')
const { reserveForRemoval } = await import('../src/main/projectAgents')
const { gitOnPath, setGitToolForTests } = await import('../src/main/gitTool')
const templates = await import('../src/main/templates')

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' })
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
const root = join(base, 'ws.worktrees', 'proj')
const PATH = process.env.PATH
let w: ReturnType<typeof createWorkspaceService>
const run = <T,>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0

/** A new worktree hive/<name> in the workspace's worktree folder, off main. */
async function tree(name: string): Promise<{ path: string; branch: string }> {
  const t = { path: join(root, name), branch: `hive/${name}` }
  await createWorktree(proj, t.path, t.branch, 'main')
  return t
}
const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
}
const branches = (): string[] => git(proj, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean)
const listOf = async (): Promise<UnusedWorktree[]> => (await run(() => unusedWorktrees(proj))).worktrees
const find = async (path: string): Promise<UnusedWorktree | undefined> => (await listOf()).find((x) => x.path.toLowerCase() === path.toLowerCase())
/** Agents of the project, with these worktrees. */
const agents = (trees: { path: string; branch: string }[]): void =>
  writeFileSync(join(proj, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: trees.map((t, i) => ({ id: `a${i}`, name: `A${i}`, provider: 'claude-code', worktree: { ...t, base: 'main' } })) }))

beforeAll(async () => {
  mkdirSync(join(proj, '.hive'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  commit(proj, 'a.txt')
  agents([])
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => disposeWorkspaceService(w))
afterEach(() => {
  process.env.PATH = PATH
  setGitToolForTests({ state: 'unknown' })
  failing = null
})

describe('listing', () => {
  it('lists the worktrees no agent works in, each checked, never the project or one an agent has', async () => {
    const used = await tree(`used${++n}`)
    const fresh = await tree(`fresh${n}`)
    const ahead = await tree(`ahead${n}`)
    commit(ahead.path, 'x.txt')
    const dirty = await tree(`dirty${n}`)
    writeFileSync(join(dirty.path, 'new.txt'), 'new\n')
    agents([used])
    const list = await listOf()
    const paths = list.map((x) => x.path.toLowerCase())
    expect(paths).not.toContain(used.path.toLowerCase())
    expect(paths).not.toContain(proj.toLowerCase())
    const f = list.find((x) => x.branch === fresh.branch)!
    expect(f.check).toMatchObject({ removable: true, into: 'main', ahead: 0, dirty: 0 })
    expect(f.lastCommit?.subject).toBe('a.txt')
    expect(f.head).toMatch(/^[0-9a-f]{40}$/)
    expect(unusedState(f)).toBe('Merged into main · clean')
    const a = list.find((x) => x.branch === ahead.branch)!
    expect(a.check).toMatchObject({ removable: false, ahead: 1, dirty: 0 })
    expect(unusedState(a)).toBe('1 commit not on main')
    expect(holdsWork(a)).toBe(true)
    const d = list.find((x) => x.branch === dirty.branch)!
    expect(unusedState(d)).toBe('1 changed file')
    expect(lostByRemoving(d)).toEqual([`1 uncommitted file in ${d.path}`, 'the files git ignores in its folder (build output, copied .env files)'])
    expect(await run(() => unusedWorktreeCounts(proj))).toMatchObject({ merged: expect.any(Number), count: list.length })
    agents([])
  })

  it('a detached worktree is listed, never removable by Remove', async () => {
    const t = await tree(`detached${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    const d = await find(t.path)
    expect(d).toMatchObject({ branch: null, check: { removable: false, reason: 'it is not on a branch (detached HEAD)', dirty: 0 } })
    expect((await run(() => removeUnusedWorktree(proj, t.path))).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })
})

describe('Remove', () => {
  it('deletes a merged, clean one and its branch', async () => {
    const t = await tree(`merged${++n}`)
    expect(await run(() => removeUnusedWorktree(proj, t.path, { expectInto: 'main' }))).toEqual({ deleted: true })
    expect(existsSync(t.path)).toBe(false)
    expect(branches()).not.toContain(t.branch)
  })

  it('keeps one with unmerged commits or uncommitted files, saying why', async () => {
    const t = await tree(`work${++n}`)
    commit(t.path, 'w.txt')
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false, reason: '1 commit not merged into main' })
    expect(existsSync(t.path)).toBe(true)
  })

  it('keeps one an agent works in, one being removed, and folders git does not list', async () => {
    const t = await tree(`taken${++n}`)
    agents([t])
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toEqual({ deleted: false, reason: 'an agent works in it now' })
    agents([])
    const release = reserveForRemoval(t.path)
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toEqual({ deleted: false, reason: 'That worktree is already being removed.' })
    release()
    const plain = join(root, `plain${n}`)
    mkdirSync(plain, { recursive: true })
    expect((await run(() => removeUnusedWorktree(proj, plain))).deleted).toBe(false)
    expect((await run(() => removeUnusedWorktree(proj, proj))).deleted).toBe(false)
    expect(existsSync(t.path) && existsSync(plain) && existsSync(proj)).toBe(true)
  })
})

describe('Remove anyway', () => {
  const anyway = (path: string, token: string) => run(() => removeUnusedWorktree(proj, path, { force: token }))
  const preview = (path: string) => run(() => removalPreview(proj, path))

  it('deletes what the confirmation showed, folder and branch, once', async () => {
    const t = await tree(`anyway${++n}`)
    commit(t.path, 'w.txt')
    writeFileSync(join(t.path, 'loose.txt'), 'x')
    const p = await preview(t.path)
    expect(p.lost).toEqual([`1 commit on ${t.branch} not on main`, `1 uncommitted file in ${p.path}`, 'the files git ignores in its folder (build output, copied .env files)'])
    expect(await anyway(t.path, p.token)).toEqual({ deleted: true })
    expect(existsSync(t.path)).toBe(false)
    expect(branches()).not.toContain(t.branch)
    // A token is good for one removal.
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
  })

  it('refuses a token past its 15 minutes, with no other preview since; one inside them still works (#373)', async () => {
    const old = await tree(`expired${++n}`)
    const fresh = await tree(`fresh${n}`)
    const p = await preview(old.path)
    const q = await preview(fresh.path)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + PREVIEW_MS - 60_000)
      expect(await anyway(fresh.path, q.token)).toEqual({ deleted: true })
      vi.setSystemTime(Date.now() + 2 * 60_000)
      expect(await anyway(old.path, p.token)).toEqual({ deleted: false, lookAgain: true, reason: 'what it holds was checked more than 15 minutes ago: nothing was removed, look again' })
    } finally {
      vi.useRealTimers()
    }
    expect(existsSync(old.path)).toBe(true)
    expect(branches()).toContain(old.branch)
    // Spent by that refusal: a new look is needed, and settles it (#377).
    expect(await anyway(old.path, p.token)).toMatchObject({ deleted: false, lookAgain: true, reason: expect.stringMatching(/not checked for this removal/) })
    expect(await anyway(old.path, (await preview(old.path)).token)).toEqual({ deleted: true })
  })

  it('a token is spent by a removal refused for another reason too', async () => {
    const t = await tree(`spent${++n}`)
    const p = await preview(t.path)
    agents([t])
    // Not one a new look settles: no lookAgain.
    expect(await anyway(t.path, p.token)).toEqual({ deleted: false, reason: 'an agent works in it now' })
    agents([])
    expect((await anyway(t.path, p.token)).reason).toMatch(/not checked for this removal/)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses without a preview of this worktree', async () => {
    const t = await tree(`notoken${++n}`)
    const other = await tree(`other${n}`)
    expect(await anyway(t.path, 'made-up')).toMatchObject({ deleted: false, reason: expect.stringMatching(/not checked for this removal/) })
    const p = await preview(other.path)
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after a file is renamed and rewritten, the count the same', async () => {
    const t = await tree(`rename${++n}`)
    writeFileSync(join(t.path, 'old.txt'), 'old\n')
    const p = await preview(t.path)
    rmSync(join(t.path, 'old.txt'))
    writeFileSync(join(t.path, 'new-important.txt'), 'new work\n')
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, lookAgain: true, reason: expect.stringMatching(/changed since you were shown.*its files/) })
    expect(existsSync(join(t.path, 'new-important.txt'))).toBe(true)
  })

  it("refuses after an uncommitted file's content changes, its size the same", async () => {
    const t = await tree(`edit${++n}`)
    writeFileSync(join(t.path, 'a.txt'), 'AAAA\n')
    const p = await preview(t.path)
    writeFileSync(join(t.path, 'a.txt'), 'BBBB\n')
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after an ignored file changes', async () => {
    const t = await tree(`ignored${++n}`)
    commit(t.path, '.gitignore')
    writeFileSync(join(t.path, '.gitignore'), '*.log\n')
    git(t.path, 'add', '-A')
    git(t.path, 'commit', '-qm', 'ignore logs')
    writeFileSync(join(t.path, 'build.log'), 'one\n')
    const p = await preview(t.path)
    writeFileSync(join(t.path, 'build.log'), 'one, and more\n')
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its files/) })
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after the worktree switches to another branch at the same commit; neither branch goes', async () => {
    const t = await tree(`switched${++n}`)
    commit(t.path, 'w.txt')
    const p = await preview(t.path)
    expect(p.branch).toBe(t.branch)
    git(t.path, 'checkout', '-q', '-b', `hive/different${n}`)
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its branch/) })
    expect(branches()).toEqual(expect.arrayContaining([t.branch, `hive/different${n}`]))
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after a change staged in its index alone, the working file the same', async () => {
    const t = await tree(`staged${++n}`)
    writeFileSync(join(t.path, 'a.txt'), 'changed\n')
    const p = await preview(t.path)
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: t.path, input: 'NEW STAGED WORK AFTER PREVIEW\n', encoding: 'utf8' }).trim()
    git(t.path, 'update-index', '--cacheinfo', `100644,${blob},a.txt`)
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its files/) })
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after an ignored file and a large file change, at the same size with their times put back', async () => {
    const t = await tree(`sametime${++n}`)
    writeFileSync(join(t.path, '.gitignore'), '*.log\n*.bin\n')
    git(t.path, 'add', '-A')
    git(t.path, 'commit', '-qm', 'ignore')
    const secret = join(t.path, 'secret.log')
    writeFileSync(secret, 'AAAA')
    const was = statSync(secret)
    const p = await preview(t.path)
    writeFileSync(secret, 'BBBB')
    utimesSync(secret, was.atime, was.mtime)
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    // Bigger than any "hash only small files" limit: still read whole.
    const big = join(t.path, 'big.bin')
    const bytes = Buffer.alloc(9 * 1024 * 1024)
    writeFileSync(big, bytes)
    const bigWas = statSync(big)
    const q = await preview(t.path)
    bytes[bytes.length - 1] = 1
    writeFileSync(big, bytes)
    utimesSync(big, bigWas.atime, bigWas.mtime)
    expect((await anyway(t.path, q.token)).deleted).toBe(false)
    expect(existsSync(secret) && existsSync(big)).toBe(true)
  })

  it("a main branch git couldn't look for is no answer: no preview, and a token from before removes nothing", async () => {
    const t = await tree(`nomain${++n}`)
    commit(t.path, 'w.txt')
    const before = await preview(t.path)
    failing = (args) => args.includes('for-each-ref')
    await expect(preview(t.path)).rejects.toThrow(/couldn't check what it holds: git couldn't list the branches/)
    expect(await anyway(t.path, before.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/couldn't list the branches/) })
    failing = (args) => args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')
    await expect(preview(t.path)).rejects.toThrow(/couldn't read origin\/HEAD/)
    failing = null
    expect(existsSync(t.path)).toBe(true)
    expect(branches()).toContain(t.branch)
  })

  it('a detached worktree names the commits only its HEAD holds, and they count as work', async () => {
    const t = await tree(`alone${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    commit(t.path, 'unique.txt')
    const listed = (await find(t.path))!
    expect(listed.check).toMatchObject({ removable: false, ahead: 1, dirty: 0 })
    expect(holdsWork(listed)).toBe(true)
    expect(unusedState(listed)).toBe('1 commit on no branch')
    expect(lostByRemoving(listed)![0]).toBe('1 commit on no branch (only its detached HEAD has it)')
    const p = await preview(t.path)
    expect(p.lost[0]).toBe('1 commit on no branch (only its detached HEAD has it)')
    expect(await anyway(t.path, p.token)).toEqual({ deleted: true })
  })

  it("nothing to confirm when git can't count what it holds", async () => {
    const t = await tree(`uncounted${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    failing = (args) => args.includes('rev-list')
    expect(lostByRemoving((await find(t.path))!)).toBeNull()
    await expect(preview(t.path)).rejects.toThrow(/couldn't check what it holds: git could not count its commits/)
    failing = null
    expect(existsSync(t.path)).toBe(true)
  })
})

describe('without git (#346)', () => {
  it('lists nothing, says why, and removes nothing', async () => {
    const t = await tree(`nogit${++n}`)
    process.env.PATH = (PATH ?? '').split(delimiter).filter((d) => d && !gitOnPath({ PATH: d })).join(delimiter)
    expect(await run(() => unusedWorktrees(proj))).toEqual({ worktrees: [], gitProblem: "Git isn't installed (or isn't on Hive's PATH)" })
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false, reason: "Git isn't installed (or isn't on Hive's PATH)" })
    await expect(run(() => removalPreview(proj, t.path))).rejects.toThrow(/isn't installed/)
    expect(existsSync(t.path)).toBe(true)
  })
})

describe("a deleted template's worktree agents", () => {
  it('finds the unused worktrees named after them, numbered ones too; deleting the template touches none', async () => {
    n++
    const a = await tree(`claudette${n}`)
    const b = await tree(`claudette${n}-2`)
    const other = await tree(`someone${n}`)
    const found = await run(() => unusedWorktreesNamed(proj, [`Claudette${n}`, 'Nobody']))
    expect(found.map((p) => p.toLowerCase()).sort()).toEqual([a.path, b.path].map((p) => p.toLowerCase()).sort())
    expect(found.map((p) => p.toLowerCase())).not.toContain(other.path.toLowerCase())

    const t = { version: 1, name: `Trio ${n}`, savedAt: '2026-10-06T10:00:00.000Z', layout: 'auto', agents: [{ name: `Claudette${n}`, provider: 'claude-code', worktree: true }, { name: 'Folder', provider: 'claude-code', worktree: false }] }
    mkdirSync(join(proj, '.hive', 'templates'), { recursive: true })
    writeFileSync(join(proj, '.hive', 'templates', `trio-${n}.json`), JSON.stringify(t))
    const left = await run(() => templates.deleteTemplate({ scope: 'project', project: proj, file: `trio-${n}.json` }))
    expect(left.unusedWorktrees).toEqual([{ project: proj, count: 2 }])
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true)
    expect(templateWorktreesHint(left, () => 'proj')).toMatchObject({ title: '2 unused worktrees in proj', project: proj })
  })
})

describe('what the window says', () => {
  const wt = (check: UnusedWorktree['check'], extra: Partial<UnusedWorktree> = {}): UnusedWorktree => ({ path: 'C:\\w\\x', branch: 'hive/x', check, ...extra })
  it('the Changes notice only for worktrees holding work', () => {
    expect(unusedWorkNotice([wt({ removable: true, into: 'main', ahead: 0, dirty: 0 })])).toBeNull()
    expect(unusedWorkNotice([wt({ removable: false, into: 'main', ahead: 2, dirty: 0 }), wt({ removable: false, into: 'main', ahead: 0, dirty: 3 })])).toBe("2 unused worktrees have work that isn't on main")
  })
  it('nothing to remove anyway when git could not count it', () => {
    expect(lostByRemoving(wt({ removable: false, into: 'main', reason: "git couldn't check hive/x" }))).toBeNull()
    expect(unusedState(wt({ removable: false, into: 'main', reason: "git couldn't check hive/x" }))).toBe("git couldn't check hive/x")
  })
  it('no template hint without unused worktrees', () => {
    expect(templateWorktreesHint({ unusedWorktrees: [] }, () => 'x')).toBeNull()
  })
})
