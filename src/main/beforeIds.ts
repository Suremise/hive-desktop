import { constants, existsSync } from 'original-fs'
import { copyFile } from 'original-fs/promises'

/**
 * The project-id migration (#508) changes kept records (cards, lanes.json, watches.json) in place, so each keeps its
 * content from before it was first changed beside it, `<file>.before-ids.bak`, once: a second run, or a later change,
 * never replaces it. Called in the record's lock, before the write; a backup that can't be made stops that write.
 */
export async function keepBeforeIds(file: string): Promise<void> {
  const bak = `${file}.before-ids.bak`
  if (existsSync(bak) || !existsSync(file)) return
  await copyFile(file, bak, constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
}
