// The workspace's small stores as its database keeps them (#1018: lanes, watches, deliveries in .hive/hive.db), read by
// the suites that checked their files before: a read-only connection, opened and closed for each read.
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

/** A store's entries, in order (what its file's array held); [] while the workspace has no database yet. */
function storeDocs(ws, store, scope = '') {
  const file = path.join(ws, '.hive', 'hive.db')
  if (!fs.existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_rows'").get()) return []
    return db.prepare('SELECT doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord').all(store, scope).map((r) => JSON.parse(r.doc))
  } finally {
    db.close()
  }
}

/** Where a session host's deliveries are kept: its workspace's database, under its project's id (the Assistant's under `assistant`). */
function deliveriesPlace(host) {
  const h = path.resolve(host)
  const parent = path.dirname(h)
  if (path.basename(h).toLowerCase() === 'assistant' && path.basename(parent).toLowerCase() === '.hive') return { ws: path.dirname(parent), scope: 'assistant' }
  let id = null
  try {
    id = JSON.parse(fs.readFileSync(path.join(h, '.hive', 'project.json'), 'utf8')).id
  } catch {
    // No project.json: kept under the folder's name.
  }
  return { ws: parent, scope: typeof id === 'string' && id ? id : `folder:${path.basename(h).toLowerCase()}` }
}

/** A session host's deliveries, in order. */
function deliveriesOf(host) {
  const p = deliveriesPlace(host)
  return storeDocs(p.ws, 'deliveries', p.scope)
}

/** A value kept beside a store's entries (deliveries' `next`), parsed; undefined when there is none. */
function storeMeta(ws, store, key, scope = '') {
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { readOnly: true, timeout: 5000 })
  try {
    const r = db.prepare('SELECT value FROM store_meta WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key)
    return r ? JSON.parse(r.value) : undefined
  } finally {
    db.close()
  }
}

/**
 * Saves one entry of a store as Hive would (a suite's stand-in for editing its file by hand): in its place if it is
 * there, else last; `meta` values set beside it (JSON-encoded here). In one transaction.
 */
function putStoreDoc(ws, store, key, doc, { scope = '', meta = {} } = {}) {
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
  try {
    db.exec('BEGIN IMMEDIATE')
    const had = db.prepare('SELECT ord FROM store_rows WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key)
    const ord = had ? had.ord : (db.prepare('SELECT coalesce(max(ord), -1) + 1 AS o FROM store_rows WHERE store = ? AND scope = ?').get(store, scope).o)
    db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc').run(store, scope, key, ord, JSON.stringify(doc))
    for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, k, JSON.stringify(v))
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}

module.exports = { storeDocs, storeMeta, putStoreDoc, deliveriesPlace, deliveriesOf }
