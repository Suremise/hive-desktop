import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync } from 'original-fs'
import { basename, dirname, join } from 'path'

/**
 * Hive's SQLite layer (#990, #1017): every database Hive keeps (the workspace's board in `.hive/hive.db`; later its metrics,
 * and the Assistant's journal in a file of its own, #989) is opened, set up and migrated here, with Node's built-in
 * `node:sqlite` (no native module to rebuild for each Electron). Nothing else imports `node:sqlite`, so another library
 * would be a change to this file only. Its calls are synchronous: at these sizes a query or a commit takes well under a
 * millisecond on main's thread.
 */

/** One step of a database's schema: run once, in its own transaction, in order of `version`. */
export interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

export interface OpenOptions {
  /** The schema's steps, in order. */
  migrations: Migration[]
  /** This Hive's version, recorded with each step it runs. */
  hiveVersion: string
  /** Where a copy of the file is kept before a step runs on one that has data (the last 3 are kept). */
  backupDir?: string
  /** The name its copies start with there (default: the file's name without `.db`), so databases sharing a folder keep their own three. */
  backupFamily?: string
  /**
   * Runs on each connection once it is set up, before any step: SQL functions the schema's triggers call (both
   * connections), and settings only a new file can take (`isNew`: no schema yet, e.g. `auto_vacuum`).
   */
  setup?: (db: DatabaseSync, isNew: boolean) => void
}

/** An open database: a writer and a reader connection to one file. */
export interface Db {
  file: string
  /** The connection every write goes through (one at a time: the caller's lock). */
  writer: DatabaseSync
  /** The connection queries use: it sees what was last committed, never a write still under way. */
  reader: DatabaseSync
  /** The schema version of a file saved by a newer Hive (opened read-only), else null. */
  newer: number | null
  close: () => void
}

/**
 * The settings every connection gets: WAL (readers never wait for the writer), `synchronous=NORMAL` (a crash of Hive loses
 * nothing committed; a power cut may lose the last commit or two, never the file), a wait for a lock held by another
 * process, and caches sized for a board of a few thousand cards.
 */
function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA cache_size = -8192')
  db.exec('PRAGMA mmap_size = 67108864')
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec('PRAGMA journal_size_limit = 67108864')
}

/** The newest schema version a file has (0: a new file). */
export function schemaVersion(db: DatabaseSync): number {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
  if (!has) return 0
  const row = db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number | null } | undefined
  return row?.v ?? 0
}

/** Whether a file has anything in it worth a copy before its schema changes. */
function hasData(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' LIMIT 1").get()
}

/** How many copies of a database `backupTo` keeps. */
export const BACKUPS_KEPT = 3

/** A copy's name, `<family>-v<version>-<ISO time with : and . as ->.db`: sorted by its time, whatever the version. */
const backupName = (family: string, version: number, at: Date): string => `${family}-v${version}-${at.toISOString().replace(/[:.]/g, '-')}.db`
/** What follows `<family>-v` in a copy's name: its version and time. */
const BACKUP_REST = /^\d+-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.db$/

/**
 * A copy of the file as it is (VACUUM INTO: consistent, synchronous), keeping the newest three of its family in `dir`
 * (#1039). Only names of the family's exact form count, so another database's copies, or anything else in the folder,
 * are never pruned.
 */
export function backupTo(db: DatabaseSync, dir: string, family: string, version: number, at = new Date()): string {
  mkdirSync(dir, { recursive: true })
  const name = backupName(family, version, at)
  const file = join(dir, name)
  rmSync(file, { force: true })
  db.prepare('VACUUM INTO ?').run(file)
  const prefix = `${family}-v`
  const kept = readdirSync(dir)
    .map((f) => ({ f, at: f.startsWith(prefix) ? BACKUP_REST.exec(f.slice(prefix.length))?.[1] : undefined }))
    .filter((c): c is { f: string; at: string } => !!c.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.f < b.f ? -1 : 1))
  for (const c of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) rmSync(join(dir, c.f), { force: true })
  return file
}

/** Runs `fn` in a transaction on `db` (BEGIN IMMEDIATE: the write lock at once), committed when it returns, undone when it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
}

/** Runs the steps the file hasn't had, each in its own transaction, after a copy of a file with data in it. */
function migrate(db: DatabaseSync, file: string, opts: OpenOptions): void {
  const from = schemaVersion(db)
  const todo = opts.migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  if (!todo.length) return
  if (opts.backupDir && from > 0 && hasData(db)) backupTo(db, opts.backupDir, opts.backupFamily ?? basename(file).replace(/\.db$/i, ''), from)
  transaction(db, () => db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, hive_version TEXT NOT NULL) STRICT'))
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at, hive_version) VALUES (?, ?, ?, ?)')
  for (const m of todo) {
    transaction(db, () => {
      m.up(db)
      record.run(m.version, m.name, new Date().toISOString(), opts.hiveVersion)
    })
  }
}

/**
 * Opens (or makes) a database file with its two connections, set up and migrated. A file saved by a newer Hive (a
 * schema version this build doesn't know) is opened read-only and migrated not at all: `newer` says its version, and
 * every write to it fails.
 */
export function openDb(file: string, opts: OpenOptions): Db {
  mkdirSync(dirname(file), { recursive: true })
  const writer = new DatabaseSync(file, { timeout: 5000 })
  let reader: DatabaseSync | null = null
  try {
    configure(writer)
    opts.setup?.(writer, schemaVersion(writer) === 0)
    const known = Math.max(0, ...opts.migrations.map((m) => m.version))
    const found = schemaVersion(writer)
    const newer = found > known ? found : null
    if (newer === null) migrate(writer, file, opts)
    else writer.exec('PRAGMA query_only = ON')
    reader = new DatabaseSync(file, { timeout: 5000 })
    configure(reader)
    opts.setup?.(reader, false)
    reader.exec('PRAGMA query_only = ON')
    const r = reader
    return {
      file,
      writer,
      reader: r,
      newer,
      close: () => {
        try {
          if (writer.isTransaction) writer.exec('ROLLBACK')
          if (newer === null) {
            writer.exec('PRAGMA optimize')
            writer.exec('PRAGMA wal_checkpoint(PASSIVE)')
          }
        } catch {
          // Closing anyway.
        }
        r.close()
        writer.close()
      }
    }
  } catch (e) {
    reader?.close()
    writer.close()
    throw e
  }
}
