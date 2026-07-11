import { useCallback, useEffect, useState } from 'react'

/**
 * Renderer-side lens on the desktop auto-updater (#29 S3).
 *
 * The single source of truth is the main process's state machine
 * (`electron/updater.js`): it pushes the full state object on every transition,
 * and this hook subscribes to those pushes, seeding from `getState` so a
 * consumer that mounts after the launch check still sees the current state.
 *
 * Degrades to `state: null` (consumers render nothing) when:
 * - there is no bridge — browser dev, a server deploy, or a pre-1.2 desktop
 *   build whose preload doesn't expose `updates`;
 * - the bridge exists but main registered no handlers (electron-updater failed
 *   to load), so every invoke rejects.
 * An UNSUPPORTED install (dev run, read-only AppImage) is NOT null — it reports
 * `state.supported === false` so the UI can point at the release page (D9).
 */
export function useDesktopUpdates() {
  const bridge = window.mmDesktop?.updates ?? null
  const [state, setState] = useState<MMDesktopUpdateState | null>(null)

  useEffect(() => {
    if (!bridge) return
    // Subscribe FIRST so a transition between the seed read and the listener
    // registration can't be lost; a push always supersedes the (older) seed.
    const unsubscribe = bridge.onState(s => setState(s))
    let cancelled = false
    bridge.getState().then(
      s => {
        if (!cancelled) setState(prev => prev ?? s)
      },
      () => {
        // No handler in main — treat as bridge-absent rather than crash.
      },
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge])

  // The verbs also return the post-call state; applying it is belt-and-
  // suspenders on top of the push subscription (and makes tests deterministic).
  const check = useCallback(async () => {
    if (!bridge) return
    try {
      setState(await bridge.check())
    } catch {
      /* main handler missing — the null state already reflects it */
    }
  }, [bridge])

  const setAutoCheck = useCallback(
    async (enabled: boolean) => {
      if (!bridge) return
      try {
        setState(await bridge.setAutoCheck(enabled))
      } catch {
        /* as above */
      }
    },
    [bridge],
  )

  /**
   * Ask main to install the staged update. Resolves false when nothing is
   * staged (or the bridge is gone) — the CALLER owns the D4 pre-install backup
   * and must take it BEFORE invoking this; on success the app quits.
   */
  const install = useCallback(async (): Promise<boolean> => {
    if (!bridge) return false
    try {
      return await bridge.install()
    } catch {
      return false
    }
  }, [bridge])

  return { state, check, setAutoCheck, install }
}
