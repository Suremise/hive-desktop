// The board in SQLite (#1017): the database layer (settings, migrations, a file from a newer Hive), the move of the cards'
// files into it (once, checked, the folder kept as a backup and a stub left for older versions), cards an older Hive saved
// meanwhile, Export Board to JSON (an export read back is the same board), and the window's board with archived cards in short.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import type { BoardNotice } from '../src/main/boardStore'

const base = tempDir('hive-board-store-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { openDb, schemaVersion } = await import('../src/main/db')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  store.boardTestHooks.refuseRename = null
})

/** A workspace with a project `p`, and the cards' files from before 0.9 given (`files`: name → text). */
function workspaceWith(files: Record<string, string> = {}): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
  writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const tasksDir = join(ws, '.hive', 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tasksDir, name), text)
  return ws
}
async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const card = (num: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ number: num, title: `Card ${num}`, description: `About ${num}`, project: 'p', agent: null, column: 'todo', order: num, labels: [], blocked: null, blockedBy: [], links: [], comments: [{ at: '2026-10-01T00:00:00.000Z', by: 'You', text: `Note ${num}`, id: `c${num}` }], history: [], archived: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z', ...fields })
const fileOf = (c: Record<string, unknown>): string => JSON.stringify(c, null, 2) + '\n'
const hiveFolders = (ws: string): string[] => readdirSync(join(ws, '.hive')).sort()

describe('the database layer (db.ts)', () => {
  it('opens with WAL and its settings, runs each step once, recorded with the version that ran it', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    const db = openDb(file, { migrations: steps, hiveVersion: '9.9.9' })
    try {
      expect((db.writer.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      expect((db.writer.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1)
      expect((db.writer.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
      expect(db.writer.prepare('SELECT version, name, hive_version FROM schema_version').all()).toEqual([{ version: 1, name: 'one', hive_version: '9.9.9' }])
      // The reader only reads.
      expect(() => db.reader.exec('INSERT INTO a VALUES (1)')).toThrow()
    } finally {
      db.close()
    }
    // A second step later: only it runs, after a copy of the file kept in the backup folder.
    const backups = join(base, `layer-${n}`, 'backups')
    const two = openDb(file, { migrations: [...steps, { version: 2, name: 'two', up: (d) => d.exec('CREATE TABLE b (y)') }], hiveVersion: '9.9.10', backupDir: backups })
    try {
      expect(schemaVersion(two.writer)).toBe(2)
      expect(readdirSync(backups).filter((f) => f.startsWith('hive-v1-'))).toHaveLength(1)
    } finally {
      two.close()
    }
  })

  it('a file from a newer Hive opens read-only, migrated not at all', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    openDb(file, { migrations: steps, hiveVersion: '1' }).close()
    const raw = new DatabaseSync(file)
    raw.exec("INSERT INTO schema_version VALUES (7, 'from the future', '', '2.0.0')")
    raw.close()
    const db = openDb(file, { migrations: steps, hiveVersion: '1' })
    try {
      expect(db.newer).toBe(7)
      expect(() => db.writer.exec('INSERT INTO a VALUES (1)')).toThrow()
    } finally {
      db.close()
    }
  })
})

describe("moving the cards' files in (#1017)", () => {
  it('imports every card file once, as its text was, skipping backups, temp files and damaged files; keeps the folder as a backup and leaves a stub', async () => {
    const files = {
      '1.json': fileOf(card(1, { custom: { kept: true } })),
      '2.json': fileOf(card(2, { column: 'done', archived: true, archivedFor: 'user' })),
      '3.json': '{ not json',
      '1.json.before-ids.bak': fileOf(card(1, { title: 'old copy' })),
      '1.json.123-4.tmp': '{ "half": ',
      'board.json': JSON.stringify({ version: 1, next: 40 }),
      'archive-batches.json': JSON.stringify({ version: 1, batches: [{ id: 'b1', at: '2026-10-02T00:00:00.000Z', by: 'You', label: 'All in Done', cards: [2], columns: { done: [2] } }] })
    }
    const ws = workspaceWith(files)
    const notices: BoardNotice[] = []
    store.onBoardNotice((_p, x) => notices.push(x))
    const w = await open(ws)
    const all = await inWorkspace(w, () => tasks.allTasks(w))
    expect(all.map((c) => c.number)).toEqual([1, 2])
    // Every field kept, the ones this Hive doesn't know too.
    expect(store.cardDoc(w, 1)).toEqual(card(1, { custom: { kept: true } }))
    expect(await inWorkspace(w, () => tasks.archiveBatches(w))).toEqual([expect.objectContaining({ id: 'b1', cards: [2] })])
    // The next number is board.json's: a new card never takes one used before.
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'New', project: 'p' }, user))).number).toBe(40)
    // The folder kept as it was, under its backup name; the stub has the next number and a README.
    const kept = hiveFolders(ws).find((f) => f.startsWith('tasks.imported-'))!
    expect(readdirSync(join(ws, '.hive', kept)).sort()).toEqual(Object.keys(files).sort())
    expect(readFileSync(join(ws, '.hive', kept, '1.json'), 'utf8')).toBe(files['1.json'])
    expect(readdirSync(join(ws, '.hive', 'tasks')).sort()).toEqual(['README.txt', 'board.json'])
    expect(notices).toEqual([{ kind: 'imported', cards: 2, damaged: ['3.json'], folder: kept }])
    // The import is recorded; opening again imports nothing (the stub has no cards).
    await disposeWorkspaceService(w)
    const again = await open(ws)
    expect((await inWorkspace(again, () => tasks.allTasks(again))).map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 40])
    expect(hiveFolders(ws).filter((f) => f.startsWith('tasks.'))).toEqual([kept])
    // Closed, the stub's next number is the board's (an older Hive opening it never reuses one).
    await disposeWorkspaceService(again)
    expect(JSON.parse(readFileSync(join(ws, '.hive', 'tasks', 'board.json'), 'utf8')).next).toBe(41)
  })

  it('a folder Windows refuses to rename is renamed at the next open; the cards are in the database meanwhile, imported once', async () => {
    const ws = workspaceWith({ '5.json': fileOf(card(5)) })
    store.boardTestHooks.refuseRename = () => true
    const w = await open(ws)
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.number)).toEqual([5])
    expect(existsSync(join(ws, '.hive', 'tasks', '5.json'))).toBe(true)
    await inWorkspace(w, () => tasks.updateTask(5, { title: 'Changed since' }, user))
    await disposeWorkspaceService(w)
    store.boardTestHooks.refuseRename = null
    const again = await open(ws)
    // Not imported again (the change made meanwhile is kept), and the folder has its backup name now.
    expect((await inWorkspace(again, () => tasks.getTask(5, again))).title).toBe('Changed since')
    expect(hiveFolders(ws).some((f) => f.startsWith('tasks.imported-'))).toBe(true)
    expect(readdirSync(join(ws, '.hive', 'tasks')).sort()).toEqual(['README.txt', 'board.json'])
  })

  it("a new workspace's board starts empty, with a stub and no backup folder", async () => {
    const ws = workspaceWith()
    const w = await open(ws)
    expect(await inWorkspace(w, () => tasks.allTasks(w))).toEqual([])
    expect(hiveFolders(ws).filter((f) => f.startsWith('tasks'))).toEqual(['tasks'])
  })
})

