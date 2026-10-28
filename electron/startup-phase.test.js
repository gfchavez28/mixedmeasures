// #1362 — the startup deadline waits for an UPDATE of the database instead of killing it.
// Run: `node --test` (no Electron / no display needed).
//
// Before: `waitForHealth` allowed a fixed 60 s, and a 1.0 project of 400k turns took 69 s
// to update on SQLCipher (78 s to its first /health) — so the shell killed a healthy update,
// and on Windows the kill undid it, every launch.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  freePort,
  waitForHealth,
  stopBackend,
  createStartupDeadline,
  splashHtmlFor,
  SPLASH_UPDATING_TEXT,
  STARTUP_TIMEOUT_MS,
  MIGRATION_TIMEOUT_MS,
} = require('./backend-process')
const { createFatalLineCollector, MM_PHASE_PREFIX, migrationTimeoutMessage } = require('./fatal-error')

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('the startup deadline is 60 s, and an update replaces it with its own', () => {
  const clock = fakeClock()
  const d = createStartupDeadline({ now: clock.now })
  clock.advance(STARTUP_TIMEOUT_MS - 1_000)
  assert.equal(d.expired(), false)
  d.onPhase('migrating')
  clock.advance(5 * 60_000) // far past the 60 s, well inside the update's own deadline
  assert.equal(d.expired(), false)
  assert.equal(d.phase(), 'migrating')
  clock.advance(MIGRATION_TIMEOUT_MS)
  assert.equal(d.expired(), true, 'a hung update must still end')
  assert.equal(d.phase(), 'migrating')
})

test('after the update commits, the rest of startup is back under 60 s', () => {
  const clock = fakeClock()
  const d = createStartupDeadline({ now: clock.now })
  d.onPhase('migrating')
  clock.advance(10 * 60_000)
  d.onPhase('migrated')
  assert.equal(d.phase(), 'starting')
  clock.advance(STARTUP_TIMEOUT_MS - 1)
  assert.equal(d.expired(), false)
  clock.advance(2)
  assert.equal(d.expired(), true)
})

test('a repeated or out-of-order phase line moves no deadline', () => {
  const clock = fakeClock()
  const early = createStartupDeadline({ now: clock.now })
  clock.advance(STARTUP_TIMEOUT_MS - 1_000)
  early.onPhase('migrated') // never migrating: nothing to end, and no fresh 60 s
  clock.advance(2_000)
  assert.equal(early.expired(), true)
  assert.equal(early.phase(), 'starting')
  const d = createStartupDeadline({ now: clock.now })
  d.onPhase('migrating')
  clock.advance(MIGRATION_TIMEOUT_MS - 1_000)
  d.onPhase('migrating') // a repeat must not restart the ceiling
  clock.advance(2_000)
  assert.equal(d.expired(), true)
})

test('the deadline counts on a monotonic clock, so a wall-clock jump cannot end an update (D1)', () => {
  // A laptop asleep during the update, or a clock change, moves the WALL clock. With
  // `Date.now` as the default this deadline expired on the jump and hard-stopped a healthy
  // update on wake. The stand-in is installed BEFORE the deadline exists: a default of
  // `Date.now` captures the function at creation, so stubbing it afterwards could never
  // fail this test (the first draft did exactly that, and its mutant survived).
  const realNow = Date.now
  let jump = 0
  Date.now = () => realNow() + jump
  try {
    const d = createStartupDeadline()
    d.onPhase('migrating')
    jump = MIGRATION_TIMEOUT_MS + 60_000
    assert.equal(d.expired(), false, 'a wall-clock jump expired the deadline')
  } finally {
    Date.now = realNow
  }
})

test('waitForHealth says WHICH deadline expired', async () => {
  const p = await freePort() // nothing listening
  const clock = fakeClock()
  const d = createStartupDeadline({ now: clock.now, startupMs: 50, migrationMs: 100 })
  d.onPhase('migrating')
  clock.advance(200)
  await assert.rejects(
    () => waitForHealth(p, { intervalMs: 10, deadline: d }),
    (err) => err.phase === 'migrating' && /within 100ms/.test(err.message),
  )
  const plain = createStartupDeadline({ now: clock.now, startupMs: 50 })
  clock.advance(100)
  await assert.rejects(
    () => waitForHealth(p, { intervalMs: 10, deadline: plain }),
    (err) => err.phase === 'starting',
  )
})

