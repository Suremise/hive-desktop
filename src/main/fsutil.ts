import { existsSync } from 'fs'
import { mkdir, readFile, rename, writeFile, stat, cp, rm } from 'fs/promises'
import { dirname } from 'path'
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

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
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
