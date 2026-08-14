// Mixed Measures desktop shell (Electron main process).
//
// Lifecycle: pick a free loopback port → spawn the frozen PyInstaller backend
// with absolute per-user data paths injected → health-gate the window load →
// show the SPA (served same-origin by the backend at http://127.0.0.1:<port>/).
// On quit: SIGTERM the backend so its shutdown backup runs, then hard-kill.
//
// The non-GUI logic lives in ./backend-process.js (unit-tested headlessly).

const { app, BrowserWindow, Menu, clipboard, dialog, shell, safeStorage, ipcMain, session } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const {
  DB_FILE_NAME,
  resolveAppPort,
  resolveBackendExe,
  buildSpawnEnv,
  waitForHealth,
  stopBackend,
} = require('./backend-process')
const { resolveKey, saveRecoveryKeyToFile } = require('./key-manager')
const { clampZoomFactor } = require('./zoom')
const { createFatalLineCollector, crashDialogText, crashDialogClipboardText } = require('./fatal-error')
const {
  canAutoUpdate,
  readAutoCheck,
  writeAutoCheck,
  createUpdaterController,
} = require('./updater')

const KEY_FILE_NAME = 'mm-encryption.key'
const PORT_FILE_NAME = 'mm-port'
const UPDATER_CONFIG_NAME = 'mm-updater.json'

// Name the running app "Mixed Measures" so app.getPath('userData') resolves to
// %APPDATA%/Mixed Measures (macOS: ~/Library/Application Support/Mixed Measures)
// instead of the internal package name "mixedmeasures-desktop". electron-builder's
// build.productName only controls the installer/exe, NOT the runtime data folder —
// that comes from app.getName(), which falls back to package.json "name" unless set.
// MUST run before requestSingleInstanceLock() and any getPath('userData') below
// (the path is resolved on first access and reflects the name at that moment).
// Pre-1.0 only: changing this after release would strand users' existing data.
app.setName('Mixed Measures')

// Two app instances → two uvicorn writers on one SQLite file → corruption.
// Hold a single-instance lock; a second launch just focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// How long 'exit' waits for stdio to drain before reporting without it (#716).
// Short enough to be invisible next to a crash dialog, long enough that the fatal
// line — already written and flushed before the process died — has arrived.
const STDIO_DRAIN_GRACE_MS = 250

let backend = null
let backendExited = false
let isQuitting = false
// #724: module scope on purpose. These used to live inside startBackend's closure, so
// the startup `catch` could not see them — it showed its own generic dialog, called
// app.quit(), and `isQuitting` then suppressed the fatal one. Whichever path arrives
// first now reports THE SAME dialog, once.
let fatalCollector = null
let crashReported = false
let mainWindow = null
let splashWindow = null
let updater = null

function applyAppMenu() {
  // The app is a single-purpose tool; the default Electron menu (Reload /
  // Toggle DevTools / etc.) looks dev-flavored and out of place. Hide the
  // in-window menu bar on Windows/Linux. macOS keeps a minimal menu because
  // standard shortcuts (Cmd+C/V, Cmd+Q) are routed through the system menu bar
  // there — removing it entirely would break copy/paste/quit.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    )
  } else {
    Menu.setApplicationMenu(null)
  }
}

/**
 * Resolve the at-rest encryption key (Model A) before the backend spawns.
 * Returns the key hex, or null to run plaintext. Throws on a hard error (a
 * stored key exists but is inaccessible) — caught by startup() → error dialog.
 */
function resolveEncryptionKey() {
  // At-rest encryption is a packaged-build feature (plan §2.3: "ON only in
  // packaged builds"). Dev Electron stays plaintext — matching `uvicorn` dev and
  // keeping the dev DB inspectable — unless explicitly forced for testing.
  if (!app.isPackaged && process.env.MM_FORCE_ENCRYPTION !== '1') return null
  const keyFilePath = path.join(app.getPath('userData'), KEY_FILE_NAME)
  const dbFilePath = path.join(app.getPath('userData'), DB_FILE_NAME)
  const result = resolveKey({ safeStorage, keyFilePath, dbFilePath, fs, randomBytes })
  if (result.mode === 'plaintext') {
    // Loud, non-silent in both branches: we will NOT store a key via an insecure
    // backend, and we will NOT mint a key over an existing plaintext DB (it
    // would make that data unreadable — an internal audit).
    if (result.reason === 'existing_plaintext_db') {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Existing data is unencrypted',
        message: 'Your Mixed Measures data was created without encryption, so it will stay unencrypted on this device.',
        detail: 'Turning encryption on for existing data (encrypt-in-place) is not available yet. Your data remains protected by your operating-system account; for at-rest protection, enable full-disk encryption (FileVault / BitLocker).',
        buttons: ['Continue'],
        defaultId: 0,
      })
    } else {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'At-rest encryption unavailable',
        message: 'Mixed Measures could not access a system keyring, so the database will be stored unencrypted on this device.',
        detail: 'Your data is still protected by your operating-system account. For at-rest protection, enable full-disk encryption (FileVault / BitLocker). On Linux, install or start a Secret Service (e.g. GNOME Keyring) and relaunch to turn on encryption.',
        buttons: ['Continue'],
        defaultId: 0,
      })
    }
    return null
  }
  return result.keyHex
}

