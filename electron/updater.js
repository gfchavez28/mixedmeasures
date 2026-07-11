// Auto-update policy + state machine (#29 slab S2).
//
// No `electron` import: every collaborator (autoUpdater, fs, timers) is injected,
// so the whole thing is unit-testable headlessly — same convention as
// ./backend-process.js. main.js owns the GUI/IPC edges; this file owns the rules.
//
// Design decisions this file encodes (scoping doc D3/D7/D9/D10):
//   D3  notify, never force — check on launch and every 4h, download in the
//       background, install only on an explicit request or the next natural quit.
//   D7  a failed check/download is logged and swallowed. Offline is a NORMAL state
//       for this audience (field researchers, air-gapped IRB machines); it must
//       never surface an error dialog or throw into the main process.
//   D9  Linux AppImage self-replace only works when the AppImage file is writable.
//       Installed to /opt or on an immutable distro it is not — degrade to
//       "unsupported" and let the UI point at the release page.
//   D10 the check is one HTTPS request to github.com carrying version + platform.
//       It is user-controllable and defaults ON.

'use strict'

const path = require('node:path')

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h (D3)

const STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
})

/**
 * Can this AppImage actually be replaced in place (D9)?
 *
 * The APPIMAGE env var is set by the AppImage runtime and holds the path of the
 * .AppImage file itself. Absent ⇒ not running from an AppImage (e.g. a distro
 * package or a dev run), which we also treat as non-updatable: replacing a file
 * we did not install is not ours to do.
 *
 * #554d — THE DIRECTORY IS THE ONE THAT MATTERS, and it was never checked.
 * electron-updater's `AppImageUpdater.doInstall` does exactly two things:
 *
 *     unlinkSync(appImageFile)                       // delete the running AppImage
 *     execFileSync('mv', ['-f', staged, destination]) // move the new one into place
 *
 * Both are operations on the CONTAINING DIRECTORY — POSIX `unlink` needs write+exec
 * on the parent dir and does not care about the file's own mode, and `mv` writes a
 * new entry into that same dir. So the original gate (W_OK on the FILE) tested
 * nearly the wrong thing: a user-owned AppImage sitting in a root-owned directory
 * reported `supported: true`, downloaded the update in full, and then threw EACCES
 * at `unlinkSync` on every quit — forever, invisibly (D7 swallows the error).
 *
 * We require BOTH bits. The dir check is the necessary one; the file check is kept
 * because it fails CLOSED in the sticky-dir case (`/tmp`-style +t, where you may
 * only unlink files you own) and because degrading to "unsupported" costs the user
 * nothing but a link to the release page.
 */
function appImageIsUpdatable({ env, fs }) {
  const appImagePath = env && env.APPIMAGE
  if (!appImagePath) return false
  try {
    fs.accessSync(appImagePath, fs.constants.W_OK)
    fs.accessSync(path.dirname(appImagePath), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Can this installation update itself in place at all?
 *
 * Dev runs are excluded: electron-updater throws on an unpackaged app, and a dev
 * build has no signature to verify against.
 */
function canAutoUpdate({ isPackaged, platform, env, fs }) {
  if (!isPackaged) return false
  if (platform === 'linux') return appImageIsUpdatable({ env, fs })
  return platform === 'darwin' || platform === 'win32'
}

/**
 * Read the "check automatically" preference. Default ON (D10) — a missing,
 * empty, or corrupt config must not silently disable security updates, so every
 * failure path returns true. Only an explicit `false` turns it off.
 */
function readAutoCheck({ configPath, fs }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return parsed.autoCheck !== false
  } catch {
    return true
  }
}

/** Persist the preference. Best-effort: a read-only userData dir must not crash the app. */
function writeAutoCheck(autoCheck, { configPath, fs, log = () => {} }) {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ autoCheck: Boolean(autoCheck) }, null, 2))
    return true
  } catch (err) {
    log(`updater: could not persist autoCheck (${(err && err.message) || err})`)
    return false
  }
}

/**
 * Wire electron-updater's events into a small state machine and expose the four
 * verbs main.js needs. Never throws; never rejects.
 *
 * `emit(state)` is called on EVERY transition so the renderer can render from a
 * single source of truth rather than replaying events.
 */
