const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// The shipped Electron runtime has a floor that no auditor holds (#1093).
//
// `electron` lives in devDependencies (electron-builder supplies it), so every
// `npm audit --omit=dev` gate skips it by construction. And on 2026-09-28 all six of
// electron/electron's 08-29 advisories returned 404 from GitHub's global advisory
// database, so the full-tree audit and Dependabot were blind to it as well: v1.5.2,
// v1.5.3 and v1.5.4 shipped 42.8.1 while four of those advisories named it. A lockfile
// edit, a revert or a careless install can take the runtime back below the fixes with
// every gate green. This file is the assertion (dependency-security.md §1a: a floor the
// auditor cannot hold needs its own).
//
// FLOOR is the version last taken ON PURPOSE, not the lowest safe one. 42.10.0 closes
// the one 08-29 advisory whose mechanism applies here — GHSA-qmv3-fv6v-rmhq, a
// compromised renderer poisoning the sandboxed preload's code cache (main.js runs
// `sandbox: true` with preload.js) — and the releases after it carry the line's
// Chromium/V8 backport batches, 42.11.1's fifteen named CVEs among them.
//
// A MAJOR move fails here until FLOOR moves with it, deliberately. A patched version is
// per LINE (qmv3 is fixed in 42.10.0 but in 43.4.2 on the 43 line), so "42.11.8 or
// higher" would wave through 43.0.0–43.4.1, which lack the fix. Whoever changes the
// major reads that line's advisories and sets FLOOR to the version they took.
const FLOOR = '42.11.8'

const ELECTRON_DIR = __dirname
const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package-lock.json'), 'utf8'))

/** '42.11.8' → { core: [42, 11, 8], pre: '' }; anything else → null. */
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null
}

function compareCore(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

const floor = parse(FLOOR)

test('FLOOR itself parses as a stable release', () => {
  assert.ok(floor, `FLOOR ${FLOOR} does not parse`)
  assert.equal(floor.pre, '')
})

test('the locked electron is a stable release on FLOOR\'s line, at or above it', () => {
  const entry = lock.packages['node_modules/electron']
  assert.ok(entry, 'package-lock.json has no node_modules/electron entry')
  const locked = parse(entry.version)
  assert.ok(locked, `locked electron version ${entry.version} does not parse`)
  assert.equal(locked.pre, '', `the shipped runtime must be a stable release, not ${entry.version}`)
  assert.equal(
    locked.core[0], floor.core[0],
    `electron ${entry.version} is on a different major than FLOOR ${FLOOR}. A major move is a ` +
    `deliberate decision: read that line's advisories (a patched version is per line) and set ` +
    `FLOOR in this file to the version taken.`,
  )
  assert.ok(
    compareCore(locked.core, floor.core) >= 0,
    `electron ${entry.version} is below FLOOR ${FLOOR} — the runtime has gone back below security ` +
    `fixes no audit gate can see (#1093).`,
  )
})

test('the declared range cannot resolve below FLOOR', () => {
  const spec = pkg.devDependencies && pkg.devDependencies.electron
  assert.ok(spec, 'package.json declares no electron devDependency')
  // `^x.y.z` or an exact `x.y.z`: both floors are x.y.z. Any other form (`~`, `>=`, `x`,
  // a range) is refused rather than interpreted, so a fresh resolution cannot land below FLOOR.
  const m = /^\^?(\d+\.\d+\.\d+)$/.exec(spec)
  assert.ok(m, `electron is declared as "${spec}"; declare "^${FLOOR}" (or an exact version)`)
  const declared = parse(m[1])
  assert.equal(declared.core[0], floor.core[0], `declared "${spec}" is not on FLOOR ${FLOOR}'s major`)
  assert.ok(
    compareCore(declared.core, floor.core) >= 0,
    `declared "${spec}" admits versions below FLOOR ${FLOOR}; raise it to "^${FLOOR}"`,
  )
})
