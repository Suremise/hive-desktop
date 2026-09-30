import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Hive's main-process modules import Electron; unit tests use a stub (no Electron binary needed, e.g. in CI).
  resolve: { alias: { electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
