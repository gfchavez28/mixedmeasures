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
})
