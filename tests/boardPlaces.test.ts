// Placing a card doesn't read the whole board (#458). Each change that places a card (creating one, a move, a batch)
// did read every card file, one at a time, under the board's lock: N cards created in a row cost about N²/2 reads. Now
// placement reads only the card files changed since it last looked (each file is still stat'ed, and stays the truth for
// its card), so a card changed or removed by hand, or by another program, is placed by what its file says now.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

// The card files read (fs/promises' readFile of <n>.json in a tasks folder), counted.
const reads = vi.hoisted(() => ({ cards: 0 }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    readFile: ((path: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
      if (/[\\/]tasks[\\/]\d+\.json$/.test(String(path))) reads.cards++
      return (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)
    }) as typeof real.readFile
  }
})

const base = tempDir('hive-board-places-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const tasksDir = join(wsPath, '.hive', 'tasks')
const BOARD = 200
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** A card file as Hive writes one (written here directly, as by hand or another program). */
const cardFile = (n: number, fields: Partial<TaskCard> = {}): void =>
  writeFileSync(join(tasksDir, `${n}.json`), JSON.stringify({ number: n, title: `Card ${n}`, description: 'x'.repeat(500), project: 'p', agent: null, column: 'todo', order: n, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '', createdBy: '', updatedAt: '', ...fields }))
/** The card files `fn` reads. */
async function readsOf(fn: () => Promise<unknown>): Promise<number> {
  const was = reads.cards
  await fn()
  return reads.cards - was
}

beforeAll(async () => {
  mkdirSync(join(wsPath, 'p', '.hive'), { recursive: true })
  writeFileSync(join(wsPath, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  mkdirSync(tasksDir, { recursive: true })
  for (let n = 1; n <= BOARD; n++) cardFile(n, { column: (['todo', 'review', 'passed', 'done'] as const)[n % 4], archived: n % 5 === 0 })
  writeFileSync(join(tasksDir, 'meta.json'), JSON.stringify({ version: 1, next: BOARD + 1 }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => disposeWorkspaceService(w))

describe('placing a card on a big board (#458)', () => {
  beforeEach(async () => {
    // Whatever earlier tests changed is read once here, so each test counts only its own reads.
    await run(() => tasks.boardPlaces(w))
  })

  it('creating a card reads no other card file', async () => {
    expect(await readsOf(() => run(() => tasks.createTask({ title: 'One', project: 'p' }, user)))).toBe(0)
    // The next creation reads the card just created (changed since), and only it.
    expect(await readsOf(() => run(() => tasks.createTask({ title: 'Two', project: 'p' }, user)))).toBe(1)
  })

  it('a move, and a batch of 30 moves, read the cards they change, not the board', async () => {
    // A move reads its own card (getTask) and the card created last (changed since the last placement).
    expect(await readsOf(() => run(() => tasks.updateTask(3, { column: 'review', position: 'top' }, user)))).toBeLessThanOrEqual(2)
    const numbers = Array.from({ length: 30 }, (_, i) => 101 + i).filter((n) => n % 5 !== 0)
    const n = await readsOf(async () => {
      const items = await run(() => tasks.updateTasks(numbers, { column: 'passed' }, user))
      expect(items.every((i) => i.error === null && i.card?.column === 'passed')).toBe(true)
    })
    // Each card: itself, and the one moved before it. Reading the board would be 30 × 200.
    expect(n).toBeLessThanOrEqual(2 * numbers.length)
  })

  it('a card changed or removed by hand is placed by what its file says now', async () => {
    // Changed in place: now the last card in Passed.
    cardFile(7, { column: 'passed', order: 10_000 })
    expect((await run(() => tasks.createTask({ title: 'After 7', project: 'p', column: 'passed' }, user))).order).toBe(10_001)
    // The last card in Hold, then removed: the next card goes after the one that is left.
    cardFile(8, { column: 'hold', order: 500 })
    cardFile(9, { column: 'hold', order: 600 })
    await run(() => tasks.boardPlaces(w))
    rmSync(join(tasksDir, '9.json'))
    expect((await run(() => tasks.createTask({ title: 'After 8', project: 'p', column: 'hold' }, user))).order).toBe(501)
    // A file that isn't a card (damaged) has no place, as allTasks leaves it out.
    writeFileSync(join(tasksDir, '8.json'), '{ not json')
    expect((await run(() => tasks.boardPlaces(w))).some((c) => c.number === 8)).toBe(false)
    expect((await run(() => tasks.createTask({ title: 'Hold again', project: 'p', column: 'hold' }, user))).order).toBe(502)
  })

  it('places the same as the whole board read: every card, in board order', async () => {
    const all = await run(() => tasks.allTasks(w))
    const places = await run(() => tasks.boardPlaces(w))
    expect(places).toEqual(all.map((c) => ({ number: c.number, column: c.column, order: c.order, archived: c.archived, project: c.project })))
  })
})