describe("cards an older Hive saved meanwhile (#1017 downgrade, Darren's decision of 17 Oct: none taken back on its own)", () => {
  /** A workspace moved to the board (its board opened once and closed), and the stub an older Hive writes in. */
  async function moved(files: Record<string, string>): Promise<{ ws: string; stub: string }> {
    const ws = workspaceWith(files)
    const w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    await disposeWorkspaceService(w)
    return { ws, stub: join(ws, '.hive', 'tasks') }
  }
  const older = (num: number, fields: Record<string, unknown> = {}) => fileOf(card(num, { createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', ...fields }))
  const titlesOf = async (w: WS): Promise<string[]> => (await inWorkspace(w, () => tasks.allTasks(w))).map((c) => `#${c.number} ${c.title}`).sort()
  const asideIn = (ws: string): string[] => (existsSync(join(ws, '.hive', store.SET_ASIDE)) ? readdirSync(join(ws, '.hive', store.SET_ASIDE)).sort() : [])
  const asideText = (ws: string, f: string): string => readFileSync(join(ws, '.hive', store.SET_ASIDE, f), 'utf8')
  /** Opens the workspace, reads its board and gives the notices it told. */
  async function openTold(ws: string): Promise<{ w: WS; notices: BoardNotice[] }> {
    const notices: BoardNotice[] = []
    store.onBoardNotice((_p, x) => notices.push(x))
    const w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    return { w, notices }
  }

  it('a card with a free number is set aside intact, not added; the stub is emptied and its number never given to a new card', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)), 'board.json': JSON.stringify({ version: 1, next: 2 }) })
    const free = older(2, { title: 'Made in rc.3', links: [1] })
    writeFileSync(join(stub, '2.json'), free)
    const { w, notices } = await openTold(ws)
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
    expect(asideIn(ws)).toEqual(['2.json'])
    expect(asideText(ws, '2.json')).toBe(free)
    expect(readdirSync(stub).sort()).toEqual(['README.txt', 'board.json'])
    expect(notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number).toBe(3)
  })

  it('a card whose number the board has is set aside intact: the board and its links unchanged, one notice', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1, { title: 'On the board' })), '5.json': fileOf(card(5, { links: [1] })) })
    const clash = older(1, { title: 'Made in rc.3 as #1', links: [5] })
    writeFileSync(join(stub, '1.json'), clash)
    writeFileSync(join(stub, '6.json'), older(6, { title: 'Free beside it' }))
    const { w, notices } = await openTold(ws)
    expect(await titlesOf(w)).toEqual(['#1 On the board', '#5 Card 5'])
    expect(store.cardDoc(w, 5)!.links).toEqual([1])
    expect(asideIn(ws)).toEqual(['1.json', '6.json'])
    expect(asideText(ws, '1.json')).toBe(clash)
    expect(notices).toEqual([{ kind: 'setAside', cards: 2, folder: store.SET_ASIDE }])
  })

  it('the same file again (it couldn\'t leave the stub, or came back) is set aside once and told once', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)) })
    const same = older(2, { title: 'Made in rc.3' })
    writeFileSync(join(stub, '2.json'), same)
    let { w, notices } = await openTold(ws)
    expect(notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    await disposeWorkspaceService(w)
    // The very same file in the stub again.
    writeFileSync(join(stub, '2.json'), same)
    ;({ w, notices } = await openTold(ws))
    expect(asideIn(ws)).toEqual(['2.json'])
    expect(notices).toEqual([])
    expect(readdirSync(stub).sort()).toEqual(['README.txt', 'board.json'])
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
  })

  it('different content under a name set aside before is kept beside it under a name of its own, never over it', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)) })
    const first = older(2, { title: 'Made in rc.3' })
    writeFileSync(join(stub, '2.json'), first)
    let { w } = await openTold(ws)
    await disposeWorkspaceService(w)
    const second = older(2, { title: 'Made in rc.3, edited', updatedAt: '2026-10-06T00:00:00.000Z' })
    writeFileSync(join(stub, '2.json'), second)
    const told = await openTold(ws)
    w = told.w
    expect(told.notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    const files = asideIn(ws)
    expect(files).toHaveLength(2)
    expect(asideText(ws, '2.json')).toBe(first)
    expect(files.filter((f) => f !== '2.json').map((f) => asideText(ws, f))).toEqual([second])
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
  })
})

