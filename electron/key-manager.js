// At-rest encryption key management (packaging P4, Phase 3 — Model A).
//
// The SQLCipher database key lives here, in the Electron main process: a random
// 256-bit key wrapped by the OS keychain via Electron's safeStorage (macOS
// Keychain / Windows DPAPI / Linux libsecret), stored under userData. The plain
// hex is handed to the backend as MM_ENCRYPTION_KEY (the backend's EnvKeyProvider
// consumes it). Pure/injectable (safeStorage + fs + randomBytes are parameters)
// so it is unit-testable headlessly — the GUI/dialog wiring lives in main.js.

const KEY_HEX_RE = /^[0-9a-f]{64}$/i  // 256-bit key as 64 hex chars

const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\x00')

/**
 * Classify the database file at dbFilePath: 'absent' | 'plaintext' | 'encrypted'.
 *
 * A plaintext SQLite file starts with the 16-byte "SQLite format 3\0" header; an
 * SQLCipher-encrypted file starts with its random salt. A zero-byte file counts
 * as absent (SQLite writes the header on first real write). Any other non-empty
 * unrecognized file is reported 'encrypted' — the fail-safe direction (refuse to
 * mint a key over data we can't identify), mirroring the backend's Phase 0.5
 * present-but-unreadable-is-not-fresh rule.
 */
