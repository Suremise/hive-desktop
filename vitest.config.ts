import { fileURLToPath } from 'url'
import { configDefaults, defineConfig } from 'vitest/config'
import { progressWanted, VitestProgress } from './tests/progressReport.mts'

export default defineConfig({
  // Hive's main-process modules import Electron; unit tests use a stub (no Electron binary needed, e.g. in CI). They
  // also use Electron's original-fs (no .asar handling, #246), which is Node's fs outside Electron: vi.mock('fs') and
  // vi.mock('fs/promises') reach them too.
  resolve: { alias: { electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url)), 'original-fs': 'fs' } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // fs.watch watches real paths, so a short (8.3) temp folder can't trip Node's libuv (tests/watchRealPaths.ts, #389), and
    // git runs with no global config, as on GitHub's runner (tests/noGlobalGit.ts, #448).
    setupFiles: ['tests/watchRealPaths.ts', 'tests/noGlobalGit.ts'],
    // Under load (e2e sets, scenario runs and other agents' tests on the same machine), Vitest's defaults (5 s a test, a
    // worker per core) made timing-sensitive tests fail that pass alone (#189, #196, #204): half the cores, so a full run
    // beside an e2e set leaves it room, and longer limits for a slow moment (a test that waits for something still says
    // how long it waits). A test that needs more says so itself.
    maxWorkers: '50%',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Run inside a Hive agent's session: the files' progress in Hive's Progress panel (tests/progressReport.mts), added to
    // Vitest's own reporters (which it picks by where it runs: minimal for a coding agent), so the output is unchanged.
    ...(progressWanted() ? { reporters: [...configDefaults.reporters, new VitestProgress()] } : {})
  }
})
