// Adding an agent with a worktree reuses a matching unused worktree (#456): the one on the branch a new worktree would
// get (hive/<name>), in Hive's worktrees folder, when it is merged into the base (a squash merge counting) and clean,
// brought up to the base; otherwise a new one is made and the reply says why. An unused worktree the user picks is
// brought up the same way when merged and clean, else taken with its work. Setup runs again only if a lockfile changed.
// Templates reuse their own way (#289): without reuseWorktree nothing changes. Only one nothing uses: no git lock in it,
// no process in it (checked once, not guarded against work started meanwhile).
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { lockfileChanged, reuseNote } from '../src/shared/unusedWorktrees'
import { tempDir } from './tempDir'

const base = tempDir('hive-wtreuse-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const wt = await import('../src/main/worktrees')
const { createWorktree } = wt
const { addAgent, gitInfo, reserveForRemoval, worktreeMatch } = await import('../src/main/projectAgents')
const { placeKey } = await import('../src/main/fsutil')

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
const root = join(base, 'ws.worktrees', 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T,>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0

/** The branch Hive makes for a new worktree agent of this name here (#703): hive/<workspace>/<project>/<name>. */
const full = (t: { path: string }): string => `hive/ws/proj/${basename(t.path)}`

/** An unused worktree in the workspace's worktree folder, off main: on hive/<name>, Hive's branch from before #703, unless `branch` says. */
async function tree(name: string, where = root, branch = `hive/${name}`): Promise<{ path: string; branch: string }> {
  const t = { path: join(where, name), branch }
  await createWorktree(proj, t.path, t.branch, 'main')
  return t
}
const commit = (cwd: string, file: string, text = `${file}\n`): void => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-qm', file)
}
const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD')
const branches = (): string[] => git(proj, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean)
/** The project with no agents and this worktree setup command. */
const reset = (setup = ''): void => writeFileSync(join(proj, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [], worktreeSetup: setup }))
const add = (name: string, extra: Record<string, unknown> = {}) => run(() => addAgent(proj, { name, location: 'new-worktree', reuseWorktree: true, ...extra }))

