/**
 * Page-zoom bounds for the desktop shell (#697).
 *
 * ## Why this exists
 *
 * `applyAppMenu()` builds the macOS menu from `appMenu`/`editMenu`/`windowMenu` and
 * omits `viewMenu`; every other platform gets `Menu.setApplicationMenu(null)`.
 * Electron binds the Cmd/Ctrl +/-/0 zoom accelerators to the `zoomIn`/`zoomOut`/
 * `resetZoom` **MenuItem roles**, so removing the menu unbound the shortcuts — and
 * there was no `webFrame.setZoomFactor` fallback anywhere in the tree. The packaged
 * app therefore had **no mechanism at all** for enlarging text, which engages WCAG
 * 2.2 SC 1.4.4 Resize Text (Level AA) for an audience of applied researchers,
 * evaluators and faculty reading a 12–13px type scale.
 *
 * The comment on `applyAppMenu` is honest about its reasoning — the default Electron
 * menu "looks dev-flavored and out of place", which is a fair aesthetic call. The
 * mistake was that hiding the *menu* also unbound the *accelerators*, which is not
 * visible from the code.
 *
 * ## Why the renderer owns the state and this module only clamps
 *
 * Zoom is persisted in the renderer's `localStorage` (`mm-zoom`), exactly like the
 * theme (`mm-theme`) — and that works in the packaged app specifically because the
 * backend port is stable across launches, which `main.js` already does on purpose so
 * origin-keyed localStorage survives (an internal audit). So no new config file is
 * needed, and **no key is added to `mm-updater.json`** — `writeAutoCheck` stringifies
 * the whole object, so a zoom key parked there would be wiped every time the user
 * toggled auto-update.
 *
 * Main still clamps, because a renderer value is untrusted input: `setZoomFactor`
 * accepts absurd numbers and a NaN would leave the window in an unusable state the
 * user could not click their way out of.
 *
 * ## Why not CSS
 *
 * A root `font-size` change does nothing here — the app is px-dominated (~2,300
 * sizing utilities at ≤13px), so rem-scaling would move almost nothing. CSS `zoom`
 * on a wrapper *would* scale px, but it perturbs `getBoundingClientRect`, which
 * `react-virtuoso` measures for every virtualised list and the sticky table headers
 * depend on. Electron's native zoom is the same code path as browser Ctrl+= and
 * Chromium handles all of that correctly.
 */

/** Smallest allowed factor. Below this the 8–10px badge text is unreadable. */
const MIN_ZOOM_FACTOR = 0.8

/**
 * Largest allowed factor. 2.0 is not arbitrary: SC 1.4.4 requires text to scale to
 * **200%** without loss of content or function, so the ceiling has to reach it.
 */
const MAX_ZOOM_FACTOR = 2.0

/** What a fresh install renders at, and what Reset returns to. */
const DEFAULT_ZOOM_FACTOR = 1.0

/**
 * Coerce an untrusted value to a usable zoom factor.
 *
 * Non-numbers, NaN and ±Infinity fall back to the default rather than clamping —
 * `Math.min/max` would happily pass NaN straight through (`Math.max(0.8, NaN)` is
 * NaN), which is the case that would actually brick the window.
 */
function clampZoomFactor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR
  if (value < MIN_ZOOM_FACTOR) return MIN_ZOOM_FACTOR
  if (value > MAX_ZOOM_FACTOR) return MAX_ZOOM_FACTOR
  return value
}

module.exports = {
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  DEFAULT_ZOOM_FACTOR,
  clampZoomFactor,
}
