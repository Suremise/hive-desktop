// Project Settings → Storage: which files Clean Up… removes, and how sizes read.
import { describe, expect, it } from 'vitest'
import { formatSize, planCleanup, type CleanupFacts, type CleanupSession } from '../src/shared/storage'
import type { CleanupOptions } from '../src/shared/types'

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-02T12:00:00Z')
const ago = (days: number): string => new Date(now - days * DAY).toISOString()
const session = (id: string, patch: Partial<CleanupSession> = {}): CleanupSession => ({
  id,
  name: `Session ${id}`,
  archived: true,
  lastActiveAt: ago(200),
  running: false,
  inCli: true,
  backups: [{ path: `P/.hive/archive/${id}.jsonl`, bytes: 1000 }],
  ...patch
})
const facts = (sessions: CleanupSession[], images: string[] = [], live: string[] = []): CleanupFacts => ({
  sessions,
  imageFolders: images.map((name) => ({ name, path: `P/.hive/images/${name}`, bytes: 500 })),
  liveNames: new Set(live),
  now
})
const NONE: CleanupOptions = { archivedImagesDays: null, orphanImages: false, archivedBackupsDays: null, goneBackups: false }

describe('Clean Up', () => {
  it('removes images of archived sessions older than N days only', () => {
    const f = facts([session('old'), session('young', { lastActiveAt: ago(10) }), session('open', { archived: false }), session('busy', { running: true })], ['old', 'young', 'open', 'busy'])
    expect(planCleanup(f, { ...NONE, archivedImagesDays: 90 }).map((i) => [i.kind, i.sessionId])).toEqual([['archived-images', 'old']])
    expect(planCleanup(f, { ...NONE, archivedImagesDays: 5 }).map((i) => i.sessionId)).toEqual(['old', 'young'])
    expect(planCleanup(f, NONE)).toEqual([])
  })

  it("removes images of deleted sessions and of launches that never got an id, never a running one's", () => {
    const f = facts([session('kept')], ['kept', 'deleted-1', 'run-abc', 'run-live', 'live-id'], ['run-live', 'live-id'])
    const items = planCleanup(f, { ...NONE, orphanImages: true })
    expect(items.map((i) => i.path)).toEqual(['P/.hive/images/deleted-1', 'P/.hive/images/run-abc'])
    expect(items.every((i) => i.kind === 'orphan-images')).toBe(true)
  })

  it("keeps old backups apart from last copies: N days only takes backups the CLI still has", () => {
    const f = facts([session('cli'), session('gone', { inCli: false }), session('recent', { lastActiveAt: ago(3) }), session('open', { archived: false }), session('busy', { running: true, inCli: false })])
    expect(planCleanup(f, { ...NONE, archivedBackupsDays: 90 }).map((i) => [i.kind, i.sessionId])).toEqual([['archived-backup', 'cli']])
    expect(planCleanup(f, { ...NONE, goneBackups: true }).map((i) => [i.kind, i.sessionId])).toEqual([['gone-backup', 'gone']])
  })

  it('lists every copy of a session (an active backup next to the archived one)', () => {
    const two = session('two', { backups: [{ path: 'P/.hive/sessions/two.jsonl', bytes: 10 }, { path: 'P/.hive/archive/two.jsonl', bytes: 20 }] })
    const items = planCleanup(facts([two]), { ...NONE, archivedBackupsDays: 1 })
    expect(items.map((i) => i.bytes)).toEqual([10, 20])
    expect(planCleanup(facts([session('none', { backups: [] })]), { ...NONE, archivedBackupsDays: 1, goneBackups: true })).toEqual([])
  })
})

describe('formatSize', () => {
  it('reads KB, MB and GB', () => {
    expect(formatSize(0)).toBe('0 KB')
    expect(formatSize(300)).toBe('1 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatSize(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })
})
