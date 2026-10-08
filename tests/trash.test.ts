// Hive's one way to the Recycle Bin (#414): every deletion goes through trash() in src/main/trash.ts, and a test copy of
// Hive moves what it deletes into its own trash folder instead of the user's Recycle Bin.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'

// A rename across drives (EXDEV) where a test asks for one: the test trash folder can't be on another drive here.
const hooks: { exdev: ((from: string, to: string) => boolean) | null } = { exdev: null }
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (hooks.exdev?.(String(from), String(to))) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}'`), { code: 'EXDEV' })
      await real.rename(from, to)
    }
  }
})

const { testTrashDir, trash } = await import('../src/main/trash')
const { trashAllOrNothing } = await import('../src/main/fsutil')

const base = mkdtempSync(join(tmpdir(), 'hive-trash-'))
const shell = electron.shell as unknown as { trashItem?: (p: string) => Promise<void> }
const saved = { dir: process.env.HIVE_TEST_TRASH_DIR, profile: process.env.HIVE_USER_DATA }
afterEach(() => {
  for (const [k, v] of [['HIVE_TEST_TRASH_DIR', saved.dir], ['HIVE_USER_DATA', saved.profile]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  delete shell.trashItem
  hooks.exdev = null
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** Every source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mts|cts)$/.test(e.name) ? [join(dir, e.name)] : []))
}

describe('trash (src/main/trash.ts)', () => {
  it('is the only caller of shell.trashItem', () => {
    const root = join(__dirname, '..', 'src')
    const callers = sources(root).filter((f) => !f.endsWith(join('main', 'trash.ts')) && /\btrashItem\b/.test(readFileSync(f, 'utf8')))
    expect(callers.map((f) => relative(root, f))).toEqual([])
  })

  it('picks the test trash folder only in an unpackaged test copy', () => {
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p' }, false)).toBe('C:\\t\\trash')
    expect(testTrashDir({ HIVE_USER_DATA: 'C:\\p' }, false)).toBe(join('C:\\p', 'test-trash'))
    // npm run dev: no test profile, the Recycle Bin.
    expect(testTrashDir({}, false)).toBeNull()
    // The installed app: always the Recycle Bin, whatever its environment says.
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p' }, true)).toBeNull()
  })

  it('in a test copy, moves files and folders into its trash folder and notes each one', async () => {
    const dir = join(base, 'run-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    shell.trashItem = async () => {
      throw new Error('the real Recycle Bin was used')
    }
    const file = join(base, 'note.md')
    writeFileSync(file, 'hello')
    const folder = join(base, 'skill')
    mkdirSync(join(folder, 'refs'), { recursive: true })
    writeFileSync(join(folder, 'refs', 'a.txt'), 'a')
    await trash(file)
    await trash(folder)
    // The same name again: kept apart.
    writeFileSync(file, 'again')
    await trash(file)
    expect(existsSync(file) || existsSync(folder)).toBe(false)
    const log = readFileSync(join(dir, 'trash.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { from: string; to: string })
    expect(log.map((e) => e.from)).toEqual([file, folder, file])
    expect(new Set(log.map((e) => e.to)).size).toBe(3)
    expect(readFileSync(log[0].to, 'utf8')).toBe('hello')
    expect(readFileSync(log[2].to, 'utf8')).toBe('again')
    expect(readFileSync(join(log[1].to, 'refs', 'a.txt'), 'utf8')).toBe('a')
  })

  it('falls back to <profile>/test-trash with only a test profile', async () => {
    const profile = join(base, 'profile')
    process.env.HIVE_USER_DATA = profile
    delete process.env.HIVE_TEST_TRASH_DIR
    const file = join(base, 'card.json')
    writeFileSync(file, '{}')
    await trash(file)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(profile, 'test-trash')).some((n) => n.endsWith('-card.json'))).toBe(true)
  })

  it("a note that can't be written doesn't turn a deletion that happened into a failure (#414 round 1)", async () => {
    const dir = join(base, 'note-fails')
    // Its log can't be appended to: a folder of that name.
    mkdirSync(join(dir, 'trash.jsonl'), { recursive: true })
    process.env.HIVE_TEST_TRASH_DIR = dir
    const file = join(base, 'gone.md')
    writeFileSync(file, 'gone')
    await expect(trash(file)).resolves.toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter((n) => n.endsWith('-gone.md'))).toHaveLength(1)
    // A group's delete (trashAllOrNothing, the Images tab's) goes through whole: nothing put back, nothing lost.
    const group = ['a.png', 'b.png'].map((n) => join(base, n))
    for (const f of group) writeFileSync(f, f)
    await trashAllOrNothing(group, trash)
    expect(group.filter((f) => existsSync(f) || existsSync(`${f}.spare`))).toEqual([])
    expect(readdirSync(dir).filter((n) => /-(a|b)\.png$/.test(n))).toHaveLength(2)
  })

  it('an item on another drive is refused before anything moves: whole, in place, nothing in the trash (#414 round 1)', async () => {
    const dir = join(base, 'other-drive')
    process.env.HIVE_TEST_TRASH_DIR = dir
    const folder = join(base, 'project')
    mkdirSync(join(folder, 'src'), { recursive: true })
    writeFileSync(join(folder, 'a.txt'), 'a')
    writeFileSync(join(folder, 'src', 'b.txt'), 'b')
    hooks.exdev = (from, to) => from === folder && to.startsWith(dir)
    await expect(trash(folder)).rejects.toThrow(/another drive.*Nothing was changed/)
    expect(readFileSync(join(folder, 'a.txt'), 'utf8') + readFileSync(join(folder, 'src', 'b.txt'), 'utf8')).toBe('ab')
    expect(readdirSync(dir)).toEqual([])
    // The caller's all-or-nothing: the first went, the second was refused, so the first is put back.
    const first = join(base, 'one.png')
    const second = join(base, 'two.png')
    writeFileSync(first, '1')
    writeFileSync(second, '2')
    hooks.exdev = (from, to) => from === second && to.startsWith(dir)
    await expect(trashAllOrNothing([first, second], trash)).rejects.toThrow(/another drive/)
    expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['1', '2'])
  })

  it('rejects for something that is not there, noting nothing', async () => {
    const dir = join(base, 'missing-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    await expect(trash(join(base, 'not-there.txt'))).rejects.toThrow()
    expect(existsSync(join(dir, 'trash.jsonl'))).toBe(false)
  })

  it('outside a test copy, uses the Recycle Bin (shell.trashItem), and passes on its failure', async () => {
    delete process.env.HIVE_TEST_TRASH_DIR
    delete process.env.HIVE_USER_DATA
    const asked: string[] = []
    shell.trashItem = async (p) => {
      asked.push(p)
    }
    await trash(join(base, 'real.txt'))
    expect(asked).toEqual([join(base, 'real.txt')])
    shell.trashItem = async () => {
      throw new Error('in use')
    }
    await expect(trash(join(base, 'real.txt'))).rejects.toThrow('in use')
  })
})
