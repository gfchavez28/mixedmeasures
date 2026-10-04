// Tests for check-fuses.js (#1100). The check is the only thing that looks at the fuses a
// packaged app really carries, so these pin both halves: the comparison, and — end to end on
// a stand-in binary — that the config in package.json, flipped the way electron-builder flips
// it, is exactly what the check then accepts.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { compareFuses, locateBinary, loadFuses, main, NOT_FUSES } = require('./check-fuses.js')

const fuses = loadFuses()
const { FuseV1Options, FuseState, SENTINEL } = fuses
const pkg = require('../package.json')

/** Electron 44.5.1's shipped defaults (build/fuses/fuses.json5), in wire order. */
const ELECTRON_44_DEFAULTS = '101100011' // runAsNode … wasmTrapHandlers

/** A stand-in Electron binary: junk, the sentinel, wire version 1, the wire. */
function fakeElectron(wire = ELECTRON_44_DEFAULTS) {
  return Buffer.concat([
    Buffer.from('\x7fELF not really a binary '),
    Buffer.from(SENTINEL),
    Buffer.from([1, wire.length]),
    Buffer.from(wire), // '0' = 48 = DISABLE, '1' = 49 = ENABLE
    Buffer.from(' trailing bytes'),
  ])
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fuses-'))
}

/** A wire as getCurrentFuseWire returns it, from a '0'/'1' string. */
function wireOf(bits) {
  const wire = { version: '1' }
  ;[...bits].forEach((b, i) => { wire[i] = b === '1' ? FuseState.ENABLE : FuseState.DISABLE })
  return wire
}

test('the shipped config sets the six fuses the plan decided, and cookie encryption is left alone', () => {
  const f = pkg.build.electronFuses
  assert.equal(f.runAsNode, false)
  assert.equal(f.enableNodeOptionsEnvironmentVariable, false)
  assert.equal(f.enableNodeCliInspectArguments, false)
  assert.equal(f.grantFileProtocolExtraPrivileges, false)
  assert.equal(f.enableEmbeddedAsarIntegrityValidation, true)
  assert.equal(f.onlyLoadAppFromAsar, true)
  // One-way: once on, turning it off corrupts every researcher's cookie store. Decided
  // 2026-10-04 to leave it; changing that is a decision, not an edit.
  assert.equal(f.enableCookieEncryption, undefined)
})

test('every configured key names a fuse @electron/fuses knows', () => {
  for (const key of Object.keys(pkg.build.electronFuses)) {
    if (NOT_FUSES.has(key)) continue
    assert.notEqual(FuseV1Options[key[0].toUpperCase() + key.slice(1)], undefined, key)
  }
})

test('compareFuses passes a wire that matches and names each fuse that does not', () => {
  const config = { runAsNode: false, onlyLoadAppFromAsar: true, resetAdHocDarwinSignature: true }
  assert.deepEqual(compareFuses(config, wireOf('000001000'), fuses), [])
  assert.deepEqual(compareFuses(config, wireOf('100000000'), fuses), [
    'runAsNode: configured DISABLE, binary says ENABLE',
    'onlyLoadAppFromAsar: configured ENABLE, binary says DISABLE',
  ])
})

test('compareFuses fails a wire too short to hold a configured fuse, and an unknown key', () => {
  assert.deepEqual(compareFuses({ grantFileProtocolExtraPrivileges: false }, wireOf('0000'), fuses), [
    'grantFileProtocolExtraPrivileges: configured DISABLE, binary says absent from the wire',
  ])
  assert.deepEqual(compareFuses({ notAFuse: true }, wireOf('0'), fuses), ['notAFuse: not a fuse @electron/fuses knows'])
})

test('locateBinary finds the one file carrying the sentinel, and refuses zero or two', () => {
  const dir = tmpdir()
  try {
    fs.writeFileSync(path.join(dir, 'libffmpeg.so'), 'a library')
    fs.writeFileSync(path.join(dir, 'chrome-sandbox'), 'a helper')
    assert.throws(() => locateBinary(dir, SENTINEL), /found 0/)
    fs.writeFileSync(path.join(dir, 'mixedmeasures-desktop'), fakeElectron())
    assert.equal(locateBinary(dir, SENTINEL), path.join(dir, 'mixedmeasures-desktop'))
    fs.writeFileSync(path.join(dir, 'second'), fakeElectron())
    assert.throws(() => locateBinary(dir, SENTINEL), /found 2/)
    assert.equal(locateBinary('/x/Mixed Measures.app', SENTINEL), '/x/Mixed Measures.app')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('end to end: an unflipped binary fails; flipped as electron-builder flips it, it passes', async () => {
  const dir = tmpdir()
  const bin = path.join(dir, 'MixedMeasures.exe')
  const quiet = { log: console.log, error: console.error }
  console.log = () => {}
  console.error = () => {}
  try {
    fs.writeFileSync(bin, fakeElectron())
    assert.equal(await main([dir], { pkg, fuses }), 1)

    // electron-builder's own mapping from build.electronFuses to a flip (platformPackager.js
    // generateFuseConfig), so a drift between its key names and ours fails here.
    // Through the package index: requiring out/platformPackager alone trips its own
    // circular imports ("Class extends value undefined").
    const { PlatformPackager } = require('app-builder-lib')
    const flipConfig = await PlatformPackager.prototype.generateFuseConfig.call(null, pkg.build.electronFuses)
    await require('@electron/fuses').flipFuses(bin, flipConfig)

    assert.equal(await main([dir], { pkg, fuses }), 0)
    // The fuse no config touches keeps Electron's default (wasmTrapHandlers, the 9th).
    const wire = await fuses.getCurrentFuseWire(bin)
    assert.equal(wire[8], FuseState.ENABLE)
  } finally {
    console.log = quiet.log
    console.error = quiet.error
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
