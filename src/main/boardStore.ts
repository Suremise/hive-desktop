import { AsyncLocalStorage } from 'async_hooks'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'original-fs'
import { mkdir, writeFile } from 'original-fs/promises'
import { join } from 'path'
import type { StatementSync } from 'node:sqlite'
import { app } from 'electron'
import { HIVE_DIR } from '../shared/defaults'
import { msg } from '../shared/i18n'
import type { ArchiveBatch } from '../shared/types'
import { openDb, type Db, type Migration } from './db'
import { emit } from './events'
import { withFileLock } from './fsutil'
import { trash } from './trash'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('board')

/**
 * The workspace's task board in SQLite (#1017, design on the card): `.hive/hive.db`, one row a card. Each row keeps the
 * card as the JSON document its file held (`doc`), so every reader builds the same card from it as before (the Agent
 * API's JSON unchanged), with columns generated from the document for queries. Every write goes through `boardWrite`:
 * the board's lock, one transaction, and one `tasks-changed` after it commits. A later migration can move comments,
 * history, decisions and links into tables of their own: only this module reads or writes rows.
 */

export const DB_FILE = 'hive.db'
/** The folder the cards' files were in before (#1017), and what an older Hive still looks at. */
const TASKS = 'tasks'

/** The board's schema, step by step (db.ts runs the steps a file hasn't had). */
export const BOARD_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'cards',
    up: (db) =>
      db.exec(`
        CREATE TABLE cards (
          number     INTEGER PRIMARY KEY,
          doc        TEXT NOT NULL,
          project    TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.project'))   STORED,
          project_id TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.projectId')) STORED,
          col        TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.column'))    STORED,
          ord        REAL    GENERATED ALWAYS AS (json_extract(doc, '$.order'))     STORED,
          agent      TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.agent'))     STORED,
          archived   INTEGER GENERATED ALWAYS AS (coalesce(json_extract(doc, '$.archived') = 1, 0)) STORED,
          updated_at TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.updatedAt')) STORED
        );
        CREATE INDEX cards_place ON cards(archived, col, ord);
        CREATE INDEX cards_project ON cards(project_id, archived);
        CREATE INDEX cards_agent ON cards(agent) WHERE agent IS NOT NULL;
        CREATE INDEX cards_updated ON cards(updated_at);
        CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE archive_batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, doc TEXT NOT NULL) STRICT;
      `)
  }
]

/** What the import from files recorded (board_meta `imported`). */
interface Imported {
  at: string
  cards: number
  damaged: string[]
  hiveVersion: string
  /** The folder the files were moved to, as a backup. */
  folder: string
  /** The files' folder couldn't be renamed yet (held open): tried again at the next open. */
  pendingRename?: boolean
}

interface Board {
  /** The workspace folder, as the workspace has it. */
  path: string
  db: Db
  /** Statements made once. */
  get: StatementSync
  put: StatementSync
  version: StatementSync
  /** The writer's data_version when last looked at: another process's commit changes it (#1017's poll). */
  dataVersion: number
  poll: NodeJS.Timeout
}

const boards = new Map<string, Board>()

/** For tests: a card whose save fails (as a full disk would); a folder Windows won't rename (something has a file in it open). */
export const boardTestHooks: { failPut: ((n: number) => boolean) | null; refuseRename: ((from: string) => boolean) | null } = { failPut: null, refuseRename: null }
const keyOf = (path: string): string => path.toLowerCase()

/** What the board tells the user about the import (index.ts shows it as a notice). */
export type BoardNotice = { kind: 'imported'; cards: number; damaged: string[]; folder: string } | { kind: 'setAside'; cards: number; folder: string }
let notify: (path: string, n: BoardNotice) => void = () => undefined
export function onBoardNotice(fn: (path: string, n: BoardNotice) => void): void {
  notify = fn
}