beforeAll(async () => {
  mkdirSync(join(proj, '.hive'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  commit(proj, 'a.txt')
  reset()
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  await disposeWorkspaceService(w)
})

describe('a new worktree agent named like an unused worktree', () => {
  it('reuses one merged and clean, brought up to main (no -2), its setup not run again when no lockfile changed', async () => {
    reset('npm install')
    const t = await tree(`b${++n}`)
    commit(proj, `main${n}.txt`)
    const def = await add(`B${n}`)
    expect(placeKey(def.worktree!.path)).toBe(placeKey(t.path))
    expect(def.worktree!.branch).toBe(t.branch)
    expect(head(t.path)).toBe(head(proj))
    expect(existsSync(join(t.path, `main${n}.txt`))).toBe(true)
    expect(await wt.dirtyCount(t.path)).toBe(0)
    expect(def.reuse).toEqual({ branch: t.branch, reused: true, base: 'main', upTo: head(proj) })
    expect(def.needsSetup).toBeUndefined()
    expect(branches()).not.toContain(full(t))
    expect(reuseNote(def.reuse!)).toBe(`reused ${t.branch}, brought up to main at ${head(proj).slice(0, 7)}`)
  })

  it('runs the setup again when the update changed a lockfile', async () => {
    reset('npm install')
    const t = await tree(`b${++n}`)
    commit(proj, 'package-lock.json', `{"n":${n}}\n`)
    const def = await add(`B${n}`)
    expect(placeKey(def.worktree!.path)).toBe(placeKey(t.path))
    expect(def.needsSetup).toBe(true)
  })

  it('reuses one already at main as it is', async () => {
    reset()
    const t = await tree(`b${++n}`)
    const def = await add(`B${n}`)
    expect(placeKey(def.worktree!.path)).toBe(placeKey(t.path))
    expect(def.reuse).toEqual({ branch: t.branch, reused: true, base: 'main' })
    expect(reuseNote(def.reuse!)).toBe(`reused ${t.branch}, already at main`)
  })

  it('reuses one whose work was squash-merged, moved to main', async () => {
    reset()
    const t = await tree(`b${++n}`)
    commit(t.path, `work${n}.txt`)
    commit(proj, `work${n}.txt`)
    const def = await add(`B${n}`)
    expect(placeKey(def.worktree!.path)).toBe(placeKey(t.path))
    expect(head(t.path)).toBe(head(proj))
  })

  it('makes a new one, saying why, when the unused one has unmerged commits or uncommitted files; those stay', async () => {
    reset()
    const ahead = await tree(`b${++n}`)
    commit(ahead.path, `mine${n}.txt`)
    const tip = head(ahead.path)
    const a = await add(`B${n}`)
    expect(a.worktree!.branch).toBe(full(ahead))
    expect(a.reuse).toEqual({ branch: ahead.branch, reused: false, base: 'main', notReused: '1 commit not merged into main' })
    expect(reuseNote(a.reuse!)).toBe(`made a new worktree, leaving ${ahead.branch}'s unused one as it is (1 commit not merged into main)`)
    expect(head(ahead.path)).toBe(tip)

    const dirty = await tree(`b${++n}`)
    writeFileSync(join(dirty.path, 'draft.txt'), 'draft\n')
    const d = await add(`B${n}`)
    expect(d.worktree!.branch).toBe(full(dirty))
    expect(d.reuse?.notReused).toBe('1 uncommitted file')
    expect(existsSync(join(dirty.path, 'draft.txt'))).toBe(true)
  })

  it('the dialog sees the same before adding: reusable, or why not, or none', async () => {
    reset()
    const t = await tree(`b${++n}`)
    expect(await run(() => worktreeMatch(proj, t.branch, 'main'))).toMatchObject({ branch: t.branch, base: 'main', reusable: true })
    commit(t.path, `mine${n}.txt`)
    expect(await run(() => worktreeMatch(proj, t.branch, 'main'))).toMatchObject({ reusable: false, why: '1 commit not merged into main' })
    expect(await run(() => worktreeMatch(proj, `hive/none${n}`, 'main'))).toBeNull()
  })

  it('only one in Hive\'s worktrees folder, never one made elsewhere', async () => {
    reset()
    const t = await tree(`b${++n}`, join(base, 'elsewhere'))
    const def = await add(`B${n}`)
    expect(def.worktree!.branch).toBe(full(t))
    expect(def.reuse).toBeUndefined()
  })

  it('not one being removed or merged: a new one', async () => {
    reset()
    const t = await tree(`b${++n}`)
    const release = reserveForRemoval(t.path)
    try {
      const def = await add(`B${n}`)
      expect(def.worktree!.branch).toBe(full(t))
      expect(def.reuse?.notReused).toBe('it is being removed or merged')
    } finally {
      release()
    }
  })

  it('without reuseWorktree (a template\'s load), a new one as before', async () => {
    reset()
    const t = await tree(`b${++n}`)
    const def = await run(() => addAgent(proj, { name: `B${n}`, location: 'new-worktree' }))
    expect(def.worktree!.branch).toBe(full(t))
    expect(def.reuse).toBeUndefined()
  })
})

describe('branches in full, hive/<workspace>/<project>/<agent>, and the ones from before (#703)', () => {
  it('a new worktree is on the full form; an unused one on it is reused', async () => {
    reset()
    const made = await add(`F${++n}`)
    expect(made.worktree!.branch).toBe(`hive/ws/proj/f${n}`)
    const t = await tree(`f${++n}`, root, `hive/ws/proj/f${n}`)
    const def = await add(`F${n}`)
    expect([placeKey(def.worktree!.path), def.worktree!.branch, def.reuse?.reused]).toEqual([placeKey(t.path), t.branch, true])
  })

  it('of one on each form, the full form is reused; the one from before stays', async () => {
    reset()
    const name = `f${++n}`
    const old = await tree(`${name}-old`, root, `hive/${name}`)
    const t = await tree(name, root, `hive/ws/proj/${name}`)
    const def = await add(name.toUpperCase())
    expect([placeKey(def.worktree!.path), def.worktree!.branch]).toEqual([placeKey(t.path), t.branch])
    expect(existsSync(old.path) && branches().includes(old.branch)).toBe(true)
  })

  it("Add Agent's look before adding finds the one from before for the full form, and only for Hive's own branch", async () => {
    reset()
    const t = await tree(`f${++n}`)
    expect(await run(() => worktreeMatch(proj, `hive/ws/proj/f${n}`, 'main', `F${n}`))).toMatchObject({ path: t.path, branch: t.branch, reusable: true })
    // A branch of the user's own, or another workspace's or project's full form, never finds it.
    for (const other of [`feature/f${n}`, `hive/other/proj/f${n}`, `hive/ws/other/f${n}`]) expect(await run(() => worktreeMatch(proj, other, 'main'))).toBeNull()
  })

  it("another workspace's branch for a project of the same name in one repository is never taken: a new one", async () => {
    reset()
    const t = await tree(`f${++n}`, root, `hive/other/proj/f${n}`)
    const def = await add(`F${n}`)
    expect(def.worktree!.branch).toBe(`hive/ws/proj/f${n}`)
    expect(placeKey(def.worktree!.path)).not.toBe(placeKey(t.path))
    expect(def.reuse).toBeUndefined()
  })
})

describe('an unused worktree the user picks', () => {
  it('merged and clean: brought up to main', async () => {
    reset()
    const t = await tree(`p${++n}`)
    commit(proj, `main${n}.txt`)
    const def = await run(() => addAgent(proj, { name: `Other${n}`, location: 'existing-worktree', worktreePath: t.path, reuseWorktree: true }))
    expect(head(t.path)).toBe(head(proj))
    expect(def.reuse).toMatchObject({ reused: true, upTo: head(proj) })
  })

  it('holding work: taken as it is, with its work', async () => {
    reset()
    const t = await tree(`p${++n}`)
    commit(t.path, `mine${n}.txt`)
    const tip = head(t.path)
    const def = await run(() => addAgent(proj, { name: `Other${n}`, location: 'existing-worktree', worktreePath: t.path, reuseWorktree: true }))
    expect(head(t.path)).toBe(tip)
    expect(def.reuse).toEqual({ branch: t.branch, reused: true, base: 'main', keptWork: true })
    expect(reuseNote(def.reuse!)).toBe(`reused ${t.branch} as it is (it keeps its work)`)
  })
})

describe('one something uses (checked once): left as it is, and a new worktree is made', () => {
  // Each where git keeps it: the worktree's own index and HEAD locks, its branch's and packed-refs' in the common git folder.
  for (const file of ['index.lock', 'HEAD.lock', 'branch', 'packed-refs.lock']) {
    it(`git busy in it (${file === 'branch' ? "its branch's ref lock" : file})`, async () => {
      reset()
      const t = await tree(`r${++n}`)
      const tip = head(t.path)
      commit(proj, `main${n}.txt`)
      const lock = git(t.path, 'rev-parse', '--path-format=absolute', '--git-path', file === 'branch' ? `refs/heads/${t.branch}.lock` : file)
      writeFileSync(lock, '', { flag: 'wx' })
      try {
        const def = await add(`R${n}`)
        expect(def.worktree!.branch).toBe(full(t))
        expect(def.reuse?.notReused).toBe('git is busy in it')
        // Left as it was: HEAD, index and files.
        expect(git(t.path, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${t.branch}`)
        expect(head(t.path)).toBe(tip)
        expect(git(t.path, 'diff', '--cached', '--name-only')).toBe('')
        expect(existsSync(join(t.path, `main${n}.txt`))).toBe(false)
        expect(await wt.dirtyCount(t.path)).toBe(0)
        expect(existsSync(lock)).toBe(true)
      } finally {
        rmSync(lock)
      }
    })
  }

  it('a process working in it (in a folder of it); once it ends, the worktree is reused', async () => {
    reset()
    const t = await tree(`r${++n}`)
    const tip = head(t.path)
    commit(proj, `main${n}.txt`)
    const inside = join(t.path, 'sub')
    mkdirSync(inside)
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume()"], { cwd: inside, env: { SystemRoot: process.env.SystemRoot ?? '' }, stdio: 'pipe', windowsHide: true })
    const ended = new Promise((done) => child.once('exit', done))
    try {
      await new Promise<void>((ready, fail) => {
        child.stdout.once('data', () => ready())
        child.once('error', fail)
      })
      const def = await add(`R${n}`)
      expect(def.worktree!.branch).toBe(full(t))
      expect(def.reuse?.notReused).toBe('a program is using it')
      expect(head(t.path)).toBe(tip)
      expect(existsSync(inside)).toBe(true)
      // The new one goes again: an unused one on the full form would be taken first (#703).
      git(proj, 'worktree', 'remove', '--force', def.worktree!.path)
      git(proj, 'branch', '-D', def.worktree!.branch)
    } finally {
      child.stdin.end()
      await ended
    }
    reset()
    const again = await add(`R${n}`)
    expect(placeKey(again.worktree!.path)).toBe(placeKey(t.path))
    expect(again.reuse).toEqual({ branch: t.branch, reused: true, base: 'main', upTo: head(proj) })
  })
})

describe('lockfiles', () => {
  it('the usual package managers\' lockfiles, anywhere; not other files', () => {
    expect(lockfileChanged(['src/a.ts', 'package-lock.json'])).toBe(true)
    expect(lockfileChanged(['web/yarn.lock'])).toBe(true)
    expect(lockfileChanged(['pnpm-lock.yaml', 'Cargo.lock'])).toBe(true)
    expect(lockfileChanged(['package.json', 'README.md', 'locks/notes.lock.txt'])).toBe(false)
    expect(lockfileChanged([])).toBe(false)
  })
})

describe('branches from before in the way of the full form (#703 round 2)', () => {
  it("a hive/<slug> worktree of a name the new rules write otherwise (B--1: hive/b--1) is still found, in the look and the add", async () => {
    reset()
    const t = await tree('b--1', root, 'hive/b--1')
    expect(await run(() => worktreeMatch(proj, 'hive/ws/proj/b-1', 'main', 'B--1'))).toMatchObject({ path: t.path, branch: 'hive/b--1', reusable: true })
    const def = await add('B--1')
    expect([placeKey(def.worktree!.path), def.worktree!.branch, def.reuse?.reused]).toEqual([placeKey(t.path), 'hive/b--1', true])
  })

  it('a branch hive/<workspace> from before (an agent once called "ws"), in either case: new branches go to hive/ws-2/…, and it stays', async () => {
    // A repository of its own, as it was before #703: no full-form branch yet, so hive/ws can be one.
    const old = join(wsPath, 'oldrepo')
    mkdirSync(join(old, '.hive'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', old])
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(old, 'config', k, v)
    commit(old, 'a.txt')
    const oldReset = (): void => writeFileSync(join(old, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const addOld = (name: string) => run(() => addAgent(old, { name, location: 'new-worktree', reuseWorktree: true }))
    const oldBranches = (): string[] => git(old, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean)
    await w.refresh()
    for (const legacy of ['hive/ws', 'hive/WS']) {
      oldReset()
      git(old, 'branch', legacy)
      const def = await addOld(`N${++n}`)
      expect(def.worktree!.branch).toBe(`hive/ws-2/oldrepo/n${n}`)
      expect(existsSync(def.worktree!.path)).toBe(true)
      // The dialog is told the same place for its default.
      expect((await run(() => gitInfo(old))).branchSpace).toBe('ws-2')
      // Recognised as this workspace's: removed and added again, the same name works in it again.
      oldReset()
      const again = await addOld(`N${n}`)
      expect([placeKey(again.worktree!.path), again.worktree!.branch, again.reuse?.reused]).toEqual([placeKey(def.worktree!.path), def.worktree!.branch, true])
      expect(oldBranches()).toContain(legacy)
      // Put back for the next: its worktree and branch go, then the branch in the way.
      git(old, 'worktree', 'remove', '--force', def.worktree!.path)
      git(old, 'branch', '-D', def.worktree!.branch, legacy)
    }
    oldReset()
    expect((await addOld(`N${++n}`)).worktree!.branch).toBe(`hive/ws/oldrepo/n${n}`)
  })

  it('a branch Hive would make one inside of (hive/ws/proj/x/y) numbers it; one it would be inside of refuses, saying which', async () => {
    reset()
    git(proj, 'branch', `hive/ws/proj/x${++n}/y`)
    expect((await add(`X${n}`)).worktree!.branch).toBe(`hive/ws/proj/x${n}-2`)
    reset()
    git(proj, 'branch', `feature${n}`)
    await expect(add(`Y${n}`, { branch: `feature${n}/y` })).rejects.toThrow(`a branch feature${n} is in the way`)
  })
})