describe('numbers an older Hive could take (#1017 round 1)', () => {
  it("the stub's next number moves on as each number is taken, before Hive closes (ended without closing, an older Hive never reuses one)", async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)) })
    const w = await open(ws)
    const made = await inWorkspace(w, () => tasks.createTask({ title: 'Made in 0.9', project: 'p' }, user))
    // Read while the board is open: nothing has closed it.
    expect(JSON.parse(readFileSync(join(ws, '.hive', 'tasks', 'board.json'), 'utf8')).next).toBe(made.number + 1)
  })

  it("a damaged card file's number is never given to another card, moving in or back (as before 0.9)", async () => {
    // No board.json: the next number comes from the files, the damaged one's too.
    const ws = workspaceWith({ '1.json': fileOf(card(1)), '2.json': '{ damaged' })
    let w = await open(ws)
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'p' }, user))).number).toBe(3)
    await disposeWorkspaceService(w)
    // A damaged file an older Hive left in the stub: its number is past the board's, and kept from new cards.
    writeFileSync(join(ws, '.hive', 'tasks', '9.json'), '{ damaged too')
    w = await open(ws)
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number).toBe(10)
  })
})

describe('Export Board to JSON (#1017)', () => {
  it("writes each card as its file was before 0.9; read back into another workspace, it is the same board, the Agent API's JSON byte for byte", async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1, { custom: 'mine' })), '2.json': fileOf(card(2, { column: 'done', archived: true })), 'board.json': JSON.stringify({ version: 1, next: 9 }) })
    const w = await open(ws)
    await inWorkspace(w, () => tasks.commentTask(1, 'after the move', user))
    const out = join(base, `export-${++n}`)
    expect(await store.exportBoard(w, out)).toBe(2)
    expect(readdirSync(out).sort()).toEqual(['1.json', '2.json', 'board.json'])
    expect(JSON.parse(readFileSync(join(out, '1.json'), 'utf8'))).toEqual(store.cardDoc(w, 1))
    expect(JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')).next).toBe(9)
    // The export as an older Hive's board folder, opened by this one: the same cards.
    const copy = workspaceWith(Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), 'utf8')])))
    // Its project the same project (its id with it), as a workspace copied whole would have it.
    writeFileSync(join(copy, 'p', '.hive', 'project.json'), readFileSync(join(ws, 'p', '.hive', 'project.json')))
    const w2 = await open(copy)
    expect(JSON.stringify(await inWorkspace(w2, () => tasks.allTasks(w2)))).toBe(JSON.stringify(await inWorkspace(w, () => tasks.allTasks(w))))
  })
})

