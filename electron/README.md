# Mixed Measures — Electron desktop shell

The desktop wrapper around Mixed Measures. It launches the packaged backend and
presents the app in a native window, so end users run a single installable app
with no Python, Node, or web server to set up.

## How it works

The shell spawns the **frozen backend** (a PyInstaller build of the FastAPI app)
as a child process on a loopback port, waits for it to become healthy, then loads
the single-page app that the backend serves same-origin at
`http://127.0.0.1:<port>/`.

- **Stable per-install port.** The port is chosen once and persisted under
  `userData/mm-port` (re-minted only on conflict). Web origins include the port,
  so a per-launch random port would reset all origin-keyed `localStorage`
  preferences on every start.
- **Same-origin SPA.** Because the backend serves the built frontend, cookies,
  CSRF, CSP, and client-side routing all work with no renderer-side changes.
- **Hardened renderer.** `sandbox`, `contextIsolation`, and no `nodeIntegration`;
  the renderer only ever loads the local `127.0.0.1` origin, and off-origin
  navigations and redirects are blocked.

## Files

- `main.js` — Electron main process (lifecycle, window, single-instance lock).
- `backend-process.js` — Electron-free helpers (port selection, health polling,
  executable/env resolution, teardown). Unit-tested headlessly.
- `backend-process.test.js` — `node --test` suite (no Electron, no display).
- `updater.js` — auto-update policy and state machine. Like `backend-process.js`
  it imports no Electron: `autoUpdater`, `fs`, and the timers are injected, so it
  is unit-tested headlessly. `main.js` owns the GUI/IPC edges; this file owns the
  rules.
- `updater.test.js` — `node --test` suite for the above.
- `preload.js` — minimal hardened context bridge (`window.mmDesktop`).
- `splash.html` — shown while the backend starts.
- `scripts/update-manifest.js` — release-pipeline tool: re-patches
  `latest-mac.yml` after the DMG staple rewrites the artifact, and merges the mac
  legs' per-arch manifests into the one file the auto-updater reads.
  Dependency-free; exercised by `release.yml`. Unit tests alongside it.

## Auto-update

Updates come from GitHub Releases via `electron-updater`. The app checks on launch
and every four hours, downloads in the background, and installs only when the user
asks or on the next natural quit — it never interrupts work. The check is a single
HTTPS request carrying the version and platform; it is switchable off in Settings
and no other data leaves the machine.

Four things are load-bearing when changing anything here:

- **`build.files` in `package.json` is an allow-list.** A new app-source file that
  is not listed is silently dropped from the packaged app, and the shipped build
  throws `MODULE_NOT_FOUND` on first launch — while every CI gate stays green.
  (Production `node_modules` are collected separately by electron-builder, so
  dependencies do not need listing.)
- **`electron-updater` is a runtime dependency**, pinned exact. In
  `devDependencies` it would not be packaged at all.
- **`win.publisherName` must stay pinned** to the signing certificate's full
  Distinguished Name. `electron-updater` skips Windows update signature
  verification entirely when it is absent, and it compares every DN field, so a
  bare common name only warns. Re-read it from a signed build's Authenticode
  output rather than typing it from memory.
- **A new key under `build` must exist in `app-builder-lib`'s JSON schema**, or
  electron-builder fails the build.

An update installs through the normal quit path (`quitAndInstall()` calls
`app.quit()`), so the backend is always stopped first. Because a Windows quit
hard-kills the backend and therefore writes no shutdown backup, the renderer takes
a fresh backup before requesting an install.

A read-only AppImage (installed to `/opt`, or an immutable distro) cannot replace
itself; that install reports itself as unsupported and points at the release page
instead of failing. Being offline is a normal state and is never surfaced as an
error.

## Building and running a dev shell

The shell runs the **frozen** backend (development uses the same artifact as
production), so build that first:

```bash
# 1. Build the SPA (it is bundled INTO the backend bundle):
cd frontend && npm ci && npm run build
# 2. Freeze the backend (the bundle contains the SPA + database migrations):
cd ../backend && source venv/bin/activate && pyinstaller mixedmeasures.spec
# 3. Run the shell:
cd ../electron && npm install && npm start
```

`MM_BACKEND_EXE=/path/to/mm-backend` overrides the resolved backend path for local
development. It is **ignored in packaged builds** — honoring it there would hand
the database encryption key to an arbitrary substitute binary.

## Testing

```bash
cd electron && npm install && npm test   # node --test, headless
```

The helper suite covers port selection, the health gate (including crash-bail and
timeout), per-platform executable resolution, spawn-environment injection,
teardown (POSIX `SIGTERM`-then-`SIGKILL`, Windows `taskkill`), the update-manifest
patch/merge tool (round-trip fidelity, hash recomputation, arch-merge dedup,
version-mismatch refusal), and the updater state machine (offline is swallowed,
a periodic check never interrupts an in-flight download, install refuses unless an
update is staged, and the auto-check preference defaults on even when its config
file is missing or corrupt).

CI runs this suite as `npm ci && npm test` on **Node 20**. Local development may
be on a newer Node; validate the lockfile there before relying on it.

A windowed smoke test still needs a display: launch with `npm start`, create a
project, import a CSV, code a segment, run a statistic, export a file, then quit
and confirm the backend process exits and a shutdown backup is written.

## Security & platform notes

- The renderer loads only the local backend origin; the backend validates the
  loopback `Host` header (a DNS-rebinding guard) and registers explicit MIME types
  for the SPA assets.
- On encrypted databases, the shell inspects the database header before minting a
  first-run key: an existing plaintext database stays plaintext, and an encrypted
  database with a missing key file fails clearly toward the recovery key rather
  than minting a useless new one.
- On Windows, process teardown uses `taskkill /T /F`, so the graceful-shutdown
  backup does not run on a Windows quit; the periodic auto-backup is the
  mitigation. POSIX platforms get a clean `SIGTERM` shutdown.
- The shipped Electron runtime is pinned to a security-supported release.
