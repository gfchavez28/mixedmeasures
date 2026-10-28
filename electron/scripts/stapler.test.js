// Tests for stapler.js (#1293): the retry around every `xcrun stapler` call the mac release leg
// makes. Apple's ticket service cannot be made to drop a call, so these drive the retry with
// injected attempts and, end to end, with a stand-in `xcrun` first on PATH — the same way the
// script's --self-test does on the release runner.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test, after } = require('node:test')

const stapler = require('./stapler.js')
const { ATTEMPTS, PAUSE_MS, withRetry, runStapler, pauseFromEnv, main } = stapler

const SCRIPT = path.join(__dirname, 'stapler.js')

/** Attempts that fail `fails` times (exit 68, as the v1.5.7 dmg staple did) and then pass. */
function scripted(fails, { code = 68 } = {}) {
  let calls = 0
  const attempt = () => {
    calls++
    return calls <= fails ? { code, output: `drop ${calls}: The network connection was lost.` } : { code: 0, output: 'worked' }
  }
  return { attempt, calls: () => calls }
}

function collect() {
  const lines = []
  const sleeps = []
  return { lines, sleeps, log: (m) => lines.push(m), sleep: (ms) => sleeps.push(ms) }
}

test('the decided bound: three attempts, twenty seconds apart', () => {
  assert.equal(ATTEMPTS, 3)
  assert.equal(PAUSE_MS, 20_000)
})

test('a first-time pass makes one call and prints nothing', () => {
  const s = scripted(0)
  const c = collect()
  assert.equal(withRetry('stapler validate X', s.attempt, c), 0)
  assert.equal(s.calls(), 1)
  assert.deepEqual(c.lines, [])
  assert.deepEqual(c.sleeps, [])
})

test('a call that drops once is retried after the pause, passes, and says so', () => {
  const s = scripted(1)
  const c = collect()
  assert.equal(withRetry('stapler validate X', s.attempt, c), 0)
  assert.equal(s.calls(), 2)
  assert.deepEqual(c.sleeps, [PAUSE_MS])
  const text = c.lines.join('\n')
  assert.match(text, /stapler validate X: attempt 1 of 3 failed \(exit 68\)/)
  assert.match(text, /drop 1: The network connection was lost\./, "the failed attempt's own output is printed")
  assert.match(text, /retrying in 20 s/)
  assert.match(text, /passed on attempt 2 of 3/)
})

test('a call that keeps failing stops after the bound, fails with its exit code, and prints every attempt', () => {
  const s = scripted(99)
  const c = collect()
  assert.equal(withRetry('stapler staple D', s.attempt, c), 68)
  assert.equal(s.calls(), ATTEMPTS)
  assert.deepEqual(c.sleeps, [PAUSE_MS, PAUSE_MS], 'no pause after the last attempt')
  const text = c.lines.join('\n')
  for (let i = 1; i <= ATTEMPTS; i++) assert.match(text, new RegExp(`drop ${i}: `))
  assert.match(text, /stapler staple D: failed 3 of 3 attempts/)
  assert.doesNotMatch(text, /passed on attempt/)
})

test('a failure is never reported as success, even with no exit code', () => {
  const c = collect()
  assert.equal(withRetry('x', () => ({ code: null, output: '' }), { ...c, attempts: 1 }), 1)
  assert.match(c.lines.join('\n'), /\(no output\)/)
})

// --- end to end, through a stand-in xcrun ---------------------------------------------------

const made = []
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

function fakeXcrun({ sleepS = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stapler-test-'))
  made.push(dir)
  fs.writeFileSync(path.join(dir, 'xcrun'), [
    '#!/bin/sh',
    'echo "$*" >> "$FAKE_LOG"',
    // `exec`, so the timeout's kill reaches the sleeping process itself and no grandchild holds stdout open
    sleepS ? `exec sleep ${sleepS}` : ':',
    'n=$(wc -l < "$FAKE_LOG"); if [ "$n" -le "$FAKE_FAILS" ]; then echo "The staple and validate action failed! Error 68." >&2; exit 68; fi',
    'echo "The validate action worked!"',
    '',
  ].join('\n'), { mode: 0o755 })
  return dir
}

function cli(args, { dir, fails }) {
  const log = path.join(dir, 'calls.log')
  fs.rmSync(log, { force: true })
  fs.writeFileSync(log, '')
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, MM_STAPLER_PAUSE_MS: '0', FAKE_LOG: log, FAKE_FAILS: String(fails) },
  })
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls }
}

