// Tests for macos-floor.js (#1118). The script is the only thing that compares the macOS an
// app DECLARES with the macOS its binaries NEED, and the only source of the update feed's
// minimumSystemVersion — so a parser that silently reads nothing would pass every app.
// Fixtures are synthetic Mach-O headers built here, byte for byte.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  MACOS_TO_DARWIN,
  darwinForMacos,
  compareVersions,
  readPlistString,
  fileMinVersion,
  checkApp,
} = require('./macos-floor.js')

const LC_BUILD_VERSION = 0x32
const LC_VERSION_MIN_MACOSX = 0x24

function encodeVersion(v) {
  const [major, minor = 0] = v.split('.').map(Number)
  return ((major << 16) | (minor << 8)) >>> 0
}

/** A thin 64-bit Mach-O image with one version load command (or none). */
function machO({ minos, cmd = 'build', platform = 1 } = {}) {
  const cmds = []
  if (minos && cmd === 'build') {
    const c = Buffer.alloc(24)
    c.writeUInt32LE(LC_BUILD_VERSION, 0)
    c.writeUInt32LE(24, 4)
    c.writeUInt32LE(platform, 8)
    c.writeUInt32LE(encodeVersion(minos), 12)
    c.writeUInt32LE(encodeVersion(minos), 16) // sdk
    c.writeUInt32LE(0, 20) // ntools
    cmds.push(c)
  } else if (minos && cmd === 'vmin') {
    const c = Buffer.alloc(16)
    c.writeUInt32LE(LC_VERSION_MIN_MACOSX, 0)
    c.writeUInt32LE(16, 4)
    c.writeUInt32LE(encodeVersion(minos), 8)
    c.writeUInt32LE(encodeVersion(minos), 12)
    cmds.push(c)
  }
  // An unrelated command first, so the walk has to step over one to find the version.
  const other = Buffer.alloc(16)
  other.writeUInt32LE(0x1b, 0) // LC_UUID's id; contents irrelevant
  other.writeUInt32LE(16, 4)
  const body = Buffer.concat([other, ...cmds])
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4) // CPU_TYPE_ARM64
  header.writeUInt32LE(1 + cmds.length, 16)
  header.writeUInt32LE(body.length, 20)
  return Buffer.concat([header, body, Buffer.alloc(64)])
}

