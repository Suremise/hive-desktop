// A session host's attachments folder (#387), `.hive/attachments`, and the move of the folder it replaces, `.hive/images`.
// Attachments stay inside the host (decision 4): nothing is written or moved through a junction or symbolic link, at the
// folder, its session folders or any folder above them.
import { lstat, mkdir, readdir, readFile, rename, rmdir } from 'original-fs/promises'
import { extname, join, relative, sep } from 'path'
import { ATTACHMENTS_DIR, OLD_ATTACHMENTS_DIR, movedAttachmentPath } from '../shared/attachments'
import { HIVE_DIR } from '../shared/defaults'
import { insideReal, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'

const log = createLogger('attachments')

/**
 * In the attachments folder: the files the move renamed because their name was taken, by their old path in the old
 * folder (`<session>/<name>`, forward slashes) to their name now. Old links lead to them, not to the file that kept the
 * name.
 */
const MOVED_FILE = '.moved.json'

/** Each host's move, once a run: every use of the folder waits for it, so nothing is saved or listed half-way. */
const moves = new Map<string, Promise<void>>()

/**
 * The host's attachments folder, `<host>\.hive\attachments` (it may not exist yet), after moving what its old
 * `.hive\images` folder holds into it. A move that fails part-way (a file another program has open) leaves the rest in
 * the old folder for the next run.
 */
export async function attachmentsDir(host: string): Promise<string> {
  const key = host.toLowerCase()
  let move = moves.get(key)
  if (!move) {
    move = moveOldFolder(host).catch((e) => log.warn(`Could not move the images folder of ${userText(host)} to attachments`, e))
    moves.set(key, move)
  }
  await move
  return join(host, HIVE_DIR, ATTACHMENTS_DIR)
}

/** Tests only: forgets which hosts were moved, so a test can move one again (as a restart would). */
export function forgetMoves(): void {
  moves.clear()
}

/** A folder Hive may keep attachments in: a real folder (not a link), really inside the host. */
async function isOwnFolder(host: string, p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return !!st && !st.isSymbolicLink() && st.isDirectory() && insideReal(p, [host])
}

/** A session folder's name: a session id, or run-<launch> (no separators, never "." or ".."). */
const SESSION_FOLDER = /^(?!\.{1,2}$)[\w.-]+$/

/**
 * The host's attachments folder, or a session folder in it, made where missing, after checking that it and every folder
 * from the host down to it (`.hive`, `attachments`, the session's) is a real folder of the host's own: never a junction
 * or symbolic link, never really outside the host. Throws otherwise, so nothing is written through one.
 */
export async function ownAttachmentsFolder(host: string, sessionFolder?: string): Promise<string> {
  if (sessionFolder !== undefined && !SESSION_FOLDER.test(sessionFolder)) throw new Error('Not a session folder name.')
  const root = await attachmentsDir(host)
  const chain = [join(host, HIVE_DIR), root, ...(sessionFolder !== undefined ? [join(root, sessionFolder)] : [])]
  for (const p of chain) {
    if (!(await lstat(p).catch(() => null))) await mkdir(p).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)))
    if (!(await isOwnFolder(host, p))) {
      log.warn(`${userText(p)} is a link or not a folder: no attachments are kept through it`)
      throw new Error(`${p} is a link or not a folder of the project's own, so Hive keeps no attachments in it.`)
    }
  }
  return chain[chain.length - 1]
}

/** A name free in a folder: taken means anything there, a link (even a broken one) included. */
export async function freeName(dir: string, name: string, suffix: (i: number) => string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let target = join(dir, name)
  for (let i = 1; await lstat(target).then(() => true, () => false); i++) target = join(dir, `${stem}${suffix(i)}${ext}`)
  return target
}

/**
 * Moves `.hive\images` to `.hive\attachments`: renamed whole when there is no attachments folder yet, else file by file
 * into the session folders of the same names (a name already taken gets " (moved)", recorded in MOVED_FILE). Only real
 * folders and files of the host's own move, into real folders of its own: a link, at either end or above, stays where
 * it is with what it holds.
 */
