import { fileURLToPath } from 'url'
import { configDefaults, defineConfig } from 'vitest/config'
import { progressWanted, VitestProgress } from './tests/progressReport.mts'

export default defineConfig({
  // Hive's main-process modules import Electron; unit tests use a stub (no Electron binary needed, e.g. in CI).
  resolve: { alias: { electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Run inside a Hive agent's session: the files' progress in Hive's Progress panel (tests/progressReport.mts), added to
    // Vitest's own reporters (which it picks by where it runs: minimal for a coding agent), so the output is unchanged.
    ...(progressWanted() ? { reporters: [...configDefaults.reporters, new VitestProgress()] } : {})
  }
})
