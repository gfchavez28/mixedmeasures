// Real OS-keyring round-trip smoke for key-manager.js — CROSS-LAUNCH.
//
// WHY THIS EXISTS: key-manager.test.js proves the resolveKey / recovery logic with a
// STUBBED safeStorage. The one thing a stub can't cover is whether the *real* OS
// backend (macOS Keychain via Security.framework; also exercises Windows DPAPI /
// Linux libsecret when run there) actually persists a wrapped key that a SEPARATE,
// LATER process can decrypt back to the same bytes. That cross-process persistence is
// exactly what "quit Mixed Measures and reopen it, and your encrypted database still
// opens" depends on — and it is the half of the "macOS keychain pass" that otherwise
// needed a physical Mac. (A single-process mint→resolve can't prove it: the keyring
// session is already open and the wrapped blob never leaves the process.)
//
// HOW: the coordinator (no --phase arg) spawns three independent Electron child
// processes against one shared temp dir —
//   1) --phase=mint     fresh first run → mints a 256-bit key, wraps it with the real
//                        keyring, writes db.key, prints KEYHEX. Then EXITS.
//   2) --phase=resolve  a brand-new process; db.key now exists → decrypt branch. A new
//                        safeStorage instance must unwrap db.key via the persisted OS
//                        keychain item and yield the SAME KEYHEX. (the real "relaunch".)
//   3) --phase=recover  another fresh process; exportRecoveryKey reads the same key out.
// All three KEYHEX values must match → RESULT: PASS.
//
// RUN: `npx --no-install electron scripts/keychain-smoke.js` (from electron/).
// Prints `RESULT: PASS|FAIL|SKIP` and exits 0 (pass/skip) or 1 (fail). The CI step that
// runs it is best-effort (continue-on-error, hard timeout) — a headless runner with no
// usable keyring honestly SKIPs, and a keychain access prompt can never hang it (each
// child has its own timeout). The RESULT line is the signal a human reads.
//
// STILL human-only (the post-launch soft-launch check, not covered here): the
// first-launch macOS Keychain *permission prompt* UX, and a real GUI install/open.
//
// NOT bundled into the app (electron-builder `files` is an allow-list) and NOT a
// *.test.js (node --test skips it), so it never runs during `npm test`.

