const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runAsPrimaryInstance } = require('./single-instance')

// #1141 — a second launch of the app started a SECOND backend on the same database,
// and nothing ever stopped it: main.js quit when the lock was refused, but registered
// `whenReady(startup)` and its handlers at module scope regardless, so `startup()` ran
// anyway ~90 ms later. Two halves are pinned here: the module's rule (register only
// with the lock) through a fake `app`, and main.js's use of it through a source scan —
// the one link a headless suite cannot drive (renderer-recovery.test.js's precedent).

function fakeApp({ lock }) {
  const calls = []
  return {
    calls,
    requestSingleInstanceLock() { calls.push('lock'); return lock },
    quit() { calls.push('quit') },
  }
}

test('a refused instance quits and registers NOTHING', () => {
  const app = fakeApp({ lock: false })
  let registered = 0
  const primary = runAsPrimaryInstance({ app, register: () => { registered++ } })
  assert.equal(primary, false)
  assert.equal(registered, 0, 'register ran in the refused instance — its startup() would spawn a second backend')
  assert.deepEqual(app.calls, ['lock', 'quit'])
})

test('the instance holding the lock registers once and does not quit', () => {
  const app = fakeApp({ lock: true })
  let registered = 0
  const primary = runAsPrimaryInstance({ app, register: () => { registered++ } })
  assert.equal(primary, true)
  assert.equal(registered, 1)
  assert.deepEqual(app.calls, ['lock'], 'the primary instance must never call app.quit() here')
})

// ── main.js ────────────────────────────────────────────────────────────────────

// ⚠️ `(^|[^:])//` and not a bare `//`, so `http://` inside a string is not taken for a
// comment (packaged-files.test.js's stripper, for the same reason).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const LIFECYCLE = /\bapp\.(on|once|whenReady)\(/g
const REGISTER_START = 'function registerPrimaryInstance() {'

/**
 * Every `app.on(` / `app.once(` / `app.whenReady(` in `src`, split by whether it lies
 * inside `registerPrimaryInstance`'s body. The body ends at the first line that is a
 * bare `}` — main.js declares its functions at the top level, so that is the function's
 * own closing brace.
 */
function lifecycleCalls(src) {
  const code = stripComments(src)
  const start = code.indexOf(REGISTER_START)
  let end = -1
  if (start !== -1) {
    const close = /^\}$/m
    const rest = code.slice(start)
    const m = close.exec(rest)
    end = m ? start + m.index : -1
  }
  const inside = []
  const outside = []
  for (let m = LIFECYCLE.exec(code); m !== null; m = LIFECYCLE.exec(code)) {
    const within = start !== -1 && end !== -1 && m.index > start && m.index < end
    ;(within ? inside : outside).push(m[0])
  }
  LIFECYCLE.lastIndex = 0
  return { inside, outside, found: start !== -1 && end !== -1 }
}

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')

test('main.js registers every app listener inside registerPrimaryInstance', () => {
  const { inside, outside, found } = lifecycleCalls(MAIN)
  assert.ok(found, `main.js no longer declares \`${REGISTER_START}\` closed by a top-level \`}\``)
  // Population self-check (#729/#730): second-instance, before-quit,
  // window-all-closed and whenReady. A scan that finds none passes by finding nothing.
  assert.ok(inside.length >= 4, `the scan found ${inside.length} lifecycle calls inside — it has gone blind`)
  assert.deepEqual(outside, [], (
    `${outside.join(', ')} registered OUTSIDE registerPrimaryInstance, so it runs in a ` +
    'refused second launch too (#1141). Move it inside the function.'
  ))
})

test('main.js claims the lock only through runAsPrimaryInstance, with that function', () => {
  const code = stripComments(MAIN)
  assert.doesNotMatch(code, /requestSingleInstanceLock\(/, 'a second lock call in main.js bypasses the module')
  const uses = code.match(/runAsPrimaryInstance\(\{\s*app,\s*register:\s*registerPrimaryInstance\s*\}\)/g) || []
  assert.equal(uses.length, 1)
})

test('the scan can say no (a predicate falsifier)', () => {
  const planted = [
    'function registerPrimaryInstance() {',
    "  app.on('before-quit', stop)",
    '}',
    'app.whenReady().then(startup)',
    '',
  ].join('\n')
  const { inside, outside } = lifecycleCalls(planted)
  assert.deepEqual(inside, ['app.on('])
  assert.deepEqual(outside, ['app.whenReady('])
})

test('a second launch during the splash focuses the splash', () => {
  // Before the page loads, `mainWindow` is null, and the handler focused nothing — a
  // click on the shortcut looked ignored. It now falls back to the splash.
  const code = stripComments(MAIN)
  assert.match(
    code,
    /app\.on\('second-instance',[\s\S]*?mainWindow && !mainWindow\.isDestroyed\(\) \? mainWindow : splashWindow/,
  )
})