function inspectDatabaseFile(dbFilePath, fs) {
  let fd
  try {
    fd = fs.openSync(dbFilePath, 'r')
  } catch {
    return 'absent'
  }
  try {
    const buf = Buffer.alloc(16)
    const n = fs.readSync(fd, buf, 0, 16, 0)
    if (n === 0) return 'absent'
    if (n === 16 && buf.equals(SQLITE_PLAINTEXT_HEADER)) return 'plaintext'
    return 'encrypted'
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Is the OS keychain backend usable for real (not the insecure plaintext fallback)?
 * On Linux without a Secret Service, safeStorage silently falls back to the
 * 'basic_text' backend, which is NOT encryption — we must refuse to store a key
 * through it. getSelectedStorageBackend() is Linux-only; absent ⇒ mac/win, fine.
 */
function encryptionBackendUsable(safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) return false
  const getBackend = safeStorage.getSelectedStorageBackend
  if (typeof getBackend === 'function') {
    const backend = getBackend.call(safeStorage)
    if (backend === 'basic_text' || backend === 'unknown') return false
  }
  return true
}

/**
 * Resolve the database key. Outcomes:
 *  - { mode: 'encrypted', keyHex }  → run the backend with this key
 *  - { mode: 'plaintext', reason }  → first run with no usable keyring; the
 *    caller MUST surface this loudly (we deliberately do NOT write a key through
 *    the insecure basic_text backend — honoring "never silently store plaintext")
 *  - throws (with .code) → a stored key exists but is inaccessible; the encrypted
 *    DB cannot be opened, so refuse to fall back to plaintext over real data.
 */
function resolveKey({ safeStorage, keyFilePath, dbFilePath, fs, randomBytes }) {
  if (!dbFilePath) {
    // Required so the first-run minting branch can look at the existing DB —
    // minting without looking is exactly the M1/M2 lockout class.
    throw new Error('resolveKey requires dbFilePath')
  }
  const usable = encryptionBackendUsable(safeStorage)

  if (fs.existsSync(keyFilePath)) {
    // A key file means an encrypted DB almost certainly exists — the key MUST
    // be recoverable, or we'd risk migrating/serving over unreadable data.
    if (!usable) {
      const err = new Error(
        'A stored encryption key exists but the system keyring is unavailable, ' +
        'so your encrypted data cannot be opened. Start the system keyring (or ' +
        'restore from your recovery key) and relaunch Mixed Measures.',
      )
      err.code = 'KEYRING_UNAVAILABLE_WITH_EXISTING_KEY'
      throw err
    }
    let keyHex
    try {
      keyHex = safeStorage.decryptString(fs.readFileSync(keyFilePath))
    } catch (e) {
      const err = new Error(
        'The stored encryption key could not be decrypted (the system keyring may ' +
        'have changed). Restore from your recovery key to open your data.',
      )
      err.code = 'KEY_DECRYPT_FAILED'
      throw err
    }
    if (!KEY_HEX_RE.test(keyHex)) {
      const err = new Error('The stored encryption key is malformed.')
      err.code = 'KEY_MALFORMED'
      throw err
    }
    return { mode: 'encrypted', keyHex: keyHex.toLowerCase() }
  }

  // No key file. Before treating this as a true first run, look at the DB that
  // may already live at the target path — minting unconditionally would either
  // (an internal audit) lock out an existing PLAINTEXT DB (Linux: a keyring that
  // appears after months of plaintext use → the keyed backend dies on every
  // later launch with a misleading "backend exited" error, sticky because the
  // key file persists), or (M2) mask a deleted/lost key file over an ENCRYPTED
  // DB — a fresh key can never open it; the user needs their recovery key.
  const dbState = inspectDatabaseFile(dbFilePath, fs)
  if (dbState === 'plaintext') {
    // Stay plaintext: no encrypt-in-place migration exists yet, and a key would
    // make the existing data unreadable. Caller surfaces this distinctly.
    return { mode: 'plaintext', reason: 'existing_plaintext_db' }
  }
  if (dbState === 'encrypted') {
    const err = new Error(
      'This device has an encrypted Mixed Measures database, but its stored ' +
      'encryption key file is missing (it may have been deleted, or the app data ' +
      'was partially restored from another machine). A newly generated key cannot ' +
      'open the existing data — restore using your recovery key, or move the ' +
      'database file aside to start fresh.',
    )
    err.code = 'KEY_FILE_MISSING_FOR_ENCRYPTED_DB'
    throw err
  }

  // DB absent → genuine first run; nothing is encrypted yet.
  if (!usable) {
    return { mode: 'plaintext', reason: 'keyring_unavailable' }
  }

  // Generate and store a fresh key (wrapped by the OS keychain).
  const keyHex = randomBytes(32).toString('hex')
  fs.writeFileSync(keyFilePath, safeStorage.encryptString(keyHex), { mode: 0o600 })
  return { mode: 'encrypted', keyHex }
}

/**
 * Return the current key hex for the user to save as a recovery key. Requires a
 * usable keyring and an existing stored key.
 */
function exportRecoveryKey({ safeStorage, keyFilePath, fs }) {
  if (!encryptionBackendUsable(safeStorage)) {
    throw new Error('The system keyring is unavailable, so the recovery key cannot be read.')
  }
  if (!fs.existsSync(keyFilePath)) {
    throw new Error('No encryption key is stored yet.')
  }
  const keyHex = safeStorage.decryptString(fs.readFileSync(keyFilePath))
  if (!KEY_HEX_RE.test(keyHex)) throw new Error('The stored encryption key is malformed.')
  return keyHex.toLowerCase()
}

/**
 * The contents written to a recovery-key file. Plain text so the user can store
 * it in a password manager; the 64-hex IS the key, so the file is as sensitive
 * as the database itself.
 */
function recoveryKeyFileContents(keyHex) {
  return [
    'Mixed Measures — at-rest encryption recovery key',
    '',
    'Keep this file private. It is the ONLY way to recover your encrypted',
    'database if this computer\'s system keychain is lost, reset, or you move',
    'to a new machine. Anyone with this key can decrypt a backup of your data.',
    '',
    'To recover: reinstall Mixed Measures and import this key when prompted.',
    '',
    `Recovery key: ${keyHex}`,
    '',
  ].join('\n')
}

/**
 * Trigger-only recovery-key export (Phase 5, decision C): runs ENTIRELY in the
 * Electron main process so the key never crosses into the renderer — the UI only
 * invokes this and gets back a result. Reads the key, prompts a native Save
 * dialog, writes the recovery file. Injectable (`showSaveDialog` + deps) for
 * headless tests. Returns one of:
 *  - { ok: true, path }
 *  - { ok: false, reason: 'unavailable', message }  (no usable keyring / no key)
 *  - { ok: false, reason: 'canceled' }              (user dismissed the dialog)
 */
async function saveRecoveryKeyToFile({ safeStorage, keyFilePath, fs, showSaveDialog }) {
  let keyHex
  try {
    keyHex = exportRecoveryKey({ safeStorage, keyFilePath, fs })
  } catch (e) {
    return { ok: false, reason: 'unavailable', message: e.message }
  }
  const result = await showSaveDialog({
    title: 'Save recovery key',
    defaultPath: 'mixed-measures-recovery-key.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (!result || result.canceled || !result.filePath) {
    return { ok: false, reason: 'canceled' }
  }
  fs.writeFileSync(result.filePath, recoveryKeyFileContents(keyHex), { mode: 0o600 })
  return { ok: true, path: result.filePath }
}

/**
 * Re-store a key from a recovery key (e.g. after keychain loss / on a new
 * machine). Re-wraps it with the local keyring. Validates the hex first.
 */
function importRecoveryKey(keyHex, { safeStorage, keyFilePath, fs }) {
  if (typeof keyHex !== 'string' || !KEY_HEX_RE.test(keyHex.trim())) {
    throw new Error('Recovery key must be 64 hexadecimal characters (a 256-bit key).')
  }
  if (!encryptionBackendUsable(safeStorage)) {
    throw new Error('The system keyring is unavailable, so the recovery key cannot be stored.')
  }
  const normalized = keyHex.trim().toLowerCase()
  fs.writeFileSync(keyFilePath, safeStorage.encryptString(normalized), { mode: 0o600 })
  return normalized
}

module.exports = {
  KEY_HEX_RE,
  encryptionBackendUsable,
  inspectDatabaseFile,
  resolveKey,
  exportRecoveryKey,
  importRecoveryKey,
  recoveryKeyFileContents,
  saveRecoveryKeyToFile,
}
