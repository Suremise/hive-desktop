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
          'hive-mcp': resolve(__dirname, 'src/main/mcp/hive-mcp.ts'),
          'hive-progress': resolve(__dirname, 'src/main/progressReporters/hive-progress.ts')
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
    plugins: [
      react(),
      {
        // Codicons' base rule (.codicon[class*='codicon-'] { font: 16px/1 codicon }) comes twice: from
        // @vscode/codicons at start, and from Monaco when an editor first loads. As plain CSS it ties with Hive's own
        // icon sizes (.activity-btn .codicon …), so whichever loaded last won and every shell icon fell to 16px. Both
        // copies go in a cascade layer, below Hive's (unlayered) styles: Hive's icon rules win whatever loads when.
        name: 'hive-codicons-layer',
        enforce: 'pre',
        transform(code: string, id: string) {
          if (!/[\\/](?:@vscode[\\/]codicons[\\/]dist|ui[\\/]codicons[\\/]codicon)[\\/]codicon\.css(?:\?|$)/.test(id)) return null
          return { code: `@layer codicons {\n${code}\n}\n`, map: null }
        }
      },
      {
        // The dev server's hot reload needs ws: and localhost; a build connects to nothing.
        name: 'hive-production-csp',
        apply: 'build',
        transformIndexHtml: (html: string) => html.replace(" connect-src 'self' ws: http://localhost:*", " connect-src 'self'")
      }
    ],
    build: { chunkSizeWarningLimit: 8000 }
  }
})
