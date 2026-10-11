// A session host's attachments folder (#387), `.hive/attachments`, and the move of the folder it replaces, `.hive/images`.
import { existsSync } from 'original-fs'
import { lstat, mkdir, readdir, rename, rmdir } from 'original-fs/promises'
import { extname, join } from 'path'
import { ATTACHMENTS_DIR, OLD_ATTACHMENTS_DIR } from '../shared/attachments'
import { HIVE_DIR } from '../shared/defaults'
import { createLogger, userText } from './logger'

const log = createLogger('attachments')

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

/** Tests only: forgets which hosts were moved, so a test can move one again. */
export function forgetMoves(): void {
  moves.clear()
}

/**
 * Moves `.hive\images` to `.hive\attachments`: renamed whole when there is no attachments folder yet, else file by file
 * into the session folders of the same names (a name already taken gets " (moved)"). A link, either side, is left alone:
 * Hive never moves files through one.
 */
async function moveOldFolder(host: string): Promise<void> {
  const hive = join(host, HIVE_DIR)
  const old = join(hive, OLD_ATTACHMENTS_DIR)
  const st = await lstat(old).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isDirectory()) return log.warn(`${userText(old)} is a link or not a folder: Hive leaves it alone`)
  const dest = join(hive, ATTACHMENTS_DIR)
  const there = await lstat(dest).catch(() => null)
  if (there && (there.isSymbolicLink() || !there.isDirectory())) return log.warn(`${userText(dest)} is a link or not a folder: the images folder stays`)
  if (!there) {
    try {
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
  for (const d of await readdir(old, { withFileTypes: true })) {
    if (!d.isDirectory()) {
      left++
      continue
    }
    const from = join(old, d.name)
    const to = join(dest, d.name)
    await mkdir(to, { recursive: true })
    for (const f of await readdir(from, { withFileTypes: true })) {
      if (!f.isFile()) {
        left++
        continue
      }
      let target = join(to, f.name)
      const ext = extname(f.name)
      for (let i = 1; existsSync(target); i++) target = join(to, `${f.name.slice(0, f.name.length - ext.length)} (moved${i > 1 ? ` ${i}` : ''})${ext}`)
      try {
        await rename(join(from, f.name), target)
        moved++
      } catch (e) {
        left++
        log.warn(`Could not move ${userText(f.name)} to ${ATTACHMENTS_DIR}`, e)
      }
    }
    await rmdir(from).catch(() => undefined)
  }
  await rmdir(old).catch(() => undefined)
  log.info(`Moved ${moved} file(s) of ${userText(old)} to ${ATTACHMENTS_DIR}${left ? `; ${left} left there` : ''}`)
}
