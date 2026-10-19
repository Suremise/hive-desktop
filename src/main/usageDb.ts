import type { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import type { ProviderId } from '../shared/types'
import type { LedgerRow, UsageSummary } from '../shared/usageLedger'
import { readTimeline, type UsageTimeline } from '../shared/usageTimeline'
import { transaction, type Migration } from './db'

/**
 * The usage history's database (#1106): `.hive/usage.db`, beside the workspace's `hive.db`, under each session host's
 * scope (a project's id, `assistant` for the Assistant), as its session records are (#1061). Its own file, so the usage
 * worker's commits never wait on a board change held across awaits, never look like another process's change to the
 * board's poll, and an older Hive still opens `hive.db` for writing. Only the usage worker opens it (usageWorker.ts): it
 * writes, and answers main's queries. No Electron here: the worker can't load it.
 *
 * - `usage_sessions`: a row a session (`source`: read from its `transcript`, a `kept` usage imported from before, or an
 *   `external` session, started outside Hive: kept for the Sessions list, never counted in totals): who (provider,
 *   agent, name, folder), where it was read (`path`, the size and
 *   modified time read, the offset read to), the parser's saved state (`state` at `state_offset`, its shape and the Hive
 *   version that saved it), its summary (shared/usageLedger.ts UsageSummary) and its timeline (cost per lane).
 * - `usage_rows`: its rows (LedgerRow), keyed by session, day, model, card and role.
 * - `usage_meta`: per scope, or '' for the workspace (the backfill's record).
 */

export const USAGE_FILE = 'usage.db'
export const usageFile = (workspacePath: string): string => join(workspacePath, HIVE_DIR, USAGE_FILE)

export const USAGE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'usage',
    up: (db) =>
      db.exec(`
        CREATE TABLE usage_sessions (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          provider       TEXT NOT NULL,
          agent_id       TEXT,
          agent_name     TEXT,
          name           TEXT,
          cwd            TEXT,
          source         TEXT NOT NULL,
          path           TEXT,
          size           INTEGER NOT NULL DEFAULT 0,
          mtime          REAL NOT NULL DEFAULT 0,
          offset         INTEGER NOT NULL DEFAULT 0,
          state          BLOB,
          state_offset   INTEGER,
          state_shape    TEXT,
          state_version  TEXT,
          state_at       TEXT,
          summary        TEXT NOT NULL,
          timeline       TEXT,
          first_activity TEXT,
          last_activity  TEXT,
          updated_at     TEXT NOT NULL,
          PRIMARY KEY (scope, session)
        ) STRICT;
        CREATE TABLE usage_rows (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          day            TEXT NOT NULL,
          model          TEXT NOT NULL,
          card           INTEGER NOT NULL,
          role           TEXT NOT NULL,
          input          INTEGER NOT NULL,
          output         INTEGER NOT NULL,
          cache_write    INTEGER NOT NULL,
          cache_read     INTEGER NOT NULL,
          requests       INTEGER NOT NULL,
          prompts        INTEGER NOT NULL,
          compactions    INTEGER NOT NULL,
          fixed_usd      REAL NOT NULL,
          fixed_estimated INTEGER NOT NULL,
          covered_input  INTEGER NOT NULL,
          covered_output INTEGER NOT NULL,
          covered_cache_write INTEGER NOT NULL,
          covered_cache_read  INTEGER NOT NULL,
          tokens_unknown INTEGER NOT NULL,
          shared         INTEGER NOT NULL,
          PRIMARY KEY (scope, session, day, model, card, role)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX usage_rows_card ON usage_rows(card) WHERE card > 0;
        CREATE TABLE usage_meta (
          scope TEXT NOT NULL,
          key   TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (scope, key)
        ) STRICT, WITHOUT ROWID;
      `)
  }
]

/** Where a session was read: what an ingest compares the file with, and the state it takes up. */
export interface Cursor {
  path: string | null
  size: number
  mtime: number
  offset: number
  state: Uint8Array | null
  stateOffset: number | null
  stateShape: string | null
  stateVersion: string | null
  stateAt: string | null
  /** Its rows' requests and tokens, added up: an ingest never makes them fewer (usage history is only added to). */
  requests: number
  tokens: number
  source: string
}

