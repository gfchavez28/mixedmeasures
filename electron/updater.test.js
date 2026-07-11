// Tests for updater.js (#29 slab S2).
//
// The failure modes this guards are all SILENT: an updater that swallows a state
// transition shows a stale "up to date" forever; one that throws on offline takes
// the main process down; one that installs nothing on "Restart to update" quits
// the app for no reason. None of these surface in a manual happy-path test.

'use strict'

const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  STATUS,
  appImageIsUpdatable,
  canAutoUpdate,
  readAutoCheck,
  writeAutoCheck,
  createUpdaterController,
} = require('./updater.js')

/** A stand-in for electron-updater's autoUpdater: an EventEmitter + two spies. */
function fakeAutoUpdater({ checkImpl } = {}) {
  const au = new EventEmitter()
  au.calls = { check: 0, quitAndInstall: 0 }
  au.checkForUpdates = async () => {
    au.calls.check += 1
    if (checkImpl) return checkImpl(au)
    return {}
  }
  au.quitAndInstall = () => { au.calls.quitAndInstall += 1 }
  return au
}

function controller(overrides = {}) {
  const states = []
  const au = overrides.autoUpdater || fakeAutoUpdater()
  const ctl = createUpdaterController({
    autoUpdater: au,
    supported: true,
    autoCheck: true,
    emit: (s) => states.push({ ...s }),
    log: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    ...overrides,
  })
  return { ctl, au, states }
}

// ── D9: AppImage writability ────────────────────────────────────────────────

test('appImageIsUpdatable is false when APPIMAGE is unset (not an AppImage run)', () => {
  assert.equal(appImageIsUpdatable({ env: {}, fs }), false)
})

test('appImageIsUpdatable reflects real write access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-appimage-'))
  const file = path.join(dir, 'app.AppImage')
  fs.writeFileSync(file, 'x')

  assert.equal(appImageIsUpdatable({ env: { APPIMAGE: file }, fs }), true)

  fs.chmodSync(file, 0o444) // read-only, as an /opt install would be
  const readOnly = appImageIsUpdatable({ env: { APPIMAGE: file }, fs })
  fs.chmodSync(file, 0o644)
  fs.rmSync(dir, { recursive: true, force: true })

  // root ignores the permission bits, so only assert when the check is meaningful.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    assert.equal(readOnly, false)
  }
})

// #554d — electron-updater's AppImageUpdater.doInstall does `unlinkSync(appImage)`
// then `mv -f new dest`: BOTH are operations on the containing DIRECTORY (POSIX
// unlink needs write+exec on the parent and ignores the file's own mode). The old
// gate checked W_OK on the FILE only, so a user-owned AppImage in a root-owned dir
// reported supported:true, downloaded the update in full, and then threw EACCES at
// unlinkSync on every single quit — forever, and invisibly, because D7 swallows it.
test('appImageIsUpdatable is false when the DIRECTORY is not writable (#554d)', () => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return // root ignores modes

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-appimage-dir-'))
  const file = path.join(dir, 'app.AppImage')
  fs.writeFileSync(file, 'x')
  fs.chmodSync(file, 0o644) // the FILE is writable — the old gate said "go"

  fs.chmodSync(dir, 0o555) // ...but the directory is read-only, as an /opt install is
  let updatable
  try {
    updatable = appImageIsUpdatable({ env: { APPIMAGE: file }, fs })
  } finally {
    fs.chmodSync(dir, 0o755)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  assert.equal(updatable, false, 'a writable file in an unwritable dir cannot be replaced')
})

test('canAutoUpdate: dev runs never update, mac/win do, linux depends on the AppImage', () => {
  const env = {}
  assert.equal(canAutoUpdate({ isPackaged: false, platform: 'darwin', env, fs }), false)
  assert.equal(canAutoUpdate({ isPackaged: true, platform: 'darwin', env, fs }), true)
  assert.equal(canAutoUpdate({ isPackaged: true, platform: 'win32', env, fs }), true)
  // linux without a writable AppImage degrades rather than erroring
  assert.equal(canAutoUpdate({ isPackaged: true, platform: 'linux', env, fs }), false)
})

