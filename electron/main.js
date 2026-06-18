// Mixed Measures desktop shell (Electron main process).
//
// Lifecycle: pick a free loopback port → spawn the frozen PyInstaller backend
// with absolute per-user data paths injected → health-gate the window load →
// show the SPA (served same-origin by the backend at http://127.0.0.1:<port>/).
// On quit: SIGTERM the backend so its shutdown backup runs, then hard-kill.
//
// The non-GUI logic lives in ./backend-process.js (unit-tested headlessly).

const { app, BrowserWindow, Menu, dialog, shell, safeStorage, ipcMain, session } = require('electron')
const { spawn } = require('node:child_process')
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

const KEY_FILE_NAME = 'mm-encryption.key'
const PORT_FILE_NAME = 'mm-port'

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

let backend = null
let backendExited = false
let isQuitting = false
let mainWindow = null
let splashWindow = null

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
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  child.on('exit', (code, signal) => {
    backendExited = true
    if (!isQuitting) onBackendCrash(code, signal)
  })
  return child
}

function onBackendCrash(code, signal) {
  // The backend died while the app was running (not during a clean quit).
  dialog.showErrorBox(
    'Mixed Measures engine stopped',
    `The local engine exited unexpectedly (code ${code}, signal ${signal}). The app will close.`,
  )
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
  } catch (err) {
    closeSplash()
    dialog.showErrorBox('Mixed Measures failed to start', String((err && err.message) || err))
    app.quit()
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
  stopBackend(backend, { platform: process.platform, spawn })
})

// Single-window desktop app: closing the window quits (incl. macOS).
app.on('window-all-closed', () => app.quit())

app.whenReady().then(startup)
