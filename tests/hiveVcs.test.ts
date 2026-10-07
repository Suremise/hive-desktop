// Keeping a project's .hive out of version control (#345): git's info/exclude of the repository holding the project
// (its own, a worktree's common one, or one above it), other systems and sync services named, and the notice's text.
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureHiveExcluded, excludeLine, hasExcludeLine, hiveVcs, literalPattern, syncServiceOf, vcsOf } from '../src/main/hiveVcs'
import { hiveVcsKey, hiveVcsText } from '../src/shared/hiveVcsText'

const base = mkdtempSync(join(tmpdir(), 'hive-vcs-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const folder = (...parts: string[]): string => {
  const d = join(base, `case-${++n}`, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

describe('.hive kept out of version control (#345)', () => {
  it("adds /.hive/ to a project's own repository once, keeping what the file had", async () => {
    const p = folder('project')
    mkdirSync(join(p, '.git', 'info'), { recursive: true })
    writeFileSync(join(p, '.git', 'info', 'exclude'), '# mine\n*.log')
    // Not a repository git can read (a bare .git folder): the line is written, but git couldn't confirm it (#346).
    expect(await ensureHiveExcluded(p)).toEqual({ excluded: true, root: p, added: true, unconfirmed: true })
    expect(await ensureHiveExcluded(p)).toEqual({ excluded: true, root: p, added: false, unconfirmed: true })
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toBe('# mine\n*.log\n# Hive project metadata (added by Hive)\n/.hive/\n')
    expect(await hiveVcs(p)).toEqual({ state: 'excluded' })
  })

  it('takes the unanchored line someone wrote, and makes info/ when git has none', async () => {
    const p = folder('project')
    mkdirSync(join(p, '.git'), { recursive: true })
    expect((await ensureHiveExcluded(p))?.added).toBe(true)
    const q = folder('other')
    mkdirSync(join(q, '.git', 'info'), { recursive: true })
    writeFileSync(join(q, '.git', 'info', 'exclude'), '.hive/\r\n')
    expect((await ensureHiveExcluded(q))?.added).toBe(false)
  })

  it("a worktree's exclude is its repository's common one", async () => {
    const main = folder('main')
    const common = join(main, '.git')
    mkdirSync(join(common, 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(common, 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = folder('wt')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 'wt')}\n`)
    await ensureHiveExcluded(wt)
    expect(readFileSync(join(common, 'info', 'exclude'), 'utf8')).toContain('/.hive/')
  })

  it('a repository in a folder above (a workspace kept in git) gets the project\'s path, made later too', async () => {
    const ws = folder('ws')
    const p = join(ws, 'sub', 'project')
    mkdirSync(p, { recursive: true })
    // No repository of its own or the workspace's yet (whatever holds the test's temporary folder).
    expect(vcsOf(p)).toEqual(vcsOf(base))
    if (!vcsOf(base)) expect((await hiveVcs(p)).state).toBe('none')
    // git init in the workspace: the next check excludes it there.
    mkdirSync(join(ws, '.git'))
    expect(await hiveVcs(p)).toEqual({ state: 'excluded' })
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toContain('\n/sub/project/.hive/\n')
    expect(excludeLine(ws, p)).toBe('/sub/project/.hive/')
    expect(hasExcludeLine('.hive/', '/sub/project/.hive/')).toBe(false)
  })

  it("a project whose name has git's pattern characters (project[1]) is excluded as git itself says, in a real repository", async () => {
    const ws = folder('ws')
    execFileSync('git', ['init', '-q'], { cwd: ws })
    const p = join(ws, 'project[1]')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'secret.txt'), 'x')
    writeFileSync(join(p, 'code.txt'), 'x')
    expect(excludeLine(ws, p)).toBe('/project\\[1\\]/.hive/')
    expect(await ensureHiveExcluded(p)).toEqual({ excluded: true, root: ws, added: true })
    // Git agrees: nothing under .hive is listed, the project's own file is.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ws, encoding: 'utf8' })
    expect(status).toContain('project[1]/code.txt')
    expect(status).not.toContain('.hive')
    expect(literalPattern('a*b?[c]')).toBe('a\\*b\\?\\[c\\]')
  })

  it("isn't reported excluded when a .gitignore rule brings .hive back (git's answer, not the line Hive wrote)", async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q'], { cwd: p })
    writeFileSync(join(p, '.gitignore'), '!/.hive/\n')
    const r = await ensureHiveExcluded(p)
    expect(r).toEqual({ excluded: false, root: p, added: true })
    expect(await hiveVcs(p)).toEqual({ state: 'not-excluded' })
    // The rule goes: excluded (the exclude file unchanged, so the minute's cached answer is asked again after it).
    writeFileSync(join(p, '.gitignore'), '')
    writeFileSync(join(p, '.git', 'info', 'exclude'), readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8') + '# touched\n')
    expect((await ensureHiveExcluded(p))?.excluded).toBe(true)
  })

  it('names another version control system, the nearest one winning', async () => {
    const hg = folder('hg')
    mkdirSync(join(hg, '.hg'))
    expect(await hiveVcs(hg)).toEqual({ state: 'other-vcs', vcs: 'Mercurial' })
    // A git repository of its own inside an SVN working copy: git's.
    const svn = folder('svn')
    mkdirSync(join(svn, '.svn'))
    const inner = join(svn, 'project')
    mkdirSync(join(inner, '.git'), { recursive: true })
    expect(vcsOf(inner)).toEqual({ kind: 'git', root: inner })
    expect(vcsOf(join(svn))).toEqual({ kind: 'other', name: 'Subversion', root: svn })
  })

  it("knows a sync service's folder, not one that only starts with its name", () => {
    const roots: [string, string][] = [['C:\\Users\\me\\OneDrive', 'OneDrive'], ['D:\\Dropbox\\', 'Dropbox']]
    expect(syncServiceOf('C:\\Users\\me\\OneDrive\\code\\app', roots)).toBe('OneDrive')
    expect(syncServiceOf('c:/users/me/onedrive', roots)).toBe('OneDrive')
    expect(syncServiceOf('C:\\Users\\me\\OneDrive2\\app', roots)).toBeNull()
    expect(syncServiceOf('D:\\Dropbox\\app', roots)).toBe('Dropbox')
    expect(syncServiceOf('D:\\Code\\app', roots)).toBeNull()
  })

  it('says why, and offers Exclude only where Hive can', () => {
    expect(hiveVcsText({ state: 'excluded' })).toBeNull()
    expect(hiveVcsText(undefined)).toBeNull()
    expect(hiveVcsText({ state: 'none' })).toMatchObject({ title: ".hive isn't excluded from version control", canExclude: false })
    expect(hiveVcsText({ state: 'not-excluded' })?.canExclude).toBe(true)
    expect(hiveVcsText({ state: 'other-vcs', vcs: 'Mercurial' })?.detail).toContain('Mercurial working copy')
    expect(hiveVcsText({ state: 'excluded', sync: 'OneDrive' })).toMatchObject({ title: '.hive is synced by OneDrive', canExclude: false })
    expect(hiveVcsText({ state: 'none', sync: 'Dropbox' })?.detail).toContain('Dropbox copies the project folder')
    // A dismissed notice shows again when the situation changes.
    expect(hiveVcsKey({ state: 'none' })).not.toBe(hiveVcsKey({ state: 'none', sync: 'OneDrive' }))
  })
})
