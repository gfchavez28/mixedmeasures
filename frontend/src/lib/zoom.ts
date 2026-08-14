/**
 * Text-size (page zoom) preference for the desktop app (#697).
 *
 * The packaged app had **no way to enlarge text at all**: `applyAppMenu()` omits
 * `viewMenu`, and Electron binds the Cmd/Ctrl +/-/0 accelerators to the
 * `zoomIn`/`zoomOut`/`resetZoom` MenuItem roles, so hiding the menu unbound the
 * shortcuts — with no `webFrame.setZoomFactor` fallback anywhere. That engages WCAG
 * 2.2 SC 1.4.4 Resize Text (Level AA), which is why the ceiling is 200%.
 *
 * This module is the pure half: the step ladder and the arithmetic. The React
 * binding lives in `zoom-context.tsx`.
 *
 * ## Design notes
 *
 * - **The renderer owns the preference**, persisted in `localStorage` exactly like
 *   the theme. That works in the packaged app because `main.js` keeps the backend
 *   port stable across launches specifically so origin-keyed localStorage survives.
 *   No new config file, and deliberately NOT a key in `mm-updater.json` — its
 *   `writeAutoCheck` stringifies the whole object, so anything parked there is wiped
 *   whenever the user toggles auto-update.
 * - **Discrete steps, not a slider.** Chromium's own zoom is stepped, arbitrary
 *   factors produce fractional-pixel text that renders muddily, and a step ladder
 *   makes `+`/`−` predictable. The ladder is denser below 150% because that is where
 *   people actually adjust.
 * - **The bounds mirror `electron/zoom.js`** and are agreement-tested against it, so
 *   the renderer can never offer a step main would silently clamp.
 */

/**
 * The offered zoom factors. 1.0 must be present (it is the default and the Reset
 * target) and 2.0 must be the last (SC 1.4.4's 200%).
 */
export const ZOOM_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0] as const

export const DEFAULT_ZOOM = 1.0
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

export const ZOOM_STORAGE_KEY = 'mm-zoom'

/** Render a factor the way the control labels it. `1.25` → `"125%"`. */
export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`
}

/**
 * Snap an arbitrary factor to the nearest offered step.
 *
 * Junk (NaN, ±Infinity, non-numbers) resolves to the default rather than snapping —
 * `Math.abs(NaN - x)` is NaN, so a naive nearest-search would return whichever step
 * happened to be first. Same reasoning as `electron/zoom.js::clampZoomFactor`.
 */
export function snapZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM
  let best: number = ZOOM_STEPS[0]
  let bestDelta = Math.abs(value - best)
  for (const step of ZOOM_STEPS) {
    const delta = Math.abs(value - step)
    if (delta < bestDelta) {
      best = step
      bestDelta = delta
    }
  }
  return best
}

/** The next step up, or the current one at the ceiling (never wraps). */
export function zoomIn(current: number): number {
  const i = ZOOM_STEPS.indexOf(snapZoom(current) as (typeof ZOOM_STEPS)[number])
  return ZOOM_STEPS[Math.min(i + 1, ZOOM_STEPS.length - 1)]
}

/** The next step down, or the current one at the floor (never wraps). */
export function zoomOut(current: number): number {
  const i = ZOOM_STEPS.indexOf(snapZoom(current) as (typeof ZOOM_STEPS)[number])
  return ZOOM_STEPS[Math.max(i - 1, 0)]
}

/** Read the stored preference. Any junk (or no storage at all) reads as default. */
export function readStoredZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY)
    if (raw === null) return DEFAULT_ZOOM
    return snapZoom(Number(raw))
  } catch {
    // localStorage throws in private-mode/sandboxed contexts. A zoom preference is
    // never worth breaking the app over.
    return DEFAULT_ZOOM
  }
}

export function writeStoredZoom(factor: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(factor))
  } catch {
    /* see readStoredZoom */
  }
}

/**
 * Is this keystroke a zoom command?
 *
 * Returns the intent, or `null` when the event is not ours.
 *
 * ⚠️ Verified against the global chord layer before writing this: the numeric
 * chord state machine in `useCodeChordShortcuts` guards its digit branch with
 * `!e.ctrlKey && !e.metaKey && !e.altKey`, so Ctrl/Cmd+0 cannot be mistaken for a
 * code shortcut. It does clear a pending chord, which is the correct behaviour for
 * any non-chord key.
 *
 * `+` is matched by several codes because the physical key reports differently
 * across layouts and with Shift: `=`/`+` on US, `Add` on the numpad.
 */
export function zoomIntentFromKey(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): 'in' | 'out' | 'reset' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  if (e.key === '=' || e.key === '+' || e.key === 'Add') return 'in'
  if (e.key === '-' || e.key === '_' || e.key === 'Subtract') return 'out'
  if (e.key === '0') return 'reset'
  return null
}
