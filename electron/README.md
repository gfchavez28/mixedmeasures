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
- `preload.js` — minimal hardened context bridge (`window.mmDesktop`).
- `splash.html` — shown while the backend starts.

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
timeout), per-platform executable resolution, spawn-environment injection, and
teardown (POSIX `SIGTERM`-then-`SIGKILL`, Windows `taskkill`).

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
