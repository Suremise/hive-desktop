import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'hive-mcp': resolve(__dirname, 'src/main/mcp/hive-mcp.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@docs': resolve(__dirname, 'docs'),
        '@root': resolve(__dirname)
      }
    },
    plugins: [react()],
    build: { chunkSizeWarningLimit: 8000 }
  }
})