export function cursorOf(db: DatabaseSync, scope: string, session: string): Cursor | null {
  const s = db.prepare('SELECT path, size, mtime, offset, state, state_offset, state_shape, state_version, state_at, source FROM usage_sessions WHERE scope = ? AND session = ?').get(scope, session) as Record<string, unknown> | undefined // i18n-ignore: SQL
  if (!s) return null
  const sums = db.prepare('SELECT coalesce(sum(requests), 0) AS q, coalesce(sum(input + output + cache_write + cache_read), 0) AS t FROM usage_rows WHERE scope = ? AND session = ?').get(scope, session) as { q: number; t: number } // i18n-ignore: SQL
  return {
    path: (s.path as string | null) ?? null,
    size: s.size as number,
    mtime: s.mtime as number,
    offset: s.offset as number,
    state: (s.state as Uint8Array | null) ?? null,
    stateOffset: (s.state_offset as number | null) ?? null,
    stateShape: (s.state_shape as string | null) ?? null,
    stateVersion: (s.state_version as string | null) ?? null,
    stateAt: (s.state_at as string | null) ?? null,
    requests: sums.q,
    tokens: sums.t,
    source: s.source as string
  }
}

/** Who a session was, as its record has it. */
export interface SessionMeta {
  scope: string
  session: string
  provider: ProviderId
  agentId?: string
  agentName?: string
  name?: string
  cwd?: string
}

/** What an ingest records of a session: its file and how far it was read, the parser's state when saved, and what it used. */
export interface SessionWrite extends SessionMeta {
  source: 'transcript' | 'kept' | 'external'
  path: string | null
  size: number
  mtime: number
  offset: number
  /** The parser's state to keep (null: keep the one saved, if any). */
  state: { data: Uint8Array; offset: number; shape: string; version: string } | null
  summary: UsageSummary
  timeline: UsageTimeline | null
  rows: LedgerRow[]
}

/**
 * Records a session: its rows replaced by these, its row in usage_sessions written, in one transaction. `expect`: the
 * offset it was read from as found then (null: not recorded yet); when another writer (another Hive on this workspace)
 * recorded it meanwhile, nothing is written and it says so (false), so a reader that started from an older point never
 * writes over a newer one.
 */
