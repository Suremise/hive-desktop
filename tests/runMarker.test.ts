// The running marker's write (#1111): asynchronous, whole or not at all, and never put back once the run has ended.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { writeMarkerFile } from '../src/main/lastRun'
import type { RunMarker } from '../src/shared/unexpectedClose'
import { tempDir } from './tempDir'

const marker: RunMarker = { version: 1, pid: 42, startedAt: '2026-10-20T00:00:00.000Z', lastSeen: '2026-10-20T00:01:00.000Z', hive: '0.9.4', workspaces: [], agents: [], processes: [] }

describe('the running marker (#1111)', () => {
  it('is written whole, compact, with no temp file left', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    expect(await writeMarkerFile(file, marker, () => true)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toEqual(marker)
    expect(text).toBe(`${JSON.stringify(marker)}\n`)
    expect(readdirSync(dir)).toEqual(['running.json'])
  })

  it('is not put back when the run ended while it was written (Hive quitting)', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    expect(await writeMarkerFile(file, marker, () => false)).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a write that fails leaves nothing behind', async () => {
    const dir = tempDir('run-marker-')
    expect(await writeMarkerFile(join(dir, 'missing', 'running.json'), marker, () => true)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
