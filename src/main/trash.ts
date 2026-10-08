import { basename, join } from 'path'
import { appendFile, mkdir, rename } from 'original-fs/promises'
import { app, shell } from 'electron'
import { createLogger, userText } from './logger'

const log = createLogger('trash')

/**
 * Hive's one way to delete what the user can see (files, notes, skills, templates, cards, backups, projects): to the
 * Recycle Bin, so it can be restored (#414). Nothing in main calls `shell.trashItem` itself (tests/trash.test.ts).
 *
 * Test copies of Hive never touch the user's Recycle Bin: an unpackaged build with HIVE_TEST_TRASH_DIR (the run
 * context gives every test copy one, in the suite's own folder) or with a test profile (HIVE_USER_DATA: then
 * `<profile>/test-trash`) moves the item into that folder instead, and notes it in `trash.jsonl` there, so suites can
 * check it arrived. `npm run dev` (no test profile) and the installed app use the Recycle Bin.
 */
export function testTrashDir(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): string | null {
  if (packaged) return null
  if (env.HIVE_TEST_TRASH_DIR) return env.HIVE_TEST_TRASH_DIR
  return env.HIVE_USER_DATA ? join(env.HIVE_USER_DATA, 'test-trash') : null
}

let moved = 0

/**
 * Moves a file or folder to the Recycle Bin (or a test copy's trash folder). It resolves once the item has gone, and
 * rejects only when it hasn't, changing nothing (callers rely on that: Delete Project says "Nothing was deleted", a
 * group's delete puts back what had gone).
 *
 * In a test copy the move is one rename, whole or not at all: an item on another drive than the trash folder is refused
 * (a copy and remove could fail halfway, leaving parts of it in both places). Noting the move in `trash.jsonl` comes
 * after it and is best effort: a note that can't be written is logged as a warning, and never turns the deletion,
 * which has happened, into a failure.
 */
export async function trash(path: string): Promise<void> {
  const dir = testTrashDir()
  if (!dir) return shell.trashItem(path)
  await mkdir(dir, { recursive: true })
  // A name of its own: the same name can be deleted twice in a run.
  const to = join(dir, `${Date.now()}-${process.pid}-${++moved}-${basename(path)}`)
  try {
    await rename(path, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    throw new Error(`${path} is on another drive than the test trash folder (${dir}): a test copy of Hive only moves within a drive, so nothing is half deleted. Nothing was changed.`, { cause: e })
  }
  await appendFile(join(dir, 'trash.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), from: path, to })}\n`).catch((e) => log.warn(`Moved ${userText(path)} to the test trash folder, but could not note it in its trash.jsonl`, e))
}
