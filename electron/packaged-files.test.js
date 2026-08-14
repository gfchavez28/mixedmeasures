const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// electron-builder's `build.files` is a DENY-BY-DEFAULT allow-list: a module that
// isn't named there is simply absent from app.asar. Nothing in the build fails —
// `npm test`, tsc, lint, the signed 4-platform matrix and every CI gate stay green,
// because the miss only surfaces when Electron evaluates the require AT RUNTIME, in
// the packaged app, as a main-process "Cannot find module" crash box.
//
// That is exactly how v1.3.1's first cut shipped: `zoom.js` and `fatal-error.js` were
// both added this release, neither joined the list, and the installer bricked on
// launch. (The second one is the crash-dialog module itself — so the very machinery
// meant to report a fatal startup error was missing from the build.)
//
// This is the codebase's enumeration-debt shape, and the standing remedy applies:
// derive the enumeration from the artifact the next variant must touch. The required
// set is READ OUT OF THE REQUIRE GRAPH here rather than restated, so a new module is
// covered the moment main.js requires it — nobody has to remember this file exists.

const ELECTRON_DIR = __dirname
const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'))
const SHIPPED = pkg.build.files

// Roots of the packaged require graph. `main` is declared by package.json; preload is
// loaded by Electron from a PATH STRING (webPreferences.preload), never a require, so
// the walk cannot discover it and it is seeded explicitly.
const ROOTS = [pkg.main, 'preload.js']

// ⚠️ Strip comments BEFORE scanning. This guard's own header names require('./zoom')
// in prose; a naive scan matches that and reports modules nobody imports.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function localRequires(absFile) {
  const src = stripComments(fs.readFileSync(absFile, 'utf8'))
  const re = /require\(\s*['"](\.\/[A-Za-z0-9._/-]+)['"]\s*\)/g
  const found = []
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const spec = m[1].replace(/^\.\//, '')
    found.push(path.extname(spec) ? spec : `${spec}.js`)
  }
  return found
}

/** Every local module reachable from the packaged entry points, transitively. */
function reachableModules() {
  const seen = new Set()
  const queue = [...ROOTS]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const abs = path.join(ELECTRON_DIR, rel)
    if (!fs.existsSync(abs)) continue // reported by its own test below
    for (const dep of localRequires(abs)) queue.push(dep)
  }
  return seen
}

test('every module the packaged app can require is in build.files', () => {
  const missing = [...reachableModules()].filter((m) => !SHIPPED.includes(m)).sort()
  assert.deepEqual(
    missing,
    [],
    `These modules are reachable from the packaged entry points but are NOT in ` +
      `electron/package.json build.files, so they will be absent from app.asar and ` +
      `the app will crash on launch with "Cannot find module": ${missing.join(', ')}`
  )
})

test('every file named in build.files actually exists', () => {
  // The inverse rot: a renamed or deleted module leaves a dangling entry, and
  // electron-builder does not object to one.
  const absent = SHIPPED.filter((f) => !fs.existsSync(path.join(ELECTRON_DIR, f))).sort()
  assert.deepEqual(absent, [], `build.files names files that do not exist: ${absent.join(', ')}`)
})

test('the entry points themselves are shipped', () => {
  // A guard that only walks the graph would pass vacuously if main.js were dropped
  // from the list — there would be nothing to walk.
  for (const root of ROOTS) {
    assert.ok(SHIPPED.includes(root), `${root} is an entry point and must be in build.files`)
  }
})

test('test files are never shipped', () => {
  const leaked = SHIPPED.filter((f) => f.endsWith('.test.js'))
  assert.deepEqual(leaked, [], `test files must not be packaged: ${leaked.join(', ')}`)
})
