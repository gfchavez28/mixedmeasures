// Electron's and Chromium's licence notices travel with every copy of the app (#1122).
//
// WHY: Electron's MIT licence and Chromium's notices ask that they ship with every copy. The
// Electron download carries both beside the binary (`LICENSE`, `LICENSES.chromium.html`).
// On Windows and Linux electron-builder leaves them at the top of the unpacked app (the first
// renamed `LICENSE.electron.txt`), so the installers carry them. On macOS every target packs
// ONLY the `.app` bundle, and electron-builder up to 26.15.3 deleted the two files outside it:
// the published v1.5.5 and v1.5.6 Mac zips (the two measured) hold neither, and every gate was
// green, because nothing looked. 26.16.1 moves them into `Contents/Resources`, inside the signature's seal.
// This script is the look: each release leg runs it on what it built.
//
//   node check-notices.js <App.app | win-unpacked | linux-unpacked>
//     a .app is read at Contents/Resources; anything else at its top level
//     exit 1: a notice missing, empty, or not the text it should be
//
// Dependency-free (node stdlib), like the other release scripts here.

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * The two notices, by the names electron-builder gives them in a packaged app, and a phrase
 * each one must contain, so a placeholder or a swapped file does not pass. Both phrases were
 * read from Electron 44.5.1's own download (electron-v44.5.1-linux-x64.zip, SHA-256 = the npm
 * package's checksums.json): `LICENSE` is the MIT text, and the credits page opens "Chromium
 * software is made available as source code…".
 */
const NOTICES = Object.freeze([
  Object.freeze({ file: 'LICENSE.electron.txt', phrase: 'Permission is hereby granted', what: "Electron's MIT licence" }),
  Object.freeze({ file: 'LICENSES.chromium.html', phrase: 'Chromium', what: "Chromium's credits (its third-party notices)" }),
])

/** Where the notices live in a packaged app: inside the bundle on macOS, at the top elsewhere. */
function noticeDir(target) {
  return target.replace(/[\\/]+$/, '').endsWith('.app') ? path.join(target, 'Contents', 'Resources') : target
}

/**
 * One line per notice that is missing, empty or wrong; [] when both are present and right.
 * Throws when the target itself does not exist, so a wrong path never reads as "all missing".
 */
function checkNotices(target, notices = NOTICES) {
  if (!fs.existsSync(target)) throw new Error(`no such app: ${target}`)
  const dir = noticeDir(target)
  const problems = []
  for (const { file, phrase, what } of notices) {
    const full = path.join(dir, file)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      problems.push(`${file} (${what}) is missing from ${dir}`)
      continue
    }
    if (!stat.isFile() || stat.size === 0) {
      problems.push(`${file} (${what}) is ${stat.isFile() ? 'empty' : 'not a file'}`)
      continue
    }
    if (!fs.readFileSync(full, 'utf8').includes(phrase)) {
      problems.push(`${file} does not read as ${what}: no "${phrase}" in it`)
    }
  }
  return problems
}

function main(argv) {
  const [target] = argv
  if (!target) throw new Error('usage: check-notices.js <App.app | win-unpacked | linux-unpacked>')
  const problems = checkNotices(target)
  if (problems.length > 0) {
    console.error(`check-notices: ${target} does not carry the licence notices it must:`)
    for (const p of problems) console.error(`  ${p}`)
    return 1
  }
  const dir = noticeDir(target)
  const sizes = NOTICES.map(({ file }) => `${file} (${fs.statSync(path.join(dir, file)).size.toLocaleString('en-US')} bytes)`)
  console.log(`check-notices: ${dir} carries ${sizes.join(' and ')}`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`check-notices: ${err.message}`)
    process.exitCode = 1
  }
}

module.exports = { NOTICES, noticeDir, checkNotices, main }
