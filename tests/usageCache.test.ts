// The usage cache on disk (usage-cache.json): a restarted Hive takes an unchanged transcript's usage from it without
// reading the transcript, reads a changed one again, ignores a damaged or older cache, and prices from the settings.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUsage } from '../src/shared/types'

const line = (o: unknown): string => JSON.stringify(o)
const usage = (input: number, output: number) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output })
const transcript = (output: string): string =>
  [
    line({ type: 'user', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'hello' }, version: '2.1.283' }),
    line({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-28T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: usage(1000, 120) } }),
    // Three digits, so a test can change the number without changing the file's size.
    line({ type: 'assistant', requestId: 'r2', timestamp: '2026-09-28T10:01:00.000Z', message: { model: 'claude-opus-5-5', usage: usage(2000, Number(output)) } })
  ].join('\n') + '\n'
// A whole second, so the modified time set back after an edit is exactly the one the cache saw.
const WHEN = new Date('2026-09-28T12:00:00.000Z')

/** A fresh Hive main process (as after a restart) with its profile in `profile`. */
async function hive(profile: string) {
  vi.resetModules()
  const electron = await import('electron')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
  const { sessions } = await import('../src/main/sessions')
  const { config } = await import('../src/main/config')
  const read = (path: string): Promise<SessionUsage | null> => (sessions as unknown as { usageFor(p: string, id: string, provider: string): Promise<SessionUsage | null> }).usageFor(path, 'abc', 'claude-code')
  return { sessions, config, read }
}

function setup(): { profile: string; file: string } {
  const profile = mkdtempSync(join(tmpdir(), 'hive-usage-cache-'))
  const file = join(profile, 'abc.jsonl')
  writeFileSync(file, transcript('100'))
  utimesSync(file, WHEN, WHEN)
  return { profile, file }
}

/** Changes what the transcript says without changing its size or modified time: only a reader would notice. */
function changeUnseen(file: string): void {
  writeFileSync(file, transcript('999'))
  utimesSync(file, WHEN, WHEN)
}

describe('usage cache', () => {
  it("after a restart, takes an unchanged transcript's usage from the cache without reading it", async () => {
    const { profile, file } = setup()
    const first = await hive(profile)
    expect((await first.read(file))?.outputTokens).toBe(220)
    await first.sessions.flushUsageCache()
    expect(existsSync(join(profile, 'usage-cache.json'))).toBe(true)

    changeUnseen(file)
    const second = await hive(profile)
    expect((await second.read(file))?.outputTokens).toBe(220)
  })

  it('reads a transcript again when it changed while Hive was closed', async () => {
    const { profile, file } = setup()
    const first = await hive(profile)
    await first.read(file)
    await first.sessions.flushUsageCache()

    writeFileSync(file, transcript('999') + line({ type: 'assistant', requestId: 'r3', timestamp: '2026-09-28T10:02:00.000Z', message: { model: 'claude-opus-5-5', usage: usage(10, 5) } }) + '\n')
    const second = await hive(profile)
    const u = await second.read(file)
    expect(u?.outputTokens).toBe(120 + 999 + 5)
    expect(u?.requests).toBe(3)
  })

  it("ignores a damaged cache, and one from another Hive version", async () => {
    for (const content of ['{ not json', line({ version: '0.0.1-older', entries: [] })]) {
      const { profile, file } = setup()
      const first = await hive(profile)
      await first.read(file)
      await first.sessions.flushUsageCache()
      const cache = join(profile, 'usage-cache.json')
      if (content.includes('older')) {
        const saved = JSON.parse(readFileSync(cache, 'utf8'))
        writeFileSync(cache, line({ ...saved, version: '0.0.1-older' }))
      } else writeFileSync(cache, content)

      changeUnseen(file)
      const second = await hive(profile)
      expect((await second.read(file))?.outputTokens).toBe(120 + 999)
    }
  })

  it('prices a cached result from the current prices', async () => {
    const { profile, file } = setup()
    const first = await hive(profile)
    const before = (await first.read(file))!
    expect(before.costEstimated).toBe(true)
    await first.sessions.flushUsageCache()

    changeUnseen(file)
    const second = await hive(profile)
    second.config.settings.providers['claude-code'].prices = { 'claude-opus-5-5': { input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0 } }
    second.sessions.clearUsageCache()
    const after = (await second.read(file))!
    // 3,000 input tokens at $1M per million, and still the cached counts (not the changed file's).
    expect(after.costUsd).toBeCloseTo(3000)
    expect(after.outputTokens).toBe(220)
    expect(Object.values(after.days ?? {}).reduce((t, d) => t + (d.costUsd ?? 0), 0)).toBeCloseTo(3000)
  })

  it('Clear forgets it, in memory and on disk', async () => {
    const { profile, file } = setup()
    const first = await hive(profile)
    await first.read(file)
    await first.sessions.flushUsageCache()
    await first.sessions.forgetUsageCache()
    expect(existsSync(join(profile, 'usage-cache.json'))).toBe(false)
    changeUnseen(file)
    expect((await first.read(file))?.outputTokens).toBe(120 + 999)
  })
})