// ── D10: the preference defaults ON and fails safe ──────────────────────────

test('readAutoCheck defaults to true when the config is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-updcfg-'))
  const cfg = path.join(dir, 'mm-updater.json')

  assert.equal(readAutoCheck({ configPath: cfg, fs }), true, 'missing file → ON')

  fs.writeFileSync(cfg, '{ this is not json')
  assert.equal(readAutoCheck({ configPath: cfg, fs }), true, 'corrupt file → ON')

  fs.writeFileSync(cfg, JSON.stringify({ autoCheck: false }))
  assert.equal(readAutoCheck({ configPath: cfg, fs }), false, 'explicit false → OFF')

  fs.writeFileSync(cfg, JSON.stringify({ autoCheck: true }))
  assert.equal(readAutoCheck({ configPath: cfg, fs }), true)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeAutoCheck round-trips and never throws on an unwritable path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-updcfg-'))
  const cfg = path.join(dir, 'mm-updater.json')

  assert.equal(writeAutoCheck(false, { configPath: cfg, fs }), true)
  assert.equal(readAutoCheck({ configPath: cfg, fs }), false)

  const bad = path.join(dir, 'no-such-dir', 'mm-updater.json')
  assert.equal(writeAutoCheck(true, { configPath: bad, fs }), false, 'returns false, does not throw')

  fs.rmSync(dir, { recursive: true, force: true })
})

// ── The state machine ───────────────────────────────────────────────────────

test('unsupported installs report unsupported and never call the updater', async () => {
  const au = fakeAutoUpdater()
  const { ctl } = controller({ autoUpdater: au, supported: false })

  assert.equal(ctl.getState().status, STATUS.UNSUPPORTED)
  ctl.start()
  await ctl.check({ manual: true })
  assert.equal(au.calls.check, 0, 'a check must never reach electron-updater')
  assert.equal(ctl.install(), false)
  assert.equal(au.calls.quitAndInstall, 0)
})

test('the happy path walks checking → downloading → downloaded', async () => {
  const { ctl, au, states } = controller()

  await ctl.check({ manual: true })
  au.emit('checking-for-update')
  au.emit('update-available', { version: '1.3.0' })
  au.emit('download-progress', { percent: 42.6 })
  au.emit('update-downloaded', { version: '1.3.0' })

  assert.deepEqual(
    states.map((s) => s.status),
    [STATUS.CHECKING, STATUS.DOWNLOADING, STATUS.DOWNLOADING, STATUS.DOWNLOADED],
  )
  assert.equal(ctl.getState().version, '1.3.0')
  assert.equal(ctl.getState().percent, 100)
  assert.equal(states[2].percent, 43, 'progress is rounded for display')
})

test('an update-not-available check returns to idle and clears any stale version', async () => {
  const { ctl, au } = controller()
  au.emit('update-available', { version: '1.3.0' })
  au.emit('update-not-available', {})
  assert.equal(ctl.getState().status, STATUS.IDLE)
  assert.equal(ctl.getState().version, null)
})

test('offline is swallowed: no throw, no rejection, state goes to error', async () => {
  const au = fakeAutoUpdater({
    checkImpl: (u) => {
      // electron-updater both emits AND rejects on a network failure.
      u.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))
      return Promise.reject(new Error('getaddrinfo ENOTFOUND github.com'))
    },
  })
  const { ctl } = controller({ autoUpdater: au })

  await assert.doesNotReject(() => ctl.check({ manual: true }))
  assert.equal(ctl.getState().status, STATUS.ERROR)
  assert.match(ctl.getState().message, /Could not check for updates/)
  // D7's whole point: the copy tells an offline user this is fine.
  assert.match(ctl.getState().message, /offline/)
})

