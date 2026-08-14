import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  DEFAULT_ZOOM,
  readStoredZoom,
  writeStoredZoom,
  snapZoom,
  zoomIn as stepIn,
  zoomOut as stepOut,
  zoomIntentFromKey,
} from './zoom'

/**
 * Applies and persists the text-size preference (#697).
 *
 * Mirrors `ThemeProvider`: state in `localStorage`, applied on mount, one provider
 * at the app root. The difference is that applying it needs the main process —
 * `webFrame` is unreachable under `sandbox: true` + `contextIsolation: true`, so the
 * factor goes over the `mmDesktop.setZoomFactor` bridge and main clamps it.
 *
 * **In a browser this is inert by design.** `window.mmDesktop` is undefined in dev
 * and in the source checkout, and the browser's own Ctrl+= already works there — so
 * binding our handler would only shadow a working native affordance with a
 * non-working one. `isSupported` gates both the keyboard listener and the Settings
 * control, the same way `SoftwareUpdateSection` renders nothing outside the app.
 */
interface ZoomContextValue {
  /** The current factor (1.0 = 100%). */
  zoom: number
  /** True only in the packaged desktop app, where zoom can actually be applied. */
  isSupported: boolean
  setZoom: (factor: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

const ZoomContext = createContext<ZoomContextValue | undefined>(undefined)

function desktopBridge(): { setZoomFactor?: (f: number) => Promise<number> } | undefined {
  return (window as { mmDesktop?: { setZoomFactor?: (f: number) => Promise<number> } }).mmDesktop
}

export function ZoomProvider({ children }: { children: React.ReactNode }) {
  const isSupported = typeof desktopBridge()?.setZoomFactor === 'function'
  const [zoom, setZoomState] = useState<number>(() => (isSupported ? readStoredZoom() : DEFAULT_ZOOM))
  const zoomRef = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  /**
   * Send a factor to main and reconcile if main clamped it differently.
   *
   * Deliberately does NOT setState for the value it was handed — the caller has
   * already done that (or, on mount, the initial state IS that value). Keeping the
   * push and the state write separate is what lets the mount effect run without
   * setting state at all.
   */
  const pushToMain = useCallback((factor: number) => {
    void desktopBridge()
      ?.setZoomFactor?.(factor)
      .then((applied) => {
        // Main is the authority: if it ever clamps differently from us, adopt its
        // answer rather than leaving the Settings control disagreeing with the window.
        if (typeof applied === 'number' && applied !== factor) {
          setZoomState(applied)
          writeStoredZoom(applied)
        }
      })
      .catch(() => { /* the window keeps its current zoom; nothing to recover */ })
  }, [])

  const apply = useCallback((next: number) => {
    const snapped = snapZoom(next)
    setZoomState(snapped)
    writeStoredZoom(snapped)
    pushToMain(snapped)
  }, [pushToMain])

  // Re-apply on mount. Electron does not persist the zoom factor across launches, so
  // without this the stored preference would be silently ignored every restart —
  // which for an accessibility setting is the same as not having it. No setState
  // here: `useState`'s initialiser already read the same value.
  useEffect(() => {
    if (!isSupported) return
    const stored = readStoredZoom()
    if (stored !== DEFAULT_ZOOM) pushToMain(stored)
  }, [isSupported, pushToMain])

  // Restore the accelerators the missing `viewMenu` unbound. Bound once, reading
  // through a ref so the listener never goes stale (the `optionsRef` pattern the
  // workbench keyboard layer uses).
  useEffect(() => {
    if (!isSupported) return
    const onKeyDown = (e: KeyboardEvent) => {
      const intent = zoomIntentFromKey(e)
      if (!intent) return
      e.preventDefault()
      if (intent === 'in') apply(stepIn(zoomRef.current))
      else if (intent === 'out') apply(stepOut(zoomRef.current))
      else apply(DEFAULT_ZOOM)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSupported, apply])

  const value: ZoomContextValue = {
    zoom,
    isSupported,
    setZoom: apply,
    zoomIn: useCallback(() => apply(stepIn(zoomRef.current)), [apply]),
    zoomOut: useCallback(() => apply(stepOut(zoomRef.current)), [apply]),
    resetZoom: useCallback(() => apply(DEFAULT_ZOOM), [apply]),
  }

  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useZoom(): ZoomContextValue {
  const ctx = useContext(ZoomContext)
  if (!ctx) throw new Error('useZoom must be used within ZoomProvider')
  return ctx
}
