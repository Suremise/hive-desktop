// The journal browser's store calls (#1033): the timeline newest first with each row's links, every filter (all the
// search's words as prefixes, kinds, project or the workspace's own, source, dates), pages and the total, reading
// without making a journal, a kind edited within the scope, Forget deleting just what the search matched up to the
// count's newest id, and the windows told of each change.
import { existsSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { DEFAULT_JOURNAL, type JournalSettings } from '../src/shared/journal'

const base = tempDir('hive-journal-browse-')
const j = await import('../src/main/journal')

let n = 0
const homes: string[] = []
const home = (): string => {
  const h = join(base, `home-${++n}`)
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) j.closeJournal(h)
})
afterAll(() => j.closeAllJournals())

const all: JournalSettings = { ...DEFAULT_JOURNAL, scope: ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment'] }
const write = (h: string, input: Partial<Parameters<typeof j.writeEntry>[2]> & { summary: string }, source: 'assistant' | 'hive' = 'assistant') => j.writeEntry(h, all, { kind: 'decision', ...input }, source)
/** Sets entries' times (a test stands in for days passing). */
function at(h: string, times: Record<number, string>): void {
  j.closeJournal(h)
  const db = new DatabaseSync(j.journalFile(h))
  for (const [id, t] of Object.entries(times)) db.prepare('UPDATE entries SET at = ? WHERE id = ?').run(t, Number(id))
  db.close()
}
const summaries = (p: { rows: { summary: string }[] }): string[] => p.rows.map((r) => r.summary)

/** Five entries over three days, of two projects and the workspace, by both writers. */
function seeded(): string {
  const h = home()
  const a = write(h, { summary: 'Orange theme chosen', project: 'alpha', links: [{ type: 'card', ref: '#12' }, { type: 'commit', ref: 'abc123' }] })
  const b = write(h, { kind: 'plan', summary: 'Plan the orange markers', project: 'beta' })
  const c = write(h, { kind: 'event', summary: '#12 is Done', project: 'alpha', links: [{ type: 'card', ref: '12' }] }, 'hive')
  const d = write(h, { kind: 'insight', summary: 'Themes need contrast', detail: 'Orange text on white fails AA.' })
  const e = write(h, { kind: 'digest', summary: 'Week 42', digestOf: '2026-W42', importance: 2 })
  at(h, { [a]: '2026-10-14T10:00:00.000Z', [b]: '2026-10-15T10:00:00.000Z', [c]: '2026-10-16T09:00:00.000Z', [d]: '2026-10-16T12:00:00.000Z', [e]: '2026-10-13T08:00:00.000Z' })
  return h
}

describe('the timeline', () => {
  it('is newest first, with each row its links, the total and the newest id', () => {
    const h = seeded()
    const p = j.browseJournal(h, {})
    expect(summaries(p)).toEqual(['Themes need contrast', '#12 is Done', 'Plan the orange markers', 'Orange theme chosen', 'Week 42'])
    expect(p.total).toBe(5)
    expect(p.upTo).toBe(5)
    expect(p.rows[3].links).toEqual([{ type: 'card', ref: '12' }, { type: 'commit', ref: 'abc123' }])
    expect(p.rows[4]).toMatchObject({ kind: 'digest', digestOf: '2026-W42', importance: 2, source: 'assistant' })
    expect(p.rows[1].source).toBe('hive')
  })

  it('comes in pages, the total all of them', () => {
    const h = seeded()
    const first = j.browseJournal(h, {}, 0, 2)
    const next = j.browseJournal(h, {}, 2, 2)
    expect([...summaries(first), ...summaries(next)]).toEqual(['Themes need contrast', '#12 is Done', 'Plan the orange markers', 'Orange theme chosen'])
    expect(next.total).toBe(5)
  })

  it('reads nothing, and makes no journal, where there is none', () => {
    const h = home()
    expect(j.browseJournal(h, {})).toEqual({ rows: [], total: 0, upTo: 0 })
    expect(j.journalProjects(h)).toEqual([])
    expect(j.browseEntry(h, 1)).toBeNull()
    expect(j.forgetJournal(h, { query: 'x' }, 10)).toBe(0)
    expect(existsSync(j.journalFile(h))).toBe(false)
  })
})

describe('the filters', () => {
  it('search: every word must be found, each as a prefix, in the summary, detail or why', () => {
    const h = seeded()
    expect(summaries(j.browseJournal(h, { query: 'orange' }))).toEqual(['Themes need contrast', 'Plan the orange markers', 'Orange theme chosen'])
    expect(summaries(j.browseJournal(h, { query: 'orange them' }))).toEqual(['Themes need contrast', 'Orange theme chosen'])
    expect(j.browseJournal(h, { query: 'orange zebra' }).total).toBe(0)
    // Punctuation is no query syntax.
    expect(summaries(j.browseJournal(h, { query: '"orange" (theme*' }))).toEqual(['Themes need contrast', 'Orange theme chosen'])
  })

  it('kinds, project (or the workspace own), source and dates', () => {
    const h = seeded()
    expect(summaries(j.browseJournal(h, { kinds: ['plan', 'insight'] }))).toEqual(['Themes need contrast', 'Plan the orange markers'])
    expect(summaries(j.browseJournal(h, { kinds: ['digest'] }))).toEqual(['Week 42'])
    expect(summaries(j.browseJournal(h, { project: 'ALPHA' }))).toEqual(['#12 is Done', 'Orange theme chosen'])
    expect(summaries(j.browseJournal(h, { project: '' }))).toEqual(['Themes need contrast', 'Week 42'])
    expect(summaries(j.browseJournal(h, { source: 'hive' }))).toEqual(['#12 is Done'])
    expect(summaries(j.browseJournal(h, { since: '2026-10-15T00:00:00.000Z', until: '2026-10-16T10:00:00.000Z' }))).toEqual(['#12 is Done', 'Plan the orange markers'])
    expect(summaries(j.browseJournal(h, { query: 'orange', project: 'alpha', source: 'assistant' }))).toEqual(['Orange theme chosen'])
    expect(() => j.browseJournal(h, { since: 'yesterday-ish' })).toThrow(/since must be a date/)
    expect(j.journalProjects(h)).toEqual(['alpha', 'beta'])
  })

  it('superseded entries are shown (the browser marks them)', () => {
    const h = seeded()
    const newer = write(h, { summary: 'Amber theme chosen instead' })
    j.updateEntry(h, all, 1, { supersededBy: newer })
    expect(j.browseJournal(h, { query: 'orange theme' }).rows.find((r) => r.id === 1)?.supersededBy).toBe(newer)
  })
})

describe('editing', () => {
  it("changes an entry's kind, within the scope", () => {
    const h = seeded()
    expect(j.updateEntry(h, all, 4, { kind: 'decision', summary: 'Themes need AA contrast' })).toBe(true)
    expect(j.readEntry(h, 4)).toMatchObject({ kind: 'decision', summary: 'Themes need AA contrast' })
    expect(() => j.updateEntry(h, { ...all, scope: ['decision'] }, 4, { kind: 'moment' })).toThrow(/scope doesn't include moment/)
    expect(() => j.updateEntry(h, all, 4, { kind: 'gossip' })).toThrow(/kind is one of/)
    // A digest is always allowed.
    expect(j.updateEntry(h, { ...all, scope: [] }, 4, { kind: 'digest' })).toBe(true)
  })
})

describe('Forget everything about X', () => {
  it('deletes just what the search and filters matched, with their links and tags, and not what came after the count', () => {
    const h = seeded()
    const seen = j.browseJournal(h, { query: 'orange' })
    // Written after the user saw the count: it stays.
    write(h, { summary: 'Orange again, later' })
    expect(j.forgetJournal(h, { query: 'orange' }, seen.upTo)).toBe(3)
    expect(summaries(j.browseJournal(h, {}))).toEqual(['Orange again, later', '#12 is Done', 'Week 42'])
    j.closeJournal(h)
    const db = new DatabaseSync(j.journalFile(h), { readOnly: true })
    try {
      expect((db.prepare("SELECT count(*) AS n FROM links WHERE ref = 'abc123'").get() as { n: number }).n).toBe(0)
      // The index forgets them too.
      expect((db.prepare("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'contrast'").get() as { n: number }).n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('with filters only', () => {
    const h = seeded()
    expect(j.forgetJournal(h, { source: 'hive' }, 99)).toBe(1)
    expect(j.browseJournal(h, {}).total).toBe(4)
  })
})

describe('the windows are told', () => {
  // The deleted journal goes to the test's own trash folder, never the Recycle Bin (#414).
  beforeAll(() => {
    process.env.HIVE_TEST_TRASH_DIR = join(base, 'trash')
  })
  afterAll(() => {
    delete process.env.HIVE_TEST_TRASH_DIR
  })
  it('of a write, an edit, a delete, a forget and the journal deleted', async () => {
    const h = home()
    const told: string[] = []
    const off = j.onJournalChange((x) => told.push(x))
    try {
      const id = write(h, { summary: 'One' })
      write(h, { summary: 'Two' })
      j.updateEntry(h, all, id, { importance: 2 })
      j.deleteEntry(h, id)
      j.forgetJournal(h, { query: 'two' }, 99)
      // Nothing changed: no word.
      j.forgetJournal(h, { query: 'nothing' }, 99)
      await j.deleteJournal(h)
      expect(told).toEqual([h, h, h, h, h, h])
    } finally {
      off()
    }
  })
})
