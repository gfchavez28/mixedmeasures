// Read the fuses back out of a PACKAGED app and compare them with build.electronFuses (#1100).
//
// Fuses are bytes in the Electron binary that electron-builder flips at package time, just
// before signing. They turn off ways for another local program to run code AS this signed
// app — ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect — and make the app refuse a modified
// app.asar. Nothing else observes them: a skipped or failed flip ships an app that launches,
// passes every gate and has none of the protection. So each release leg reads the wire from
// what it built and fails when it differs from the config.
//
//   node check-fuses.js <App.app | electron binary | unpacked dir>
//     a directory is searched (top level only) for the one file carrying the fuse sentinel,
//     so the leg does not have to know each platform's executable name
//
// Uses @electron/fuses (a devDependency, via electron-builder) to READ the wire, so it reads
// it exactly the way the flip wrote it.

'use strict'

const fs = require('fs')
const path = require('path')

/** build.electronFuses keys that are options to the flip, not fuses. */
const NOT_FUSES = new Set(['resetAdHocDarwinSignature', 'strictlyRequireAllFuses'])

/** 'runAsNode' → 'RunAsNode', the FuseV1Options member electron-builder maps it to. */
function optionName(configKey) {
  return configKey[0].toUpperCase() + configKey.slice(1)
}

/**
 * Compare a fuse wire (getCurrentFuseWire's result) with the config. Returns one line per
 * fuse that is not as configured; [] when all match.
 */
function compareFuses(electronFuses, wire, { FuseV1Options, FuseState }) {
  const problems = []
  for (const [key, want] of Object.entries(electronFuses)) {
    if (NOT_FUSES.has(key)) continue
    const index = FuseV1Options[optionName(key)]
    if (index === undefined) {
      problems.push(`${key}: not a fuse @electron/fuses knows`)
      continue
    }
    const actual = wire[index]
    const expected = want ? FuseState.ENABLE : FuseState.DISABLE
    if (actual !== expected) {
      const said = actual === undefined ? 'absent from the wire' : (FuseState[actual] || `byte ${actual}`)
      problems.push(`${key}: configured ${want ? 'ENABLE' : 'DISABLE'}, binary says ${said}`)
    }
  }
  return problems
}

/** The file to read: an .app as is, a file as is, or the one top-level file in a
 *  directory that carries the fuse sentinel. */
function locateBinary(target, sentinel) {
  if (target.endsWith('.app')) return target
  const stat = fs.statSync(target)
  if (stat.isFile()) return target
  const marker = Buffer.from(sentinel)
  const carriers = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(target, e.name))
    .filter((file) => fs.readFileSync(file).includes(marker))
  if (carriers.length !== 1) {
    throw new Error(
      `expected exactly one Electron binary in ${target}, found ${carriers.length}` +
        (carriers.length ? `: ${carriers.map((f) => path.basename(f)).join(', ')}` : ''),
    )
  }
  return carriers[0]
}

/** @electron/fuses 1.x exports the reader and FuseV1Options from its index, but FuseState
 *  and SENTINEL only from dist/constants (the package declares no `exports`, so the deep
 *  require is allowed). */
function loadFuses() {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
  const { FuseState, SENTINEL } = require('@electron/fuses/dist/constants')
  return { getCurrentFuseWire, FuseV1Options, FuseState, SENTINEL }
}

async function main(argv, { pkg = require('../package.json'), fuses = loadFuses() } = {}) {
  const [target] = argv
  if (!target) throw new Error('usage: check-fuses.js <App.app | electron binary | unpacked dir>')
  const configured = pkg.build && pkg.build.electronFuses
  if (!configured) throw new Error('package.json has no build.electronFuses — nothing to check against')
  const binary = locateBinary(target, fuses.SENTINEL)
  const wire = await fuses.getCurrentFuseWire(binary)
  const problems = compareFuses(configured, wire, fuses)
  const names = Object.keys(configured).filter((k) => !NOT_FUSES.has(k))
  if (problems.length > 0) {
    console.error(`check-fuses: ${path.basename(binary)} does not carry the configured fuses:`)
    for (const p of problems) console.error(`  ${p}`)
    return 1
  }
  console.log(`check-fuses: ${path.basename(binary)} carries all ${names.length} configured fuses (${names.join(', ')})`)
  return 0
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => {
      console.error(`check-fuses: ${err.message}`)
      process.exitCode = 1
    },
  )
}

module.exports = { NOT_FUSES, optionName, compareFuses, locateBinary, loadFuses, main }
