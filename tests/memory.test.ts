// The main process's memory (#1005): the memory line, a warning once per crossing of 70% and 85% of the heap limit,
// and the heap snapshots kept in the profile.
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { heapLevel, heapSnapshots, heapSnapshotsDir, logMemory, memoryLine, pruneHeapSnapshots, recentMemoryLines, type MemoryNow } from '../src/main/memory'
import { tempDir } from './tempDir'

const MB = 1024 * 1024
const at = (usedMb: number): MemoryNow => ({ used: usedMb * MB, total: (usedMb + 10) * MB, limit: 1000 * MB, external: 20 * MB, arrayBuffers: 5 * MB, rss: 900 * MB })

describe('memory line (#1005)', () => {
  it('says the heap used, its total and limit, the share used, external, array buffers and rss in MB', () => {
    expect(memoryLine(at(512))).toBe('heap 512 of 522 MB used (limit 1000 MB, 51%); external 20 MB, array buffers 5 MB, rss 900 MB')
    expect(memoryLine()).toMatch(/^heap \d+ of \d+ MB used \(limit \d+ MB, \d+%\); external \d+ MB, array buffers \d+ MB, rss \d+ MB$/)
  })

  it('counts the warning levels passed', () => {
    expect([at(100), at(700), at(849), at(850), at(999)].map(heapLevel)).toEqual([0, 1, 1, 2, 2])
  })

  it('warns once per crossing, again only after falling back below, and keeps the last lines', () => {
    for (const mb of [100, 750, 760, 900, 910, 500, 720]) logMemory('test', at(mb))
    const lines = recentMemoryLines()
    expect(lines).toHaveLength(6)
    expect(lines.map((l) => l.replace(/^\S+ /, '').replace(/: heap .*/, ''))).toEqual(['WARN Memory, test: past 70% of the heap limit', 'Memory, test', 'WARN Memory, test: past 85% of the heap limit', 'Memory, test', 'Memory, test', 'WARN Memory, test: past 70% of the heap limit'])
  })
})

describe('heap snapshots (#1005)', () => {
  it('lists the snapshots newest first, and keeps the newest when pruning', () => {
    const dir = heapSnapshotsDir(tempDir('heap-'))
    expect(heapSnapshots(dir)).toEqual([])
    mkdirSync(dir)
    const put = (name: string, day: number): void => {
      writeFileSync(join(dir, name), 'x')
      utimesSync(join(dir, name), Date.UTC(2026, 9, day) / 1000, Date.UTC(2026, 9, day) / 1000)
    }
    put('Heap.20261001.000000.1.0.001.heapsnapshot', 1)
    put('Heap.20261017.000000.2.0.001.heapsnapshot', 17)
    put('Heap.20261010.000000.3.0.001.heapsnapshot', 10)
    put('notes.txt', 18)
    expect(heapSnapshots(dir).map((s) => s.file)).toEqual(['Heap.20261017.000000.2.0.001.heapsnapshot', 'Heap.20261010.000000.3.0.001.heapsnapshot', 'Heap.20261001.000000.1.0.001.heapsnapshot'].map((n) => join(dir, n)))
    pruneHeapSnapshots(dir, 1)
    expect(readdirSync(dir).sort()).toEqual(['Heap.20261017.000000.2.0.001.heapsnapshot', 'notes.txt'])
  })
})
