/**
 * Test setup: `localStorage` is jsdom's, whatever Node is running (#996).
 *
 * 🔴 **Node 25 ships its own `globalThis.localStorage`** (Web Storage, on by
 * default) and it SHADOWS jsdom's inside vitest's jsdom environment. Without a
 * `--localstorage-file` it is an object with no methods, so every test touching
 * storage failed with `localStorage.clear is not a function` — 18 red tests in
 * two unrelated files that read exactly like a product defect, and cost parts of
 * three sessions. Measured with a probe, 2026-09-22:
 *
 *   Node 24.18.0 → globalThis.localStorage.clear: function (jsdom's Storage)
 *   Node 25.3.0  → globalThis.localStorage.clear: undefined
 *                  jsdom.window.localStorage:     Storage (still there)
 *
 * ⚠️ **Why not `--no-experimental-webstorage`?** It works today (36/36 on Node
 * 25), but it is a flag for an EXPERIMENTAL feature: the day Web Storage
 * stabilises the flag can be removed, and an unknown flag in NODE_OPTIONS stops
 * every test run from starting. Re-pointing the global at jsdom's own object
 * depends on nothing but jsdom — which is the environment these tests declare.
 *
 * ⚠️ **Why not just pin Node to 24?** The pin was `>=24` and CI runs 24, so a
 * pin would only move the break to the Node 26 upgrade (26 becomes LTS in
 * October 2026) — the #635 shape, a toolchain move that finds its own breakage.
 *
 * It replaces the global ONLY when it is not already jsdom's, so on Node 24 it
 * is a no-op. `sessionStorage` was measured unaffected and is left alone.
 */
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window

if (jsdomWindow && globalThis.localStorage !== jsdomWindow.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => jsdomWindow.localStorage,
  })
}