const M = {
  noWorkspace: msg({ id: 'board.error.noWorkspace', defaultMessage: 'No workspace is open', description: 'An error: the task board needs an open workspace, and there is none.' }),
  newer: msg({ id: 'board.error.newer', defaultMessage: 'This board was saved by a newer version of Hive. It is shown read-only: update Hive to change it.', description: "An error: the workspace's task board was saved by a newer Hive, whose format this version doesn't know; cards can be read but not changed." }),
  unavailable: msg({ id: 'board.error.unavailable', defaultMessage: "The board couldn't be opened: {error}", description: "An error: the workspace's task board database couldn't be opened or its cards couldn't be moved into it; {error} says why (from the system, often in English). Nothing was lost: the cards are still where they were." })
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** The README left in the cards' old folder for anyone (or any older Hive) looking there. */
const README = [
  'The task board moved to .hive/hive.db in Hive 0.9 (#1017).', // i18n-ignore: a file left for people and older Hive versions, in English
  'An older Hive opening this workspace shows an empty board; cards it adds here are set aside in .hive/tasks.set-aside when Hive 0.9 or later opens again, for you to review.', // i18n-ignore: as above
  'To use the board in an older Hive, use Export Board to JSON in Hive 0.9 and copy the exported files into this folder, with Hive closed.', // i18n-ignore: as above
  ''
].join('\r\n')

/** The stub of the old folder: the next number (so an older Hive never reuses one) and the README. */
function writeStub(hive: string, next: number): void {
  const dir = join(hive, TASKS)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ version: 1, next }, null, 2) + '\n')
    if (!existsSync(join(dir, 'README.txt'))) writeFileSync(join(dir, 'README.txt'), README)
  } catch (e) {
    log.warn('writing the board folder for older versions', e)
  }
}

/** Moves the stub's next number on (an older Hive never takes one this board has used), if the stub is there. */
function writeStubNext(hive: string, next: number): void {
  const file = join(hive, TASKS, 'board.json')
  if (!existsSync(join(hive, TASKS))) return
  try {
    writeFileSync(file, JSON.stringify({ version: 1, next }, null, 2) + '\n')
  } catch (e) {
    log.warn('moving on the next number older versions read', e)
  }
}

/** The highest card number among card files' names, damaged files' too: none of them is ever given to another card. */
const highestName = (names: string[]): number => names.reduce((m, f) => Math.max(m, Number(f.slice(0, -5)) || 0), 0)

const cardFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
}

/** A card file's content, parsed: null when it isn't a card (not JSON, or not an object). */
function parseCard(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const meta = (db: Db['writer'], key: string): string | null => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null // i18n-ignore: SQL
const setMeta = (db: Db['writer'], key: string, value: string): void => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value) // i18n-ignore: SQL

/** The next card number: past the one kept and every card's. */
function nextOf(db: Db['writer']): number {
  const saved = Number(meta(db, 'next')) || 1
  const highest = (db.prepare('SELECT max(number) AS m FROM cards').get() as { m: number | null }).m ?? 0 // i18n-ignore: SQL
  return Math.max(saved, highest + 1)
}

/** Renames a folder, retried a few times at once (Windows refuses while something has a file in it open); false if it never went. */
function renameNow(from: string, to: string): boolean {
  if (boardTestHooks.refuseRename?.(from)) return false
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(from, to)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break
    }
  }
  return false
}

/**
 * Moves the cards' files into a new database (#1017), once, in one transaction: every `<n>.json` (never .bak, .tmp or
 * anything else) as its text was, board.json's next number and the archive batches. Checked before it commits: as many
 * rows as card files read, each with its file's number, column and archived. A file that isn't a card is left where it
 * is (in the backup folder after the move) and named. Then the folder becomes `tasks.imported-<time>`, kept as a backup,
 * and a stub takes its place for older versions.
 */