export function writeSession(db: DatabaseSync, w: SessionWrite, expect: { offset: number; path: string | null } | null): boolean {
  return transaction(db, () => {
    const now = db.prepare('SELECT offset, path FROM usage_sessions WHERE scope = ? AND session = ?').get(w.scope, w.session) as { offset: number; path: string | null } | undefined // i18n-ignore: SQL
    if (expect ? !now || now.offset !== expect.offset || now.path !== expect.path : !!now) return false
    db.prepare('DELETE FROM usage_rows WHERE scope = ? AND session = ?').run(w.scope, w.session) // i18n-ignore: SQL
    const put = db.prepare('INSERT INTO usage_rows (scope, session, day, model, card, role, input, output, cache_write, cache_read, requests, prompts, compactions, fixed_usd, fixed_estimated, covered_input, covered_output, covered_cache_write, covered_cache_read, tokens_unknown, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
    for (const r of w.rows) put.run(w.scope, w.session, r.day, r.model, r.card, r.role, r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.requests, r.prompts, r.compactions, r.fixedUsd, r.fixedEstimated ? 1 : 0, r.covered.inputTokens, r.covered.outputTokens, r.covered.cacheWriteTokens, r.covered.cacheReadTokens, r.tokensUnknown, r.shared ? 1 : 0)
    const at = new Date().toISOString()
    db.prepare(
      // i18n-ignore: SQL
      `INSERT INTO usage_sessions (scope, session, provider, agent_id, agent_name, name, cwd, source, path, size, mtime, offset, summary, timeline, first_activity, last_activity, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, session) DO UPDATE SET provider = excluded.provider, agent_id = excluded.agent_id, agent_name = excluded.agent_name, name = excluded.name, cwd = excluded.cwd,
         source = excluded.source, path = excluded.path, size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, summary = excluded.summary, timeline = excluded.timeline,
         first_activity = excluded.first_activity, last_activity = excluded.last_activity, updated_at = excluded.updated_at`
    ).run(w.scope, w.session, w.provider, w.agentId ?? null, w.agentName ?? null, w.name ?? null, w.cwd ?? null, w.source, w.path, w.size, w.mtime, w.offset, JSON.stringify(w.summary), w.timeline ? JSON.stringify(w.timeline) : null, w.summary.firstActivity, w.summary.lastActivity, at) // i18n-ignore: SQL
    if (w.state) db.prepare('UPDATE usage_sessions SET state = ?, state_offset = ?, state_shape = ?, state_version = ?, state_at = ? WHERE scope = ? AND session = ?').run(w.state.data, w.state.offset, w.state.shape, w.state.version, at, w.scope, w.session) // i18n-ignore: SQL
    return true
  })
}

/** Notes a session's file as read with nothing new (its size and time), so the next tick doesn't read it again. */
export function touchSession(db: DatabaseSync, scope: string, session: string, path: string, size: number, mtime: number): void {
  db.prepare('UPDATE usage_sessions SET path = ?, size = ?, mtime = ? WHERE scope = ? AND session = ?').run(path, size, mtime, scope, session) // i18n-ignore: SQL
}

/**
 * A session's who (agent, name, folder) brought up to date, its usage as it was: a record renamed, an agent renamed, a
 * session started outside Hive adopted (its source then `transcript`). Written only when it changed.
 */
export function updateMeta(db: DatabaseSync, m: SessionMeta, source: 'transcript' | 'external'): void {
  const v = [m.agentId ?? null, m.agentName ?? null, m.name ?? null, m.cwd ?? null]
  // An external session stays one only while no record has it: a record's job makes it Hive's.
  const src = source === 'transcript' ? "CASE WHEN source = 'external' THEN 'transcript' ELSE source END" : 'source' // i18n-ignore: SQL
  db.prepare(`UPDATE usage_sessions SET agent_id = ?, agent_name = ?, name = ?, cwd = ?, source = ${src} WHERE scope = ? AND session = ? AND (agent_id IS NOT ? OR agent_name IS NOT ? OR name IS NOT ? OR cwd IS NOT ? OR source <> ${src})`).run(...v, m.scope, m.session, ...v) // i18n-ignore: SQL
}

export function getMeta(db: DatabaseSync, scope: string, key: string): string | null {
  return ((db.prepare('SELECT value FROM usage_meta WHERE scope = ? AND key = ?').get(scope, key) as { value: string } | undefined)?.value ?? null) // i18n-ignore: SQL
}

export function setMeta(db: DatabaseSync, scope: string, key: string, value: string): void {
  db.prepare('INSERT INTO usage_meta (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value').run(scope, key, value) // i18n-ignore: SQL
}

// ---------------------------------------------------------------------------
// Reads (main's queries, answered by the worker).
// ---------------------------------------------------------------------------

/** A session as the history has it: who, its summary and its rows (not priced: main prices them with its settings). */
export interface StoredSession extends SessionMeta {
  source: string
  /** The file it was last read from, and its size and modified time then. */
  path: string | null
  size: number
  mtime: number
  summary: UsageSummary
  rows: LedgerRow[]
}

type RowRecord = Record<string, number | string>

const rowOf = (r: RowRecord): LedgerRow => ({
  day: r.day as string,
  model: r.model as string,
  card: r.card as number,
  role: r.role as LedgerRow['role'],
  inputTokens: r.input as number,
  outputTokens: r.output as number,
  cacheWriteTokens: r.cache_write as number,
  cacheReadTokens: r.cache_read as number,
  requests: r.requests as number,
  prompts: r.prompts as number,
  compactions: r.compactions as number,
  fixedUsd: r.fixed_usd as number,
  fixedEstimated: r.fixed_estimated === 1,
  covered: { inputTokens: r.covered_input as number, outputTokens: r.covered_output as number, cacheWriteTokens: r.covered_cache_write as number, cacheReadTokens: r.covered_cache_read as number },
  tokensUnknown: r.tokens_unknown as number,
  shared: r.shared === 1
})

const metaOf = (s: Record<string, unknown>): SessionMeta => ({
  scope: s.scope as string,
  session: s.session as string,
  provider: s.provider as ProviderId,
  ...(s.agent_id ? { agentId: s.agent_id as string } : {}),
  ...(s.agent_name ? { agentName: s.agent_name as string } : {}),
  ...(s.name ? { name: s.name as string } : {}),
  ...(s.cwd ? { cwd: s.cwd as string } : {})
})

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

/** The sessions of some scopes (all of them: null), with their rows. A summary that can't be read leaves its session out. */
export function storedSessions(db: DatabaseSync, scopes: string[] | null): StoredSession[] {
  const where = scopes ? `WHERE scope IN (${placeholders(scopes.length)})` : '' // i18n-ignore: SQL
  if (scopes && !scopes.length) return []
  const args = scopes ?? []
  const rows = new Map<string, LedgerRow[]>()
  for (const r of db.prepare(`SELECT * FROM usage_rows ${where}`).all(...args) as RowRecord[]) { // i18n-ignore: SQL
    const k = `${r.scope}\0${r.session}`
    const list = rows.get(k)
    if (list) list.push(rowOf(r))
    else rows.set(k, [rowOf(r)])
  }
  const out: StoredSession[] = []
  for (const s of db.prepare(`SELECT scope, session, provider, agent_id, agent_name, name, cwd, source, path, size, mtime, summary FROM usage_sessions ${where}`).all(...args) as Record<string, unknown>[]) { // i18n-ignore: SQL
    let summary: UsageSummary
    try {
      summary = JSON.parse(s.summary as string) as UsageSummary
    } catch {
      continue
    }
    out.push({ ...metaOf(s), source: s.source as string, path: (s.path as string | null) ?? null, size: s.size as number, mtime: s.mtime as number, summary, rows: rows.get(`${s.scope}\0${s.session}`) ?? [] })
  }
  return out
}

/** The rows on some cards (role and card kept), with whose session each is. */
export function cardRows(db: DatabaseSync, cards: number[]): (SessionMeta & { row: LedgerRow })[] {
  if (!cards.length) return []
  const rows = db.prepare(`SELECT r.*, s.provider, s.agent_id, s.agent_name, s.name, s.cwd FROM usage_rows r JOIN usage_sessions s ON s.scope = r.scope AND s.session = r.session WHERE r.card IN (${placeholders(cards.length)})`).all(...cards) as Record<string, unknown>[] // i18n-ignore: SQL
  return rows.map((r) => ({ ...metaOf(r), row: rowOf(r as RowRecord) }))
}

/** Sessions of a scope with their timelines (for spans of time no card has: a lane's), who each was and its summary. */
export function storedTimelines(db: DatabaseSync, scope: string): (SessionMeta & { summary: UsageSummary; timeline: UsageTimeline | null; firstActivity: string | null; lastActivity: string | null })[] {
  const out = []
  for (const s of db.prepare('SELECT scope, session, provider, agent_id, agent_name, name, cwd, summary, timeline, first_activity, last_activity FROM usage_sessions WHERE scope = ?').all(scope) as Record<string, unknown>[]) { // i18n-ignore: SQL
    let summary: UsageSummary
    let timeline: UsageTimeline | null = null
    try {
      summary = JSON.parse(s.summary as string) as UsageSummary
      if (s.timeline) timeline = readTimeline(JSON.parse(s.timeline as string))
    } catch {
      continue
    }
    out.push({ ...metaOf(s), summary, timeline, firstActivity: (s.first_activity as string | null) ?? null, lastActivity: (s.last_activity as string | null) ?? null })
  }
  return out
}

/** Which sessions of a scope the history has (and whether each was read from a transcript). */
export function sessionIds(db: DatabaseSync, scope: string): { session: string; source: string; path: string | null; size: number; mtime: number }[] {
  return db.prepare('SELECT session, source, path, size, mtime FROM usage_sessions WHERE scope = ?').all(scope) as { session: string; source: string; path: string | null; size: number; mtime: number }[] // i18n-ignore: SQL
}
