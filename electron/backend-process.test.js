// Headless tests for the Electron-free backend-process helpers.
// Run: `node --test` (no Electron / no display needed).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const net = require('node:net')
const {
  freePort,
  resolveAppPort,
  resolveBackendExe,
  buildSpawnEnv,
  waitForHealth,
  stopBackend,
} = require('./backend-process')

test('freePort returns a usable loopback port', async () => {
  const p = await freePort()
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536, `got ${p}`)
})

test('resolveBackendExe — override wins in dev', () => {
  assert.equal(
    resolveBackendExe({ isPackaged: false, platform: 'linux', resourcesPath: '/r', projectRoot: '/p', override: '/custom/mm' }),
    '/custom/mm',
  )
})

test('resolveBackendExe — override is IGNORED when packaged (keychain-bypass guard)', () => {
  // Honoring MM_BACKEND_EXE in a packaged app would hand the decrypted
  // MM_ENCRYPTION_KEY to an arbitrary substitute binary (an internal audit).
  assert.equal(
    resolveBackendExe({ isPackaged: true, platform: 'linux', resourcesPath: '/r', projectRoot: '/p', override: '/custom/mm' }),
    path.join('/r', 'mm-backend', 'mm-backend'),
  )
})

test('resolveBackendExe — packaged points into resources/', () => {
  assert.equal(
    resolveBackendExe({ isPackaged: true, platform: 'darwin', resourcesPath: '/App/Contents/Resources', projectRoot: '/p' }),
    path.join('/App/Contents/Resources', 'mm-backend', 'mm-backend'),
  )
})

test('resolveBackendExe — dev points at the PyInstaller onedir; .exe on win32', () => {
  assert.equal(
    resolveBackendExe({ isPackaged: false, platform: 'linux', resourcesPath: '/r', projectRoot: '/proj' }),
    path.join('/proj', 'backend', 'dist', 'mm-backend', 'mm-backend'),
  )
  assert.equal(
    resolveBackendExe({ isPackaged: false, platform: 'win32', resourcesPath: '/r', projectRoot: '/proj' }),
    path.join('/proj', 'backend', 'dist', 'mm-backend', 'mm-backend.exe'),
  )
})

test('buildSpawnEnv injects absolute userData paths + the packaged flags', () => {
  const env = buildSpawnEnv({ port: 5123, userData: '/home/u/.config/MixedMeasures', baseEnv: { PATH: '/usr/bin' } })
  assert.equal(env.PATH, '/usr/bin') // base env preserved
  assert.equal(env.MM_PORT, '5123')
  assert.equal(env.MM_DATABASE_PATH, path.join('/home/u/.config/MixedMeasures', 'mixedmeasures.db'))
  assert.equal(env.MM_DATA_DIR, path.join('/home/u/.config/MixedMeasures', 'data'))
  assert.equal(env.MM_BACKUP_DIR, path.join('/home/u/.config/MixedMeasures', 'backups'))
  assert.equal(env.MM_ENABLE_API_DOCS, 'false')
  assert.equal(env.MM_CORS_ORIGINS, '')
  assert.equal(env.MM_PACKAGED, '1')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  // No key → encryption vars absent (plaintext, unchanged default).
  assert.equal(env.MM_ENCRYPTION_ENABLED, undefined)
  assert.equal(env.MM_ENCRYPTION_KEY, undefined)
})

test('buildSpawnEnv turns on encryption when a key is supplied', () => {
  const key = 'ab'.repeat(32)
  const env = buildSpawnEnv({ port: 1, userData: '/u', encryptionKeyHex: key })
  assert.equal(env.MM_ENCRYPTION_ENABLED, '1')
  assert.equal(env.MM_ENCRYPTION_KEY, key)
})

test('buildSpawnEnv injects the loopback token when supplied (an internal audit)', () => {
  const env = buildSpawnEnv({ port: 1, userData: '/u', loopbackToken: 'deadbeef'.repeat(8) })
  assert.equal(env.MM_LOOPBACK_TOKEN, 'deadbeef'.repeat(8))
})

test('buildSpawnEnv omits the loopback token when absent', () => {
  const env = buildSpawnEnv({ port: 1, userData: '/u' })
  assert.equal(env.MM_LOOPBACK_TOKEN, undefined)
})

