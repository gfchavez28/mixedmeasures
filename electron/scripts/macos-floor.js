// The macOS floor a built .app really has, checked against the one it declares (#1118).
//
// WHY: v1.5.5's Info.plist said macOS 12.0, while 101 of the binaries inside it — every
// numpy and scipy extension — were built for macOS 14. The build runner was macOS 14, so
// pip preferred those wheels over the older-macOS ones both projects also publish, and
// numpy loads when the backend starts. Nothing compared the two numbers, so the stated
// requirement was false with every gate green. A newer runner, a new wheel or a new
// Electron major can each raise the floor the same way; this script makes that loud.
//
// It also yields the value the update feed needs (#1100): electron-updater compares
// `minimumSystemVersion` in latest-mac.yml against os.release(), which on a Mac is the
// DARWIN kernel version, not the macOS one. Reading it from the BUILT app means the feed
// says what the shipped binary needs, never a number typed into a workflow.
//
//   node macos-floor.js check <path/to/App.app>
//     stdout: the Darwin version for the feed (e.g. 23.0.0), and nothing else
//     stderr: what was scanned, and every binary built for a newer macOS than declared
//     exit 1: any such binary, no Mach-O found at all, or a floor the table cannot map
//
// Dependency-free (node stdlib), like update-manifest.js: it runs on the release runner
// before anything else is installed there, and its parsing is unit-tested on Linux.

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * macOS major → Darwin major. A TABLE, not arithmetic: macOS 11–15 are Darwin 20–24, but
 * Apple renumbered macOS to 26 in 2025 and the kernel went on to 25 (runner-images READMEs,
 * 2026-10-04: macOS 14.8.9 → Darwin 23.6.0, 15.7.9 → 24.6.0, 26.6.2 → 25.6.0). An unknown
 * major throws, so the table grows by a decision and never by a guess.
 */
const MACOS_TO_DARWIN = Object.freeze({ 11: 20, 12: 21, 13: 22, 14: 23, 15: 24, 26: 25 })

/**
 * '14.0' → '23.0.0'. Only whole majors are mapped: a minor floor (14.2) has no Darwin
 * equivalent the table can vouch for, and rounding it down would let an update reach a
 * Mac that cannot run it.
 */
function darwinForMacos(version) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(version).trim())
  if (!m) throw new Error(`not a macOS version: "${version}"`)
  if (Number(m[2] || 0) !== 0 || Number(m[3] || 0) !== 0) {
    throw new Error(`macOS ${version}: only a whole major (e.g. 14.0) can be mapped to a Darwin version`)
  }
  const darwin = MACOS_TO_DARWIN[Number(m[1])]
  if (darwin === undefined) {
    throw new Error(`macOS ${m[1]} is not in MACOS_TO_DARWIN; add it from a runner image's Kernel Version line`)
  }
  return `${darwin}.0.0`
}

/** '14.0' vs '12.3' → positive; compares numerically, part by part. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/** A string value from an XML plist; a binary plist is refused rather than misread. */
function readPlistString(text, key) {
  if (text.startsWith('bplist')) throw new Error('Info.plist is a binary plist; this reader takes XML')
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(text)
  return m ? m[1].trim() : null
}

const MH_MAGIC = 0xfeedface // 32-bit, read little-endian
const MH_MAGIC_64 = 0xfeedfacf // 64-bit, read little-endian
const FAT_MAGIC = 0xcafebabe // big-endian header
const FAT_MAGIC_64 = 0xcafebabf
const LC_VERSION_MIN_MACOSX = 0x24
const LC_BUILD_VERSION = 0x32
const PLATFORM_MACOS = 1
/** A fat header with more slices than this is not one (a Java class also starts CAFEBABE) —
 *  and reading its slice table would allocate nfat × 20 bytes, up to 80 GB for a stray file. */
const MAX_FAT_ARCHES = 16

/** 0x000e0000 → '14.0'; the low byte is the patch level, which a floor ignores. */
function decodeVersion(v) {
  return `${v >>> 16}.${(v >>> 8) & 0xff}`
}

/**
 * The minimum-macOS values one Mach-O image declares, or null when the bytes at `offset`
 * are not a Mach-O header. `read(position, length)` returns a Buffer (shorter at EOF).
 */
