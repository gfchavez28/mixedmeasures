const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  DEFAULT_ZOOM_FACTOR,
  clampZoomFactor,
} = require('./zoom')

// #697 — the renderer owns the zoom preference, so everything arriving here is
// untrusted input. These pin the coercion, not the plumbing.

test('the ceiling reaches 200%, which is what SC 1.4.4 requires', () => {
  // If this ever drops below 2.0 the feature stops satisfying the success
  // criterion it was built for, silently. Pin the requirement, not the number.
  assert.ok(MAX_ZOOM_FACTOR >= 2.0)
})

test('an in-range factor passes through untouched', () => {
  assert.equal(clampZoomFactor(1.0), 1.0)
  assert.equal(clampZoomFactor(1.25), 1.25)
  assert.equal(clampZoomFactor(MIN_ZOOM_FACTOR), MIN_ZOOM_FACTOR)
  assert.equal(clampZoomFactor(MAX_ZOOM_FACTOR), MAX_ZOOM_FACTOR)
})

test('out-of-range factors clamp to the bounds', () => {
  assert.equal(clampZoomFactor(0.01), MIN_ZOOM_FACTOR)
  assert.equal(clampZoomFactor(50), MAX_ZOOM_FACTOR)
  assert.equal(clampZoomFactor(-3), MIN_ZOOM_FACTOR)
})

test('NaN and Infinity fall back to the default rather than clamping', () => {
  // The load-bearing case: Math.max(0.8, NaN) is NaN, so a naive clamp would pass
  // NaN through to setZoomFactor and leave a window the user cannot click out of.
  assert.equal(clampZoomFactor(NaN), DEFAULT_ZOOM_FACTOR)
  assert.equal(clampZoomFactor(Infinity), DEFAULT_ZOOM_FACTOR)
  assert.equal(clampZoomFactor(-Infinity), DEFAULT_ZOOM_FACTOR)
})

test('non-numbers fall back to the default', () => {
  // The renderer sends this over IPC, so a string or object is one bad refactor away.
  for (const junk of [undefined, null, '1.5', {}, [], true, () => {}]) {
    assert.equal(clampZoomFactor(junk), DEFAULT_ZOOM_FACTOR, `for ${String(junk)}`)
  }
})

test('the default sits inside the allowed range', () => {
  assert.ok(DEFAULT_ZOOM_FACTOR >= MIN_ZOOM_FACTOR)
  assert.ok(DEFAULT_ZOOM_FACTOR <= MAX_ZOOM_FACTOR)
})
