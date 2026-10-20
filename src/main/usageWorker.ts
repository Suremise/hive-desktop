import { parentPort } from 'worker_threads'
import { createHash } from 'crypto'
import { open, stat } from 'original-fs/promises'
import { dirname, join } from 'path'
import type { AppSettings, SessionUsage } from '../shared/types'
import { applyBaseline, baselineOfRows, baselineOfUsage, dominates, ledgerRows, mergeBaselines, reshareRows, summaryOf, unknownOnCards, type SessionHold } from '../shared/usageLedger'
import { openDb, type Db } from './db'
import { readAdvancedFrom, valuesReader } from './advancedValues'
import type { DatabaseSync } from 'node:sqlite'
import { baselineOf, cardRows, cursorOf, getMeta, replaceRows, sessionIds, setMeta, storedSession, storedSessions, storedTimelines, updateMeta, USAGE_MIGRATIONS, writeSession, type SessionMeta, type SessionWrite } from './usageDb'
import { newUsageParser, parserShape, restoreParser, saveParser, type RawUsageParser } from './usageParsers'

/**
 * The usage worker (#1106): a thread of its own that keeps each workspace's usage history (usageDb.ts), so reading the
 * CLIs' transcripts never holds up Hive's main process. It reads only what a transcript added since it was last read,
 * taking up the parser's saved state; makes the session's rows (shared/usageLedger.ts) and writes them with its own
 * node:sqlite connection to `.hive/usage.db`, one short transaction a session (WAL: main and other readers never wait for
 * it; another Hive's worker on the same workspace waits up to db.ts's busy timeout, and a session it recorded meanwhile
 * is left as it wrote it). It answers main's queries on that file too, so main never opens it. Jobs run one at a time,
 * in the order main sends them (main keeps the queue and its priorities, usageHistory.ts); queries are answered at once,
 * between a job's reads. No Electron here (a worker can't load it): logs go to main.
 */

export interface IngestJob extends SessionMeta {
  /** The file to read (the CLI's transcript, or Hive's backup of it), as main found it; null when it has none. */
  path: string | null
  /** The cards the session's agent held (main works them out from the board). */
  holds: SessionHold[]
  /** Keep the parser's state now: the session ended, or main says it runs (then at most every few minutes). */
  keepState: 'now' | 'running' | 'no'
  /** A session started outside Hive (no record): kept for the Sessions list, never counted in totals. */
  external?: boolean
  /** The holds `holds` were made from, as a key (open ones as open): a change re-shares the session's cards. */
  holdsKey: string | null
}

export interface KeptJob extends SessionMeta {
  /** A kept usage (a deleted session's, or one whose transcript went): priced when it was kept. */
  usage: SessionUsage
  holds: SessionHold[]
  holdsKey: string | null
}

/** `failed`: the file is there (or that can't be told) but couldn't be read; `busy`: not written (another writer, a read-only file). */
export type IngestResult = { status: 'written' | 'unchanged' | 'missing' | 'kept' | 'busy' | 'failed'; requests?: number }

export type WorkerRequest = { id: number } & (
  | { type: 'config'; advanced: Record<string, unknown>; providers: AppSettings['providers']; hiveVersion: string }
  | { type: 'ingest'; file: string; job: IngestJob }
  | { type: 'kept'; file: string; job: KeptJob }
  | { type: 'sessions'; file: string; scopes: string[] | null }
  | { type: 'cards'; file: string; cards: number[] }
  | { type: 'timelines'; file: string; scope: string }
  | { type: 'ids'; file: string; scope: string }
  | { type: 'meta'; file: string; scope: string; key: string; value?: string }
  | { type: 'forgetStates'; file: string; before: string }
  | { type: 'attribute'; file: string; scope: string; sessions: { session: string; holds: SessionHold[]; holdsKey: string | null }[] }
  | { type: 'close'; file: string }
)

export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { log: 'info' | 'warn'; text: string; path?: string }

/** How much of a transcript is read at a time (a longer line: a bigger piece). */
const CHUNK = 4 * 1024 * 1024
/** How often a running session's parser state is kept (a crash then reads at most this much again). */
const STATE_EVERY_MS = 10 * 60_000