function imageMinVersions(read, offset) {
  const head = read(offset, 32)
  if (head.length < 28) return null
  const magic = head.readUInt32LE(0)
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return null
  const ncmds = head.readUInt32LE(16)
  const sizeofcmds = head.readUInt32LE(20)
  const headerSize = magic === MH_MAGIC_64 ? 32 : 28
  const cmds = read(offset + headerSize, sizeofcmds)
  const found = []
  let p = 0
  for (let i = 0; i < ncmds && p + 8 <= cmds.length; i++) {
    const cmd = cmds.readUInt32LE(p)
    const size = cmds.readUInt32LE(p + 4)
    if (size < 8) break // a malformed command; stop rather than loop
    if (cmd === LC_BUILD_VERSION && p + 16 <= cmds.length) {
      // Only the macOS platform sets a macOS floor (a Catalyst or iOS slice says nothing here).
      if (cmds.readUInt32LE(p + 8) === PLATFORM_MACOS) found.push(decodeVersion(cmds.readUInt32LE(p + 12)))
    } else if (cmd === LC_VERSION_MIN_MACOSX && p + 12 <= cmds.length) {
      found.push(decodeVersion(cmds.readUInt32LE(p + 8)))
    }
    p += size
  }
  return found
}

/**
 * The highest minimum-macOS a file declares across all of its slices; null for a file
 * that is not Mach-O; 'unknown' for a Mach-O image that declares none.
 */
function fileMinVersion(read) {
  const first = read(0, 8)
  if (first.length < 8) return null
  const be = first.readUInt32BE(0)
  let versions = []
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const nfat = first.readUInt32BE(4)
    if (nfat < 1 || nfat > MAX_FAT_ARCHES) return null
    const entry = be === FAT_MAGIC_64 ? 32 : 20
    const table = read(8, nfat * entry)
    if (table.length < nfat * entry) return null
    let anyImage = false
    for (let i = 0; i < nfat; i++) {
      const at = i * entry
      const offset = be === FAT_MAGIC_64 ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8)
      const v = imageMinVersions(read, offset)
      if (v === null) continue
      anyImage = true
      versions = versions.concat(v)
    }
    if (!anyImage) return null
  } else {
    const v = imageMinVersions(read, 0)
    if (v === null) return null
    versions = v
  }
  if (versions.length === 0) return 'unknown'
  return versions.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi))
}

/** Every regular file under `dir`. Symlinks are NOT followed — a framework's Versions/Current
 *  link would otherwise count each binary twice, and a link cycle would never end. That needs no
 *  check of its own: a Dirent describes the LINK, so a symlink is neither isDirectory() nor
 *  isFile() and falls through both branches below. */
function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (entry.isFile()) yield full
  }
}

function fileReader(fd) {
  return (position, length) => {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, position)
    return buf.subarray(0, n)
  }
}

/**
 * Scan a built .app. Returns the declared floor, its Darwin version, how many Mach-O files
 * were read, and every file built for a newer macOS than declared (or declaring none).
 */
function checkApp(appDir) {
  const plistPath = path.join(appDir, 'Contents', 'Info.plist')
  if (!fs.existsSync(plistPath)) throw new Error(`no Contents/Info.plist under ${appDir}`)
  const declared = readPlistString(fs.readFileSync(plistPath, 'utf8'), 'LSMinimumSystemVersion')
  if (!declared) throw new Error('Info.plist has no LSMinimumSystemVersion')
  const darwin = darwinForMacos(declared)

  let machoCount = 0
  const offenders = []
  for (const file of walkFiles(appDir)) {
    const fd = fs.openSync(file, 'r')
    let minos
    try {
      minos = fileMinVersion(fileReader(fd))
    } finally {
      fs.closeSync(fd)
    }
    if (minos === null) continue
    machoCount++
    if (minos === 'unknown' || compareVersions(minos, declared) > 0) {
      offenders.push({ file: path.relative(appDir, file), minos })
    }
  }
  return { declared, darwin, machoCount, offenders }
}

function main(argv) {
  const [mode, appDir] = argv
  if (mode !== 'check' || !appDir) throw new Error('usage: macos-floor.js check <path/to/App.app>')
  const { declared, darwin, machoCount, offenders } = checkApp(appDir)
  // A scan that found no binaries proves nothing, and must not read as a pass.
  if (machoCount === 0) throw new Error(`no Mach-O files found under ${appDir} — wrong path?`)
  console.error(`macos-floor: ${machoCount} Mach-O files; LSMinimumSystemVersion ${declared} (Darwin ${darwin})`)
  if (offenders.length > 0) {
    console.error(`macos-floor: ${offenders.length} file(s) need a newer macOS than the app declares:`)
    for (const o of offenders) console.error(`  ${o.minos === 'unknown' ? 'no minimum' : `macOS ${o.minos}`}  ${o.file}`)
    console.error('Raise build.mac.minimumSystemVersion to the highest of these (and say so in the release notes),')
    console.error('or build those dependencies for the declared floor.')
    return 1
  }
  process.stdout.write(`${darwin}\n`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`macos-floor: ${err.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  MACOS_TO_DARWIN,
  darwinForMacos,
  compareVersions,
  readPlistString,
  fileMinVersion,
  checkApp,
  main,
}
