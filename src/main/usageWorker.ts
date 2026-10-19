import { parentPort } from 'worker_threads'
import { open, stat } from 'original-fs/promises'
import { dirname, join } from 'path'
import type { AppSettings, SessionUsage } from '../shared/types'
import { keptRows, ledgerRows, summaryOf, type SessionHold } from '../shared/usageLedger'
import { openDb, type Db } from './db'
import { readAdvancedFrom, valuesReader } from './advancedValues'
import { cardRows, cursorOf, getMeta, sessionIds, setMeta, storedSessions, storedTimelines, touchSession, updateMeta, USAGE_MIGRATIONS, writeSession, type SessionMeta, type SessionWrite } from './usageDb'
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
}

export interface KeptJob extends SessionMeta {
  /** A kept usage (a deleted session's, or one whose transcript went): priced when it was kept. */
  usage: SessionUsage
  holds: SessionHold[]
}

export type IngestResult = { status: 'written' | 'unchanged' | 'missing' | 'kept' | 'busy'; requests?: number }

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

const tokenSum = (u: Pick<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens'>): number => u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens

/**
 * Records what a session used from its file: unchanged since it was read, nothing; else from where it was left (its
 * parser's saved state), or from the start (no state of this parser's shape and Hive's version, a file that shrank or is
 * another). What it read is recorded unless it would make the session's totals smaller than recorded (usage history is
 * only added to: a backup that lags the transcript it replaced, a rewritten file), which leaves the rows as they were.
 */
async function ingest(file: string, job: IngestJob): Promise<IngestResult> {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  const cur = cursorOf(db, job.scope, job.session)
  if (!job.path) return { status: cur ? 'unchanged' : 'missing' }
  let st
  try {
    st = await stat(job.path)
  } catch {
    return { status: cur ? 'unchanged' : 'missing' }
  }
  if (!st.isFile()) return { status: cur ? 'unchanged' : 'missing' }
  const samePath = !!cur?.path && cur.path.toLowerCase() === job.path.toLowerCase()
  if (cur && samePath && cur.size === st.size && cur.mtime === st.mtimeMs && cur.source !== 'kept') {
    updateMeta(db, job, job.external ? 'external' : 'transcript')
    return { status: 'unchanged' }
  }
  let parser: RawUsageParser | null = null
  let from = 0
  if (cur?.state && samePath && cur.stateOffset !== null && cur.stateOffset <= st.size && cur.stateVersion === hiveVersion && cur.stateShape) {
    parser = restoreParser(job.provider, job.session, cur.state, cur.stateShape)
    if (parser) from = cur.stateOffset
  }
  parser ??= newUsageParser(job.provider, job.session)
  if (!parser) return { status: cur ? 'unchanged' : 'missing' }
  let offset: number
  try {
    offset = await feed(job.path, parser, from, st.size)
  } catch (e) {
    log('warn', `usage history: couldn't read a transcript (${(e as Error).message})`, job.path)
    return { status: cur ? 'unchanged' : 'missing' }
  }
  const raw = parser.result()
  // Read again after the awaits: what another writer recorded meanwhile is checked in the write.
  const now = cursorOf(db, job.scope, job.session)
  if (now && (raw.requests < now.requests || tokenSum(raw) < now.tokens)) {
    touchSession(db, job.scope, job.session, job.path, st.size, st.mtimeMs)
    log('info', `usage history: ${job.session} read ${raw.requests} request(s), fewer than recorded (${now.requests}): kept as recorded`, job.path)
    return { status: 'kept', requests: now.requests }
  }
  const due = job.keepState === 'now' || (job.keepState === 'running' && (!now?.stateAt || Date.now() - Date.parse(now.stateAt) >= STATE_EVERY_MS))
  const timeline = raw.timeline ?? null
  const w: SessionWrite = {
    ...job,
    // An external session a record now has is Hive's; one recorded as Hive's stays so.
    source: job.external && (!now || now.source === 'external') ? 'external' : 'transcript',
    path: job.path,
    size: st.size,
    mtime: st.mtimeMs,
    offset,
    state: due ? { data: saveParser(parser), offset, shape: parserShape(parser), version: hiveVersion } : null,
    summary: summaryOf(raw),
    timeline,
    rows: ledgerRows(raw, job.holds, providers ? { providers } : null)
  }
  const ok = writeSession(db, w, now ? { offset: now.offset, path: now.path } : null)
  return { status: ok ? 'written' : 'busy', requests: raw.requests }
}

/** Records a kept usage, for a session the history doesn't have yet (one read from its transcript is never replaced). */
function kept(file: string, job: KeptJob): IngestResult {
  if (readOnly(file)) return { status: 'busy' }
  const db = dbOf(file).writer
  if (cursorOf(db, job.scope, job.session)) return { status: 'unchanged' }
  const w: SessionWrite = { ...job, source: 'kept', path: null, size: 0, mtime: 0, offset: 0, state: null, summary: summaryOf({ ...job.usage, lastPrompt: null }), timeline: null, rows: keptRows(job.usage, job.holds) }
  return { status: writeSession(db, w, null) ? 'written' : 'busy', requests: job.usage.requests }
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
    case 'forgetStates': {
      if (readOnly(m.file)) return 0
      const r = dbOf(m.file).writer.prepare('UPDATE usage_sessions SET state = NULL, state_offset = NULL, state_shape = NULL, state_version = NULL, state_at = NULL WHERE state IS NOT NULL AND updated_at < ?').run(m.before) // i18n-ignore: SQL
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
