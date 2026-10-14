import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'

// The PF1007L frame runs Android System WebView 106 forever. cssTarget
// chrome61 keeps the minifier from emitting 4/8-digit hex colours, which the
// frame rejects. scripts/check-dist.mjs gates the built client on the rest.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: { target: 'chrome106', cssTarget: 'chrome61' },
  nitro: {
    // Starts the source refresh loops when the process starts, not on the
    // first request: a frame may be the first thing to ask, hours later.
    plugins: ['./src/nitro/startup.ts'],
  },
  plugins: [tanstackStart(), nitro(), viteReact()],
})
