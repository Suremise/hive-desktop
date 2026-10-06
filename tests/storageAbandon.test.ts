// Storage measurements walk every file of every worktree, so a page that stops waiting abandons its call (#246): the
// call fails, and the walk stops once no other call waits for it (another window's, or one that can't be abandoned).
// opendir is held at a gate so a walk can be caught half way; what it reads afterwards shows whether it carried on.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, opened: [] as string[] }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    opendir: async (path: string, ...rest: unknown[]) => {
      gate.opened.push(String(path))
      if (gate.hold) await gate.hold
      return real.opendir(path, ...(rest as []))
    }
  }
})

const base = mkdtempSync(join(tmpdir(), 'hive-storage-abandon-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const DIRS = 40
/** A project whose agent's worktree has DIRS folders of one 100-byte file each. */
function project(name: string): { path: string; tree: string } {
  const path = join(base, name)
  const tree = join(base, `${name}-tree`)
  mkdirSync(join(path, '.hive'), { recursive: true })
  for (let i = 0; i < DIRS; i++) {
    mkdirSync(join(tree, `d${i}`), { recursive: true })
    writeFileSync(join(tree, `d${i}`, 'f.txt'), 'x'.repeat(100))
  }
  return { path, tree }
}
const projects = new Map<string, string>()
const assistantHome = join(base, 'assistant-home')

vi.mock('../src/main/sessions', () => ({ sessions: {} }))
vi.mock('../src/main/workspace', () => ({
  workspace: {
    assertSessionHost: (p: string) => p,
    isAssistantHome: (p: string) => p === assistantHome,
    assistantHome,
    listProjectPaths: async () => [...projects.keys()],
    projectConfig: async (p: string) => ({ agents: [{ id: 'tree', name: 'Tree', worktree: { path: projects.get(p) } }] })
  }
}))

const { StorageStopped, abandonStorage, projectStorage, workspaceStorage } = await import('../src/main/storage')

/** Holds every opendir until released. */
function hold(): () => void {
  let release!: () => void
  gate.hold = new Promise((r) => (release = r))
  return () => {
    gate.hold = null
    release()
  }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))
const reads = (dir: string): number => gate.opened.filter((p) => p.startsWith(dir)).length

beforeEach(() => {
  gate.hold = null
  gate.opened = []
})

describe('abandoning a storage measurement', () => {
  it('stops the walk when nothing else waits, and the next call starts afresh', async () => {
    const p = project('alone')
    projects.set(p.path, p.tree)
    const release = hold()
    const call = projectStorage(p.path, true, 'page-1')
    await settle()
    abandonStorage('page-1')
    await expect(call).rejects.toBeInstanceOf(StorageStopped)
    const before = reads(p.tree)
    release()
    await settle()
    expect(reads(p.tree) - before).toBeLessThanOrEqual(1)
    const again = await projectStorage(p.path, false)
    expect(again.worktrees[0].bytes).toBe(DIRS * 100)
  })

  it("carries on for another window's request, which gets the whole result", async () => {
    const p = project('shared')
    projects.set(p.path, p.tree)
    const release = hold()
    const first = projectStorage(p.path, true, 'window-a')
    const second = projectStorage(p.path, true, 'window-b')
    await settle()
    abandonStorage('window-a')
    await expect(first).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await second).worktrees[0].bytes).toBe(DIRS * 100)
    expect(reads(p.tree)).toBe(DIRS + 1)
  })

  it('carries on for a call that gave no request (it cannot be abandoned)', async () => {
    const p = project('anonymous')
    projects.set(p.path, p.tree)
    const release = hold()
    const page = projectStorage(p.path, true, 'page-2')
    const plain = projectStorage(p.path, true)
    await settle()
    abandonStorage('page-2')
    await expect(page).rejects.toBeInstanceOf(StorageStopped)
    release()
    expect((await plain).worktrees[0].bytes).toBe(DIRS * 100)
  })

  it('stops a workspace measurement before the next project', async () => {
    projects.clear()
    const a = project('ws-a')
    const b = project('ws-b')
    projects.set(a.path, a.tree)
    projects.set(b.path, b.tree)
    const release = hold()
    const call = workspaceStorage(true, 'settings-1')
    await settle()
    abandonStorage('settings-1')
    await expect(call).rejects.toBeInstanceOf(StorageStopped)
    release()
    await settle()
    expect(reads(b.tree)).toBe(0)
    projects.clear()
  })

  it('ignores a request that is unknown or already answered', async () => {
    const p = project('done')
    projects.set(p.path, p.tree)
    const done = await projectStorage(p.path, true, 'page-3')
    abandonStorage('page-3')
    abandonStorage('never-sent')
    expect(await projectStorage(p.path, false, 'page-4')).toEqual(done)
  })
})
