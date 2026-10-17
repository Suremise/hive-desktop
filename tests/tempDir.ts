// Tests' temp folders, by their long, real paths (#448). GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, the
// 8.3 short form, while Hive and git resolve real paths (#389): a test comparing a folder it made under os.tmpdir() with
// one Hive or git gave back passed on every machine but CI's. Tests make their folders here instead, and one that needs
// another name for a folder (an 8.3 name, a junction) makes it on purpose with pathAliases.ts. tests/tempDir.test.ts
// fails on any other use of os.tmpdir() in the tests.
//
// The folder is in the test area, %LOCALAPPDATA%\hive-test\tmp (#992), not %TEMP%: Hive's Antivirus scanning setting
// covers the test area, and thousands of tests making and removing folders in %TEMP% kept Defender busy. Each test
// removes its own; npm run test:clean (tests/e2e/clean.mjs) sweeps what a stopped run left after a day. Where
// LOCALAPPDATA is unset (off Windows), it's in the temp folder. LOCALAPPDATA is read once, as this loads: a test that
// changes it later doesn't move the folder.
import { mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const base = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'tmp')
let root: string | undefined

/** The tests' temp folder (hive-test\tmp) by its real, long path, made if it isn't there. */
export function tempRoot(): string {
  if (root) return root
  mkdirSync(base, { recursive: true })
  return (root = realpathSync.native(base))
}

/** A new, empty folder in the temp folder, named `prefix` and six random characters, by its real, long path. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tempRoot(), prefix))
}
