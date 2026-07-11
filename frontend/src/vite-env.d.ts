/// <reference types="vite/client" />

// Electron preload bridge (electron/preload.js). Present only in the packaged
// desktop app; undefined in the browser/dev — always feature-detect before use.
export {}
declare global {
  // Injected by vite.config.ts `define` from package.json / CITATION.cff.
  const __APP_VERSION__: string
  const __APP_RELEASE_DATE__: string

  // Mirrors the state object emitted by electron/updater.js (#29). `available`
  // is declared there but never emitted (update-available goes straight to
  // downloading because downloads are automatic); kept for completeness.
  interface MMDesktopUpdateState {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
    version: string | null
    percent: number
    message: string | null
    autoCheck: boolean
    supported: boolean
  }

  interface Window {
    mmDesktop?: {
      isDesktop: boolean
      saveRecoveryKey: () => Promise<
        { ok: true; path: string } | { ok: false; reason: string; message?: string }
      >
      // Absent in desktop builds older than 1.2.0 — feature-detect the whole
      // object, not just mmDesktop. Verbs only: the renderer can never hand the
      // main process a URL, path, or version to install (electron/preload.js).
      updates?: {
        getState: () => Promise<MMDesktopUpdateState>
        check: () => Promise<MMDesktopUpdateState>
        setAutoCheck: (enabled: boolean) => Promise<MMDesktopUpdateState>
        install: () => Promise<boolean>
        onState: (callback: (state: MMDesktopUpdateState) => void) => () => void
      }
    }
  }
}
