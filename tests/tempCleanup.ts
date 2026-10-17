// Every test file's temp folders are removed when it ends (#995): tempDir() (tests/tempDir.ts) records each folder it
// makes, and this removes them after the file's own afterAll hooks (Vitest runs after-hooks in reverse order, and this,
// a setup file, registers first), once the file has closed its watchers and services. A test that removes its own
// folders sooner still may. One that can't be removed (a file a test left open) is reported, not failed: the sweep
// (npm run test:clean) takes it after a day.
import { afterAll } from 'vitest'
import { removeTempDirs } from './tempDir'

afterAll(() => {
  const failed = removeTempDirs()
  if (failed.length) console.warn(`Temp folders left behind (a file still open?):\n${failed.join('\n')}`)
})
