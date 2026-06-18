/// <reference types="vite/client" />

// Electron preload bridge (electron/preload.js). Present only in the packaged
// desktop app; undefined in the browser/dev — always feature-detect before use.
export {}
declare global {
  interface Window {
    mmDesktop?: {
      isDesktop: boolean
      saveRecoveryKey: () => Promise<
        { ok: true; path: string } | { ok: false; reason: string; message?: string }
      >
    }
  }
}
