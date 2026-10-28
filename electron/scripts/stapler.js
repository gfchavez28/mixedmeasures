// Every `xcrun stapler` call the release's mac leg makes, retried when Apple's ticket service
// drops it (#1293).
//
// WHY: `stapler staple` and `stapler validate` both ask Apple's ticket service
// (api.apple-cloudkit.com, com.apple.gk.ticket-delivery) about the file. On 2026-10-17 the
// v1.5.7 tag failed three of its four mac attempts, each on a DIFFERENT one of these calls:
// `validate` failed 37 s after the same command had passed on a byte-identical copy, and the
// dmg's `staple` died with "The network connection was lost" (Error 68). Every artifact was
// fine each time; the cut could not finish while the connection was bad.
//
//   node stapler.js staple <file>     staple the ticket, then (stapler's own) validate
//   node stapler.js validate <file>   the stapled ticket is present and Apple still vouches for it
//   node stapler.js --self-test       the retry, driven through a stand-in xcrun (release.yml runs it)
//
// What it does: up to ATTEMPTS tries, PAUSE_MS apart, each bounded by ATTEMPT_TIMEOUT_MS. ANY
// failure is retried, not only the error wordings seen so far: Apple documents none of them, and
// a list that misses one fails the leg exactly as before. A retry cannot pass a bad file, because
// the file does not change between tries — `validate` writes nothing, and `staple` writes the
// ticket only once it has one — so the only answer that can change is the service's. A real
// defect therefore still fails, ATTEMPTS times over, with every attempt's output printed.
//
// Output: NOTHING when the first try passes (the workflow prints its own line). Every failed
// attempt prints stapler's output and the retry; a pass after a retry says so. That is the
// evidence a flake leaves in the log (RELEASING *Known gotchas*).
//
// ⚠️ electron-builder's own staple of the .app (`--config.mac.notarize=true`) is a fifth call
// that this cannot reach: it happens inside @electron/notarize 2.5.0, whose `retries: 3` never
// fires (its promise-retry callback ignores the retry function), so one drop there fails the
// "Package & publish" step. Recovery for that one stays `gh run rerun <id> --failed`.
//
// Dependency-free (node stdlib), like the other release scripts here. Not packaged.

'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** The decided bound (#1293): three tries, twenty seconds apart. */
const ATTEMPTS = 3
const PAUSE_MS = 20_000
/** A call that never answers counts as a failed attempt rather than hanging the step. */
const ATTEMPT_TIMEOUT_MS = 120_000
const VERBS = Object.freeze(['staple', 'validate'])

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function indent(text) {
  return String(text).split('\n').map((l) => `    ${l}`).join('\n')
}

/** One `xcrun stapler <verb> <file>` -> { code, output }. A spawn error or a timeout is a failure, never a pass. */
function runStapler(verb, file, { timeoutMs = ATTEMPT_TIMEOUT_MS, env = process.env } = {}) {
  const r = spawnSync('xcrun', ['stapler', verb, file], { encoding: 'utf8', timeout: timeoutMs, env })
  const output = [r.stdout, r.stderr].filter(Boolean).join('').trimEnd()
  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? `no answer within ${timeoutMs / 1000} s` : r.error.message
    return { code: 1, output: output ? `${output}\n${why}` : why }
  }
  return { code: r.status === null ? 1 : r.status, output }
}

/**
 * Run `attempt` until it returns code 0, at most `attempts` times, `pauseMs` apart.
 * Returns 0, or the last failure's exit code (never 0 for a failure).
 */
function withRetry(label, attempt, { attempts = ATTEMPTS, pauseMs = PAUSE_MS, sleep = sleepMs, log = console.log } = {}) {
  let last = 1
  for (let i = 1; i <= attempts; i++) {
    const r = attempt()
    if (r.code === 0) {
      if (i > 1) log(`${label}: passed on attempt ${i} of ${attempts}`)
      return 0
    }
    last = r.code || 1
    log(`${label}: attempt ${i} of ${attempts} failed (exit ${r.code}):`)
    log(indent(r.output || '(no output)'))
    if (i < attempts) {
      log(`${label}: retrying in ${pauseMs / 1000} s`)
      sleep(pauseMs)
    }
  }
  log(`${label}: failed ${attempts} of ${attempts} attempts`)
  return last
}

