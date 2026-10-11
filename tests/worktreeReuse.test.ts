// Adding an agent with a worktree reuses a matching unused worktree (#456): the one on the branch a new worktree would
// get (hive/<name>), in Hive's worktrees folder, when it is merged into the base (a squash merge counting) and clean,
// brought up to the base; otherwise a new one is made and the reply says why. An unused worktree the user picks is
// brought up the same way when merged and clean, else taken with its work. Setup runs again only if a lockfile changed.
// Templates reuse their own way (#289): without reuseWorktree nothing changes. Only one nothing uses: no git lock in it,
// no process in it (checked once, not guarded against work started meanwhile).
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { lockfileChanged, reuseNote } from '../src/shared/unusedWorktrees'
import { tempDir } from './tempDir'

const base = tempDir('hive-wtreuse-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const wt = await import('../src/main/worktrees')
const { createWorktree } = wt
const { addAgent, reserveForRemoval, worktreeMatch } = await import('../src/main/projectAgents')
const { placeKey } = await import('../src/main/fsutil')

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
const root = join(base, 'ws.worktrees', 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T,>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0

/** An unused worktree hive/<name> in the workspace's worktree folder, off main. */
async function tree(name: string, where = root): Promise<{ path: string; branch: string }> {
  const t = { path: join(where, name), branch: `hive/${name}` }
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
    expect(branches()).not.toContain(`${t.branch}-2`)
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
    expect(a.worktree!.branch).toBe(`${ahead.branch}-2`)
    expect(a.reuse).toEqual({ branch: ahead.branch, reused: false, base: 'main', notReused: '1 commit not merged into main' })
    expect(reuseNote(a.reuse!)).toBe(`made a new worktree, leaving ${ahead.branch}'s unused one as it is (1 commit not merged into main)`)
    expect(head(ahead.path)).toBe(tip)

    const dirty = await tree(`b${++n}`)
    writeFileSync(join(dirty.path, 'draft.txt'), 'draft\n')
    const d = await add(`B${n}`)
    expect(d.worktree!.branch).toBe(`${dirty.branch}-2`)
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
    expect(def.worktree!.branch).toBe(`${t.branch}-2`)
    expect(def.reuse).toBeUndefined()
  })

  it('not one being removed or merged: a new one', async () => {
    reset()
    const t = await tree(`b${++n}`)
    const release = reserveForRemoval(t.path)
    try {
      const def = await add(`B${n}`)
      expect(def.worktree!.branch).toBe(`${t.branch}-2`)
      expect(def.reuse?.notReused).toBe('it is being removed or merged')
    } finally {
      release()
    }
  })

  it('without reuseWorktree (a template\'s load), a new one as before', async () => {
    reset()
    const t = await tree(`b${++n}`)
    const def = await run(() => addAgent(proj, { name: `B${n}`, location: 'new-worktree' }))
    expect(def.worktree!.branch).toBe(`${t.branch}-2`)
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
        expect(def.worktree!.branch).toBe(`${t.branch}-2`)
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
      expect(def.worktree!.branch).toBe(`${t.branch}-2`)
      expect(def.reuse?.notReused).toBe('a program is using it')
      expect(head(t.path)).toBe(tip)
      expect(existsSync(inside)).toBe(true)
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