test('the CLI passes stapler its verb and file, and is silent on a first-time pass', () => {
  const dir = fakeXcrun()
  const r = cli(['validate', '/x/Mixed Measures.app'], { dir, fails: 0 })
  assert.equal(r.code, 0)
  assert.deepEqual(r.calls, ['stapler validate /x/Mixed Measures.app'])
  assert.equal(r.out, '')
})

test('the CLI retries a dropped call and exits 0; a call that always fails exits non-zero after three', () => {
  const dir = fakeXcrun()
  const flaky = cli(['staple', 'MM.dmg'], { dir, fails: 1 })
  assert.equal(flaky.code, 0)
  assert.equal(flaky.calls.length, 2)
  assert.match(flaky.out, /attempt 1 of 3 failed \(exit 68\)[\s\S]*Error 68\.[\s\S]*passed on attempt 2 of 3/)
  const t0 = Date.now()
  const broken = cli(['validate', 'MM.dmg'], { dir, fails: 99 })
  assert.equal(broken.code, 68)
  assert.equal(broken.calls.length, 3)
  assert.match(broken.out, /failed 3 of 3 attempts/)
  // Two 20 s pauses would take 40 s; the self-test on the release runner relies on the override.
  assert.ok(Date.now() - t0 < 15_000, 'MM_STAPLER_PAUSE_MS=0 was not honoured')
})

test('a call that never answers is cut off and counts as a failed attempt', () => {
  const dir = fakeXcrun({ sleepS: 5 })
  fs.writeFileSync(path.join(dir, 'calls.log'), '')
  const t0 = Date.now()
  const r = runStapler('validate', 'MM.dmg', {
    timeoutMs: 300,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(dir, 'calls.log'), FAKE_FAILS: '0' },
  })
  assert.notEqual(r.code, 0)
  assert.match(r.output, /no answer within 0\.3 s/)
  assert.ok(Date.now() - t0 < 4000, 'the attempt was not cut off')
})

test('usage errors exit 2 and never call stapler', () => {
  const lines = []
  for (const argv of [[], ['notarize', 'x'], ['validate'], ['validate', 'a', 'b']]) {
    assert.equal(main(argv, { env: {}, log: (m) => lines.push(m) }), 2, JSON.stringify(argv))
  }
  assert.match(lines[0], /usage/)
})

test('the pause override accepts only a whole number of milliseconds', () => {
  assert.equal(pauseFromEnv({}), PAUSE_MS)
  assert.equal(pauseFromEnv({ MM_STAPLER_PAUSE_MS: '0' }), 0)
  assert.throws(() => pauseFromEnv({ MM_STAPLER_PAUSE_MS: '2s' }), /whole number/)
})

test('the self-test FAILS a helper that calls stapler once and does not retry', () => {
  // The self-test is what the release run's log rests on, so it must not pass a broken helper.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stapler-test-'))
  made.push(dir)
  const once = path.join(dir, 'once.js')
  fs.writeFileSync(once, "const r = require('child_process').spawnSync('xcrun', ['stapler', ...process.argv.slice(2)], { stdio: 'inherit' }); process.exitCode = r.status\n")
  const lines = []
  assert.equal(stapler.selfTest({ script: once, log: (m) => lines.push(m) }), 1)
  const text = lines.join('\n')
  assert.match(text, /a call that drops once: exit 68, wanted 0/)
  assert.match(text, /a call that always fails: xcrun called 1 times, wanted 3/)
})

test('--self-test passes, and its log carries the retry line the release run shows', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /passed on attempt 2 of 3/)
  assert.match(r.stdout, /failed 3 of 3 attempts/)
  assert.match(r.stdout, /stapler self-test: PASS/)
})
