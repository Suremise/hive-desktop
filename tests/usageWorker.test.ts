// The usage worker (#1106): records a session from its transcript, reads only what was added since (taking up its
// parser's state), never makes a session's totals smaller, keeps a kept usage only for a session it doesn't have, and
// leaves a session another writer recorded meanwhile as that writer wrote it.
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { handleRequest, type IngestJob, type IngestResult } from '../src/main/usageWorker'
import { cursorOf, writeSession, type StoredSession } from '../src/main/usageDb'
import { summaryOf, usageFromRows } from '../src/shared/usageLedger'
import { priceUsage } from '../src/shared/usageDays'
import { newUsageParser } from '../src/main/usageParsers'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { estimateCost } from '../src/shared/prices'
import type { AppSettings } from '../src/shared/types'
import { tempDir } from './tempDir'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const line = (i: number, output = 100): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }) + '\n'
const prompt = (i: number): string => JSON.stringify({ type: 'user', timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: 'user', content: `go ${i}` } }) + '\n'

let id = 0

/** Holds a file open the way an editor or a virus scanner can: no sharing, so it can't be read (as sessionInUse.test.ts does). */
async function hold(file: string): Promise<ChildProcess> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => {
      if (String(d).includes('held')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.on('exit', () => reject(new Error('the holder exited')))
  })
  return child
}
const call = (m: Record<string, unknown>): Promise<unknown> => handleRequest({ id: ++id, ...m } as never)

async function setup() {
  const dir = tempDir('hive-usage-worker-')
  const file = join(dir, '.hive', 'usage.db')
  const transcript = join(dir, 'abc.jsonl')
  await call({ type: 'config', advanced: {}, providers: DEFAULT_SETTINGS.providers, hiveVersion: '9.9.9-test' })
  const job = (o: Partial<IngestJob> = {}): IngestJob => ({ scope: 'p1', session: 'abc', provider: 'claude-code', agentId: 'a1', path: transcript, holds: [], holdsKey: null, keepState: 'now', ...o })
  const ingest = (o?: Partial<IngestJob>) => call({ type: 'ingest', file, job: job(o) }) as Promise<IngestResult>
  const stored = async (): Promise<StoredSession | undefined> => ((await call({ type: 'sessions', file, scopes: ['p1'] })) as StoredSession[]).find((s) => s.session === 'abc')
  const output = async (): Promise<number> => (await stored())?.rows.reduce((n, r) => n + r.outputTokens, 0) ?? 0
  return { file, transcript, ingest, stored, output, close: () => call({ type: 'close', file }) }
}