function startBackend(port, encryptionKeyHex, loopbackToken) {
  const exe = resolveBackendExe({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    projectRoot: path.join(__dirname, '..'),
    override: process.env.MM_BACKEND_EXE,
  })
  const env = buildSpawnEnv({
    port,
    userData: app.getPath('userData'),
    baseEnv: process.env,
    encryptionKeyHex,
    loopbackToken,
  })
  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  // #716: the backend marks a fatal STARTUP failure with MM-FATAL so its recovery
  // instructions can reach the crash dialog instead of dying in a pipe. Everything
  // still passes through to our own stderr unchanged — this only observes.
  const fatal = createFatalLineCollector()
  fatalCollector = fatal
  // ⚠️ The prefix and the payload are written SEPARATELY, and the payload is written
  // as the raw Buffer. `${d}` would decode each chunk on its own — the #723 defect —
  // and mangle a multi-byte character split across a chunk boundary in the developer's
  // terminal too. Writing the bytes through untouched needs no decoder at all, so this
  // stays a single-mechanism fix: the collector is the ONE place stderr is decoded.
  child.stdout.on('data', (d) => { process.stdout.write('[backend] '); process.stdout.write(d) })
  child.stderr.on('data', (d) => {
    fatal.push(d)
    process.stderr.write('[backend] ')
    process.stderr.write(d)
  })

  // ⚠️ 'exit' fires when the PROCESS ends; 'close' fires once its stdio has drained
  // too. The fatal line is written immediately before the process dies, so reporting
  // on 'exit' can race the last stderr chunk and show the generic text for a failure
  // we were told the cause of. So: flag on 'exit' (waitForHealth's isExited depends
  // on that being prompt), REPORT on 'close' — with a short fallback timer, because a
  // stdio handle held open elsewhere would otherwise mean no dialog at all, which is
  // worse than an occasionally-generic one.
  const report = (code, signal) => reportCrash({ code, signal })
  child.on('exit', (code, signal) => {
    backendExited = true
    if (!isQuitting) setTimeout(() => report(code, signal), STDIO_DRAIN_GRACE_MS)
  })
  child.on('close', (code, signal) => report(code, signal))
  return child
}

/**
 * Show the one crash dialog and quit. Every failure path routes through here (#724).
 *
 * The dialog is deliberately an OS-native one rather than a BrowserWindow: it has to
 * appear before the app has a window (or after its window is gone), and the platform
 * dialog is what screen readers already announce without any ARIA work of ours.
 */
function reportCrash({ code = null, signal = null, error = null }) {
  if (crashReported || isQuitting) return
  crashReported = true
  closeSplash() // it is frameless and always-on-top; leaving it behind the dialog looks broken
  const text = crashDialogText({
    code,
    signal,
    fatalLines: fatalCollector ? fatalCollector.lines() : [],
    startupError: error,
  })
  // "Copy details" exists because the guidance names a PATH the researcher is being
  // asked to act on, and a native message box is not selectable — without this the
  // only way to report it onward is to retype it from a screenshot.
  const COPY = 0
  const QUIT = 1
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: ['Copy details', 'Quit'],
    defaultId: QUIT,
    cancelId: QUIT,
    noLink: true,
  })
  if (choice === COPY) clipboard.writeText(crashDialogClipboardText(text))
  app.quit()
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // #706: the data surfaces carry hard pixel floors — ByTextTable pins a 300px
    // sticky column, DatasetGridComponents pins 160px sticky cells — so below a
    // certain width they OVERLAP rather than reflow. 1280×720 is the minimum the
    // 2026-07-03 UX review drove the app at, so that is the number rather than an
    // invented one.
    minWidth: 1280,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true, // no menu bar reserved on Win/Linux (macOS uses the system bar)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  })

  // Downloads no longer use window.open (migrated to blob+anchor in P3a), so we
  // can safely deny new windows. Real external links (if any) open in the OS
  // browser; same-origin app navigations should never request a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // setWindowOpenHandler only covers window.open/target=_blank. A plain
  // same-window navigation (an <a href> in user-authored or imported rich text,
  // or any renderer bug) would otherwise load a remote page INSIDE the app
  // window with the preload bridge still exposed. The app must never leave its
  // own loopback origin in the top frame (an internal audit). The trailing slash
  // in appOrigin is load-bearing: it stops port-prefix confusion
  // (:8000 vs :80001) from matching.
  const appOrigin = `http://127.0.0.1:${port}/`
  for (const navEvent of ['will-navigate', 'will-redirect']) {
    mainWindow.webContents.on(navEvent, (event, url) => {
      if (!url.startsWith(appOrigin)) event.preventDefault()
    })
  }

  mainWindow.once('ready-to-show', () => {
    closeSplash()
    mainWindow.show()
  })

  return mainWindow.loadURL(`http://127.0.0.1:${port}/`)
}

