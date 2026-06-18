// Headless tests for the at-rest key manager (P4 Phase 3). No Electron / display:
// safeStorage and fs are stubbed. Run: `node --test`.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  encryptionBackendUsable,
  inspectDatabaseFile,
  resolveKey,
  exportRecoveryKey,
  importRecoveryKey,
  saveRecoveryKeyToFile,
} = require('./key-manager')

const KEY_FILE = '/userData/mm-encryption.key'
const DB_FILE = '/userData/mixedmeasures.db'
const FIXED_KEY = 'ab'.repeat(32) // 64 hex chars
const PLAINTEXT_DB = Buffer.concat([Buffer.from('SQLite format 3\x00'), Buffer.alloc(100, 1)])
const ENCRYPTED_DB = Buffer.alloc(116, 0x7f) // non-empty, no SQLite header (SQLCipher salt page)

// Reversible safeStorage stub. `backend === undefined` simulates mac/win (no
// getSelectedStorageBackend); a string value simulates Linux.
function makeSafeStorage({ available = true, backend, failDecrypt = false } = {}) {
  const s = {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('ENC:' + plain),
    decryptString: (buf) => {
      if (failDecrypt) throw new Error('decrypt failed')
      const str = buf.toString()
      return str.startsWith('ENC:') ? str.slice(4) : str
    },
  }
  if (backend !== undefined) s.getSelectedStorageBackend = () => backend
  return s
}

function makeFs(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => store.get(p),
    writeFileSync: (p, data) => store.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data)),
    openSync: (p) => {
      if (!store.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e }
      return p // path doubles as the fd
    },
    readSync: (fd, buf, offset, length, position) => {
      const data = store.get(fd)
      const n = Math.max(0, Math.min(length, data.length - position))
      if (n > 0) data.copy(buf, offset, position, position + n)
      return n
    },
    closeSync: () => {},
    _store: store,
  }
}

const fixedRandom = (n) => Buffer.alloc(n, 0xab) // → 'abab...' (64 hex)

// --- encryptionBackendUsable -----------------------------------------------

test('encryptionBackendUsable: true on mac/win (no backend fn) when available', () => {
  assert.equal(encryptionBackendUsable(makeSafeStorage({ available: true })), true)
})

test('encryptionBackendUsable: false when safeStorage reports unavailable', () => {
  assert.equal(encryptionBackendUsable(makeSafeStorage({ available: false })), false)
})

test('encryptionBackendUsable: false on Linux basic_text fallback', () => {
  assert.equal(encryptionBackendUsable(makeSafeStorage({ backend: 'basic_text' })), false)
})

test('encryptionBackendUsable: true on Linux gnome_libsecret', () => {
  assert.equal(encryptionBackendUsable(makeSafeStorage({ backend: 'gnome_libsecret' })), true)
})

// --- resolveKey: first run -------------------------------------------------

test('resolveKey: first run + usable keyring → generates + stores a key', () => {
  const fs = makeFs()
  const r = resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.mode, 'encrypted')
  assert.equal(r.keyHex, FIXED_KEY)
  assert.ok(fs.existsSync(KEY_FILE), 'key file written')
  assert.equal(fs._store.get(KEY_FILE).toString(), 'ENC:' + FIXED_KEY)
})

test('resolveKey: first run + NO usable keyring → plaintext, no key written', () => {
  const fs = makeFs()
  const r = resolveKey({ safeStorage: makeSafeStorage({ backend: 'basic_text' }), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.mode, 'plaintext')
  assert.equal(r.reason, 'keyring_unavailable')
  assert.equal(fs.existsSync(KEY_FILE), false, 'must NOT write a key via the insecure backend')
})

// --- resolveKey: subsequent runs -------------------------------------------

test('resolveKey: existing key + usable keyring → decrypts the same key', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  const r = resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.mode, 'encrypted')
  assert.equal(r.keyHex, FIXED_KEY)
})

test('resolveKey: existing key + keyring unavailable → HARD error (no plaintext fallback)', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  assert.throws(
    () => resolveKey({ safeStorage: makeSafeStorage({ available: false }), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom }),
    (e) => e.code === 'KEYRING_UNAVAILABLE_WITH_EXISTING_KEY',
  )
})

test('resolveKey: existing key + decrypt fails → KEY_DECRYPT_FAILED', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  assert.throws(
    () => resolveKey({ safeStorage: makeSafeStorage({ failDecrypt: true }), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom }),
    (e) => e.code === 'KEY_DECRYPT_FAILED',
  )
})

test('resolveKey: existing key decrypts to garbage → KEY_MALFORMED', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:not-a-valid-key') })
  assert.throws(
    () => resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom }),
    (e) => e.code === 'KEY_MALFORMED',
  )
})

// --- recovery key ----------------------------------------------------------

test('exportRecoveryKey returns the stored key hex', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  assert.equal(exportRecoveryKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs }), FIXED_KEY)
})

test('exportRecoveryKey throws when keyring unavailable', () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  assert.throws(() => exportRecoveryKey({ safeStorage: makeSafeStorage({ available: false }), keyFilePath: KEY_FILE, fs }))
})

test('importRecoveryKey validates hex and re-wraps the key', () => {
  const fs = makeFs()
  const stored = importRecoveryKey('CD'.repeat(32), { safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs })
  assert.equal(stored, 'cd'.repeat(32)) // normalized lower
  assert.equal(fs._store.get(KEY_FILE).toString(), 'ENC:' + 'cd'.repeat(32))
})

