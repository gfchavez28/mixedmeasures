// Pure (Electron-free) helpers for managing the PyInstaller backend subprocess.
// Kept separate from main.js so this logic is unit-testable without an Electron
// runtime or a display — the GUI-bound wiring lives in main.js.

const net = require('node:net')
const http = require('node:http')
const path = require('node:path')

// Single source for the on-disk DB filename: buildSpawnEnv points the backend
// at it, and key-manager's first-run sniff (an internal audit/M2) inspects it —
// the two MUST agree or the sniff silently looks at the wrong file.
const DB_FILE_NAME = 'mixedmeasures.db'

/** Ask the OS for a free loopback TCP port (bind :0, read it back, release). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Can we bind this specific loopback port right now? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * Resolve the app's port, STABLE across launches (an internal audit).
 *
 * Web origins include the port, and the renderer's localStorage (theme,
 * collapse states, workbench prefs across ~10 modules) is origin-keyed — a
 * fresh random port every launch silently reset all of it. So: pick a random
 * port once, persist it under userData, and reuse it. If the saved port is
 * taken at launch (rare — another app grabbed it), mint a new one and persist
 * THAT, so preferences reset once and are stable again afterwards.
 *
 * Companion change: with a stable origin the HTTP cache also becomes stable,
 * so index.html is served Cache-Control: no-cache backend-side (else an
 * auto-update could briefly serve the stale app shell).
 */
async function resolveAppPort({ portFilePath, fs }) {
  let saved = null
  try {
    const n = Number(fs.readFileSync(portFilePath, 'utf8').toString().trim())
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) saved = n
  } catch {
    // missing/unreadable port file → first launch (or treat as such)
  }
  if (saved !== null && await portFree(saved)) return saved
  const port = await freePort()
  try {
    fs.writeFileSync(portFilePath, String(port))
  } catch {
    // Persisting failed (read-only dir?) — run on the fresh port; next launch
    // just repeats the random pick, which is the pre-M8 behavior.
  }
  return port
}

/**
 * Resolve the path to the frozen backend executable.
 * - packaged: lives under Electron's resources/ (electron-builder extraResources)
 * - dev:      the PyInstaller onedir built by `pyinstaller mixedmeasures.spec`
 * - override: MM_BACKEND_EXE wins IN DEV ONLY (handy for pointing at an alternate
 *   build). Ignored when packaged: honoring it there would let any same-user
 *   process relaunch the signed app with a substitute "backend" and receive the
 *   decrypted MM_ENCRYPTION_KEY in its env — on macOS that bypasses the
 *   app-scoped Keychain ACL (an internal audit; same gating as MM_FORCE_ENCRYPTION).
 */
function resolveBackendExe({ isPackaged, platform, resourcesPath, projectRoot, override }) {
  if (override && !isPackaged) return override
  const exeName = platform === 'win32' ? 'mm-backend.exe' : 'mm-backend'
  if (isPackaged) return path.join(resourcesPath, 'mm-backend', exeName)
  return path.join(projectRoot, 'backend', 'dist', 'mm-backend', exeName)
}

/**
 * Build the spawn env for the backend. Absolute writable paths are rooted at
 * the per-user data dir (never CWD — see packaging plan §2.1); the MM_-prefixed
 * names rely on the config.py AliasChoices added in P2 (do not rename).
 *
 * `encryptionKeyHex` (P4 Phase 3): when present, turn on at-rest encryption and
 * hand the SQLCipher key to the backend's EnvKeyProvider. Absent ⇒ neither var
 * is set (plaintext, unchanged) — the key only travels via env (not argv, which
 * is world-visible in `ps`), consistent with Model A's threat model.
 *
 * `loopbackToken` (an internal audit): a per-launch secret the backend requires on
 * every /api request (LoopbackTokenMiddleware). main.js injects the same value as
 * a request header from the renderer, so a different local process/OS account that
 * finds the port can't read the decrypted data. Travels via env (not argv), like
 * the key. Absent ⇒ var unset and the backend's check stays inert.
 */
