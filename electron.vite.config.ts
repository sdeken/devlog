import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@devlog/core': resolve('packages/core/src'), '@devlog/extension-api': resolve('packages/extension-api/src') }
    },
    build: {
      rollupOptions: {
        // The extension process is its own, self-contained file (see hostProcess.ts).
        input: { index: resolve('src/main/index.ts'), extensionHost: resolve('src/main/extensions/hostProcess.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@devlog/core': resolve('packages/core/src') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@devlog/core': resolve('packages/core/src')
      }
    },
    plugins: [react()]
  }
})
