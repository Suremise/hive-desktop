// Tests' temp folders, by their long, real paths (#448). GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, the
// 8.3 short form, while Hive and git resolve real paths (#389): a test comparing a folder it made under os.tmpdir() with
// one Hive or git gave back passed on every machine but CI's. Tests make their folders here instead, and one that needs
// another name for a folder (an 8.3 name, a junction) makes it on purpose with pathAliases.ts. tests/tempDir.test.ts
// fails on any other use of os.tmpdir() in the tests.
//
// The folder is in the test area, %LOCALAPPDATA%\hive-test\tmp (#992), not %TEMP%: Hive's Antivirus scanning setting
// covers the test area, and thousands of tests making and removing folders in %TEMP% kept Defender busy. Each unit run
// has its own folder there, run-<random> (#995), which vitest.config.ts makes before the workers start (they inherit
// it) and tests/tempRun.ts removes once the run has ended, with whatever Hive's code under test wrote late (a settings
// save 300 ms after a change, a sessions.json written as a file's services wound down). Every folder tempDir() makes is
// also removed as its test file ends (tests/tempCleanup.ts), so a run doesn't grow as it goes. npm run test:clean
// (tests/e2e/clean.mjs) sweeps what a stopped run left after a day. Where LOCALAPPDATA is unset (off Windows), it's in
// the temp folder. LOCALAPPDATA is read once, as this loads: a test that changes it later doesn't move the folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

/** The test area's temp folder, hive-test\tmp: the runs' folders are in it. */
export const tempArea = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'tmp')
let root: string | undefined
const made = new Set<string>()

/**
 * Makes this run's own folder in the test area (vitest.config.ts, before the workers start: they inherit it), unless a
 * run that started this one has already (a run inside a test sees its parent's). The process that made it removes it.
 */
export function startRunTemp(): string {
  if (!process.env.HIVE_TEST_RUN_TMP) {
    mkdirSync(tempArea, { recursive: true })
    process.env.HIVE_TEST_RUN_TMP = realpathSync.native(mkdtempSync(join(tempArea, 'run-')))
    process.env.HIVE_TEST_RUN_TMP_OWNER = String(process.pid)
  }
  return tempRoot()
}

/** Removes this run's folder, if this process made it (tests/tempRun.ts, as the run ends). Replies with why it couldn't. */
export function endRunTemp(): string | undefined {
  const dir = process.env.HIVE_TEST_RUN_TMP
  if (!dir || process.env.HIVE_TEST_RUN_TMP_OWNER !== String(process.pid)) return undefined
  // Only ever a run's folder, directly in the test area.
  if (!basename(dir).startsWith('run-') || dirname(dir).toLowerCase() !== realpathSync.native(tempArea).toLowerCase()) return `not a run's folder: ${dir}`
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return undefined
  } catch (e) {
    return `${dir}: ${(e as Error).message}`
  }
}

/** The tests' temp folder by its real, long path, made if it isn't there: the run's own, or hive-test\tmp outside a run. */
export function tempRoot(): string {
  if (root) return root
  const dir = process.env.HIVE_TEST_RUN_TMP || tempArea
  mkdirSync(dir, { recursive: true })
  return (root = realpathSync.native(dir))
}

/** A new, empty folder in the temp folder, named `prefix` and six random characters, by its real, long path. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tempRoot(), prefix))
  made.add(dir)
  return dir
}

/**
 * Removes every folder tempDir() has made (in this test file: each file has its own copy of this module) and not yet
 * removed here. Replies with those it couldn't remove (a file still open), with why, and keeps them for the next call.
 */
export function removeTempDirs(): string[] {
  const failed: string[] = []
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      made.delete(dir)
    } catch (e) {
      failed.push(`${dir}: ${(e as Error).message}`)
    }
  }
  return failed
}