test('the phase line is read across chunk boundaries, from the same stream as MM-FATAL', () => {
  const seen = []
  const c = createFatalLineCollector({ onPhase: (p) => seen.push(p) })
  c.push(Buffer.from('INFO  [alembic] Context impl SQLiteImpl.\n\nMM-PHA'))
  assert.deepEqual(seen, [], 'a split marker waits for its newline')
  c.push(Buffer.from('SE: migrating\nINFO  [alembic] Running upgrade\n'))
  c.push(Buffer.from(`${MM_PHASE_PREFIX}migrated\n${MM_PHASE_PREFIX}something-else\n`))
  assert.deepEqual(seen, ['migrating', 'migrated'], 'an unknown phase is ignored')
  assert.deepEqual(c.lines(), [], 'a phase is never a fatal line')
})

test('during an update the stop is HARD on every platform', () => {
  const calls = []
  const child = { exitCode: null, killed: false, pid: 7, kill: (sig) => calls.push(sig) }
  let escalated = false
  stopBackend(child, { platform: 'darwin', hard: true, setTimeoutFn: () => { escalated = true } })
  assert.deepEqual(calls, ['SIGKILL'])
  assert.equal(escalated, false)
  const spawned = []
  stopBackend({ ...child, kill: () => { throw new Error('no signals on win32') } },
    { platform: 'win32', hard: true, spawnSync: (cmd, args) => { spawned.push([cmd, ...args]); return {} } })
  assert.deepEqual(spawned, [['taskkill', '/pid', '7', '/T', '/F']])
})

test('outside an update the POSIX stop is still SIGTERM first (the shutdown backup)', () => {
  const calls = []
  const child = { exitCode: null, killed: false, pid: 7, kill: (sig) => calls.push(sig) }
  stopBackend(child, { platform: 'linux', setTimeoutFn: () => {} })
  assert.deepEqual(calls, ['SIGTERM'])
})

test('the splash says the data is being updated, on the real splash page', () => {
  const html = fs.readFileSync(path.join(__dirname, 'splash.html'), 'utf8')
  const updating = splashHtmlFor(html, 'migrating')
  assert.notEqual(updating, html, 'the replacement must find the line it replaces')
  assert.ok(updating.includes(SPLASH_UPDATING_TEXT))
  assert.ok(!updating.includes('Starting the local engine'))
  assert.equal(splashHtmlFor(html, 'starting'), html)
})

test('the splash line is D21, word for word, centred inside a gutter (#1362)', () => {
  // The copy was decided (D21), so it is pinned here and not only by its own constant.
  assert.equal(
    SPLASH_UPDATING_TEXT,
    'Updating your data for this version. A large project can take several minutes. '
      + 'Keep Mixed Measures open until it finishes.',
  )
  // At the splash's 420 px it is two lines; unconstrained it ran edge to edge, flush left
  // under a centred title (rendered 2026-10-24 in Chromium at 420x240).
  const html = fs.readFileSync(path.join(__dirname, 'splash.html'), 'utf8')
  const rule = (html.match(/\.sub\s*\{([^}]*)\}/) || [])[1] || ''
  assert.match(rule, /text-align:\s*center/)
  assert.match(rule, /max-width:\s*\d+px/)
})

test('the timeout guidance names the minutes and says the update was undone', () => {
  const text = migrationTimeoutMessage(MIGRATION_TIMEOUT_MS / 60_000)
  assert.ok(text.includes('within 30 minutes'))
  assert.ok(/undone/.test(text) && /can still open it/.test(text))
  assert.ok(!text.includes('\n'))
})

test('main.js waits on the phase deadline and stops an update hard on quit (wiring scan)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  assert.match(src, /waitForHealth\(port, \{[^}]*deadline: startupDeadline/)
  assert.match(src, /createFatalLineCollector\(\{[\s\S]*?onPhase/)
  assert.match(src, /hard: Boolean\(startupDeadline && startupDeadline\.phase\(\) === 'migrating'\)/)
  assert.match(src, /err\.phase === 'migrating'[\s\S]*?hard: true[\s\S]*?migrationTimeoutMessage/)
  // Without these two, every line above still matches while the shell half does nothing:
  // a deadline never created leaves `deadline: startupDeadline` null (the old 60 s, and
  // a quit never hard), and a phase that skips the splash leaves "Starting the local
  // engine…" up for the whole update (both were surviving mutants, 2026-10-24).
  assert.match(src, /startupDeadline = createStartupDeadline\(\)\s*backend = startBackend\(/)
  assert.match(src, /onPhase: \(phase\) => \{\s*if \(startupDeadline\) startupDeadline\.onPhase\(phase\)\s*showSplashPhase\(phase\)/)
})