let providers: AppSettings['providers'] | null = null
let hiveVersion = '0.0.0'
const dbs = new Map<string, Db>()

function dbOf(file: string): Db {
  const key = file.toLowerCase()
  let db = dbs.get(key)
  if (!db) {
    db = openDb(file, { migrations: USAGE_MIGRATIONS, hiveVersion, backupDir: join(dirname(file), 'backups'), backupFamily: 'usage' })
    dbs.set(key, db)
  }
  return db
}

/** Closes every file it has open (its code run in main's thread, in unit tests: so a test can delete its folder). */
export function closeAll(): void {
  for (const db of dbs.values()) db.close()
  dbs.clear()
}

function close(file: string): void {
  const key = file.toLowerCase()
  dbs.get(key)?.close()
  dbs.delete(key)
}

const send = (m: WorkerReply): void => parentPort!.postMessage(m)
/** Where the log goes: to main (from the worker thread), or what main set (its code run in main's own thread, in unit tests). */
let logTo: (m: WorkerReply) => void = (m) => parentPort?.postMessage(m)
export const logInProcess = (fn: (m: WorkerReply) => void): void => {
  logTo = fn
}
const log = (level: 'info' | 'warn', text: string, path?: string): void => logTo({ log: level, text, ...(path ? { path } : {}) })

/** Feeds a file to a parser from `offset` to its end (whole lines only); returns where it stopped. */
async function feed(path: string, parser: RawUsageParser, from: number, size: number): Promise<number> {
  let offset = from
  if (size <= offset) return offset
  const fh = await open(path, 'r')
  try {
    let chunk = CHUNK
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - offset))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      // Whole lines only: a line still being written is read next time.
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (end < 0) {
        if (bytesRead === buf.length && offset + bytesRead < size) {
          chunk *= 2
          continue
        }
        break
      }
      parser.feed(buf.subarray(0, end + 1).toString('utf8'))
      offset += end + 1
      if (bytesRead < buf.length) break
    }
  } finally {
    await fh.close()
  }
  return offset
}

/** Files saved by a newer Hive (opened read-only, db.ts): nothing is written to them, said once each. */
const warnedNewer = new Set<string>()
function readOnly(file: string): boolean {
  const db = dbOf(file)
  if (db.newer === null) return false
  if (!warnedNewer.has(file.toLowerCase())) {
    warnedNewer.add(file.toLowerCase())
    log('warn', `usage history: saved by a newer Hive (schema ${db.newer}), so this one only reads it`, file)
  }
  return true
}

/** How much of a file just before a state's offset its check covers. */
const CHECK_BYTES = 4096