// #554c — the error handler used to set "Could not check for updates." for EVERY
// failure, so a download dying at 80% (disk full, connection dropped mid-transfer)
// told the user their CHECK had failed and that being offline was fine: advice for
// a problem they didn't have. The pre-error status is the phase that died.
test('a download that fails mid-transfer says the DOWNLOAD failed, not the check', async () => {
  const au = fakeAutoUpdater()
  const { ctl } = controller({ autoUpdater: au })

  au.emit('update-available', { version: '1.3.0' })
  au.emit('download-progress', { percent: 80 })
  assert.equal(ctl.getState().status, STATUS.DOWNLOADING)
  assert.equal(ctl.getState().percent, 80)

  au.emit('error', new Error('ENOSPC: no space left on device'))

  const s = ctl.getState()
  assert.equal(s.status, STATUS.ERROR)
  assert.match(s.message, /Could not download the update/)
  assert.doesNotMatch(s.message, /Could not check/)
  // ...and it must NOT tell a disk-full user that being offline is fine.
  assert.doesNotMatch(s.message, /offline/)
  // A stale 80% must not bleed into the next attempt's progress UI.
  assert.equal(s.percent, 0)
})

test('an error while a staged update sits DOWNLOADED is also a download failure', async () => {
  const au = fakeAutoUpdater()
  const { ctl } = controller({ autoUpdater: au })
  au.emit('update-downloaded', { version: '1.3.0' })
  au.emit('error', new Error('EACCES'))
  assert.match(ctl.getState().message, /Could not download the update/)
})

test('an error with no check in flight still reads as a check failure', async () => {
  const au = fakeAutoUpdater()
  const { ctl } = controller({ autoUpdater: au })
  au.emit('error', new Error('rate limited'))
  assert.match(ctl.getState().message, /Could not check for updates/)
})

test('install() only fires when an update is actually staged', async () => {
  const { ctl, au } = controller()

  assert.equal(ctl.install(), false, 'idle → refuse')
  au.emit('update-available', { version: '1.3.0' })
  assert.equal(ctl.install(), false, 'still downloading → refuse')
  assert.equal(au.calls.quitAndInstall, 0)

  au.emit('update-downloaded', { version: '1.3.0' })
  assert.equal(ctl.install(), true)
  assert.equal(au.calls.quitAndInstall, 1)
})

test('background checks respect the toggle; a manual check ignores it', async () => {
  const { ctl, au } = controller({ autoCheck: false })

  await ctl.check()
  assert.equal(au.calls.check, 0, 'auto-check off → background check is a no-op')

  await ctl.check({ manual: true })
  assert.equal(au.calls.check, 1, 'Check now works regardless of the toggle')
})

test('start() does not check when auto-check is off', () => {
  const { ctl, au } = controller({ autoCheck: false })
  ctl.start()
  assert.equal(au.calls.check, 0)
})

test('a periodic tick never interrupts an in-flight download', async () => {
  let tick = null
  const { ctl, au } = controller({ setIntervalFn: (fn) => { tick = fn; return { unref() {} } } })
  ctl.start()
  assert.equal(au.calls.check, 1, 'launch check')

  au.emit('update-available', { version: '1.3.0' })
  await tick()
  assert.equal(au.calls.check, 1, 'no second check while downloading')

  au.emit('update-downloaded', { version: '1.3.0' })
  await tick()
  assert.equal(au.calls.check, 1, 'no check once staged either')
  assert.equal(ctl.getState().status, STATUS.DOWNLOADED, 'staged state survives the tick')
})

test('autoDownload and autoInstallOnAppQuit are enabled for supported installs', () => {
  const { au } = controller()
  assert.equal(au.autoDownload, true)
  assert.equal(au.autoInstallOnAppQuit, true)
})

test('setAutoCheck persists into state and re-schedules', async () => {
  let cleared = 0
  const { ctl, au } = controller({ autoCheck: false, clearIntervalFn: () => { cleared += 1 } })

  const next = ctl.setAutoCheck(true)
  assert.equal(next.autoCheck, true)
  assert.equal(au.calls.check, 1, 'turning it on checks immediately')

  ctl.setAutoCheck(false)
  assert.equal(ctl.getState().autoCheck, false)
  assert.ok(cleared >= 1, 'the interval is torn down when switched off')
})