test('importRecoveryKey rejects a malformed recovery key', () => {
  const fs = makeFs()
  assert.throws(() => importRecoveryKey('too-short', { safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs }))
  assert.equal(fs.existsSync(KEY_FILE), false)
})

// --- saveRecoveryKeyToFile (Phase 5, decision C: trigger-only export) -------

const SAVE_PATH = '/home/me/mixed-measures-recovery-key.txt'

test('saveRecoveryKeyToFile: writes the key file and returns ok+path', async () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  const showSaveDialog = async () => ({ canceled: false, filePath: SAVE_PATH })
  const res = await saveRecoveryKeyToFile({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs, showSaveDialog })
  assert.deepEqual(res, { ok: true, path: SAVE_PATH })
  assert.match(fs._store.get(SAVE_PATH).toString(), new RegExp(FIXED_KEY))
})

test('saveRecoveryKeyToFile: canceled dialog → ok:false, no file written', async () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  const showSaveDialog = async () => ({ canceled: true, filePath: undefined })
  const res = await saveRecoveryKeyToFile({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs, showSaveDialog })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'canceled')
  assert.equal(fs.existsSync(SAVE_PATH), false)
})

test('saveRecoveryKeyToFile: no usable keyring → ok:false unavailable, dialog not shown', async () => {
  const fs = makeFs({ [KEY_FILE]: Buffer.from('ENC:' + FIXED_KEY) })
  let dialogShown = false
  const showSaveDialog = async () => { dialogShown = true; return { canceled: false, filePath: SAVE_PATH } }
  const res = await saveRecoveryKeyToFile({ safeStorage: makeSafeStorage({ available: false }), keyFilePath: KEY_FILE, fs, showSaveDialog })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'unavailable')
  assert.equal(dialogShown, false)
})

test('saveRecoveryKeyToFile: no stored key yet → ok:false unavailable', async () => {
  const fs = makeFs()
  const showSaveDialog = async () => ({ canceled: false, filePath: SAVE_PATH })
  const res = await saveRecoveryKeyToFile({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs, showSaveDialog })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'unavailable')
})

// --- inspectDatabaseFile + first-run DB sniff (an internal audit/M2) ------------

test('inspectDatabaseFile: absent / plaintext / encrypted / empty / tiny-garbage', () => {
  const fs = makeFs({
    '/db/plain.db': PLAINTEXT_DB,
    '/db/enc.db': ENCRYPTED_DB,
    '/db/empty.db': Buffer.alloc(0),
    '/db/tiny.db': Buffer.from('junk'),
  })
  assert.equal(inspectDatabaseFile('/db/missing.db', fs), 'absent')
  assert.equal(inspectDatabaseFile('/db/plain.db', fs), 'plaintext')
  assert.equal(inspectDatabaseFile('/db/enc.db', fs), 'encrypted')
  // zero-byte file = SQLite hasn't written its header yet → fresh
  assert.equal(inspectDatabaseFile('/db/empty.db', fs), 'absent')
  // non-empty unrecognized file → fail-safe: refuse to treat as fresh
  assert.equal(inspectDatabaseFile('/db/tiny.db', fs), 'encrypted')
})

test('resolveKey: no key file + existing PLAINTEXT DB → stays plaintext, no key minted (M1)', () => {
  const fs = makeFs({ [DB_FILE]: PLAINTEXT_DB })
  const r = resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.mode, 'plaintext')
  assert.equal(r.reason, 'existing_plaintext_db')
  assert.equal(fs.existsSync(KEY_FILE), false, 'minting a key would lock out the existing data')
})

test('resolveKey: no key file + existing ENCRYPTED DB → hard error, no key minted (M2)', () => {
  const fs = makeFs({ [DB_FILE]: ENCRYPTED_DB })
  assert.throws(
    () => resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom }),
    (e) => e.code === 'KEY_FILE_MISSING_FOR_ENCRYPTED_DB',
  )
  assert.equal(fs.existsSync(KEY_FILE), false, 'a fresh key can never open the existing data')
})

test('resolveKey: zero-byte DB file still counts as first run → mints a key', () => {
  const fs = makeFs({ [DB_FILE]: Buffer.alloc(0) })
  const r = resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.mode, 'encrypted')
  assert.ok(fs.existsSync(KEY_FILE))
})

test('resolveKey: plaintext DB beats keyring-unavailable in reason specificity', () => {
  // Both conditions hold; the DB-state answer is the accurate one (no keyring
  // change would alter the outcome while the plaintext DB exists).
  const fs = makeFs({ [DB_FILE]: PLAINTEXT_DB })
  const r = resolveKey({ safeStorage: makeSafeStorage({ backend: 'basic_text' }), keyFilePath: KEY_FILE, dbFilePath: DB_FILE, fs, randomBytes: fixedRandom })
  assert.equal(r.reason, 'existing_plaintext_db')
})

test('resolveKey: missing dbFilePath is a wiring error, not a silent skip', () => {
  const fs = makeFs()
  assert.throws(
    () => resolveKey({ safeStorage: makeSafeStorage(), keyFilePath: KEY_FILE, fs, randomBytes: fixedRandom }),
    /requires dbFilePath/,
  )
})
