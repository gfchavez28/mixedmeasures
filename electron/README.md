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

- `main.js` — Electron main process (lifecycle, window). Every app listener lives in
  `registerPrimaryInstance`, so a refused second launch registers nothing.
- `single-instance.js` — the single-instance lock: claim it, then register the app's
  lifecycle only when it is held, or quit (#1141). Electron-free; unit-tested.
- `backend-process.js` — Electron-free helpers (port selection, health polling,
  executable/env resolution, teardown). Unit-tested headlessly.
- `backend-process.test.js` — `node --test` suite (no Electron, no display).
- `updater.js` — auto-update policy and state machine. Like `backend-process.js`
  it imports no Electron: `autoUpdater`, `fs`, and the timers are injected, so it
  is unit-tested headlessly. `main.js` owns the GUI/IPC edges; this file owns the
  rules.
- `updater.test.js` — `node --test` suite for the above.
- `fatal-error.js` — turns a backend startup failure into dialog text (#716). Same
  Electron-free split as the two above: it scans the child's stderr for the
  `MM-FATAL:` line the backend writes (`backend/app/startup_errors.py`) and composes
  the crash dialog, falling back to the generic sentence when there is none. ⚠️ The
  prefix is a contract **mirrored by hand in two languages with no codegen**, so each
  side's suite can stay green while the two drift.
- `fatal-error.test.js` — `node --test` suite for the above.
- `renderer-recovery.js` — what the window does when its PAGE crashes or hangs
  (#1046): a native dialog that says saved work is safe and offers *Reload this
  page · Open the project list · Quit* (or *Wait · Reload the window* for a hang),
  instead of the white window a dead renderer leaves. Same Electron-free split:
  the window, `webContents` and `dialog` are injected. ⚠️ Not `fatal-error.js`'s
  channel — that one is the BACKEND failing to start, and it quits. Three of its
  rules came from driving a real Electron, not from the docs: the documented
  `forcefullyCrashRenderer()` can leave a hung renderer stuck in crash handling,
  so it is followed by a kill by process id; the reload after that kill runs on
  the NEXT tick, because inside `render-process-gone` it froze the main process;
  and `unresponsive` fires only when input goes unanswered.
- `renderer-recovery.test.js` — `node --test` suite for the above, including a
  source scan that `main.js` wires it onto the main window.
- `packaged-files.test.js` — the guard on `build.files` (#761). See below.
- `build-config.test.js` — the guard on the rest of `build` (#759). Validates the
  config against the **installed** `app-builder-lib/scheme.json`, so a key the next
  electron-builder major removes fails `npm test` on the bump commit instead of
  failing config validation mid-release. Also pins the publisher-name invariants
  that now straddle two files (see Auto-update below), since `release.yml` is
  otherwise outside everything `npm test` can see.
- `runtime-floor.test.js` — the floor on the shipped Electron runtime (#1093).
  `electron` is a devDependency, so no production audit gate sees it, and its own
  advisories have been missing from GitHub's advisory database. This test holds
  `FLOOR`, the version last taken on purpose. It fails if the lock goes below it
  or onto another major, or if the declared range admits anything lower. **A major
  move must set `FLOOR` again**, because a patched version is per line.
- `preload.js` — minimal hardened context bridge (`window.mmDesktop`).
- `splash.html` — shown while the backend starts.
- `scripts/update-manifest.js` — release-pipeline tool: re-patches
  `latest-mac.yml` after the DMG staple rewrites the artifact, merges the mac
  legs' per-arch manifests into the one file the auto-updater reads, and stamps
  and checks the feed's `minimumSystemVersion` (#1100). Dependency-free;
  exercised by `release.yml`. Unit tests alongside it.
- `scripts/macos-floor.js` — release-pipeline tool (#1118): reads every Mach-O
  file in the built `.app`, fails when any needs a newer macOS than
  `LSMinimumSystemVersion`, and prints the floor as the Darwin version the feed
  needs. v1.5.5 said 12.0 and shipped numpy/scipy built for 14.0; this is what
  would have said so. Dependency-free, unit-tested on synthetic headers.
- `scripts/check-fuses.js` — release-pipeline tool (#1100): reads the fuses back
  out of each packaged leg and fails when they differ from `build.electronFuses`.
  Nothing else ever looks at them.
- `scripts/electron-advisories.js` — CI check (#1094): reads Electron's own
  published security advisories and fails when the locked `electron` version is
  in a range its `REVIEWED` list does not excuse. The dependency audits cannot
  see the runtime (`electron` is a devDependency), and the global advisory
  database has missed Electron's advisories before. Dependency-free; it uses
  `GITHUB_TOKEN` when set. Not packaged: `build.files` does not name it.

## 🔴 `build.files` is a deny-by-default allow-list — and nothing but a launch tests it (#761)

`package.json`'s `build.files` names every file electron-builder puts in `app.asar`.
A module that isn't listed is simply **absent from the shipped app**, and *no gate can
see it*: `npm test`, tsc, lint and the full signed 4-platform matrix all pass, because
the miss only surfaces when Electron evaluates the `require` **at runtime, in the
packaged app**. In dev, `electron .` loads from this directory, where every file
plainly exists.

That is not hypothetical — it shipped. **v1.3.1's first cut built green on all five
jobs, signed and notarized, and died on first launch** with `Cannot find module
'./zoom'`. Both modules added that release, `zoom.js` and `fatal-error.js`, had never
joined the list. ⚠️ **The second one is the crash reporter**, so the machinery built to
explain a fatal startup failure was itself missing — and the §4b block owed for
#716/#723/#724 could not have passed on that build.

**`packaged-files.test.js` now derives the requirement instead of restating it.** It
walks the require graph transitively from the declared entry points and fails naming
any module absent from `build.files`, so **a new module is covered the moment `main.js`
requires it** — nobody has to remember the guard exists. Companion assertions cover the
inverse rot: a dangling entry for a deleted file, a dropped entry point (which would
make the walk pass vacuously), and a `.test.js` leaking into the package.

Two things to preserve if you touch it: **`preload.js` is seeded explicitly** (Electron
loads it from a path string in `webPreferences`, never a `require`, so the walk cannot
discover it), and **comments are stripped before scanning** — the guard's own header
names `require('./zoom')` in prose, and a naive scan matches that.

This is the codebase's **enumeration debt** shape, with the standing remedy applied:
derive the enumeration from the artifact the next variant must touch.

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
- **The publisher name must stay pinned** to the signing certificate's full
  Distinguished Name. `electron-updater` skips Windows update signature
  verification entirely when it is absent, and it compares every DN field, so a
  bare common name only warns. Re-read it from a signed build's Authenticode
  output rather than typing it from memory (`Get-AuthenticodeSignature` →
  `SignerCertificate.Subject`). ⚠️ **It lives in `release.yml`, not
  `package.json`** (#759 Half 2): electron-builder 26 removed `win.publisherName`
  and gave each signing manager its own — we sign with Azure Trusted Signing, so
  the key is `win.azureSignOptions.publisherName`, passed inside the workflow's
  existing `AZURE_TENANT_ID` guard. It must NOT move back into `package.json`,
  because v26 selects the signing manager by the mere *presence* of
  `azureSignOptions` and would then engage Azure signing on the unsigned path.
  Two non-obvious couplings: setting `verifyUpdateCodeSignature: false` also
  strips the name from `app-update.yml` as a side effect, and the whole thing is
  invisible to a fresh install — only an actual update exercises it.
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
file is missing or corrupt), the fatal-startup reader (#716 — a marker split
across two stderr chunks is still collected, developer noise and tracebacks never
reach the dialog, and the body is capped), and renderer recovery (#1046 — one
dialog per crash, a repeat recommends the project list, a hang dialog withdrawn
when the page recovers, and a deliberate kill never reported as a crash), and the
runtime floor (#1093 — the locked Electron and the declared range at or above `FLOOR`),
the macOS floor scan (#1118 — synthetic thin and universal Mach-O headers), the
feed's `minimumSystemVersion` (checked against the shipped electron-updater's own
comparison, which lets an update through on a malformed value), and the fuse
read-back (#1100 — a stand-in binary flipped through electron-builder's own mapping).

⚠️ **What the headless suite cannot prove: that the crash dialog appears.** The
backend is only a spawned child in a packaged build, so #716's last mile is a
packaged-build check — it is on the RELEASING §4b list and #716 stays open until it
passes. In dev the backend's stderr goes to the terminal and looks fine, which is
how the original gap survived. The dialog stays up until *Quit*: *Copy details*
copies (awaited — a Promise from Electron 44) and the same dialog comes back saying
so (`fatal-error.js::showCrashDialog`); `main.js` holds `window-all-closed` off
while it shows. **The same is true of the renderer-recovery dialogs
(#1046):** the suite drives every rule through fakes. A throwaway harness has driven
them in a real Electron on Linux: 42.3.3 (2026-09-26), 42.11.8 at the runtime
bump (2026-09-28), and 44.5.1 at the major move (2026-10-04 — the kill-by-process-id
fallback still fires there). Whether they appear on the packaged Windows build, and whether
the hang path's kill behaves the same there, is a §4b check. **Re-run that harness in
the new binary whenever the runtime moves**
(the internal design notes, git-ignored; run steps in its
header), and drive the real shell per the internal design notes
(also git-ignored). ⚠️ When driving the real shell, give `window.open` a same-origin URL: an
off-origin `https://` URL is handed to `shell.openExternal`, which opens the
desktop's own browser.

CI runs this suite as `npm ci && npm test` on **Node 24** (#635 — Node 20 went EOL
2026-04-30). Local development may be on a different Node; validate the lockfile
under CI's version before relying on it, and prove it with `npm ci` rather than
with `npm audit`'s vulnerability count — a lockfile `npm ci` refuses to install
still reports "0 vulnerabilities" (#726).

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
- The shipped Electron runtime is locked to a release on a supported line (44.5.1,
  taken on 2026-10-04 as the head of the 44 line; 42 reaches end of life 2026-10-20),
  with a floor guarded by `runtime-floor.test.js`. **Supported is dated:** Electron
  supports the latest three majors; 44's end of life is 2027-03-02, and the move
  after it needs #1121 first (Electron 46 removes the synchronous `safeStorage`
  calls). RELEASING §1b's `/security-audit` step compares the lock with the line
  at every cut. Plan and sources: the internal design notes
  (git-ignored; its calendar names the Linux proof kits saved beside it).
- **Fuses** (`build.electronFuses`, flipped before signing): no
  `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, no extra `file://`
  privileges, and only an integrity-checked `app.asar` loads (macOS/Windows check
  it). The release legs read them back (`scripts/check-fuses.js`). ⚠️ With
  `runAsNode` off, `child_process.fork()` from the main process throws (44.4.0);
  nothing here forks.
- **macOS 14 or later** (`build.mac.minimumSystemVersion`), because that is what
  the bundled numpy/scipy need — proven per build by `scripts/macos-floor.js` and
  carried in the update feed so an older Mac is not updated into an app that will
  not open.