/**
 * Wire the auto-updater (#29 S2). Must run AFTER the window exists — the first
 * state push happens on the launch check, and a dropped push would leave the
 * renderer showing "idle" while an update downloads behind it.
 *
 * `electron-updater` is required lazily: on an unsupported install (dev run, or a
 * read-only AppImage) we never load it at all, so a broken/absent module can't
 * take down startup for a user who was never going to auto-update anyway.
 */
function setupUpdater() {
  const configPath = path.join(app.getPath('userData'), UPDATER_CONFIG_NAME)
  const supported = canAutoUpdate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    fs,
  })

  let autoUpdater = null
  if (supported) {
    try {
      ;({ autoUpdater } = require('electron-updater'))
    } catch (err) {
      console.error(`updater: electron-updater unavailable (${(err && err.message) || err})`)
      return null
    }
  }

  const send = (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state)
  }

  const controller = createUpdaterController({
    autoUpdater,
    supported,
    autoCheck: readAutoCheck({ configPath, fs }),
    emit: send,
    log: (msg) => console.log(msg),
  })

  ipcMain.handle('update:getState', () => controller.getState())
  ipcMain.handle('update:check', () => controller.check({ manual: true }))
  ipcMain.handle('update:setAutoCheck', (_event, next) => {
    const state = controller.setAutoCheck(next)
    writeAutoCheck(state.autoCheck, { configPath, fs, log: (m) => console.log(m) })
    return state
  })
  // The renderer takes a fresh backup BEFORE invoking this (D4) — Windows quits by
  // hard-killing the backend, so no shutdown backup runs on the way into an update.
  // quitAndInstall() calls app.quit() internally, so `before-quit` → stopBackend still fires.
  ipcMain.handle('update:install', () => controller.install())

  controller.start()
  return controller
}

async function startup() {
  try {
    applyAppMenu()
    // Trigger-only recovery-key export (Phase 5, decision C): the whole flow runs
    // here in main — the key never crosses into the renderer, which only invokes
    // this channel and receives a {ok|reason} result. mainWindow is read at invoke
    // time (the Settings button fires long after it exists).
    ipcMain.handle('encryption:saveRecoveryKey', () =>
      saveRecoveryKeyToFile({
        safeStorage,
        keyFilePath: path.join(app.getPath('userData'), KEY_FILE_NAME),
        fs,
        showSaveDialog: (opts) => dialog.showSaveDialog(mainWindow, opts),
      }),
    )
    // Page zoom (#697). ONE verb, and main is the only place `setZoomFactor` is
    // called — the renderer owns the preference (localStorage `mm-zoom`, like the
    // theme) and asks main to apply it. Everything arriving here is untrusted, so it
    // is clamped; see zoom.js for why the state does not live in main and why CSS
    // zoom was rejected. Returns the APPLIED factor so a clamped request does not
    // leave the Settings control showing a value the window is not at.
    ipcMain.handle('zoom:set', (_event, factor) => {
      const applied = clampZoomFactor(factor)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.setZoomFactor(applied)
      }
      return applied
    })
    // Stable across launches (an internal audit): origin-keyed localStorage (theme,
    // panel/workbench prefs) would otherwise silently reset every launch.
    const port = await resolveAppPort({
      portFilePath: path.join(app.getPath('userData'), PORT_FILE_NAME),
      fs,
    })
    // Per-launch loopback token (an internal audit): the backend requires it on every
    // /api request, and we inject it as a header on every renderer request below — so
    // another local process or OS account that finds the port can't pull decrypted
    // data. Minted fresh each launch; never persisted.
    const loopbackToken = randomBytes(32).toString('hex')
    const appOrigin = `http://127.0.0.1:${port}/`
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      // Scope to our own loopback origin so the token never travels to any other host.
      if (details.url.startsWith(appOrigin)) {
        details.requestHeaders['X-MM-Loopback-Token'] = loopbackToken
      }
      callback({ requestHeaders: details.requestHeaders })
    })
    const encryptionKeyHex = resolveEncryptionKey()
    backend = startBackend(port, encryptionKeyHex, loopbackToken)
    createSplash()
    await waitForHealth(port, { isExited: () => backendExited })
    await createMainWindow(port)
    updater = setupUpdater()
  } catch (err) {
    // #724: route through the ONE reporter. When the backend died on its way up it has
    // usually already told us why (MM-FATAL), and `waitForHealth` only ever reports the
    // symptom — "Backend process exited before it became healthy". Ranking lives in
    // crashDialogText, so the cause wins over the symptom no matter which arrives first.
    reportCrash({ error: err })
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  // Also reached via autoUpdater.quitAndInstall() and the autoInstallOnAppQuit
  // path, so the backend always gets its stop signal before an update is applied.
  if (updater) updater.stop()
  // #554a: spawnSync — the Windows kill must COMPLETE before the app exe exits,
  // or the auto-updater's already-running NSIS installer can start overwriting the
  // install dir while mm-backend.exe still holds locks in it. before-quit is our
  // last synchronous moment.
  stopBackend(backend, {
    platform: process.platform,
    spawnSync,
    log: (msg) => console.log(msg),
  })
})

// Single-window desktop app: closing the window quits (incl. macOS).
app.on('window-all-closed', () => app.quit())

app.whenReady().then(startup)