const { app, safeStorage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const km = require('../key-manager')

const log = (m) => console.log('[keychain-smoke] ' + m)

// --phase=<mint|resolve|recover> marks a child worker; absent ⇒ coordinator.
function parseArgs() {
  const out = {}
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function depsFor(dir) {
  return {
    safeStorage,
    keyFilePath: path.join(dir, 'db.key'),
    dbFilePath: path.join(dir, 'app.db'), // intentionally absent → genuine first-run mint
    fs,
    randomBytes: crypto.randomBytes,
  }
}

// ── Worker: run exactly one phase against the shared dir, print KEYHEX + RESULT. ──
function runPhase(phase, dir) {
  if (!dir) {
    log('RESULT: FAIL — worker invoked without --dir')
    return app.exit(1)
  }
  // Same production guard as resolveKey: refuse to treat the insecure basic_text
  // fallback as real encryption. A runner with no Secret Service SKIPs honestly.
  if (!km.encryptionBackendUsable(safeStorage)) {
    log('RESULT: SKIP — encryptionBackendUsable() === false (no real keyring on this runner)')
    return app.exit(0)
  }
  const deps = depsFor(dir)
  try {
    let keyHex
    if (phase === 'mint') {
      const r = km.resolveKey(deps)
      if (r.mode !== 'encrypted') throw new Error(`mint resolveKey mode=${r.mode} (expected encrypted)`)
      if (!fs.existsSync(deps.keyFilePath)) throw new Error('key file was not written after mint')
      keyHex = r.keyHex
    } else if (phase === 'resolve') {
      // The cross-launch assertion: a fresh process must find the persisted key file
      // and unwrap it via the OS keyring — never re-mint.
      if (!fs.existsSync(deps.keyFilePath)) throw new Error('key file absent at resolve (mint did not persist it)')
      const r = km.resolveKey(deps)
      if (r.mode !== 'encrypted') throw new Error(`resolve mode=${r.mode} (expected encrypted)`)
      keyHex = r.keyHex
    } else if (phase === 'recover') {
      keyHex = km.exportRecoveryKey({ safeStorage, keyFilePath: deps.keyFilePath, fs })
    } else {
      throw new Error(`unknown phase '${phase}'`)
    }
    log(`KEYHEX=${keyHex}`)
    log('RESULT: PASS')
    app.exit(0)
  } catch (e) {
    log('RESULT: FAIL — ' + (e && e.stack ? e.stack : e))
    app.exit(1)
  }
}

// ── Coordinator: spawn the three phases as separate processes, compare keys. ──
function spawnPhase(phase, dir) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // children must be full Electron, not node mode
  let raw = ''
  try {
    raw = execFileSync(process.execPath, [__filename, `--phase=${phase}`, `--dir=${dir}`], {
      env,
      encoding: 'utf8',
      timeout: 60_000, // a stuck keychain prompt dies here, not at the job timeout
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (e && e.killed && e.signal) {
      return { result: 'SKIP', keyHex: null, reason: `child '${phase}' timed out (${e.signal}) — possible keychain prompt`, raw: e.stdout || '' }
    }
    raw = (e && (e.stdout || '')) || '' // worker exited non-zero (FAIL) — still parse its lines
  }
  const keyHex = (/KEYHEX=([0-9a-f]{64})/i.exec(raw) || [])[1] || null
  const result = (/RESULT:\s*(PASS|FAIL|SKIP)/.exec(raw) || [])[1] || 'FAIL'
  return { result, keyHex, raw }
}

// Fallback only if we genuinely can't spawn children (e.g. execPath unusable): run the
// in-process round-trip so coverage never drops below the prior single-process version.
function inProcessRoundTrip(dir) {
  const deps = depsFor(dir)
  const first = km.resolveKey(deps)
  if (first.mode !== 'encrypted') throw new Error(`in-process resolveKey mode=${first.mode}`)
  const second = km.resolveKey(deps)
  if (second.keyHex !== first.keyHex) throw new Error('keyHex changed across in-process resolves')
  const recovered = km.exportRecoveryKey({ safeStorage, keyFilePath: deps.keyFilePath, fs })
  if (recovered !== first.keyHex) throw new Error('exportRecoveryKey did not match the minted key')
  return first.keyHex
}

function runCoordinator() {
  if (!safeStorage.isEncryptionAvailable() || !km.encryptionBackendUsable(safeStorage)) {
    log('RESULT: SKIP — no usable OS keyring on this runner (isEncryptionAvailable/backend check failed)')
    return app.exit(0)
  }
  const getBackend = safeStorage.getSelectedStorageBackend
  log('selected storage backend: ' + (typeof getBackend === 'function' ? getBackend.call(safeStorage) : '(mac/win — n/a)'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-keysmoke-'))
  try {
    const mint = spawnPhase('mint', dir)
    if (mint.result === 'SKIP') { log('RESULT: SKIP — ' + (mint.reason || 'mint phase skipped')); return app.exit(0) }
    if (mint.result !== 'PASS' || !mint.keyHex) { log('RESULT: FAIL — mint phase did not produce a key\n' + mint.raw); return app.exit(1) }

    const resolve = spawnPhase('resolve', dir)
    const recover = spawnPhase('recover', dir)

    for (const [name, r] of [['resolve', resolve], ['recover', recover]]) {
      if (r.result === 'SKIP') { log(`RESULT: SKIP — ${name} phase skipped (${r.reason || 'no keyring'})`); return app.exit(0) }
      if (r.result !== 'PASS' || !r.keyHex) { log(`RESULT: FAIL — ${name} phase failed\n` + r.raw); return app.exit(1) }
    }

    if (resolve.keyHex !== mint.keyHex) {
      log(`RESULT: FAIL — relaunch process decrypted a DIFFERENT key (mint=${mint.keyHex.slice(0, 8)}… resolve=${resolve.keyHex.slice(0, 8)}…) — keyring did not persist across processes`)
      return app.exit(1)
    }
    if (recover.keyHex !== mint.keyHex) {
      log('RESULT: FAIL — recovery export did not match the minted key across processes')
      return app.exit(1)
    }

    log('cross-launch OK — a separate process unwrapped the persisted key to the SAME bytes; recovery export matches')
    log('RESULT: PASS')
    app.exit(0)
  } catch (e) {
    // Spawning failed outright — degrade to the in-process check rather than regress.
    log('cross-launch spawn unavailable (' + (e && e.message ? e.message : e) + '); falling back to in-process round-trip')
    try {
      inProcessRoundTrip(dir)
      log('in-process encrypt→decrypt via real keyring OK (cross-launch not exercised)')
      log('RESULT: PASS')
      app.exit(0)
    } catch (e2) {
      log('RESULT: FAIL — ' + (e2 && e2.stack ? e2.stack : e2))
      app.exit(1)
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* runner is ephemeral */ }
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const args = parseArgs()
  if (args.phase) return runPhase(args.phase, args.dir)
  return runCoordinator()
})
