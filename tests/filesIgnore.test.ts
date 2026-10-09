// The Files tab's dimmed (git-ignored) entries when git check-ignore fails (#222): another git command rewriting the
// index (a user's `git add`, an agent's commit) can make it exit 128 ("index file open failed"), which used to read as
// "nothing ignored" and showed dist/ undimmed. A busy index is tried again; if git still can't say, the folder keeps
// what was last known and is listed again shortly. Real git for everything but the failures, which a stub injects.
import { execFile, execFileSync } from 'child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult } from '../src/main/git'
import { tempDir } from './tempDir'

/** check-ignore results to give instead of running it, in order; empty: run it. */
const failNext: Partial<GitResult>[] = []
let checkIgnoreCalls = 0
/** Real check-ignores that failed (neither 0 nor 1), for the stress test's report. */
let realFailures = 0
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number): Promise<GitResult> => {
      if (args[0] !== 'check-ignore') return real.git(cwd, args, max)
      checkIgnoreCalls++
      const f = failNext.shift()
      if (f) return { out: '', ok: false, buf: Buffer.alloc(0), err: '', code: 128, ...f }
      const r = await real.git(cwd, args, max)
      if (r.code !== 0 && r.code !== 1) realFailures++
      return r
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const files = await import('../src/main/files')
const { onHiveEvent } = await import('../src/main/events')

const BUSY = { err: 'fatal: .git/index: index file open failed: Permission denied' }
const base = tempDir('hive-ignore-')
const ws = join(base, 'ws')
const proj = join(ws, 'proj')
mkdirSync(join(proj, 'dist'), { recursive: true })
mkdirSync(join(proj, 'src'), { recursive: true })
writeFileSync(join(proj, '.gitignore'), 'dist/\n')
writeFileSync(join(proj, 'dist', 'out.js'), '')
writeFileSync(join(proj, 'src', 'a.ts'), '')
execFileSync('git', ['init', '-q', proj])
const w = createWorkspaceService()
w.path = ws
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  failNext.length = 0
  checkIgnoreCalls = 0
})

const dimmed = async (rel = '') => (await files.listDir(proj, rel)).filter((f) => f.ignored).map((f) => f.name)
const relists = () => {
  const seen: string[][] = []
  const off = onHiveEvent((e) => e.type === 'files-changed' && seen.push(e.dirs))
  return { seen, off }
}

describe('Files tab: a failed git check-ignore (#222)', () => {
  it('a busy index is tried again: exit 128 then success shows dist dimmed', async () => {
    failNext.push(BUSY)
    expect(await dimmed()).toEqual(['dist'])
    expect(checkIgnoreCalls).toBe(2)
  })

  it('still failing: the folder keeps its last known state and is listed again shortly, a few times at most', async () => {
    const r = relists()
    expect(await dimmed()).toEqual(['dist'])
    for (let i = 0; i < files.IGNORE_TRIES; i++) failNext.push(BUSY)
    expect(await dimmed()).toEqual(['dist'])
    expect(checkIgnoreCalls).toBe(1 + files.IGNORE_TRIES)
    await vi.waitFor(() => expect(r.seen).toEqual([['']]), { timeout: 3000 })
    // Failing on every re-list: at most RELIST_MAX of them in a row.
    for (let k = 0; k < files.RELIST_MAX + 2; k++) {
      for (let i = 0; i < files.IGNORE_TRIES; i++) failNext.push(BUSY)
      await dimmed()
      await new Promise((res) => setTimeout(res, 700))
    }
    expect(r.seen.length).toBe(files.RELIST_MAX)
    // Working again: back to normal, and a later failure is listed again once more.
    expect(await dimmed()).toEqual(['dist'])
    for (let i = 0; i < files.IGNORE_TRIES; i++) failNext.push(BUSY)
    await dimmed()
    await vi.waitFor(() => expect(r.seen.length).toBe(files.RELIST_MAX + 1), { timeout: 3000 })
    r.off()
  })

  it('a folder never listed before shows nothing dimmed while git fails, and is listed again', async () => {
    const r = relists()
    failNext.push({ err: 'fatal: something else went wrong' })
    expect(await dimmed('src')).toEqual([])
    // Not a busy index: not tried again.
    expect(checkIgnoreCalls).toBe(1)
    await vi.waitFor(() => expect(r.seen).toEqual([['src']]), { timeout: 3000 })
    r.off()
  })

  it('outside a repository nothing is ignored: no retry, no re-list', async () => {
    const r = relists()
    failNext.push({ err: 'fatal: not a git repository (or any of the parent directories): .git' })
    expect(await dimmed('src')).toEqual([])
    expect(checkIgnoreCalls).toBe(1)
    await new Promise((res) => setTimeout(res, 700))
    expect(r.seen).toEqual([])
    r.off()
  })

  it("under load from the user's git add, a listing never shows dist undimmed", async () => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: proj })
    expect(await dimmed()).toEqual(['dist'])
    realFailures = 0
    const running = { on: true }
    // The user's (or an agent's) git add rewriting the index, three at once; their own clashes don't matter here.
    const writer = async () => {
      while (running.on) {
        const t = new Date(Date.now() - Math.floor(Math.random() * 1e7))
        utimesSync(join(proj, 'src', 'a.ts'), t, t)
        await new Promise((res) => execFile('git', ['add', 'src/a.ts'], { cwd: proj, windowsHide: true }, res))
      }
    }
    const undimmed: number[] = []
    let listings = 0
    const reader = async () => {
      while (running.on) {
        if (!(await dimmed()).includes('dist')) undimmed.push(listings)
        listings++
      }
    }
    setTimeout(() => (running.on = false), Number(process.env.HIVE_STRESS_MS) || 4000)
    await Promise.all([writer(), writer(), writer(), reader(), reader(), reader()])
    console.log(`#222 stress: ${listings} listings, ${realFailures} check-ignore failures absorbed`)
    expect(listings).toBeGreaterThan(20)
    expect(undimmed).toEqual([])
  }, 600000)
})