function importFiles(b: Board, hive: string, hiveVersion: string): void {
  const db = b.db.writer
  const dir = join(hive, TASKS)
  const names = cardFiles(dir)
  const cards: { n: number; doc: Record<string, unknown> }[] = []
  const damaged: string[] = []
  for (const f of names) {
    const doc = parseCard(join(dir, f))
    if (doc) cards.push({ n: Number(f.slice(0, -5)), doc })
    else damaged.push(f)
  }
  const board = readJsonFile<{ next?: unknown }>(join(dir, 'board.json'), {})
  const batches = readJsonFile<{ batches?: unknown }>(join(dir, 'archive-batches.json'), {})
  const folder = `${TASKS}.imported-${stamp()}`
  const t0 = performance.now()
  const record: Imported = { at: new Date().toISOString(), cards: cards.length, damaged, hiveVersion, folder, pendingRename: names.length > 0 || existsSync(join(dir, 'board.json')) || existsSync(join(dir, 'archive-batches.json')) }
  db.exec('BEGIN IMMEDIATE')
  try {
    const put = db.prepare('INSERT INTO cards (number, doc) VALUES (?, ?)') // i18n-ignore: SQL
    for (const c of cards) put.run(c.n, JSON.stringify(c.doc))
    // Past every card file's number, a damaged one's too (it is kept, and may be mended): as the old allocator was.
    setMeta(db, 'next', String(Math.max(Number(board.next) || 1, highestName(names) + 1)))
    const ins = db.prepare('INSERT OR IGNORE INTO archive_batches (id, doc) VALUES (?, ?)') // i18n-ignore: SQL
    if (Array.isArray(batches.batches)) for (const x of batches.batches) if (x && typeof x === 'object' && typeof (x as ArchiveBatch).id === 'string') ins.run((x as ArchiveBatch).id, JSON.stringify(x))
    // Checked before it commits: every card read is there, as its file had it.
    const rows = db.prepare('SELECT number, col, archived FROM cards').all() as { number: number; col: unknown; archived: number }[] // i18n-ignore: SQL
    if (rows.length !== cards.length) throw new Error(`${rows.length} cards in the database, ${cards.length} card files read`) // i18n-ignore: an internal check's error, logged and quoted as the reason in board.error.unavailable
    const byN = new Map(rows.map((r) => [r.number, r]))
    for (const c of cards) {
      const r = byN.get(c.n)
      const col = typeof c.doc.column === 'string' ? c.doc.column : null
      if (!r || (r.col ?? null) !== col || r.archived !== (c.doc.archived === true ? 1 : 0)) throw new Error(`card #${c.n} isn't in the database as its file has it`) // i18n-ignore: an internal check's error, logged and quoted as the reason in board.error.unavailable
    }
    setMeta(db, 'imported', JSON.stringify(record))
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
  log.info(`moved ${cards.length} card(s) from ${userText(dir)} into ${DB_FILE} in ${Math.round(performance.now() - t0)} ms${damaged.length ? `; ${damaged.length} file(s) that aren't cards left in the folder: ${damaged.join(', ')}` : ''}`)
  if (cards.length || damaged.length) notify(b.path, { kind: 'imported', cards: cards.length, damaged, folder })
  finishMove(b, hive, record)
}

/** Renames the old folder to its backup name and leaves the stub (or, refused, tries again at the next open). */
function finishMove(b: Board, hive: string, record: Imported): void {
  const dir = join(hive, TASKS)
  if (record.pendingRename && existsSync(dir)) {
    if (!renameNow(dir, join(hive, record.folder))) {
      log.warn(`couldn't rename ${userText(dir)} to ${record.folder} (held open): tried again at the next open`)
      return
    }
    log.info(`the card files are kept in ${userText(join(hive, record.folder))}`)
  }
  if (record.pendingRename) setMeta(b.db.writer, 'imported', JSON.stringify({ ...record, pendingRename: false }))
  writeStub(hive, nextOf(b.db.writer))
}

/** Where cards an older Hive saved in the stub are set aside, intact, for the user to review (Darren, 17 Oct). */
export const SET_ASIDE = `${TASKS}.set-aside`

/**
 * Card files an older Hive saved in the stub folder (#1017's downgrade; Darren's decision, 17 Oct): after the move to the
 * database nothing is taken back on its own. Every `<n>.json` found there is set aside, intact, in `.hive/tasks.set-aside`,
 * free number or not, and the user is told once ("n cards made by an older Hive were found: review them"; the review to
 * add or discard them is #1044). Each file goes once: one whose very content is set aside already isn't kept twice, and
 * another file of the same name is kept beside it under a name of its own. A copy is made before the file leaves the
 * stub, so a file Windows won't let go of (or Hive ending part way) is only removed at a later open. Their numbers are
 * never given to new cards.
 */
function setAsideStub(b: Board, hive: string): void {
  const dir = join(hive, TASKS)
  const names = cardFiles(dir)
  if (!names.length) return
  const db = b.db.writer
  // Numbers given from here are past every file's in the stub, and the older Hive's own next number.
  const board = readJsonFile<{ next?: unknown }>(join(dir, 'board.json'), {})
  setMeta(db, 'next', String(Math.max(nextOf(db), Number(board.next) || 1, highestName(names) + 1)))
  const aside = join(hive, SET_ASIDE)
  mkdirSync(aside, { recursive: true })
  const kept = new Set(readdirSync(aside).map((f) => readFileSync(join(aside, f), 'utf8')))
  let found = 0
  for (const f of names) {
    let text: string
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch (e) {
      log.warn(`couldn't read ${f} in ${userText(dir)}: tried again at the next open`, e)
      continue
    }
    if (!kept.has(text)) {
      const to = existsSync(join(aside, f)) ? `${f.slice(0, -5)}.${stamp()}-${found}.json` : f
      writeFileSync(join(aside, to), text)
      kept.add(text)
      found++
    }
    try {
      rmSync(join(dir, f))
    } catch (e) {
      log.warn(`couldn't remove ${f} from ${userText(dir)} (its copy is in ${SET_ASIDE}): tried again at the next open`, e)
    }
  }
  if (found) {
    log.info(`${found} card file(s) an older Hive saved in ${userText(dir)} set aside in ${SET_ASIDE}`)
    notify(b.path, { kind: 'setAside', cards: found, folder: SET_ASIDE })
  }
  writeStub(hive, nextOf(db))
}

/** A set-aside file's name as setAsideStub gives it: `<n>.json`, or `<n>.<time>-<i>.json` beside one of that name. */
const SET_ASIDE_NAME = /^(\d+)(?:\.[0-9TZ-]+)?\.json$/
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The files set aside in `.hive/tasks.set-aside` (#1044), oldest number first: each one's name, the number its name
 * gives and its text (null when it can't be read). One already added to the board (its content recorded as added, its
 * file not moved yet: Windows held it) isn't listed, and goes to the Recycle Bin now.
 */
export function setAsideFiles(ws: WorkspaceService): { file: string; number: number; text: string | null }[] {
  if (!ws.path) return []
  const dir = join(ws.path, HIVE_DIR, SET_ASIDE)
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => SET_ASIDE_NAME.test(f))
  } catch {
    return []
  }
  const b = boardOf(ws.path)
  const added = new Set<string>(JSON.parse(meta(b.db.writer, 'setAsideAdded') ?? '[]') as string[])
  const out: { file: string; number: number; text: string | null }[] = []
  for (const file of names) {
    let text: string | null = null
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch (e) {
      log.warn(`couldn't read ${file} in ${SET_ASIDE}`, e)
    }
    if (text !== null && added.has(textHash(text))) {
      removeAdded(dir, file)
      continue
    }
    out.push({ file, number: Number(SET_ASIDE_NAME.exec(file)![1]), text })
  }
  return out.sort((a, c) => a.number - c.number || (a.file < c.file ? -1 : 1))
}

/** The path of a set-aside file named by the window: only a name of the folder's own form, never a path out of it. */
export function setAsideFile(ws: WorkspaceService, file: string): string | null {
  if (!ws.path || !SET_ASIDE_NAME.test(file)) return null
  const p = join(ws.path, HIVE_DIR, SET_ASIDE, file)
  return existsSync(p) ? p : null
}

/**
 * A set-aside file's card was added to the board (inside boardWrite): its content is recorded as added in the same
 * transaction, so it is never listed or added again, and its file moved to the Recycle Bin once the change commits (or,
 * held, at the next listing).
 */
export function setAsideAdded(ws: WorkspaceService, file: string, text: string): void {
  writeOp(ws, (b) => {
    const db = b.db.writer
    const added = new Set<string>(JSON.parse(meta(db, 'setAsideAdded') ?? '[]') as string[])
    added.add(textHash(text))
    setMeta(db, 'setAsideAdded', JSON.stringify([...added]))
  })
  const dir = join(ws.path!, HIVE_DIR, SET_ASIDE)
  afterBoardWrite(ws, () => removeAdded(dir, file))
}

/** A set-aside file whose card is on the board goes to the Recycle Bin (#1044 round 1): the older Hive's copy stays recoverable. */
function removeAdded(dir: string, file: string): void {
  const p = join(dir, file)
  // Once: a listing while its move is under way leaves it to that move.
  if (removing.has(p)) return
  removing.add(p)
  trash(p)
    .catch((e) => log.warn(`couldn't move ${file} from ${SET_ASIDE} to the Recycle Bin (its card is on the board): tried again later`, e))
    .finally(() => removing.delete(p))
}
const removing = new Set<string>()

const hiveVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** Why a workspace's board couldn't be opened (its import failed): every use says so, and nothing was moved. */
const failures = new Map<string, Error>()

/**
 * The workspace's board, opened (and moved in from its files, the first time) when first used. Synchronous, so nothing
 * reads the board before its cards are in. Throws when it couldn't be opened, saying why; the cards' files are then
 * as they were.
 */
function boardOf(path: string): Board {
  const key = keyOf(path)
  const open = boards.get(key)
  if (open) return open
  const failed = failures.get(key)
  if (failed) throw hiveError(M.unavailable, { error: failed.message }, { kind: 'conflict' })
  const hive = join(path, HIVE_DIR)
  let db: Db | null = null
  try {
    db = openDb(join(hive, DB_FILE), { migrations: BOARD_MIGRATIONS, hiveVersion: hiveVersion(), backupDir: join(hive, 'backups') })
    const w = db.writer
    const b: Board = {
      path,
      db,
      get: db.reader.prepare('SELECT doc FROM cards WHERE number = ?'), // i18n-ignore: SQL
      put: w.prepare('INSERT INTO cards (number, doc) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET doc = excluded.doc'), // i18n-ignore: SQL
      version: w.prepare('PRAGMA data_version'), // i18n-ignore: SQL
      dataVersion: 0,
      poll: setInterval(() => pollOther(key), POLL_MS)
    }
    b.poll.unref?.()
    if (db.newer === null) {
      const raw = meta(w, 'imported')
      const imported = raw ? (JSON.parse(raw) as Imported) : null
      if (!imported) importFiles(b, hive, hiveVersion())
      else if (imported.pendingRename) finishMove(b, hive, imported)
      else setAsideStub(b, hive)
    }
    b.dataVersion = (b.version.get() as { data_version: number }).data_version
    boards.set(key, b)
    return b
  } catch (e) {
    db?.close()
    const err = e instanceof Error ? e : new Error(String(e))
    failures.set(key, err)
    log.error(`opening the board of ${userText(path)}`, e)
    throw hiveError(M.unavailable, { error: err.message }, { kind: 'conflict' })
  }
}

/** How often each open board looks for another process's changes (a dev Hive, a script on the same workspace). */
export const POLL_MS = 1000

/** Another connection (another process) committed: the board is told, once. Hive's own writes don't change the writer's data_version. */
function pollOther(key: string): void {
  const b = boards.get(key)
  if (!b) return
  try {
    const v = (b.version.get() as { data_version: number }).data_version
    if (v === b.dataVersion) return
    b.dataVersion = v
    emit({ type: 'tasks-changed', workspacePath: b.path })
  } catch (e) {
    log.warn('looking for changes to the board', e)
  }
}

/** Closes a workspace's board (it closed): the stub's next number brought up to date for older versions. */
export function closeBoard(path: string): void {
  const key = keyOf(path)
  failures.delete(key)
  const b = boards.get(key)
  if (!b) return
  boards.delete(key)
  clearInterval(b.poll)
  try {
    if (b.db.newer === null && existsSync(join(path, HIVE_DIR, TASKS))) writeStub(join(path, HIVE_DIR), nextOf(b.db.writer))
  } catch (e) {
    log.warn('bringing the board folder up to date', e)
  }
  b.db.close()
}

/** Closes every board (Hive quits). */
export function closeAllBoards(): void {
  for (const b of [...boards.values()]) closeBoard(b.path)
}

// ---------------------------------------------------------------------------
// Writes: one at a time per board, each one transaction, told once.
// ---------------------------------------------------------------------------

/** The write running here: its board, whether it is still open, whether it changed anything. */
const writing = new AsyncLocalStorage<WriteState>()

/** A board change under way: its board, whether it is still open, whether it changed anything, what runs once it commits, and why it can't commit. */
interface WriteState {
  key: string
  open: boolean
  changed: boolean
  after: (() => void)[]
  /** SQLite undid its transaction part way (a full disk, an I/O error, #1017 round 1): nothing more is written, and the change fails. */
  lost: Error | null
}

/** The error a change gets once SQLite has undone its transaction part way. */
const lostChange = (cause?: unknown): Error =>
  new Error(`The board's change was undone part way (${cause instanceof Error ? cause.message : 'its transaction ended'}): nothing of it was saved`) // i18n-ignore: an error from SQLite's side, shown as the reason a change failed like a system error

/** The workspace folder, or the error a board change gives without one. */
function pathOf(ws: WorkspaceService): string {
  if (!ws.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
  return ws.path
}

/** Whether this code runs inside a write to `ws`'s board (its reads then see the write's own changes). */
const inWrite = (key: string): boolean => {
  const w = writing.getStore()
  return !!w && w.open && w.key === key
}

/**
 * A change of the board: under the board's lock (one change at a time, for every window), in one transaction (all of it
 * or none: a failure or a crash part way leaves the board as it was), and told once (`tasks-changed`) after it commits
 * when it changed anything. Re-entrant: a change inside another (a card of a batch) is part of it. Reads inside it see
 * its own changes; reads elsewhere see the board as last committed.
 */
export async function boardWrite<T>(ws: WorkspaceService, fn: () => Promise<T>): Promise<T> {
  const path = pathOf(ws)
  const key = keyOf(path)
  if (inWrite(key)) return fn()
  return withFileLock(`board-lock:${path}`, async () => {
    const b = boardOf(path)
    if (b.db.newer !== null) throw hiveError(M.newer, undefined, { kind: 'conflict' })
    const state: WriteState = { key, open: true, changed: false, after: [], lost: null }
    const db = b.db.writer
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = await writing.run(state, fn)
      if (!boards.has(key)) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
      // Undone part way, whatever the change made of the error meanwhile (a batch skips a card that fails): it fails whole.
      if (state.lost) throw state.lost
      if (!db.isTransaction) throw lostChange()
      db.exec('COMMIT')
      return out
    } catch (e) {
      state.changed = false
      state.after = []
      try {
        if (db.isTransaction) db.exec('ROLLBACK')
      } catch {
        // Closed meanwhile (the workspace closed): nothing was committed.
      }
      throw e
    } finally {
      state.open = false
      if (state.changed) emit({ type: 'tasks-changed', workspacePath: path })
      for (const then of state.after) {
        try {
          writing.exit(then)
        } catch (e) {
          log.warn('after a board change', e)
        }
      }
    }
  })
}

/**
 * Runs `fn` once the board change running here has committed (at once outside one; never if it is undone), outside it:
 * what it starts (a loop's wake, which reads the card) sees the change saved, and a board change it makes is one of its
 * own, waiting for the board's lock like any other.
 */
export function afterBoardWrite(ws: WorkspaceService, fn: () => void): void {
  const w = writing.getStore()
  if (ws.path && w && w.open && w.key === keyOf(ws.path)) w.after.push(fn)
  else writing.exit(fn)
}

/** Marks the write running here as a change (told after it commits); outside a write, tells the board now. */
export function boardChanged(ws: WorkspaceService): void {
  if (!ws.path) return
  const w = writing.getStore()
  if (w && w.open && w.key === keyOf(ws.path)) w.changed = true
  else emit({ type: 'tasks-changed', workspacePath: ws.path })
}

/** The connection a read uses: the write's own inside one, else the reader. */
function readConn(ws: WorkspaceService): { b: Board; db: Db['reader'] } {
  const path = pathOf(ws)
  const b = boardOf(path)
  return { b, db: inWrite(keyOf(path)) ? b.db.writer : b.db.reader }
}

/**
 * A write to the board, inside boardWrite only, and only while its transaction is live: once SQLite has undone it (an
 * error that rolls back the whole transaction), every later write of the change fails too, never going on in autocommit,
 * and the change fails whole as it ends.
 */
function writeOp<T>(ws: WorkspaceService, op: (b: Board) => T): T {
  const path = pathOf(ws)
  const state = writing.getStore()
  if (!state || !state.open || state.key !== keyOf(path)) throw new Error('A board write outside boardWrite') // i18n-ignore: a mistake in Hive's code, never shown
  const b = boardOf(path)
  if (state.lost) throw state.lost
  if (!b.db.writer.isTransaction) throw (state.lost = lostChange())
  try {
    return op(b)
  } catch (e) {
    if (!b.db.writer.isTransaction) state.lost = lostChange(e)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Reads and writes of cards (tasks.ts keeps every rule; this keeps the rows).
// ---------------------------------------------------------------------------

/** A card's document as saved, parsed; null when there is no such card. */
export function cardDoc(ws: WorkspaceService, n: number): Record<string, unknown> | null {
  const { b, db } = readConn(ws)
  const row = (db === b.db.reader ? b.get : db.prepare('SELECT doc FROM cards WHERE number = ?')).get(n) as { doc: string } | undefined // i18n-ignore: SQL
  return row ? (JSON.parse(row.doc) as Record<string, unknown>) : null
}

/** Whether there is a card of that number. */
export function hasCard(ws: WorkspaceService, n: number): boolean {
  const { db } = readConn(ws)
  return !!db.prepare('SELECT 1 FROM cards WHERE number = ?').get(n) // i18n-ignore: SQL
}

/** Every card number on the board. */
export function cardNumbers(ws: WorkspaceService): Set<number> {
  const { db } = readConn(ws)
  return new Set((db.prepare('SELECT number FROM cards').all() as { number: number }[]).map((r) => r.number)) // i18n-ignore: SQL
}

/** Which cards a query asks for: archived or not (both when left out), these numbers, given to one of these agents. */
export interface CardQuery {
  archived?: boolean
  numbers?: number[]
  agents?: string[]
}

/** Cards' documents, by number, as the query asks; in number order. */
export function cardDocs(ws: WorkspaceService, q: CardQuery = {}): { number: number; doc: Record<string, unknown> }[] {
  const { db } = readConn(ws)
  const where: string[] = []
  const args: (number | string)[] = []
  if (q.archived !== undefined) where.push(`archived = ${q.archived ? 1 : 0}`)
  if (q.numbers) {
    if (!q.numbers.length) return []
    where.push(`number IN (SELECT value FROM json_each(?))`) // i18n-ignore: SQL
    args.push(JSON.stringify(q.numbers))
  }
  if (q.agents) {
    if (!q.agents.length) return []
    where.push(`agent IN (SELECT value FROM json_each(?))`) // i18n-ignore: SQL
    args.push(JSON.stringify(q.agents))
  }
  const rows = db.prepare(`SELECT number, doc FROM cards${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY number`).all(...args) as { number: number; doc: string }[] // i18n-ignore: SQL
  return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
}

/**
 * The archived cards in short, for the window's board (#1017): title, place, agent, labels and dates, made in the query
 * (no document parsed here). The Archived view and a card's dialog read them in full.
 */
export function archivedSummaryDocs(ws: WorkspaceService): { number: number; doc: Record<string, unknown> }[] {
  const { db } = readConn(ws)
  const field = (k: string): string => `'${k}', doc -> '$.${k}'`
  const fields = ['title', 'project', 'projectId', 'agent', 'agentName', 'column', 'order', 'labels', 'blocked', 'archivedFor', 'archivedBatch', 'createdAt', 'createdBy', 'updatedAt'].map(field).join(', ')
  const rows = db.prepare(`SELECT number, json_object(${fields}, 'archived', json('true')) AS doc FROM cards WHERE archived = 1 ORDER BY number`).all() as { number: number; doc: string }[] // i18n-ignore: SQL
  return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
}

/** Each card's place fields, from the index (no document parsed): what placing a card needs (#458). */
export function cardPlaces(ws: WorkspaceService): { number: number; raw: { column: unknown; order: unknown; archived: boolean; project: unknown; projectId: unknown } }[] {
  const { db } = readConn(ws)
  const rows = db.prepare('SELECT number, col, ord, archived, project, project_id FROM cards').all() as { number: number; col: unknown; ord: unknown; archived: number; project: unknown; project_id: unknown }[] // i18n-ignore: SQL
  return rows.map((r) => ({ number: r.number, raw: { column: r.col, order: r.ord, archived: r.archived === 1, project: r.project, projectId: r.project_id } }))
}

/** How many archived cards each project has (the board's Archived count, without reading them). */
export function archivedCounts(ws: WorkspaceService): { project: string; count: number }[] {
  const { db } = readConn(ws)
  return (db.prepare("SELECT coalesce(project, '') AS project, count(*) AS count FROM cards WHERE archived = 1 GROUP BY project").all() as { project: string; count: number }[]).map((r) => ({ project: String(r.project), count: Number(r.count) })) // i18n-ignore: SQL
}


/** Saves a card's document (inside boardWrite). */
export function putCard(ws: WorkspaceService, n: number, doc: Record<string, unknown>): void {
  writeOp(ws, (b) => {
    if (boardTestHooks.failPut?.(n)) throw new Error(`SQLITE_FULL: database or disk is full (test, card #${n})`) // i18n-ignore: a test's stand-in for SQLite's error
    b.put.run(n, JSON.stringify(doc))
  })
}

/** Removes a card (inside boardWrite); false when there was none. */
export function deleteCard(ws: WorkspaceService, n: number): boolean {
  return writeOp(ws, (b) => Number(b.db.writer.prepare('DELETE FROM cards WHERE number = ?').run(n).changes) > 0) // i18n-ignore: SQL
}

/**
 * The next card number, taken (inside boardWrite): never one a card has or had. The stub an older Hive reads is moved past
 * it at once (#1017 round 1): after Hive is ended without closing, an older Hive still never gives a card a number this
 * board has used (a change undone leaves only a number unused, as the old allocator could).
 */
export function takeNumber(ws: WorkspaceService): number {
  return writeOp(ws, (b) => {
    const db = b.db.writer
    const n = nextOf(db)
    setMeta(db, 'next', String(n + 1))
    writeStubNext(join(b.path, HIVE_DIR), n + 1)
    return n
  })
}

/** The bulk archives kept, oldest first. */
export function archiveBatchDocs(ws: WorkspaceService): unknown[] {
  const { db } = readConn(ws)
  return (db.prepare('SELECT doc FROM archive_batches ORDER BY seq').all() as { doc: string }[]).map((r) => JSON.parse(r.doc) as unknown) // i18n-ignore: SQL
}

/** Replaces the bulk archives kept (inside boardWrite), oldest first. */
export function setArchiveBatches(ws: WorkspaceService, batches: ArchiveBatch[]): void {
  writeOp(ws, (b) => {
    const db = b.db.writer
    db.exec('DELETE FROM archive_batches')
    const ins = db.prepare('INSERT INTO archive_batches (id, doc) VALUES (?, ?)') // i18n-ignore: SQL
    for (const x of batches) ins.run(x.id, JSON.stringify(x))
  })
}

/** The board's file (for the log, diagnostics and tests). */
export const boardFile = (workspacePath: string): string => join(workspacePath, HIVE_DIR, DB_FILE)

/** Whether the board saved by a newer Hive is shown read-only. */
export const boardReadOnly = (ws: WorkspaceService): boolean => (ws.path ? boardOf(ws.path).db.newer !== null : false)

/**
 * Exports the board to plain files (Export Board to JSON): a folder with `<n>.json` for each card, exactly as the cards'
 * files were before 0.9 (so an older Hive can read them), with board.json and archive-batches.json. Returns how many cards.
 */
export async function exportBoard(ws: WorkspaceService, dir: string): Promise<number> {
  const docs = cardDocs(ws)
  const { db } = readConn(ws)
  const next = nextOf(db)
  const batches = archiveBatchDocs(ws)
  await mkdir(dir, { recursive: true })
  for (const { number, doc } of docs) await writeFile(join(dir, `${number}.json`), JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await writeFile(join(dir, 'board.json'), JSON.stringify({ version: 1, next }, null, 2) + '\n', 'utf8')
  if (batches.length) await writeFile(join(dir, 'archive-batches.json'), JSON.stringify({ version: 1, batches }, null, 2) + '\n', 'utf8')
  log.info(`exported ${docs.length} card(s) to ${userText(dir)}`)
  return docs.length
}