function buildSpawnEnv({ port, userData, baseEnv = {}, encryptionKeyHex = null, loopbackToken = null }) {
  const env = {
    ...baseEnv,
    MM_PORT: String(port),
    MM_DATABASE_PATH: path.join(userData, DB_FILE_NAME),
    MM_DATA_DIR: path.join(userData, 'data'),
    MM_BACKUP_DIR: path.join(userData, 'backups'),
    MM_ENABLE_API_DOCS: 'false',
    MM_CORS_ORIGINS: '',
    MM_PACKAGED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }
  if (encryptionKeyHex) {
    env.MM_ENCRYPTION_ENABLED = '1'
    env.MM_ENCRYPTION_KEY = encryptionKeyHex
  }
  if (loopbackToken) {
    env.MM_LOOPBACK_TOKEN = loopbackToken
  }
  return env
}

/**
 * Poll http://127.0.0.1:<port>/health until it returns 200, bailing early if
 * the backend process has already exited (so a crash-on-startup surfaces as a
 * fast, clear failure instead of hanging until the timeout).
 *
 * The timeout budget must cover a cold first launch: the lifespan startup runs
 * Alembic migrations before uvicorn serves /health, so a fresh DB on a slow
 * disk can take several seconds.
 */
function waitForHealth(port, { timeoutMs = 60_000, intervalMs = 300, isExited = () => false } = {}) {
  const url = `http://127.0.0.1:${port}/health`
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isExited()) return reject(new Error('Backend process exited before it became healthy'))
      if (Date.now() > deadline) return reject(new Error('Backend did not become healthy within ' + timeoutMs + 'ms'))
      const req = http.get(url, (res) => {
        res.resume() // drain
        if (res.statusCode === 200) resolve()
        else setTimeout(attempt, intervalMs)
      })
      req.on('error', () => setTimeout(attempt, intervalMs))
      req.setTimeout(2_000, () => req.destroy())
    }
    attempt()
  })
}

/**
 * Terminate the backend subprocess.
 * - POSIX: SIGTERM first so the FastAPI lifespan shutdown runs (it writes the
 *   shutdown .mmbackup — confirmed in P2), then a hard SIGKILL after a grace
 *   period if it hasn't exited.
 * - Windows: no SIGTERM; taskkill the whole process tree (/T) forcefully (/F).
 *   NOTE: this is a hard kill, so the graceful shutdown backup does NOT run on
 *   Windows (packaging plan gotcha — the 4h periodic auto-backup is the
 *   mitigation). A PyInstaller onedir on Windows is a bootloader + child python
 *   process, so a plain child.kill() would orphan python; the tree-kill avoids that.
 *
 * #554a — THE WINDOWS KILL MUST BLOCK. It used to `spawn` taskkill and return
 * immediately, which raced the auto-updater: `quitAndInstall()` launches the NSIS
 * installer FIRST and only then calls `app.quit()` (verified in
 * electron-updater/out/BaseUpdater.js — `install(...)` runs, then
 * `setImmediate(() => app.quit())`). The installer then polls for the *app* exe to
 * exit before overwriting files. So `before-quit` is our last synchronous moment:
 * if taskkill is still in flight when the app exe goes away, the installer can start
 * overwriting the install dir while `mm-backend.exe` still holds file locks in it.
 * `spawnSync` closes that window — when it returns, the tree is gone.
 *
 * `before-quit` is a SYNCHRONOUS Electron handler, which is why this is spawnSync
 * and not an awaited `exit` event: making the quit path async would mean
 * preventDefault + re-quit, i.e. risking an app that never quits at all.
 *
 * `deps` is injectable for testing (spawnSync + setTimeout).
 */
function stopBackend(
  child,
  { platform, graceMs = 5_000, spawnSync, setTimeoutFn = setTimeout, log = () => {} } = {},
) {
  if (!child || child.exitCode !== null || child.killed) return
  if (platform === 'win32') {
    try {
      // `timeout` bounds a wedged taskkill so quit can never hang forever;
      // windowsHide keeps a console window from flashing on the way out.
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        timeout: graceMs,
        windowsHide: true,
      })
      if (result && result.error) {
        log(`backend: taskkill failed (${result.error.message}) — the installer may race a live backend`)
      }
    } catch (err) {
      // Never let the quit path throw: a crash in before-quit strands the app.
      log(`backend: taskkill threw (${(err && err.message) || err})`)
    }
    return
  }
  child.kill('SIGTERM')
  setTimeoutFn(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }, graceMs)
}

module.exports = {
  DB_FILE_NAME,
  freePort,
  portFree,
  resolveAppPort,
  resolveBackendExe,
  buildSpawnEnv,
  waitForHealth,
  stopBackend,
}
