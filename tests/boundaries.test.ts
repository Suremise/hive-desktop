// Workspace and file boundaries: link escapes, nested and same-named workspaces, closed workspaces' worktrees,
// and writes that must not lose someone else's change.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock, writeTextAtomic, writeTextUnlessChanged } from '../src/main/fsutil'
import { createWorkspaceService, disposeWorkspaceService, type WorkspaceService } from '../src/main/workspace'

const base = mkdtempSync(join(tmpdir(), 'hive-bounds-'))
const dir = (...p: string[]): string => {
  const d = join(base, ...p)
  mkdirSync(d, { recursive: true })
  return d
}

// A service showing a workspace without open()'s setup (config, watcher): enough for path ownership.
const made: WorkspaceService[] = []
function showing(path: string): WorkspaceService {
  const w = createWorkspaceService()
  w.path = path
  made.push(w)
  return w
}
afterEach(async () => {
  for (const w of made.splice(0)) await disposeWorkspaceService(w)
})

describe('workspace boundaries', () => {
  it('refuses to open a workspace inside, or around, one open in another window', async () => {
    const outer = dir('nest', 'outer')
    const inner = dir('nest', 'outer', 'client')
    showing(outer)
    const other = createWorkspaceService()
    made.push(other)
    await expect(other.open(inner)).rejects.toThrow(/inside the workspace/)
    await expect(other.open(dir('nest'))).rejects.toThrow(/is inside/)
    expect(other.path).toBeNull()
  })

  it("forgets a closed workspace's agent worktrees", async () => {
    const ws = dir('closing', 'ws')
    const w = showing(ws)
    const custom = dir('closing', 'elsewhere', 'worker')
    ;(w as unknown as { roots: Map<string, string> }).roots.set(custom.toLowerCase(), join(ws, 'proj'))
    expect(w.assertRoot(custom)).toBe(custom)
    expect(w.isAllowedPath(join(custom, 'a.txt'))).toBe(true)
    await w.close()
    w.path = dir('closing', 'next')
    expect(() => w.assertRoot(custom)).toThrow(/Not a project/)
    expect(w.isAllowedPath(join(custom, 'a.txt'))).toBe(false)
  })

  it('refuses an Agent API workspace name two open workspaces share', async () => {
    const { findWorkspace } = await import('../src/main/servers')
    const a = showing(dir('dupes', 'C', 'foo'))
    showing(dir('dupes', 'E', 'foo'))
    expect(() => findWorkspace('foo')).toThrow(/Several open workspaces are named "foo"/)
    expect(findWorkspace(a.path!)).toBe(a)
  })
})

describe('project files and links', () => {
  it('reads and writes in the project, but not through a link leading outside it', async () => {
    const files = await import('../src/main/files')
    const ws = dir('links', 'ws')
    const proj = dir('links', 'ws', 'proj')
    const outside = dir('links', 'outside')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    writeFileSync(join(proj, 'own.txt'), 'mine')
    symlinkSync(outside, join(proj, 'docs'), 'junction')
    showing(ws)
    expect((await files.readText(proj, 'own.txt')).text).toBe('mine')
    await expect(files.readText(proj, 'docs/secret.txt')).rejects.toThrow(/outside the project/)
    await expect(files.writeText(proj, 'docs/secret.txt', 'changed', null, false)).rejects.toThrow(/outside the project/)
    await expect(files.create(proj, 'docs', 'new.txt', false)).rejects.toThrow(/outside the project/)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    // The link itself is the project's: it can be renamed.
    expect(await files.renameEntry(proj, 'docs', 'docs2')).toBe('docs2')
  })
})

describe('writes that keep other changes', () => {
  it("won't save over a file changed since the editor loaded it", async () => {
    const f = join(dir('conflict'), 'note.md')
    writeFileSync(f, 'v1')
    await writeTextUnlessChanged(f, 'mine', 'v1')
    expect(readFileSync(f, 'utf8')).toBe('mine')
    writeFileSync(f, 'agent edit')
    await expect(writeTextUnlessChanged(f, 'mine again', 'mine')).rejects.toThrow('CONFLICT')
    expect(readFileSync(f, 'utf8')).toBe('agent edit')
    // A new file (read as '') is created; without an expected text it simply writes.
    await writeTextUnlessChanged(join(dir('conflict'), 'new.md'), 'hi', '')
    await writeTextUnlessChanged(f, 'overwrite')
    expect(readFileSync(f, 'utf8')).toBe('overwrite')
  })

  it('keeps both of two appends made at once when each holds the lock from read to write', async () => {
    const f = join(dir('append'), 'log.md')
    const append = (line: string): Promise<void> =>
      withFileLock(f, async () => {
        const existing = await readFile(f, 'utf8').catch(() => '')
        await new Promise((r) => setTimeout(r, 20))
        await writeTextAtomic(f, existing + line + '\n')
      })
    await Promise.all([append('a'), append('b'), append('c')])
    expect(readFileSync(f, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['a', 'b', 'c'])
  })
})
