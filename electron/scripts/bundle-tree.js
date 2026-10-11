// Is the app an updater unpacks from the release zip the app that was built? (#1122)
//
// WHY: installed Macs update from the `-mac-arm64.zip`, never the dmg. Squirrel.Mac (inside
// Electron) unpacks it with `/usr/bin/ditto -xk` and installs it only if its signature checks
// out against the running app's designated requirement. electron-builder 26.15.4 changed the
// tool that MAKES that zip (Info-ZIP `zip -y` → 7-Zip 24.09 with `-snl`). Two ways a zip can
// go wrong and still be shipped with every other gate green, because every gate reads the
// built .app, not the zip:
//   - a symlink stored as the thing it points to (#9846 upstream: a framework's
//     `Versions/Current` becomes a real folder, codesign says "bundle format is ambiguous",
//     and every Mac's update is refused, silently, every four hours);
//   - an executable bit lost on the way (Squirrel does not check permissions, so the update
//     installs, and then the app cannot start).
// The release's mac leg unpacks the zip the way Squirrel does and runs `compare` against the
// built app; this file is the comparison, so it can be tested here on real symlinks and modes.
//
//   node bundle-tree.js compare <built.app> <unpacked.app>
//     stdout: what was compared (entries, symlinks, executable files)
//     stderr: up to 40 differences
//     exit 1: any difference
//
// Dependency-free (node stdlib), like the other release scripts here.

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

/**
 * The permission bits compared: read and execute for owner, group and other. Write bits are
 * left out on purpose — they decide nothing about whether the app starts, ShipIt re-owns the
 * bundle on install, and an archiver's umask choice there would fail the release for nothing.
 */
const MODE_BITS = 0o555

/**
 * Every entry under `root` (not following symlinks), as relative path → description:
 *   'link -> <target>'          a symlink, by its own target text
 *   'dir'                        a directory
 *   'file <mode> <sha256>'       a regular file: MODE_BITS in octal, and its content hash
 *   'other <mode>'               anything else (a FIFO, a socket — never expected in an app)
 */
function snapshot(root) {
  const entries = new Map()
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink()) {
        entries.set(rel, `link -> ${fs.readlinkSync(full)}`)
      } else if (st.isDirectory()) {
        entries.set(rel, 'dir')
        walk(full)
      } else if (st.isFile()) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        entries.set(rel, `file ${(st.mode & MODE_BITS).toString(8).padStart(3, '0')} ${hash}`)
      } else {
        entries.set(rel, `other ${(st.mode & 0o7777).toString(8)}`)
      }
    }
  }
  walk(root)
  return entries
}

/** One line per difference between two snapshots; [] when they are the same tree. */
function compareSnapshots(built, unpacked) {
  const lines = []
  for (const [rel, want] of built) {
    const got = unpacked.get(rel)
    if (got === undefined) lines.push(`missing from the unpacked app: ${rel} (${want})`)
    else if (got !== want) lines.push(`differs: ${rel}\n    built:    ${want}\n    unpacked: ${got}`)
  }
  for (const [rel, got] of unpacked) {
    if (!built.has(rel)) lines.push(`only in the unpacked app: ${rel} (${got})`)
  }
  return lines
}

/** Counts that say what a comparison covered, so a pass over an empty tree cannot look like one. */
function summarise(entries) {
  let links = 0
  let executables = 0
  for (const d of entries.values()) {
    if (d.startsWith('link')) links++
    else if (d.startsWith('file') && parseInt(d.split(' ')[1], 8) & 0o111) executables++
  }
  return { entries: entries.size, links, executables }
}

function main(argv) {
  const [command, built, unpacked] = argv
  if (command !== 'compare' || !built || !unpacked) throw new Error('usage: bundle-tree.js compare <built.app> <unpacked.app>')
  for (const p of [built, unpacked]) if (!fs.statSync(p).isDirectory()) throw new Error(`not a directory: ${p}`)
  const a = snapshot(built)
  const b = snapshot(unpacked)
  const { entries, links, executables } = summarise(a)
  if (entries === 0) throw new Error(`${built} is empty — nothing to compare`)
  const diffs = compareSnapshots(a, b)
  if (diffs.length > 0) {
    console.error(`bundle-tree: the unpacked app is NOT the built app (${diffs.length} differences):`)
    for (const d of diffs.slice(0, 40)) console.error(`  ${d}`)
    if (diffs.length > 40) console.error(`  … and ${diffs.length - 40} more`)
    return 1
  }
  console.log(
    `bundle-tree: identical — ${entries} entries, ${links} symlinks, ${executables} executable files; ` +
      'every path, type, symlink target, read/execute bit and SHA-256 matches',
  )
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`bundle-tree: ${err.message}`)
    process.exitCode = 1
  }
}

module.exports = { MODE_BITS, snapshot, compareSnapshots, summarise, main }