describe('the usage worker', () => {
  it('records a session, does nothing more while its file is unchanged, and reads what was added from its saved state', async () => {
    const t = await setup()
    // A long line between the first request and the state's offset: its check covers only the bytes just before it.
    const pad = JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'x'.repeat(10_000) } }) + '\n'
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(200)
    expect((await t.ingest()).status).toBe('unchanged')
    // The part already read is changed (same length) far before the offset, where no reader would look again: only a read
    // from the saved state gives 300 after a line is added; a read from the start would see the changed part.
    writeFileSync(t.transcript, readFileSync(t.transcript, 'utf8').replace('"output_tokens":100}', '"output_tokens":900}'))
    appendFileSync(t.transcript, line(3))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it("doesn't take its state up for other bytes: a file that changed just before the offset is read from the start", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    await t.ingest()
    // Rewritten (shrank and grew again between reads): the bytes before the saved offset aren't the ones it was made from.
    writeFileSync(t.transcript, prompt(0) + line(1, 300) + line(2, 300) + line(3, 300))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(900)
    await t.close()
  })

  it("lets a state go once another file is read: a backup read, then grown, is read whole (its offsets aren't the transcript's)", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 30) + line(2, 30))
    await t.ingest()
    // The transcript went; Hive's backup has the same requests, written differently (a shorter first line).
    const backup = join(t.transcript, '..', 'backup.jsonl')
    writeFileSync(backup, line(1, 30) + line(2, 30))
    // As much as recorded: it's now what the session is read from (its state made from the transcript let go).
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(60)
    appendFileSync(backup, line(3, 30))
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(90)
    appendFileSync(backup, line(4, 30))
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(120)
    await t.close()
  })

  it("shares a session's cards out again when their holds change, without a new read of its file", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 10))
    await t.ingest()
    const card = async (): Promise<number> => (await t.stored())!.rows.filter((r) => r.card === 12).reduce((n, r) => n + r.outputTokens, 0)
    expect(await card()).toBe(0)
    expect((await t.ingest({ holds: [{ card: 12, role: 'build', parts: [[1, [[T0, T0 + 5000]]]] }], holdsKey: 'k1' })).status).toBe('unchanged')
    expect(await card()).toBe(10)
    expect(await t.output()).toBe(10)
    await t.close()
  })

  it('reads from the start when its state is from another Hive version (and the result is the same)', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    await t.ingest()
    await call({ type: 'config', advanced: {}, providers: DEFAULT_SETTINGS.providers, hiveVersion: '9.9.10-test' })
    appendFileSync(t.transcript, line(3))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it("never makes a session's totals smaller: a file cut short leaves what was recorded", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2) + line(3))
    await t.ingest()
    writeFileSync(t.transcript, prompt(0) + line(1))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    // A file that is gone leaves it too.
    expect((await t.ingest({ path: join(t.transcript, '..', 'gone.jsonl') })).status).toBe('unchanged')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it('keeps a kept usage that counted more than a stale backup, and never one that counted less', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 10))
    await t.ingest()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1, 500))
    const kept = priceUsage(p.result(), DEFAULT_SETTINGS)
    const job = { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null }
    expect(((await call({ type: 'kept', file: t.file, job })) as IngestResult).status).toBe('written')
    expect(await t.output()).toBe(500)
    // The stale backup read again: the kept usage stays its baseline.
    appendFileSync(t.transcript, prompt(5))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(500)
    // A kept usage that counted less of everything changes nothing.
    const less = newUsageParser('claude-code', 'abc')!
    less.feed(prompt(0) + line(1, 1))
    await call({ type: 'kept', file: t.file, job: { ...job, usage: priceUsage(less.result(), DEFAULT_SETTINGS) } })
    expect(await t.output()).toBe(500)
    await t.close()
  })

  it('keeps each count and the known cost of both a file and a kept usage that disagree (none wins by a sum)', async () => {
    const t = await setup()
    // The transcript: one request, 100 in and 1 out. The kept usage: two requests, 2 in and 20 out, priced at $5.
    writeFileSync(t.transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: new Date(T0).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 1 } } }) + '\n')
    await t.ingest()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(['a', 'b'].map((rid) => JSON.stringify({ type: 'assistant', requestId: rid, timestamp: new Date(T0).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 10 } } })).join('\n') + '\n')
    const kept = { ...priceUsage(p.result(), DEFAULT_SETTINGS), costUsd: 5, costEstimated: false }
    for (const d of Object.values(kept.days ?? {})) Object.assign(d, { costUsd: 5, costEstimated: false })
    await call({ type: 'kept', file: t.file, job: { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null } })
    const totals = async () => {
      const s = (await t.stored())!
      return { input: s.rows.reduce((n, r) => n + r.inputTokens, 0), output: s.rows.reduce((n, r) => n + r.outputTokens, 0), requests: s.rows.reduce((n, r) => n + r.requests, 0), cost: usageFromRows(s.summary, s.rows, DEFAULT_SETTINGS).costUsd! }
    }
    let now = await totals()
    expect([now.input, now.output, now.requests]).toEqual([100, 20, 2])
    expect(now.cost).toBeGreaterThanOrEqual(5)
    // The file read again (grown by a prompt): still both.
    appendFileSync(t.transcript, prompt(1))
    await t.ingest()
    now = await totals()
    expect([now.input, now.output, now.requests]).toEqual([100, 20, 2])
    expect(now.cost).toBeGreaterThanOrEqual(5)
    await t.close()
  })

  it('never erases a charge the provider reported, nor charges its tokens twice: a rewrite without its report, its cards shared out again, costs the same', async () => {
    const t = await setup()
    const req = (rid: string, input: number, output: number, at = T0): string => JSON.stringify({ type: 'assistant', requestId: rid, timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output } } }) + '\n'
    const charge = JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 1000).toISOString(), totalCostUSD: 0.5 }) + '\n'
    const own = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], costSource: 'prices' as const } } }
    const priced = async (settings: Pick<AppSettings, 'providers'> = DEFAULT_SETTINGS) => {
      const s = (await t.stored())!
      const u = usageFromRows(s.summary, s.rows, settings)
      return { cost: u.costUsd!, input: u.inputTokens, output: u.outputTokens, requests: u.requests }
    }
    const est = (input: number, output: number): number => estimateCost({ provider: 'claude-code', model: 'claude-opus-5-5', inputTokens: input, outputTokens: output, cacheWriteTokens: 0, cacheReadTokens: 0 }, DEFAULT_SETTINGS)!
    writeFileSync(t.transcript, req('r1', 100_000, 10_000) + charge)
    await t.ingest()
    expect((await priced()).cost).toBeCloseTo(0.5, 9)
    // Rewritten without the report: the same request and a new prompt. The same use, the same cost: $0.50, not $1.10.
    writeFileSync(t.transcript, req('r1', 100_000, 10_000) + prompt(5))
    expect((await t.ingest()).status).toBe('written')
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    // Its cards shared out again (a hold now covering the request, then another): which card has it changes, not the cost.
    const share = (card: number, key: string) => call({ type: 'attribute', file: t.file, scope: 'p1', sessions: [{ session: 'abc', holds: [{ card, role: 'build', parts: [[1, [[T0 - 1000, T0 + 5000]]]] }], holdsKey: key }] })
    expect(await share(12, 'h1')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    expect((await t.stored())!.rows.filter((r) => r.card === 12).reduce((n, r) => n + r.inputTokens, 0)).toBe(100_000)
    expect(await share(13, 'h2')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    // A request added, still without a report: the old charge, and Hive's estimate for the new request alone.
    appendFileSync(t.transcript, req('r2', 1_000, 100, T0 + 2000))
    expect((await t.ingest({ holds: [{ card: 13, role: 'build', parts: [[1, [[T0 - 1000, T0 + 5000]]]] }], holdsKey: 'h2' })).status).toBe('written')
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5 + est(1_000, 100), 9), input: 101_000, output: 10_100, requests: 2 })
    // And shared out again once more: the same.
    expect(await share(14, 'h3')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5 + est(1_000, 100), 9), input: 101_000, output: 10_100, requests: 2 })
    // The user's own prices (#436): Hive's estimate for all of it, as for any session.
    expect((await priced(own)).cost).toBeCloseTo(est(101_000, 10_100), 9)
    await t.close()
  })

  it.runIf(process.platform === 'win32')('says a file it could not read failed, not unchanged: a delete must not take what is recorded as all of it', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1))
    await t.ingest()
    appendFileSync(t.transcript, line(2))
    // Held open by another program (no sharing), its unread end can't be read: failed, what was recorded left as it was.
    const holder = await hold(t.transcript)
    try {
      expect((await t.ingest()).status).toBe('failed')
      expect(await t.output()).toBe(100)
    } finally {
      holder.kill()
    }
    await t.close()
  })

  it("records a kept usage only for a session it doesn't have, at the cost it was kept with", async () => {
    const t = await setup()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1, 500))
    const kept = priceUsage(p.result(), DEFAULT_SETTINGS)
    const keptJob = { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null }
    expect(((await call({ type: 'kept', file: t.file, job: keptJob })) as IngestResult).status).toBe('written')
    expect(await t.output()).toBe(500)
    expect((await t.stored())?.source).toBe('kept')
    // Another kept usage that counted less takes nothing away; its transcript, read later, adds what it has more of.
    await call({ type: 'kept', file: t.file, job: { ...keptJob, usage: { ...kept, outputTokens: 1, days: {} } } })
    expect(await t.output()).toBe(500)
    writeFileSync(t.transcript, prompt(0) + line(1, 500) + line(2))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(600)
    expect((await t.stored())?.source).toBe('transcript')
    await t.close()
  })

  it('leaves a session another writer recorded meanwhile as it wrote it', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1))
    await t.ingest()
    await t.close()
    const db = new DatabaseSync(t.file)
    const was = cursorOf(db, 'p1', 'abc')!
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1))
    const w = { scope: 'p1', session: 'abc', provider: 'claude-code' as const, source: 'transcript' as const, path: t.transcript, size: 1, mtime: 1, offset: 1, state: null, summary: summaryOf(p.result()), timeline: null, rows: [], holdsKey: null, baseline: null }
    // From an older point than what is recorded now: refused, nothing written.
    expect(writeSession(db, w, { offset: was.offset - 1, path: was.path })).toBe(false)
    expect(cursorOf(db, 'p1', 'abc')!.tokens).toBe(was.tokens)
    // From what is recorded: written.
    expect(writeSession(db, w, { offset: was.offset, path: was.path })).toBe(true)
    db.close()
  })

  it('answers the cards a session worked on, with whose session each row is', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2) + line(3))
    await t.ingest({ holds: [{ card: 12, role: 'review', parts: [[1, [[T0 + 1500, T0 + 3500]]]] }] })
    const rows = (await call({ type: 'cards', file: t.file, cards: [12] })) as { session: string; agentId?: string; row: { card: number; role: string; outputTokens: number } }[]
    expect(rows.map((r) => [r.session, r.agentId, r.row.role, r.row.outputTokens])).toEqual([['abc', 'a1', 'review', 200]])
    await t.close()
  })
})
