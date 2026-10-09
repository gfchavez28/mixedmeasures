// Run the app only in the instance that holds the single-instance lock (#1141).
//
// Pure (Electron-free) so it is unit-testable without a runtime or a display — the
// same split as backend-process.js / fatal-error.js. main.js passes the real `app`.

/**
 * Claim the lock, then register the app's lifecycle — or quit without registering
 * anything at all.
 *
 * 🔴 **`app.quit()` does not stop the module that called it.** main.js used to call
 * `requestSingleInstanceLock()` and `app.quit()` at the top, and then — further down
 * the same file — register `app.whenReady().then(startup)` and its event handlers
 * unconditionally. A refused second launch therefore ran `startup()` ~90 ms later:
 * it found the saved port busy, rewrote `mm-port`, spawned a SECOND backend on the
 * same database, and exited, leaving that backend re-parented and running (measured
 * in real Electron 44.5.1 by the 2026-10-08 audit). `before-quit` had been registered
 * after the quit and `backend` was still null, so nothing ever signalled it.
 *
 * Electron's documented pattern is the cure: everything the app does lives inside
 * `register`, which runs only when the lock is held.
 *
 * Returns whether this instance is the primary one.
 */
function runAsPrimaryInstance({ app, register }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  register()
  return true
}

module.exports = { runAsPrimaryInstance }