async function moveOldFolder(host: string): Promise<void> {
  const hive = join(host, HIVE_DIR)
  const old = join(hive, OLD_ATTACHMENTS_DIR)
  if (!(await lstat(old).catch(() => null))) return
  if (!(await isOwnFolder(host, hive)) || !(await isOwnFolder(host, old))) return log.warn(`${userText(old)} is a link or not a folder: Hive leaves it alone`)
  const dest = join(hive, ATTACHMENTS_DIR)
  const there = await lstat(dest).catch(() => null)
  if (there && !(await isOwnFolder(host, dest))) return log.warn(`${userText(dest)} is a link or not a folder: the images folder stays`)
  if (!there) {
    try {
      // A link inside moves as the link it is: what it leads to stays where it is.
      await rename(old, dest)
      log.info(`Moved ${userText(old)} to ${ATTACHMENTS_DIR}`)
      return
    } catch (e) {
      // Something in it is open: move what can be moved, file by file.
      log.warn(`Could not rename ${userText(old)}; moving its files one by one`, e)
    }
  }
  let moved = 0
  let left = 0
  const renamed: Record<string, string> = {}
  for (const d of await readdir(old)) {
    const from = join(old, d)
    const to = join(dest, d)
    if (!SESSION_FOLDER.test(d) || !(await isOwnFolder(host, from))) {
      left++
      continue
    }
    if (!(await lstat(to).catch(() => null))) await mkdir(to).catch(() => undefined)
    if (!(await isOwnFolder(host, to))) {
      log.warn(`${userText(to)} is a link or not a folder: ${userText(from)} stays`)
      left++
      continue
    }
    for (const f of await readdir(from)) {
      const st = await lstat(join(from, f)).catch(() => null)
      if (!st || st.isSymbolicLink() || !st.isFile()) {
        left++
        continue
      }
      const target = await freeName(to, f, (i) => ` (moved${i > 1 ? ` ${i}` : ''})`)
      try {
        await rename(join(from, f), target)
        moved++
        if (target !== join(to, f)) renamed[`${d}/${f}`] = `${d}/${target.slice(to.length + 1)}`
      } catch (e) {
        left++
        log.warn(`Could not move ${userText(f)} to ${ATTACHMENTS_DIR}`, e)
      }
    }
    await rmdir(from).catch(() => undefined)
  }
  if (Object.keys(renamed).length) await writeJsonAtomic(join(dest, MOVED_FILE), { ...(await readMoved(dest)), ...renamed })
  await rmdir(old).catch(() => undefined)
  log.info(`Moved ${moved} file(s) of ${userText(old)} to ${ATTACHMENTS_DIR}${left ? `; ${left} left there` : ''}`)
}

async function readMoved(root: string): Promise<Record<string, string>> {
  try {
    const v = JSON.parse(await readFile(join(root, MOVED_FILE), 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * Where a path into a host's old `.hive\images` leads now: the file the move put in `.hive\attachments`, under its new
 * name when the move had to rename it. Null for a path not in an old folder. The old path itself, while it is still
 * there, is the caller's to try first.
 */
export async function movedAttachment(oldPath: string): Promise<string | null> {
  const plain = movedAttachmentPath(oldPath)
  if (!plain) return null
  const m = /[\\/]\.hive[\\/]attachments[\\/]/i.exec(plain)!
  const root = plain.slice(0, m.index + m[0].length - 1)
  const rel = relative(root, plain).split(sep).join('/')
  const map = await readMoved(root)
  // Windows names ignore case, as the old link may.
  const key = Object.keys(map).find((k) => k.toLowerCase() === rel.toLowerCase())
  const renamed = key ? map[key] : undefined
  // Only a file of a session folder of the same root, whatever the file says.
  const parts = typeof renamed === 'string' ? renamed.split('/') : []
  const ok = parts.length === 2 && SESSION_FOLDER.test(parts[0]) && !/[\\:]/.test(parts[1]) && parts[1] !== '.' && parts[1] !== '..'
  return ok ? join(root, ...parts) : plain
}
