import { existsSync, renameSync } from 'original-fs'
import { resolve } from 'path'
import { boardLock, inBoardWrite, workspaceDb } from './boardStore'
import { transaction } from './db'
import { withFileLock } from './fsutil'
import { createLogger, userText } from './logger'

const log = createLogger('stores')

/**
 * The workspace's small stores in its database (#1018): lanes, watches and deliveries, each a row per entry in
 * `store_rows` (the board's `.hive/hive.db`, migration 2) with a few values of its own in `store_meta`. A store keeps its
 * entries in memory and its own lock as before; only where they are kept changed. A save is one transaction that writes
 * the rows that changed (no temp file, no rename: #990's EPERM class goes), under the board's lock, so it never runs
 * inside one of the board's transactions on their shared connection. Each store tells its own events, as before.
 *
 * `scope` keeps a store's entries apart where it has more than one set in a workspace (deliveries, a set per session
 * host); '' where it has one.
 */

export type StoreName = 'lanes' | 'watches' | 'deliveries'

/** A store's entries in order, each its key and its JSON document, with its values. */
export interface StoreData {
  rows: { key: string; doc: string }[]
  meta: Map<string, string>
}

/** For tests: a save that fails as it is written (a full disk). */
export const storeTestHooks: { failSave: ((store: StoreName, scope: string) => boolean) | null } = { failSave: null }

/** A store's entries and values as last committed. */
export function readStore(workspacePath: string, store: StoreName, scope = ''): StoreData {
  const db = workspaceDb(resolve(workspacePath)).reader
  const rows = db.prepare('SELECT key, doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord').all(store, scope) as { key: string; doc: string }[] // i18n-ignore: SQL
  const meta = new Map((db.prepare('SELECT key, value FROM store_meta WHERE store = ? AND scope = ?').all(store, scope) as { key: string; value: string }[]).map((r) => [r.key, r.value])) // i18n-ignore: SQL
  return { rows: rows.map((r) => ({ key: r.key, doc: r.doc })), meta }
}

/**
 * Saves a store's entries (all of them, in order) and the values given (null removes one), in one transaction: rows
 * whose document or place changed are written, rows not given removed. All of it or none. `guard` runs just before
 * the transaction, with nothing awaited between them: a store whose owner went away meanwhile (a closed workspace)
 * throws there, and nothing is written.
 */
export async function saveStore(workspacePath: string, store: StoreName, scope: string, rows: { key: string; doc: string }[], meta: Record<string, string | null> = {}, guard?: () => void): Promise<void> {
  const path = resolve(workspacePath)
  // Its lock is the board's: inside a board change it would wait for itself.
  if (inBoardWrite(path)) throw new Error(`The ${store} were saved inside a change of the board`) // i18n-ignore: a mistake in Hive's code, never shown
  await withFileLock(boardLock(path), async () => {
    guard?.()
    const db = workspaceDb(path).writer
    transaction(db, () => {
      const had = new Map((db.prepare('SELECT key, ord, doc FROM store_rows WHERE store = ? AND scope = ?').all(store, scope) as { key: string; ord: number; doc: string }[]).map((r) => [r.key, r])) // i18n-ignore: SQL
      const put = db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc') // i18n-ignore: SQL
      const keys = new Set<string>()
      rows.forEach((r, i) => {
        keys.add(r.key)
        const was = had.get(r.key)
        if (!was || was.ord !== i || was.doc !== r.doc) put.run(store, scope, r.key, i, r.doc)
      })
      const del = db.prepare('DELETE FROM store_rows WHERE store = ? AND scope = ? AND key = ?') // i18n-ignore: SQL
      for (const k of had.keys()) if (!keys.has(k)) del.run(store, scope, k)
      for (const [k, v] of Object.entries(meta)) setMeta(db, store, scope, k, v)
      if (storeTestHooks.failSave?.(store, scope)) throw new Error(`SQLITE_FULL: database or disk is full (test, ${store})`) // i18n-ignore: a test's stand-in for SQLite's error
    })
  })
}

function setMeta(db: ReturnType<typeof workspaceDb>['writer'], store: StoreName, scope: string, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM store_meta WHERE store = ? AND scope = ? AND key = ?').run(store, scope, key) // i18n-ignore: SQL
  else db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, key, value) // i18n-ignore: SQL
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** A store's file renamed to its backup name, `<file>.imported-<time>`; false when Windows refused (tried again at the next open). */
function keepAsBackup(file: string): boolean {
  const to = `${file}.imported-${stamp()}`
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(file, to)
      log.info(`${userText(file)} kept as ${userText(to)}`)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        log.warn(`keeping ${userText(file)} as a backup`, e)
        return false
      }
    }
  }
  log.warn(`couldn't rename ${userText(file)} (held open): tried again at the next open`)
  return false
}

/**
 * Opens a store, moving its file in the first time (#1018): `readFile` reads the file as the store always has (setting a
 * damaged or too-big one aside itself, null when there is none) and gives its entries; they go into the database in one
 * transaction with the mark that they did, and the file is then renamed `<file>.imported-<time>`, kept as a backup. A
 * file found there after that (a rename refused before, or one an older Hive wrote since) is renamed the same way and
 * not read again: the store's entries are the database's. Returns the store's entries.
 */
export async function openStore(workspacePath: string, store: StoreName, scope: string, file: string, readFile: () => Promise<{ rows: { key: string; doc: string }[]; meta?: Record<string, string> } | null>): Promise<StoreData> {
  const path = resolve(workspacePath)
  const first = !readStore(path, store, scope).meta.has('imported')
  if (first) {
    const got = await readFile()
    // Moved in under the lock, checked again there: a second open meanwhile moved it already.
    await withFileLock(boardLock(path), async () => {
      if (readStore(path, store, scope).meta.has('imported')) return
      const db = workspaceDb(path).writer
      transaction(db, () => {
        const put = db.prepare('INSERT OR REPLACE INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?)') // i18n-ignore: SQL
        got?.rows.forEach((r, i) => put.run(store, scope, r.key, i, r.doc))
        for (const [k, v] of Object.entries(got?.meta ?? {})) setMeta(db, store, scope, k, v)
        setMeta(db, store, scope, 'imported', JSON.stringify({ at: new Date().toISOString(), rows: got?.rows.length ?? 0, file: got ? file : null }))
      })
      if (got) log.info(`moved ${got.rows.length} ${store} entr${got.rows.length === 1 ? 'y' : 'ies'} from ${userText(file)} into the workspace database`)
    })
  }
  if (existsSync(file)) {
    if (!first) log.warn(`${userText(file)} was found after the ${store} moved into the workspace database (an older Hive's, or a rename refused before): kept as a backup, not read`)
    keepAsBackup(file)
  }
  return readStore(path, store, scope)
}
