// Tests for update-manifest.js (#29 slab S1) — the manifest is LOAD-BEARING for
// auto-update: a wrong sha512 fails every mac update at validation, and a
// single-arch manifest strands the other arch. Fixtures mirror the exact shape
// electron-builder 25 emits (incl. unknown keys like blockMapSize, which must
// round-trip untouched).

'use strict'

const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  parseManifest,
  renderManifest,
  patchManifest,
  mergeManifests,
} = require('./update-manifest.js')

const ARM64 = `version: 1.2.0
files:
  - url: MixedMeasures-1.2.0-mac-arm64.zip
    sha512: oldzipsha==
    size: 111
  - url: MixedMeasures-1.2.0-mac-arm64.dmg
    sha512: olddmgsha==
    size: 222
    blockMapSize: 33
path: MixedMeasures-1.2.0-mac-arm64.zip
sha512: oldzipsha==
releaseDate: '2026-07-10T12:00:00.000Z'
`

const X64 = `version: 1.2.0
files:
  - url: MixedMeasures-1.2.0-mac-x64.zip
    sha512: x64zipsha==
    size: 333
  - url: MixedMeasures-1.2.0-mac-x64.dmg
    sha512: x64dmgsha==
    size: 444
path: MixedMeasures-1.2.0-mac-x64.zip
sha512: x64zipsha==
releaseDate: '2026-07-10T12:05:00.000Z'
`

function sha512b64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64')
}

test('parse → render round-trips byte-identically (unknown keys survive)', () => {
  assert.strictEqual(renderManifest(parseManifest(ARM64)), ARM64)
  assert.strictEqual(renderManifest(parseManifest(X64)), X64)
})

test('parse rejects a manifest without a files block', () => {
  assert.throws(() => parseManifest('version: 1.2.0\npath: x.zip\n'), /no files: block/)
})

test('patch recomputes sha512+size for artifacts on disk, leaves absent ones alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-manifest-'))
  try {
    // Only the dmg exists on disk (the staple rewrote it); the zip is absent
    // from this dir — its entry must remain untouched.
    const dmgBytes = Buffer.from('stapled dmg bytes')
    fs.writeFileSync(path.join(dir, 'MixedMeasures-1.2.0-mac-arm64.dmg'), dmgBytes)

    const { text, patched } = patchManifest(ARM64, dir)
    assert.deepStrictEqual(patched, ['MixedMeasures-1.2.0-mac-arm64.dmg'])
    assert.match(text, new RegExp(`sha512: ${sha512b64(dmgBytes).replace(/[+/=]/g, '\\$&')}`))
    assert.match(text, new RegExp(`size: ${dmgBytes.length}\\b`))
    // zip entry untouched; blockMapSize preserved verbatim
    assert.match(text, /url: MixedMeasures-1\.2\.0-mac-arm64\.zip\n {4}sha512: oldzipsha==/)
    assert.match(text, /blockMapSize: 33/)
    // top-level sha512 mirrors the zip (unpatched here) → must NOT change
    assert.match(text, /\npath: MixedMeasures-1\.2\.0-mac-arm64\.zip\nsha512: oldzipsha==/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('patch updates the top-level sha512 when the top-level path was repatched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-manifest-'))
  try {
    const zipBytes = Buffer.from('zip bytes v2')
    fs.writeFileSync(path.join(dir, 'MixedMeasures-1.2.0-mac-arm64.zip'), zipBytes)
    const { text } = patchManifest(ARM64, dir)
    const expected = sha512b64(zipBytes)
    // both the files entry AND the legacy top-level field carry the new hash
    const occurrences = text.split(expected).length - 1
    assert.strictEqual(occurrences, 2, `top-level sha512 must track the patched zip:\n${text}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('patch fails loudly when NO listed artifact exists in the dir (wrong dir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-manifest-'))
  try {
    assert.throws(() => patchManifest(ARM64, dir), /no manifest artifacts found/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('merge combines both arches into one manifest, first head/tail wins', () => {
  const { text, urls } = mergeManifests([ARM64, X64])
  assert.deepStrictEqual(urls, [
    'MixedMeasures-1.2.0-mac-arm64.zip',
    'MixedMeasures-1.2.0-mac-arm64.dmg',
    'MixedMeasures-1.2.0-mac-x64.zip',
    'MixedMeasures-1.2.0-mac-x64.dmg',
  ])
  const merged = parseManifest(text)
  assert.strictEqual(merged.version, '1.2.0')
  assert.strictEqual(merged.entries.length, 4)
  // x64 entry hashes survive the merge
  assert.match(text, /url: MixedMeasures-1\.2\.0-mac-x64\.dmg\n {4}sha512: x64dmgsha==/)
  // exactly one top-level path block (the arm64 one)
  assert.strictEqual(text.split('\npath: ').length - 1, 1)
  assert.match(text, /\npath: MixedMeasures-1\.2\.0-mac-arm64\.zip\n/)
})

test('merge is idempotent on duplicate urls (re-run safety)', () => {
  const { urls } = mergeManifests([ARM64, ARM64, X64])
  assert.strictEqual(urls.length, 4)
})

test('merge of a single manifest is a valid passthrough (one mac leg failed)', () => {
  const { text } = mergeManifests([X64])
  assert.strictEqual(text, X64)
})

test('merge refuses mixed versions — a lying manifest is worse than no manifest', () => {
  const other = X64.replace(/1\.2\.0/g, '1.2.1')
  assert.throws(() => mergeManifests([ARM64, other]), /version mismatch/)
})
