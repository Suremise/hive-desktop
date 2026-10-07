import { dirname, join, relative, resolve } from 'path'
import { appendFile, mkdir, readFile } from 'original-fs/promises'
import { existsSync, readFileSync, statSync } from 'original-fs'
import { HIVE_DIR } from '../shared/defaults'
import { git } from './git'
import type { HiveVcs } from '../shared/types'

/**
 * Keeping a project's .hive (sessions, transcript backups, launch settings: this machine's, not the project's) out of
 * version control (#345). Hive adds it to git's .git/info/exclude, never to a tracked .gitignore, for the repository
 * that holds the project: its own, or one in a folder above it (a workspace kept in git). It does so when a project is
 * set up, at every refresh and before every launch, so a repository made later (`git init`) is covered too. Where it
 * can't (another version control system, none, a folder a sync service copies), the project says so.
 */

/** Other version control systems, by the folder or file they keep at a working copy's root. */
const OTHER_VCS: [string, string][] = [
  ['.hg', 'Mercurial'],
  ['.svn', 'Subversion'],
  ['.jj', 'Jujutsu'],
  ['.bzr', 'Bazaar'],
  ['_FOSSIL_', 'Fossil'],
  ['.fslckout', 'Fossil']
]

/** A git repository's own folder (where info/exclude is) for a working folder holding `.git`: a worktree's common one. */
export async function gitDirOf(folder: string): Promise<string | null> {
  const g = join(folder, '.git')
  if (!existsSync(g)) return null
  try {
    if (statSync(g).isDirectory()) return g
    const m = (await readFile(g, 'utf8')).match(/gitdir:\s*(.+)/)
    if (!m) return null
    const gd = resolve(folder, m[1].trim())
    // Worktrees keep info/exclude in the common dir.
    const common = join(gd, 'commondir')
    if (existsSync(common)) return resolve(gd, (await readFile(common, 'utf8')).trim())
    return gd
  } catch {
    return null
  }
}