/** The pause, from MM_STAPLER_PAUSE_MS when set (the self-test and the tests only). */
function pauseFromEnv(env) {
  const raw = env.MM_STAPLER_PAUSE_MS
  if (raw === undefined) return PAUSE_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`MM_STAPLER_PAUSE_MS must be a whole number of milliseconds, not ${JSON.stringify(raw)}`)
  return n
}

/**
 * Drive this script's own CLI through a stand-in `xcrun` first on PATH: one call that drops once
 * and then passes, and one that always fails. Proves, on the machine that runs the release, that
 * a drop is retried and a real failure still fails — Apple cannot be made to drop a call on demand.
 * `script` is the CLI under test (this file); the tests point it at a helper that does not retry.
 */
function selfTest({ log = console.log, script = __filename } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stapler-selftest-'))
  const fake = path.join(dir, 'xcrun')
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$FAKE_COUNT"',
    'if [ "$n" -le "$FAKE_FAILS" ]; then',
    '  echo "Processing: $3"',
    '  echo \'CloudKit query failed due to "The network connection was lost." (stand-in)\'',
    '  echo "The staple and validate action failed! Error 68." >&2',
    '  exit 68',
    'fi',
    'echo "Processing: $3"; echo "The validate action worked! (stand-in)"',
    '',
  ].join('\n'), { mode: 0o755 })
  const cases = [
    { name: 'a call that drops once', fails: 1, wantCode: 0, wantCalls: 2, wantText: `passed on attempt 2 of ${ATTEMPTS}` },
    { name: 'a call that always fails', fails: 99, wantCode: 68, wantCalls: ATTEMPTS, wantText: `failed ${ATTEMPTS} of ${ATTEMPTS} attempts` },
    { name: 'a call that passes first time', fails: 0, wantCode: 0, wantCalls: 1, wantText: '' },
  ]
  const problems = []
  for (const c of cases) {
    const count = path.join(dir, `count-${c.fails}`)
    const r = spawnSync(process.execPath, [script, 'validate', path.join(dir, 'Stand-in.app')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`, MM_STAPLER_PAUSE_MS: '0', FAKE_COUNT: count, FAKE_FAILS: String(c.fails) },
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd()
    const calls = Number(fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim() : 0)
    log(`stapler self-test: ${c.name}:`)
    if (out) log(indent(out))
    if (r.status !== c.wantCode) problems.push(`${c.name}: exit ${r.status}, wanted ${c.wantCode}`)
    if (calls !== c.wantCalls) problems.push(`${c.name}: xcrun called ${calls} times, wanted ${c.wantCalls}`)
    if (c.wantText ? !out.includes(c.wantText) : out !== '') problems.push(`${c.name}: output ${c.wantText ? `lacks "${c.wantText}"` : 'is not empty'}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  if (problems.length) {
    for (const p of problems) log(`stapler self-test: FAIL — ${p}`)
    return 1
  }
  log(`stapler self-test: PASS — a dropped call is retried and passes; a failing one fails after ${ATTEMPTS} attempts; a first-time pass prints nothing`)
  return 0
}

function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  if (argv.length === 1 && argv[0] === '--self-test') return selfTest({ log })
  const [verb, file] = argv
  if (argv.length !== 2 || !VERBS.includes(verb)) {
    log(`usage: node stapler.js <${VERBS.join('|')}> <file>  |  node stapler.js --self-test`)
    return 2
  }
  const pauseMs = pauseFromEnv(env)
  return withRetry(`stapler ${verb} ${file}`, () => runStapler(verb, file, { env }), { pauseMs, log })
}

if (require.main === module) process.exitCode = main()

module.exports = { ATTEMPTS, PAUSE_MS, ATTEMPT_TIMEOUT_MS, VERBS, runStapler, withRetry, pauseFromEnv, selfTest, main }