describe("the window's board (#1017)", () => {
  it('has archived cards in short unless asked for them in full; what agents read is unchanged', async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)), '2.json': fileOf(card(2, { column: 'done', archived: true, archivedFor: 'user', archivedBatch: 'b9', labels: ['x'] })) })
    const w = await open(ws)
    const short = await inWorkspace(w, () => tasks.windowTasks(w))
    const live = short.find((c) => c.number === 1)!
    const archived = short.find((c) => c.number === 2)!
    expect(live.summary).toBeUndefined()
    expect(live.description).toBe('About 1')
    expect(archived).toMatchObject({ summary: true, archived: true, title: 'Card 2', column: 'done', archivedFor: 'user', archivedBatch: 'b9', labels: ['x'], description: '', comments: [], history: [] })
    const full = await inWorkspace(w, () => tasks.windowTasks(w, true))
    expect(full.find((c) => c.number === 2)).toMatchObject({ description: 'About 2', comments: [expect.objectContaining({ text: 'Note 2' })] })
    expect(full.some((c) => c.summary)).toBe(false)
    // The Agent API's reads (listTasks, getTask) never carry the window's short form.
    expect((await inWorkspace(w, () => tasks.listTasks({ archived: true })))[0].summary).toBeUndefined()
    expect(JSON.stringify(await inWorkspace(w, () => tasks.getTask(2, w)))).toBe(JSON.stringify(full.find((c) => c.number === 2)))
  })
})

describe('a board saved by a newer Hive (#1017)', () => {
  it('reads its cards but refuses every change, saying why', async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)) })
    let w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    await disposeWorkspaceService(w)
    const raw = new DatabaseSync(store.boardFile(ws))
    raw.exec("INSERT INTO schema_version VALUES (99, 'from the future', '', '9.0.0')")
    raw.close()
    w = await open(ws)
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.number)).toEqual([1])
    await expect(inWorkspace(w, () => tasks.createTask({ title: 'No', project: 'p' }, user))).rejects.toThrow(/saved by a newer version of Hive/)
  })
})
