// The board's folder has a watcher of its own (#588). chokidar, watching .hive, read the whole tasks folder again on each
// event (an lstat of every card file), so on a 500-card board a 30-card batch took about 0.8 s instead of 0.1 s. Now
// chokidar leaves .hive/tasks out and fs.watch on it tells the board (tasks-changed) of card files changed by hand or
// by another program; the folder deleted, it is watched again once it is back; closing the workspace ends it.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-board-watcher-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { onHiveEvent } = await import('../src/main/events')

/** Bounds a hung run; the tests wait for what they expect, never for a time. */
const HUNG_MS = 15_000
const wsPath = join(base, 'ws')
const tasksDir = join(wsPath, '.hive', 'tasks')
const card = (n: number): void => writeFileSync(join(tasksDir, `${n}.json`), JSON.stringify({ number: n, title: `Card ${n}` }))

type Internals = { watcher: { getWatched: () => Record<string, string[]> } | null; tasksWatcher: unknown; tasksRetry: unknown }
let w: ReturnType<typeof createWorkspaceService>
const seen: string[] = []
let off: () => void

beforeAll(async () => {
  mkdirSync(wsPath, { recursive: true })
  w = createWorkspaceService()
  await w.open(wsPath)
  off = onHiveEvent((e: HiveEvent) => {
    if (e.type === 'tasks-changed') seen.push(e.workspacePath)
  })
})
afterAll(async () => {
  off()
  await disposeWorkspaceService(w)
})

/** Whether `change` tells the board: tasks-changed for this workspace after it. */
async function tellsTheBoard(change: () => void): Promise<void> {
  seen.length = 0
  change()
  await vi.waitFor(() => expect(seen).toContain(wsPath), { timeout: HUNG_MS })
}

describe("the board folder's watcher (#588)", () => {
  it('opening a workspace makes the board folder, and chokidar leaves it out (it read it all on each event)', async () => {
    const internals = w as unknown as Internals
    const hive = join(wsPath, '.hive')
    // chokidar scans .hive after open() returns: once it has listed the folders beside tasks, it would have tasks too.
    await vi.waitFor(() => expect(internals.watcher!.getWatched()[hive]?.map((n) => n.toLowerCase())).toEqual(expect.arrayContaining(['shared', 'skills', 'mcp', 'workspace.json'])), { timeout: HUNG_MS })
    const watched = internals.watcher!.getWatched()
    expect(watched[hive].map((n) => n.toLowerCase())).not.toContain('tasks')
    expect(Object.keys(watched).some((p) => p.toLowerCase() === tasksDir.toLowerCase() || p.toLowerCase().startsWith(tasksDir.toLowerCase() + '\\'))).toBe(false)
    expect(internals.tasksWatcher).not.toBeNull()
  })

  it('a card file added, changed or removed by hand tells the board', async () => {
    await tellsTheBoard(() => card(1))
    await tellsTheBoard(() => writeFileSync(join(tasksDir, '1.json'), JSON.stringify({ number: 1, title: 'Changed' })))
    await tellsTheBoard(() => rmSync(join(tasksDir, '1.json')))
  })

  it('the board folder deleted ends its watch (Windows then sends events without end), and made again it is watched again', { timeout: 60_000 }, async () => {
    const internals = w as unknown as Internals
    rmSync(tasksDir, { recursive: true, force: true })
    await vi.waitFor(() => expect(internals.tasksWatcher).toBeNull(), { timeout: HUNG_MS })
    // Made again (Windows may refuse it while the old watch is still closing): watched again, which tells the board.
    seen.length = 0
    await vi.waitFor(() => void mkdirSync(tasksDir, { recursive: true }), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(internals.tasksWatcher).not.toBeNull(), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(seen).toContain(wsPath), { timeout: HUNG_MS })
    // And the new watch sees what changes in it.
    await tellsTheBoard(() => card(100))
  })

  it('closing the workspace ends the watch and its retry', async () => {
    const other = createWorkspaceService()
    const otherPath = join(base, 'other')
    mkdirSync(otherPath, { recursive: true })
    await other.open(otherPath)
    expect((other as unknown as Internals).tasksWatcher).not.toBeNull()
    await disposeWorkspaceService(other)
    expect((other as unknown as Internals).tasksWatcher).toBeNull()
    expect((other as unknown as Internals).tasksRetry).toBeNull()
  })
})