function createUpdaterController({
  autoUpdater,
  supported,
  autoCheck,
  emit = () => {},
  log = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = CHECK_INTERVAL_MS,
}) {
  let state = {
    status: supported ? STATUS.IDLE : STATUS.UNSUPPORTED,
    version: null,
    percent: 0,
    message: null,
    autoCheck: Boolean(autoCheck),
    supported: Boolean(supported),
  }
  let timer = null

  function setState(patch) {
    state = { ...state, ...patch }
    emit(state)
  }

  if (supported) {
    // Background download (D3): the user is never blocked, and "Restart to update"
    // is instant because the bytes are already staged.
    autoUpdater.autoDownload = true
    // The natural-quit install (D3). On POSIX the quit path SIGTERMs the backend,
    // which writes its shutdown backup; on Windows the quit path hard-kills it —
    // but that is true of every Windows quit today, so an update is no worse. The
    // explicit "Restart to update" path takes a fresh backup first (D4).
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => setState({ status: STATUS.CHECKING, message: null }))
    autoUpdater.on('update-available', (info) =>
      setState({ status: STATUS.DOWNLOADING, version: (info && info.version) || null, percent: 0 }),
    )
    autoUpdater.on('update-not-available', () => setState({ status: STATUS.IDLE, version: null, percent: 0 }))
    autoUpdater.on('download-progress', (p) =>
      setState({ status: STATUS.DOWNLOADING, percent: Math.round((p && p.percent) || 0) }),
    )
    autoUpdater.on('update-downloaded', (info) =>
      setState({ status: STATUS.DOWNLOADED, version: (info && info.version) || null, percent: 100 }),
    )
    // D7: offline / rate-limited / unreachable is normal. Log, mark, move on.
    //
    // #554c — the message must name what ACTUALLY failed. This handler used to set
    // "Could not check for updates." unconditionally, so a download dying at 80%
    // (disk full, connection dropped mid-transfer) told the user their *check* had
    // failed and that being offline was fine — advice for a different problem.
    // `state` here is still the PRE-error status, which is exactly the context we
    // need: DOWNLOADING ⇒ the bytes failed, anything else ⇒ the check failed.
    //
    // The full user-facing sentence is composed HERE rather than in the renderer:
    // the main process is the only side that knows which phase died, and the
    // renderer used to staple "If you're offline, that's fine" onto every message.
    autoUpdater.on('error', (err) => {
      log(`updater: ${(err && err.message) || err}`)
      const downloadFailed =
        state.status === STATUS.DOWNLOADING || state.status === STATUS.DOWNLOADED
      setState({
        status: STATUS.ERROR,
        message: downloadFailed
          ? 'Could not download the update. It will try again later — if your disk is full, free some space first.'
          : "Could not check for updates. If you're offline, that's fine — it will try again later.",
        // A stale 80% must not survive into the next attempt's progress UI.
        percent: 0,
      })
    })
  }

  async function check({ manual = false } = {}) {
    if (!supported) return state
    // A manual "Check now" must work even with auto-check off (D10) — the toggle
    // governs the BACKGROUND check, not the user's explicit request.
    if (!manual && !state.autoCheck) return state
    // Don't stack checks: a 4h tick landing on a running download would reset UI state.
    if (state.status === STATUS.DOWNLOADING || state.status === STATUS.DOWNLOADED) return state
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // checkForUpdates rejects AND emits 'error'; swallow so no unhandled rejection
      // reaches the main process. The 'error' handler already set the state.
      log(`updater: check failed (${(err && err.message) || err})`)
    }
    return state
  }

  function schedule() {
    if (timer) clearIntervalFn(timer)
    timer = null
    if (!supported || !state.autoCheck) return
    timer = setIntervalFn(() => { void check() }, intervalMs)
    // Don't hold the event loop open on quit.
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    getState: () => state,

    start() {
      if (!supported) return
      schedule()
      if (state.autoCheck) void check()
    },

    stop() {
      if (timer) clearIntervalFn(timer)
      timer = null
    },

    check,

    setAutoCheck(next) {
      setState({ autoCheck: Boolean(next) })
      schedule()
      if (state.autoCheck) void check()
      return state
    },

    /**
     * Install the staged update. Returns false when nothing is staged — the caller
     * (renderer) must not be able to trigger a restart into nothing.
     *
     * quitAndInstall() calls app.quit() internally, so the existing
     * `before-quit` → stopBackend path runs and the backend shuts down properly (D4).
     */
    install() {
      if (!supported || state.status !== STATUS.DOWNLOADED) return false
      autoUpdater.quitAndInstall()
      return true
    },
  }
}

module.exports = {
  CHECK_INTERVAL_MS,
  STATUS,
  appImageIsUpdatable,
  canAutoUpdate,
  readAutoCheck,
  writeAutoCheck,
  createUpdaterController,
}
