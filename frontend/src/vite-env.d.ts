/// <reference types="vite/client" />

// Electron preload bridge (electron/preload.js). Present only in the packaged
// desktop app; undefined in the browser/dev — always feature-detect before use.
export {}
declare global {
  // Injected by vite.config.ts `define` from package.json / CITATION.cff.
  const __APP_VERSION__: string
  const __APP_RELEASE_DATE__: string

  interface Window {
    mmDesktop?: {
      isDesktop: boolean
      saveRecoveryKey: () => Promise<
        { ok: true; path: string } | { ok: false; reason: string; message?: string }
      >
    }
  }
}
