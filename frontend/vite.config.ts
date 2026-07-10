/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import path from 'path'

// The in-app "Cite Mixed Measures" panel needs the running version and the year that
// version was released, injected at build time rather than hardcoded into a component
// where they would silently rot.
//
// Both are read from `package.json` and ONLY from `package.json`: this file is also
// built by `frontend/Dockerfile`, whose docker-compose build context is `./frontend`,
// so anything above this directory (CITATION.cff, the repo root) does not exist there.
// CITATION.cff stays the public, machine-readable citation record and mirrors these two
// values; `backend/tests/test_version_agreement.py` fails when the mirrors disagree.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string; releaseDate?: string }
if (!pkg.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(pkg.releaseDate)) {
  // Fail loudly: a build that emits a wrong citation year is worse than one that stops.
  throw new Error('vite.config.ts: package.json needs `"releaseDate": "YYYY-MM-DD"`')
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_RELEASE_DATE__: JSON.stringify(pkg.releaseDate),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  // `vite preview` (production-build server) uses its own proxy block, separate
  // from `server.proxy`. Mirror it so `npm run build && npm run preview` can hit
  // the backend on :8000 — needed for prod-build smoke tests (fonts/CSP/etc).
  preview: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router-dom')) {
            return 'vendor'
          }
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'query'
          }
        },
      },
    },
  },
})
