// Tests for check-notices.js (#1122). The script is the only thing that looks for Electron's
// and Chromium's notices in a packaged app, so these pin the layouts it reads, the shape the
// published v1.5.5 and v1.5.6 Mac apps had (no notice inside the .app), and the ways a file can
// be present and still not be the notice.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { NOTICES, noticeDir, checkNotices, main } = require('./check-notices.js')

const ELECTRON_LICENSE = 'Copyright (c) Electron contributors\n\nPermission is hereby granted, free of charge, …\n'
const CHROMIUM_CREDITS = '<title>Credits</title>\n<div class="open-sourced">Chromium software is made available …</div>\n'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-notices-'))
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** A packaged mac app as electron-builder 26.16.1+ lays it out. */
function macApp(root, { license = ELECTRON_LICENSE, credits = CHROMIUM_CREDITS } = {}) {
  const app = path.join(root, 'mac-arm64', 'Mixed Measures.app')
  const res = path.join(app, 'Contents', 'Resources')
  fs.mkdirSync(res, { recursive: true })
  if (license !== null) write(path.join(res, 'LICENSE.electron.txt'), license)
  if (credits !== null) write(path.join(res, 'LICENSES.chromium.html'), credits)
  return app
}

test('the two notices are the files electron-builder names in a packaged app', () => {
  assert.deepEqual(
    NOTICES.map((n) => n.file),
    ['LICENSE.electron.txt', 'LICENSES.chromium.html'],
  )
})

test('a .app is read inside the bundle, an unpacked dir at its top', () => {
  assert.equal(noticeDir('/r/mac-arm64/Mixed Measures.app'), path.join('/r/mac-arm64/Mixed Measures.app', 'Contents', 'Resources'))
  assert.equal(noticeDir('/r/mac-arm64/Mixed Measures.app/'), path.join('/r/mac-arm64/Mixed Measures.app/', 'Contents', 'Resources'))
  assert.equal(noticeDir('/r/win-unpacked'), '/r/win-unpacked')
})

test('a mac app with both notices in Contents/Resources passes', () => {
  assert.deepEqual(checkNotices(macApp(tmpdir())), [])
})

test('a win or linux unpacked dir with both notices at the top passes', () => {
  const dir = path.join(tmpdir(), 'linux-unpacked')
  write(path.join(dir, 'LICENSE.electron.txt'), ELECTRON_LICENSE)
  write(path.join(dir, 'LICENSES.chromium.html'), CHROMIUM_CREDITS)
  assert.deepEqual(checkNotices(dir), [])
})

test('#1122: notices left BESIDE the .app, as electron-builder 26.15.3 had them, fail', () => {
  // 26.15.3 unlinked them from the folder outside the bundle; even had it not, nothing outside
  // the .app reaches the zip or the dmg. Both must be named.
  const root = tmpdir()
  const app = macApp(root, { license: null, credits: null })
  write(path.join(root, 'mac-arm64', 'LICENSE'), ELECTRON_LICENSE)
  write(path.join(root, 'mac-arm64', 'LICENSES.chromium.html'), CHROMIUM_CREDITS)
  const problems = checkNotices(app)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /^LICENSE\.electron\.txt .* is missing/)
  assert.match(problems[1], /^LICENSES\.chromium\.html .* is missing/)
})

test('an empty notice fails', () => {
  const problems = checkNotices(macApp(tmpdir(), { credits: '' }))
  assert.deepEqual(problems, ["LICENSES.chromium.html (Chromium's credits (its third-party notices)) is empty"])
})

test('a file under the right name that is not the notice fails', () => {
  const problems = checkNotices(macApp(tmpdir(), { license: 'placeholder\n' }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^LICENSE\.electron\.txt does not read as Electron's MIT licence/)
})

test('a directory where a notice should be fails', () => {
  const app = macApp(tmpdir(), { credits: null })
  fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'LICENSES.chromium.html'))
  assert.match(checkNotices(app)[0], /is not a file$/)
})

test('a target that does not exist throws instead of reading as two missing notices', () => {
  assert.throws(() => checkNotices(path.join(tmpdir(), 'nope.app')), /no such app/)
})

test('main: 0 and the sizes when both are there, 1 when one is not', (t) => {
  const lines = []
  t.mock.method(console, 'log', (s) => lines.push(s))
  t.mock.method(console, 'error', (s) => lines.push(s))
  assert.equal(main([macApp(tmpdir())]), 0)
  assert.match(lines.at(-1), /carries LICENSE\.electron\.txt \(\d[\d,]* bytes\) and LICENSES\.chromium\.html/)
  assert.equal(main([macApp(tmpdir(), { license: null })]), 1)
  assert.throws(() => main([]), /usage/)
})