/** The nearest version control holding a folder: the folder itself or one above it. */
export function vcsOf(folder: string): { kind: 'git'; root: string } | { kind: 'other'; name: string; root: string } | null {
  let dir = resolve(folder)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { kind: 'git', root: dir }
    const other = OTHER_VCS.find(([marker]) => existsSync(join(dir, marker)))
    if (other) return { kind: 'other', name: other[1], root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A path's part as a git ignore pattern matches it literally: its wildcards and brackets escaped (`project[1]`). */
export function literalPattern(part: string): string {
  return part.replace(/[\\[\]*?]/g, (c) => `\\${c}`)
}

/** The exclude line for a project's .hive in a repository whose working folder is `root`: anchored at the project. */
export function excludeLine(root: string, projectPath: string): string {
  const rel = relative(root, projectPath).split(/[\\/]/).filter(Boolean).map(literalPattern).join('/')
  return rel ? `/${rel}/${HIVE_DIR}/` : `/${HIVE_DIR}/`
}

/** Whether exclude-file text has the line (or, for a repository's own .hive, the unanchored form). */
export function hasExcludeLine(text: string, line: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim() === line || (line === `/${HIVE_DIR}/` && l.trim() === `${HIVE_DIR}/`))
}

/** What git said of whether it ignores a project's .hive, kept until its exclude file changes or for a minute. */
const ignoredCache = new Map<string, { at: number; stamp: string; ignored: boolean }>()

/**
 * Whether git ignores the project's .hive, as git itself says (`git check-ignore --no-index`: by the ignore rules
 * alone, whatever is tracked; a `.gitignore` rule can bring it back). Null when git can't be asked (not installed).
 */
async function gitIgnores(projectPath: string, excludeFile: string): Promise<boolean | null> {
  const key = projectPath.toLowerCase()
  let stamp = ''
  try {
    const s = statSync(excludeFile)
    stamp = `${s.mtimeMs}:${s.size}`
  } catch {
    // no exclude file
  }
  const kept = ignoredCache.get(key)
  if (kept && kept.stamp === stamp && Date.now() - kept.at < 60_000) return kept.ignored
  const r = await git(projectPath, ['check-ignore', '-q', '--no-index', '--', `${HIVE_DIR}/`])
  // 0: ignored; 1: not; anything else (128, git missing): couldn't say.
  if (r.code !== 0 && r.code !== 1) return null
  ignoredCache.set(key, { at: Date.now(), stamp, ignored: r.code === 0 })
  if (ignoredCache.size > 500) ignoredCache.delete(ignoredCache.keys().next().value!)
  return r.code === 0
}

/**
 * Adds the project's .hive to the info/exclude of the git repository holding it, if it isn't there, then asks git
 * whether it ignores it now (a line Hive wrote isn't proof: a `.gitignore` rule can bring .hive back). Returns that, the
 * repository's working folder and whether Hive added the line; null when no git repository holds the project.
 */
export async function ensureHiveExcluded(projectPath: string): Promise<{ excluded: boolean; root: string; added: boolean } | null> {
  const found = vcsOf(projectPath)
  if (found?.kind !== 'git') return null
  const gd = await gitDirOf(found.root)
  if (!gd) return { excluded: false, root: found.root, added: false }
  const f = join(gd, 'info', 'exclude')
  const line = excludeLine(found.root, projectPath)
  let text = ''
  try {
    text = await readFile(f, 'utf8')
  } catch {
    await mkdir(join(gd, 'info'), { recursive: true })
  }
  const added = !hasExcludeLine(text, line)
  if (added) {
    const prefix = text && !text.endsWith('\n') ? '\n' : ''
    await appendFile(f, `${prefix}# Hive project metadata (added by Hive)\n${line}\n`)
  }
  // Git's own answer; only when git can't be asked, the line Hive found or wrote.
  const ignored = await gitIgnores(projectPath, f)
  return { excluded: ignored ?? true, root: found.root, added }
}

/** Folders sync services copy (OneDrive's from Windows' variables, Dropbox's from its info.json), with their names. */
export function syncRoots(env: Record<string, string | undefined> = process.env): [string, string][] {
  const roots: [string, string][] = []
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) if (env[k]) roots.push([env[k]!, 'OneDrive'])
  for (const base of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!base) continue
    try {
      const info = JSON.parse(readFileSync(join(base, 'Dropbox', 'info.json'), 'utf8')) as Record<string, { path?: unknown }>
      for (const v of Object.values(info)) if (typeof v?.path === 'string') roots.push([v.path, 'Dropbox'])
    } catch {
      // no Dropbox here
    }
  }
  return roots
}

/** The sync service whose folder holds `path`, or null. */
export function syncServiceOf(path: string, roots: [string, string][]): string | null {
  const p = resolve(path).toLowerCase()
  for (const [root, name] of roots) {
    const r = resolve(root).toLowerCase()
    if (p === r || p.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}\\`) || p.startsWith(`${r}/`)) return name
  }
  return null
}

let roots: { at: number; list: [string, string][] } | null = null

/** Whether the project's .hive is kept out of version control, ensuring it for git first (at each refresh). */
export async function hiveVcs(projectPath: string): Promise<HiveVcs> {
  // Sync folders change rarely: read them at most once a minute.
  if (!roots || Date.now() - roots.at > 60_000) roots = { at: Date.now(), list: syncRoots() }
  const sync = syncServiceOf(projectPath, roots.list)
  const withSync = (v: HiveVcs): HiveVcs => (sync ? { ...v, sync } : v)
  const found = vcsOf(projectPath)
  if (!found) return withSync({ state: 'none' })
  if (found.kind === 'other') return withSync({ state: 'other-vcs', vcs: found.name })
  const r = await ensureHiveExcluded(projectPath).catch(() => null)
  return withSync(r?.excluded ? { state: 'excluded' } : { state: 'not-excluded' })
}