/** A universal (fat) file holding the given thin images. */
function fat(images) {
  const header = Buffer.alloc(8 + images.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(images.length, 4)
  let offset = 4096
  const parts = []
  images.forEach((img, i) => {
    header.writeUInt32BE(offset, 8 + i * 20 + 8)
    header.writeUInt32BE(img.length, 8 + i * 20 + 12)
    parts.push({ offset, img })
    offset += 4096
  })
  const out = Buffer.alloc(offset)
  header.copy(out, 0)
  for (const { offset: o, img } of parts) img.copy(out, o)
  return out
}

const reader = (buf) => (position, length) => buf.subarray(position, position + length)

function plist(min) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Mixed Measures</string>
${min === undefined ? '' : `  <key>LSMinimumSystemVersion</key>\n  <string>${min}</string>\n`}</dict>
</plist>
`
}

/** A throwaway .app: Info.plist + the given relative files. `min`: a version, 'omit' (a
 *  plist with no LSMinimumSystemVersion), or null (no plist at all). */
function makeApp(files, min = '14.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-floor-'))
  const app = path.join(root, 'Test.app')
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  if (min !== null) fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(min === 'omit' ? undefined : min))
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(app, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
  return { app, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

// --- the Darwin table ------------------------------------------------------------------

test('darwinForMacos maps whole majors through the table, including the macOS 26 renumbering', () => {
  assert.equal(darwinForMacos('13.0'), '22.0.0')
  assert.equal(darwinForMacos('14.0'), '23.0.0')
  assert.equal(darwinForMacos('14'), '23.0.0')
  assert.equal(darwinForMacos('15.0'), '24.0.0')
  // "+9" would say 35. Runner image README: macOS 26.6.2 → Darwin 25.6.0.
  assert.equal(darwinForMacos('26.0'), '25.0.0')
})

test('darwinForMacos refuses what it cannot vouch for — a fail-open feed is the cost of guessing', () => {
  assert.throws(() => darwinForMacos('14.2'), /whole major/)
  assert.throws(() => darwinForMacos('27.0'), /not in MACOS_TO_DARWIN/)
  assert.throws(() => darwinForMacos('10.15'), /whole major|not in MACOS_TO_DARWIN/)
  assert.throws(() => darwinForMacos('fourteen'), /not a macOS version/)
})

test('every table entry yields a full x.y.z — electron-updater lets an update through on anything else', () => {
  for (const major of Object.keys(MACOS_TO_DARWIN)) {
    assert.match(darwinForMacos(`${major}.0`), /^\d+\.\d+\.\d+$/)
  }
})

test('compareVersions is numeric, not lexical', () => {
  assert.ok(compareVersions('14.0', '12.3') > 0)
  assert.ok(compareVersions('9.0', '10.0') < 0) // lexically '9' > '1'
  assert.equal(compareVersions('14', '14.0'), 0)
})

// --- the plist -------------------------------------------------------------------------

test('readPlistString reads LSMinimumSystemVersion, and refuses a binary plist', () => {
  assert.equal(readPlistString(plist('14.0'), 'LSMinimumSystemVersion'), '14.0')
  assert.equal(readPlistString(plist(undefined), 'LSMinimumSystemVersion'), null)
  assert.throws(() => readPlistString('bplist00…', 'LSMinimumSystemVersion'), /binary plist/)
})

// --- reading a Mach-O ------------------------------------------------------------------

test('fileMinVersion reads LC_BUILD_VERSION and the older LC_VERSION_MIN_MACOSX', () => {
  assert.equal(fileMinVersion(reader(machO({ minos: '14.0' }))), '14.0')
  assert.equal(fileMinVersion(reader(machO({ minos: '11.0', cmd: 'vmin' }))), '11.0')
  assert.equal(fileMinVersion(reader(machO({ minos: '12.3' }))), '12.3')
})

test('fileMinVersion takes the HIGHEST slice of a universal binary', () => {
  const buf = fat([machO({ minos: '11.0' }), machO({ minos: '14.0' })])
  assert.equal(fileMinVersion(reader(buf)), '14.0')
})

test('fileMinVersion says "unknown" for a Mach-O that declares no minimum', () => {
  assert.equal(fileMinVersion(reader(machO({}))), 'unknown')
})

test('a non-macOS LC_BUILD_VERSION (an iOS slice) sets no macOS floor', () => {
  assert.equal(fileMinVersion(reader(machO({ minos: '17.0', platform: 2 }))), 'unknown')
})

test('fileMinVersion ignores what is not Mach-O, including a Java class (also CAFEBABE)', () => {
  assert.equal(fileMinVersion(reader(Buffer.from('#!/bin/sh\necho hi\n'))), null)
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 0, 0, 0, 0])
  assert.equal(fileMinVersion(reader(javaClass)), null)
  assert.equal(fileMinVersion(reader(Buffer.alloc(4))), null)
})

test('a stray CAFEBABE file claiming billions of slices is not Mach-O, and allocates nothing for it', () => {
  // Without the slice-count bound, reading this header's table asks for 0xFFFFFFFF × 20 bytes.
  const bogus = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
  // Allocates the requested length first, as the real file reader does.
  const allocatingReader = (position, length) => {
    const buf = Buffer.alloc(length)
    const n = Math.max(0, Math.min(length, bogus.length - position))
    bogus.copy(buf, 0, position, position + n)
    return buf.subarray(0, n)
  }
  assert.equal(fileMinVersion(allocatingReader), null)
})

// --- the whole app ---------------------------------------------------------------------

test('checkApp passes an app whose every binary is at or below the declared floor', () => {
  const { app, cleanup } = makeApp({
    'Contents/MacOS/Test': machO({ minos: '13.0' }),
    'Contents/Resources/mm-backend/lib.so': machO({ minos: '14.0' }),
    'Contents/Resources/readme.txt': Buffer.from('not a binary'),
  })
  try {
    const r = checkApp(app)
    assert.equal(r.declared, '14.0')
    assert.equal(r.darwin, '23.0.0')
    assert.equal(r.machoCount, 2)
    assert.deepEqual(r.offenders, [])
  } finally {
    cleanup()
  }
})

test('checkApp names every binary built for a newer macOS than declared — #1118\'s shape', () => {
  // v1.5.5: Info.plist 12.0, numpy/scipy built for 14.0.
  const { app, cleanup } = makeApp(
    {
      'Contents/MacOS/Test': machO({ minos: '12.0' }),
      'Contents/Resources/mm-backend/_internal/numpy/core.so': machO({ minos: '14.0' }),
      'Contents/Resources/mm-backend/_internal/scipy/linalg.so': fat([machO({ minos: '14.0' })]),
      'Contents/Resources/mm-backend/_internal/old.so': machO({}),
    },
    '12.0',
  )
  try {
    const r = checkApp(app)
    assert.deepEqual(
      r.offenders.map((o) => `${o.minos} ${o.file.split(path.sep).join('/')}`).sort(),
      [
        '14.0 Contents/Resources/mm-backend/_internal/numpy/core.so',
        '14.0 Contents/Resources/mm-backend/_internal/scipy/linalg.so',
        'unknown Contents/Resources/mm-backend/_internal/old.so',
      ],
    )
  } finally {
    cleanup()
  }
})

test('checkApp does not follow symlinks — a framework\'s Versions/Current would double-count', () => {
  const { app, cleanup } = makeApp({ 'Contents/Frameworks/X.framework/Versions/A/X': machO({ minos: '13.0' }) })
  try {
    fs.symlinkSync('A', path.join(app, 'Contents/Frameworks/X.framework/Versions/Current'))
    assert.equal(checkApp(app).machoCount, 1)
  } finally {
    cleanup()
  }
})

test('checkApp refuses an app with no Info.plist or no declared floor', () => {
  const none = makeApp({}, null)
  const empty = makeApp({}, 'omit')
  try {
    assert.throws(() => checkApp(none.app), /no Contents\/Info\.plist/)
    assert.throws(() => checkApp(empty.app), /no LSMinimumSystemVersion/)
  } finally {
    none.cleanup()
    empty.cleanup()
  }
})

test('the CLI fails on a scan that found no binaries — silence must not read as a pass', () => {
  const { main } = require('./macos-floor.js')
  const { app, cleanup } = makeApp({ 'Contents/Resources/readme.txt': Buffer.from('text') })
  try {
    assert.throws(() => main(['check', app]), /no Mach-O files found/)
  } finally {
    cleanup()
  }
})

test('the CLI exits 1 on an offender and prints the Darwin version only on a pass', () => {
  const { main } = require('./macos-floor.js')
  const good = makeApp({ 'Contents/MacOS/Test': machO({ minos: '14.0' }) })
  const bad = makeApp({ 'Contents/MacOS/Test': machO({ minos: '15.0' }) })
  const writes = []
  const origOut = process.stdout.write
  const origErr = console.error
  process.stdout.write = (s) => { writes.push(String(s)); return true }
  console.error = () => {}
  try {
    assert.equal(main(['check', good.app]), 0)
    assert.equal(main(['check', bad.app]), 1)
  } finally {
    process.stdout.write = origOut
    console.error = origErr
    good.cleanup()
    bad.cleanup()
  }
  assert.deepEqual(writes, ['23.0.0\n'])
})
