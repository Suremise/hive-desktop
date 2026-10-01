import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { syncCopy } from '../src/main/fsutil'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hive-synccopy-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const line = (i: number): string => JSON.stringify({ i, text: 'x'.repeat(i % 50) }) + '\n'

describe('syncCopy', () => {
  it('copies a new file, then appends only what the source gained', async () => {
    const src = join(dir, 'a.jsonl')
    const dest = join(dir, 'backup', 'a.jsonl')
    let all = ''
    for (let i = 0; i < 2000; i++) all += line(i)
    await writeFile(src, all)
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(all)
    const before = (await stat(dest)).birthtimeMs
    await appendFile(src, line(2000) + line(2001))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(all + line(2000) + line(2001))
    // Appended to, not replaced.
    expect((await stat(dest)).birthtimeMs).toBe(before)
    expect((await readdir(join(dir, 'backup'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('copies the whole file again when the source no longer starts with the copy', async () => {
    const src = join(dir, 'b.jsonl')
    const dest = join(dir, 'b-copy.jsonl')
    await writeFile(src, line(1) + line(2))
    await syncCopy(src, dest)
    await writeFile(src, line(7) + line(8) + line(9))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(line(7) + line(8) + line(9))
    // A source shorter than the copy (rewritten) is copied too.
    await writeFile(src, line(3))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(line(3))
  })

  it('notices a change in the middle of what was copied', async () => {
    const src = join(dir, 'm.jsonl')
    const dest = join(dir, 'm-copy.jsonl')
    const before = Buffer.alloc(12 * 1024, 'a')
    await writeFile(src, before)
    await syncCopy(src, dest)
    const after = Buffer.from(before)
    after[6000] = 'b'.charCodeAt(0)
    await writeFile(src, Buffer.concat([after, Buffer.from('more\n')]))
    await syncCopy(src, dest)
    expect((await readFile(dest)).equals(await readFile(src))).toBe(true)
  })

  it('appends each new byte once when copies overlap', async () => {
    const src = join(dir, 'c.jsonl')
    const dest = join(dir, 'c-copy.jsonl')
    await writeFile(src, line(0))
    await syncCopy(src, dest)
    let expected = line(0)
    const runs: Promise<void>[] = []
    for (let i = 1; i < 20; i++) {
      await appendFile(src, line(i))
      expected += line(i)
      runs.push(syncCopy(src, dest), syncCopy(src, dest))
    }
    await Promise.all(runs)
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(expected)
  })
})
