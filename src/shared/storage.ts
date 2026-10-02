// What Hive keeps per project (Project Settings → Storage) and which of it Clean Up… may remove.
import type { CleanupItem, CleanupOptions } from './types'

const DAY = 24 * 60 * 60 * 1000

export const DEFAULT_CLEANUP: CleanupOptions = { archivedImagesDays: 90, orphanImages: false, archivedBackupsDays: null, goneBackups: false }

/** A size for Storage: "820 KB", "6.1 MB", "2.4 GB". */
export function formatSize(n: number): string {
  if (n < 1024 * 1024) return n === 0 ? '0 KB' : `${Math.max(1, Math.round(n / 1024))} KB`
  const mb = n / (1024 * 1024)
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}

/** One of a project's sessions, as Clean Up sees it. */
export interface CleanupSession {
  id: string
  name: string
  archived: boolean
  lastActiveAt: string
  /** Running now (never touched). */
  running: boolean
  /** The CLI (Claude Code, Codex) still has its transcript. */
  inCli: boolean
  /** Hive's backups of it (active and archived copies) and their sizes. */
  backups: { path: string; bytes: number }[]
}

export interface CleanupFacts {
  sessions: CleanupSession[]
  /** The folders in .hive/images: a session id, or run-<launch> for a launch that had no id yet. */
  imageFolders: { name: string; path: string; bytes: number }[]
  /** Session ids and run-<launch> names of what is running now. */
  liveNames: Set<string>
  now: number
}

/**
 * What Clean Up removes with these options: images of archived sessions last active more than N days ago, images of
 * sessions Hive no longer has (deleted, or launches that never got an id), Hive's backups of archived sessions older
 * than N days that the CLI still has, and the backups of archived sessions the CLI no longer has (which deletes them).
 * Running and non-archived sessions are never in it.
 */
export function planCleanup(facts: CleanupFacts, opts: CleanupOptions): CleanupItem[] {
  const items: CleanupItem[] = []
  const old = (s: CleanupSession, days: number): boolean => facts.now - Date.parse(s.lastActiveAt) > days * DAY
  const byId = new Map(facts.sessions.map((s) => [s.id.toLowerCase(), s]))
  const label = (s: CleanupSession): string => s.name || s.id.slice(0, 8)
  for (const f of facts.imageFolders) {
    if (facts.liveNames.has(f.name.toLowerCase())) continue
    const s = byId.get(f.name.toLowerCase())
    if (s) {
      if (!s.running && s.archived && opts.archivedImagesDays !== null && old(s, opts.archivedImagesDays)) items.push({ kind: 'archived-images', path: f.path, bytes: f.bytes, sessionId: s.id, label: label(s) })
    } else if (opts.orphanImages) items.push({ kind: 'orphan-images', path: f.path, bytes: f.bytes, label: /^run-/i.test(f.name) ? 'A launch that never got a session' : `Deleted session ${f.name.slice(0, 8)}` })
  }
  for (const s of facts.sessions) {
    if (s.running || !s.archived || !s.backups.length) continue
    if (s.inCli) {
      if (opts.archivedBackupsDays !== null && old(s, opts.archivedBackupsDays)) for (const b of s.backups) items.push({ kind: 'archived-backup', path: b.path, bytes: b.bytes, sessionId: s.id, label: label(s) })
    } else if (opts.goneBackups) for (const b of s.backups) items.push({ kind: 'gone-backup', path: b.path, bytes: b.bytes, sessionId: s.id, label: label(s) })
  }
  return items
}
