import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { onCorruptFile, readKeptJson, readKeptJsonSync, writeKeptJson } from '../src/main/fsutil'
import { tempDir } from './tempDir'

describe('kept files', () => {
  const dir = tempDir('hive-kept-')
  const reports: [string, boolean][] = []
  onCorruptFile((file, _aside, restored) => reports.push([file, restored]))

  it('saves a .bak copy with every write', async () => {
    const f = join(dir, 'a.json')
    await writeKeptJson(f, { n: 1 })
    expect(JSON.parse(readFileSync(`${f}.bak`, 'utf8'))).toEqual({ n: 1 })
    expect(await readKeptJson(f, null)).toEqual({ n: 1 })
  })

  it('sets a damaged file aside and restores the last good copy', async () => {
    const f = join(dir, 'b.json')
    await writeKeptJson(f, { sessions: ['s1'] })
    writeFileSync(f, '{ "sessions": [')
    expect(await readKeptJson(f, { sessions: [] })).toEqual({ sessions: ['s1'] })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ sessions: ['s1'] })
    expect(readdirSync(dir).some((n) => n.startsWith('b.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, true])
  })

  it('falls back to the default when there is no good copy, keeping the damaged file', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, 'not json')
    expect(readKeptJsonSync(f, { fresh: true })).toEqual({ fresh: true })
    expect(readdirSync(dir).some((n) => n.startsWith('c.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, false])
  })

  it('treats a missing file as new, not damaged', async () => {
    const before = reports.length
    expect(await readKeptJson(join(dir, 'missing.json'), 7)).toBe(7)
    expect(reports.length).toBe(before)
  })
})

describe('spawn log lines', () => {
  it('hide bearer tokens and shorten long arguments', async () => {
    const { forLog } = await import('../src/main/ptyHost')
    expect(forLog('hooks.Stop=[{command="curl.exe -H \\"Authorization: Bearer 0123456789abcdef0123456789abcdef\\" x"}]')).not.toContain('0123456789abcdef')
    expect(forLog('HIVE_API_TOKEN=abcdef123456')).toBe('HIVE_API_TOKEN=***')
    expect(forLog('x'.repeat(1000)).length).toBeLessThan(340)
    expect(forLog('--model')).toBe('--model')
  })
})

describe('path guards', () => {
  it("don't let a link inside a folder lead outside it", async () => {
    const { mkdirSync, symlinkSync, writeFileSync: write } = await import('fs')
    const { insideReal } = await import('../src/main/fsutil')
    const base = tempDir('hive-guard-')
    const ws = join(base, 'ws')
    const outside = join(base, 'outside')
    mkdirSync(join(ws, 'proj'), { recursive: true })
    mkdirSync(outside)
    write(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(ws, 'proj', 'link'), 'junction')
    expect(insideReal(join(ws, 'proj', 'a.txt'), [ws])).toBe(true)
    expect(insideReal(join(ws, 'proj', 'new', 'b.txt'), [ws])).toBe(true)
    expect(insideReal(join(ws, 'proj', 'link', 'secret.txt'), [ws])).toBe(false)
    expect(insideReal(join(ws, '..', 'outside', 'secret.txt'), [ws])).toBe(false)
  })
})
