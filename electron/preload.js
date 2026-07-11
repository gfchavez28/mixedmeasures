// Minimal, hardened context bridge. sandbox:true + contextIsolation:true mean
// the renderer (the SPA) gets no Node access; we expose only a tiny, explicit
// surface. Keep it minimal.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mmDesktop', {
  isDesktop: true,
  // Trigger-only recovery-key export (Phase 5, decision C). The renderer NEVER
  // sees the key — this invoke runs the entire read→save-dialog→write flow in the
  // main process and resolves to { ok: true, path } | { ok: false, reason }.
  saveRecoveryKey: () => ipcRenderer.invoke('encryption:saveRecoveryKey'),

  // Auto-update (#29 S2). Verbs only — the renderer can request a check, flip the
  // preference, and ask to install a STAGED update; it can never hand the main
  // process a URL, a path, or a version to install.
  //
  // `install()` must be called only after a fresh backup has been taken (D4).
  updates: {
    getState: () => ipcRenderer.invoke('update:getState'),
    check: () => ipcRenderer.invoke('update:check'),
    setAutoCheck: (enabled) => ipcRenderer.invoke('update:setAutoCheck', Boolean(enabled)),
    install: () => ipcRenderer.invoke('update:install'),
    // Returns an unsubscribe fn; the event object is never forwarded to the renderer.
    onState: (callback) => {
      const handler = (_event, state) => callback(state)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    },
  },
})
