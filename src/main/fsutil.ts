import { existsSync } from 'fs'
import { mkdir, readFile, rename, writeFile, stat, cp, rm } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { createHash } from 'crypto'
import { readdir } from 'fs/promises'
import { join } from 'path'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Writes via a temp file + rename so a crash never leaves a half-written file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(data, null, 2) + '\n')
}

let tmpCounter = 0

/**
 * Each write has its own temp file, so two writes to one file at the same time can't mix their
 * contents; the last rename wins with a complete file. Windows briefly refuses a rename while
 * another process (or another rename) holds the target, so that is retried.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}-${++tmpCounter}.tmp`
  await writeFile(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await rm(tmp, { force: true }).catch(() => undefined)
        throw e
      }
      await new Promise((r) => setTimeout(r, 15 + attempt * 10))
    }
  }
}

const fileLocks = new Map<string, Promise<unknown>>()

/**
 * Runs fn with the file locked against other withFileLock calls for the same path, so a
 * read-modify-write (e.g. sessions.json when two agents finish together) never loses a change.
 */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = path.toLowerCase()
  const prev = fileLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  fileLocks.set(key, tail)
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key)
  })
  return run
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, force: true })
}

export async function removePath(path: string): Promise<void> {
  if (existsSync(path)) await rm(path, { recursive: true, force: true })
}

/** Stable hash of a directory tree (file paths + contents). */
export async function hashDir(dir: string): Promise<string> {
  const h = createHash('sha256')
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(p, r)
      else if (e.isFile()) {
        h.update(r)
        h.update(await readFile(p))
      }
    }
  }
  await walk(dir, '')
  return h.digest('hex').slice(0, 16)
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Splits a command-line string into arguments, honouring double and single quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * In Claude Code's config folder, only what Hive shows: the user CLAUDE.md and auto memory (editable),
 * and skills (read-only). Never credentials or settings.
 */
export function claudeFileAllowed(path: string, write: boolean, home: string): boolean {
  const rel = relative(resolve(home), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]/)
  if (!/\.md$/i.test(rel)) return false
  if (parts.length === 1) return parts[0].toLowerCase() === 'claude.md'
  if (parts[0] === 'projects') return parts.length === 4 && parts[2] === 'memory'
  if (parts[0] === 'skills' || parts[0] === 'plugins') return !write && parts[parts.length - 1].toLowerCase() === 'skill.md'
  return false
}
