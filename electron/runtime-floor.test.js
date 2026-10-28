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
// FLOOR is the version last taken ON PURPOSE, not the lowest safe one. On the 44 line
// (#1100, 2026-10-04) the security floor is lower than what was taken:
//   - GHSA-qmv3-fv6v-rmhq, the one 08-29 advisory whose mechanism applies here (a
//     compromised renderer poisoning the sandboxed preload's code cache; main.js runs
//     `sandbox: true` with preload.js), is fixed from 44.0.0-beta.6;
//   - the two CISA-KEV V8 bugs are fixed from 44.2.0 (CVE-2026-85046, backport #53479)
//     and 44.4.0 (CVE-2026-87491, #53769), and natively from 44.4.2;
//   - 44.4.0 and 44.4.4 also fix two events this shell listens to (`unresponsive` after
//     sleep on Windows; `ready-to-show` never firing for some hidden windows).
// 44.5.1 was the line's head as taken at that move. 1.5.8 takes 44.9.3 (#1366), the head on
// 2026-10-24, and here the floor IS a security floor:
//   - GHSA-jr5w-w6x2-84p9 (high, 2026-10-22): compromised eMudhra intermediate certificates,
//     blocked in Chromium networking and in Node tls/https/fetch from 44.9.1. The update
//     check is this app's one outbound TLS connection, and on Linux nothing behind TLS
//     checks the AppImage it downloads. 44.9.0 is NOT enough: it is what a bare
//     `npm update electron` resolved on 2026-10-24 under the 7-day window, and GHSA-jr5w
//     names it.
//   - 44.7.2's fix for an interrupted Squirrel.Mac install leaving an app macOS calls
//     "damaged" (#54844), on the path electron-updater's MacUpdater drives;
//   - 44.9.3's 69 upstream ANGLE, Chromium, PDFium, Skia and V8 backports (#55149).
// Taken 2026-10-28 over 44.10.0 (10-27, inside the window), whose release notes were read
// that day: its named fixes (Node 24.22.1's CVEs) reach no Node API this shell calls
// (RELEASING §1b's 1.5.8 block).
//
// A MAJOR move fails here until FLOOR moves with it, deliberately. A patched version is
// per LINE (qmv3 is fixed in 42.10.0, 43.5.0 and 44.0.0-beta.6; jr5w in 42.11.16, 43.8.1,
// 44.9.1 and 45.0.0-beta.6), so a bare "44.9.3 or higher" would wave through the next
// line's early releases, which can lack a fix that was backported here.
// Whoever changes the major reads that line's advisories and sets FLOOR to the version
// they took. ⚠️ The move after 44 also needs #1121 first: Electron 46 removes the
// synchronous safeStorage calls key-manager.js uses.
const FLOOR = '44.9.3'

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