test('waitForHealth resolves once a server returns 200', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.statusCode = 200; res.end('ok') }
    else { res.statusCode = 404; res.end() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    await waitForHealth(port, { timeoutMs: 5_000, intervalMs: 50 })
  } finally {
    server.close()
  }
})

test('waitForHealth bails fast when the process has exited', async () => {
  const p = await freePort() // nothing listening here
  await assert.rejects(
    () => waitForHealth(p, { timeoutMs: 5_000, intervalMs: 50, isExited: () => true }),
    /exited before it became healthy/,
  )
})

test('waitForHealth times out when never healthy', async () => {
  const p = await freePort()
  await assert.rejects(
    () => waitForHealth(p, { timeoutMs: 250, intervalMs: 50 }),
    /did not become healthy/,
  )
})

test('stopBackend — POSIX sends SIGTERM then escalates to SIGKILL', () => {
  const calls = []
  let escalate = null
  const child = { exitCode: null, killed: false, pid: 999, kill: (sig) => calls.push(sig) }
  stopBackend(child, { platform: 'linux', graceMs: 10, spawn: () => {}, setTimeoutFn: (fn) => { escalate = fn } })
  assert.deepEqual(calls, ['SIGTERM'])
  escalate() // grace elapsed, still alive → hard kill
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL'])
})

test('stopBackend — Windows tree-kills via taskkill /T /F', () => {
  const spawned = []
  const child = { exitCode: null, killed: false, pid: 1234, kill: () => { throw new Error('should not SIGTERM on win') } }
  stopBackend(child, { platform: 'win32', spawn: (cmd, args) => spawned.push([cmd, args]) })
  assert.deepEqual(spawned, [['taskkill', ['/pid', '1234', '/T', '/F']]])
})

test('stopBackend — no-op on an already-exited child', () => {
  const child = { exitCode: 0, killed: false, pid: 1, kill: () => { throw new Error('should not kill') } }
  stopBackend(child, { platform: 'linux', spawn: () => { throw new Error('should not spawn') } })
})

// --- resolveAppPort (an internal audit: stable per-install port) ----------------

const PORT_FILE = '/userData/mm-port'

function makePortFs(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    readFileSync: (p) => {
      if (!store.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e }
      return store.get(p)
    },
    writeFileSync: (p, v) => store.set(p, String(v)),
    _store: store,
  }
}

test('resolveAppPort: first launch picks a port and persists it', async () => {
  const fs = makePortFs()
  const port = await resolveAppPort({ portFilePath: PORT_FILE, fs })
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535)
  assert.equal(fs._store.get(PORT_FILE), String(port))
})

test('resolveAppPort: reuses the saved port when it is free', async () => {
  const candidate = await freePort()
  const fs = makePortFs({ [PORT_FILE]: ` ${candidate}\n` }) // whitespace tolerated
  const port = await resolveAppPort({ portFilePath: PORT_FILE, fs })
  assert.equal(port, candidate)
})

test('resolveAppPort: saved port busy → mints a new one and persists it', async () => {
  const srv = net.createServer()
  await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  const busy = srv.address().port
  try {
    const fs = makePortFs({ [PORT_FILE]: String(busy) })
    const port = await resolveAppPort({ portFilePath: PORT_FILE, fs })
    assert.notEqual(port, busy)
    assert.equal(fs._store.get(PORT_FILE), String(port), 'new port persisted so prefs reset once, not every launch')
  } finally {
    await new Promise((res) => srv.close(res))
  }
})

test('resolveAppPort: garbage or out-of-range port file → fresh port', async () => {
  for (const junk of ['not-a-number', '80', '99999', '']) {
    const fs = makePortFs({ [PORT_FILE]: junk })
    const port = await resolveAppPort({ portFilePath: PORT_FILE, fs })
    assert.ok(port >= 1024 && port <= 65535, `junk ${JSON.stringify(junk)} → ${port}`)
    assert.equal(fs._store.get(PORT_FILE), String(port))
  }
})

test('resolveAppPort: unwritable port file still returns a working port', async () => {
  const fs = {
    readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync: () => { throw new Error('EACCES') },
  }
  const port = await resolveAppPort({ portFilePath: PORT_FILE, fs })
  assert.ok(Number.isInteger(port) && port >= 1024)
})