/** A hash of the bytes just before `offset` in a file (what a saved state was made from ends there); null when unreadable. */
async function bytesBefore(path: string, offset: number): Promise<string | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const n = Math.min(CHECK_BYTES, offset)
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, offset - n)
      return createHash('sha1').update(buf.subarray(0, bytesRead)).update(String(offset)).digest('hex')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * Records what a session used from its file: unchanged since it was read, nothing (its cards re-shared from what is stored
 * when their holds changed); else from where it was left (its parser's saved state, made from this file's bytes), or from
 * the start (no state of this parser's shape and Hive's version, a file that shrank or is another). Usage history is only
 * added to (#1106 round 3): what it read replaces the session's rows when it counts at least as much, every day, in each
 * count; when it doesn't (a backup that lags the transcript it replaced, a rewritten file), what the rows counted becomes
 * part of the session's baseline, which no write goes below, so both are kept. `failed`: the file couldn't be read (it
 * is there, or can't be told), so what is recorded may lack its end: a delete waits.
 */
async function ingest(file: string, job: IngestJob): Promise<IngestResult> {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  const cur = cursorOf(db, job.scope, job.session)
  const unchanged = (): IngestResult => {
    updateMeta(db, job, job.external ? 'external' : 'transcript')
    reshare(db, job, cur)
    return { status: 'unchanged' }
  }
  if (!job.path) return cur ? unchanged() : { status: 'missing' }
  let st
  try {
    st = await stat(job.path)
  } catch (e) {
    // Gone: what is recorded is all there is. Anything else (no permission, held, a disk error): not known.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return cur ? unchanged() : { status: 'missing' }
    log('warn', `usage history: couldn't look at a transcript (${(e as Error).message})`, job.path)
    return { status: 'failed' }
  }
  if (!st.isFile()) return cur ? unchanged() : { status: 'missing' }
  const samePath = !!cur?.path && cur.path.toLowerCase() === job.path.toLowerCase()
  if (cur && samePath && cur.size === st.size && cur.mtime === st.mtimeMs) return unchanged()
  let parser: RawUsageParser | null = null
  let from = 0
  // Taken up only for this file's bytes: the same path, at least as long, its bytes before the offset as they were (a file
  // that shrank and grew again between reads is another), by this Hive's parser.
  if (cur?.state && samePath && cur.stateOffset !== null && cur.stateOffset <= st.size && cur.stateVersion === hiveVersion && cur.stateShape && cur.stateCheck === (await bytesBefore(job.path, cur.stateOffset))) {
    parser = restoreParser(job.provider, job.session, cur.state, cur.stateShape)
    if (parser) from = cur.stateOffset
  }
  parser ??= newUsageParser(job.provider, job.session)
  if (!parser) return cur ? unchanged() : { status: 'missing' }
  let offset: number
  try {
    offset = await feed(job.path, parser, from, st.size)
  } catch (e) {
    log('warn', `usage history: couldn't read a transcript (${(e as Error).message})`, job.path)
    return { status: 'failed' }
  }
  const raw = parser.result()
  // Read again after the awaits: what another writer recorded meanwhile is checked in the write.
  const now = cursorOf(db, job.scope, job.session)
  const settings = providers ? { providers } : null
  const stored = now ? storedSession(db, job.scope, job.session) : null
  let baseline = now ? baselineOf(db, job.scope, job.session) : []
  const read = ledgerRows(raw, job.holds, settings)
  let rows = applyBaseline(read, baseline, job.provider, settings)
  let grew = false
  if (stored && !dominates(rows, stored.rows)) {
    // Less of something than recorded: what was recorded joins the baseline, and neither is lost.
    baseline = mergeBaselines(baseline, baselineOfRows(stored.rows, job.provider, settings))
    rows = applyBaseline(read, baseline, job.provider, settings)
    grew = true
    log('info', `usage history: ${job.session} read less of something than recorded: what was recorded is kept beside it`, job.path)
  }
  const due = job.keepState === 'now' || (job.keepState === 'running' && (!now?.stateAt || Date.now() - Date.parse(now.stateAt) >= STATE_EVERY_MS))
  const w: SessionWrite = {
    ...job,
    // An external session a record now has is Hive's; one recorded as Hive's stays so.
    source: job.external && (!now || now.source === 'external') ? 'external' : 'transcript',
    path: job.path,
    size: st.size,
    mtime: st.mtimeMs,
    offset,
    state: due ? { data: saveParser(parser), offset, shape: parserShape(parser), version: hiveVersion, check: (await bytesBefore(job.path, offset)) ?? '' } : from === 0 ? 'clear' : null,
    summary: summaryOf(raw),
    timeline: raw.timeline ?? null,
    rows,
    holdsKey: job.holdsKey,
    baseline: grew ? baseline : null
  }
  const ok = writeSession(db, w, now ? { offset: now.offset, path: now.path } : null)
  return { status: ok ? 'written' : 'busy', requests: raw.requests }
}

/** A recorded session's cards shared out again from what is stored, when the holds its rows were made by changed. */
function reshare(db: DatabaseSync, job: { scope: string; session: string; holds: SessionHold[]; holdsKey: string | null }, cur: { holdsKey: string | null } | null): boolean {
  if (!cur || cur.holdsKey === job.holdsKey) return false
  const s = storedSession(db, job.scope, job.session)
  if (!s) return false
  replaceRows(db, job.scope, job.session, reshareRows(s.summary, s.timeline, s.rows, job.holds, providers ? { providers } : null), job.holdsKey)
  return true
}

/**
 * Records a kept usage (a deleted session's, or a record's whose transcript went) as part of the session's baseline: its
 * rows (from its file, if it was read) never go below it, day by day, in each count, nor its known cost; a session the
 * history doesn't have yet is recorded from it alone. Nothing either counted is dropped for the other.
 */
function kept(file: string, job: KeptJob): IngestResult {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  const cur = cursorOf(db, job.scope, job.session)
  const settings = providers ? { providers } : null
  const baseline = mergeBaselines(cur ? baselineOf(db, job.scope, job.session) : [], baselineOfUsage(job.usage))
  if (cur) {
    const s = storedSession(db, job.scope, job.session)
    if (!s) return { status: 'busy' }
    const base = s.rows.filter((r) => r.role !== 'kept')
    // Without a timeline (kept usage alone), its cards' unknown parts as its holds have them now.
    const rows = applyBaseline(s.timeline?.rows.length ? base : base.filter((r) => r.card === 0), baseline, job.provider, settings)
    replaceRows(db, job.scope, job.session, s.timeline?.rows.length ? rows : [...rows, ...unknownOnCards(s.summary, job.holds)], job.holdsKey, baseline)
    return { status: 'written', requests: job.usage.requests }
  }
  const w: SessionWrite = { ...job, source: 'kept', path: null, size: 0, mtime: 0, offset: 0, state: 'clear', summary: summaryOf({ ...job.usage, lastPrompt: null }), timeline: null, rows: [...applyBaseline([], baseline, job.provider, settings), ...unknownOnCards(job.usage, job.holds)], holdsKey: job.holdsKey, baseline }
  return { status: writeSession(db, w, null) ? 'written' : 'busy', requests: job.usage.requests }
}

/**
 * Shares the cards of a scope's recorded sessions out again by their holds now, without reading a file (#1106 round 3):
 * stopped and deleted sessions too, each whose holds key changed. Main works the holds out per agent.
 */
function attribute(file: string, scope: string, sessions: { session: string; holds: SessionHold[]; holdsKey: string | null }[]): number {
  if (readOnly(file)) return 0
  const db = dbOf(file).writer
  let n = 0
  for (const s of sessions) if (reshare(db, { scope, ...s }, cursorOf(db, scope, s.session))) n++
  return n
}

/** Jobs one at a time; queries at once. (Exported for main to run it in its own thread in unit tests: usageHistory.ts.) */
let jobs: Promise<unknown> = Promise.resolve()

export async function handleRequest(m: WorkerRequest): Promise<unknown> {
  switch (m.type) {
    case 'config':
      readAdvancedFrom(valuesReader(m.advanced))
      providers = m.providers
      hiveVersion = m.hiveVersion
      return true
    case 'ingest':
    case 'kept': {
      const run = jobs.then(() => (m.type === 'ingest' ? ingest(m.file, m.job) : kept(m.file, m.job)))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'sessions':
      return storedSessions(dbOf(m.file).reader, m.scopes)
    case 'cards':
      return cardRows(dbOf(m.file).reader, m.cards)
    case 'timelines':
      return storedTimelines(dbOf(m.file).reader, m.scope)
    case 'ids':
      return sessionIds(dbOf(m.file).reader, m.scope)
    case 'meta': {
      const db = dbOf(m.file)
      if (m.value !== undefined && !readOnly(m.file)) setMeta(db.writer, m.scope, m.key, m.value)
      return getMeta(db.writer, m.scope, m.key)
    }
    case 'attribute': {
      const run = jobs.then(() => attribute(m.file, m.scope, m.sessions))
      jobs = run.catch(() => undefined)
      return run
    }
    case 'forgetStates': {
      if (readOnly(m.file)) return 0
      const r = dbOf(m.file).writer.prepare('UPDATE usage_sessions SET state = NULL, state_offset = NULL, state_shape = NULL, state_version = NULL, state_check = NULL, state_at = NULL WHERE state IS NOT NULL AND updated_at < ?').run(m.before) // i18n-ignore: SQL
      return Number(r.changes)
    }
    case 'close': {
      // After the jobs sent before it.
      const run = jobs.then(() => close(m.file))
      jobs = run.catch(() => undefined)
      return run
    }
  }
}

parentPort?.on('message', (m: WorkerRequest) => {
  handleRequest(m).then(
    (value) => send({ id: m.id, ok: true, value }),
    (e) => send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  )
})
