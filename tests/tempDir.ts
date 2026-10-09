// Tests' temp folders, by their long, real paths (#448). GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, the
// 8.3 short form, while Hive and git resolve real paths (#389): a test comparing a folder it made under os.tmpdir() with
// one Hive or git gave back passed on every machine but CI's. Tests make their folders here instead, and one that needs
// another name for a folder (an 8.3 name, a junction) makes it on purpose with pathAliases.ts. tests/tempDir.test.ts
// fails on any other use of os.tmpdir() in the tests.
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let root: string | undefined

/** The temp folder by its real, long path. */
export function tempRoot(): string {
  return (root ??= realpathSync.native(tmpdir()))
}

/** A new, empty folder in the temp folder, named `prefix` and six random characters, by its real, long path. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tempRoot(), prefix))
}
