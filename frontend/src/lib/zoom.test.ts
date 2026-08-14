import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ZOOM_STEPS,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  formatZoom,
  snapZoom,
  zoomIn,
  zoomOut,
  zoomIntentFromKey,
} from './zoom'

/**
 * #697 — the packaged app had no way to enlarge text at all. `applyAppMenu()` omits
 * `viewMenu`, which unbinds Electron's zoom accelerators, and there was no
 * `setZoomFactor` fallback anywhere. WCAG 2.2 SC 1.4.4 (AA).
 */

describe('the zoom ladder', () => {
  it('reaches 200%, which is the success criterion this feature exists for', () => {
    // Pin the REQUIREMENT. If someone trims the ladder for aesthetics, the feature
    // silently stops satisfying SC 1.4.4 and nothing else would notice.
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(2.0)
  })

  it('includes 100% as the default and Reset target', () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM)
  })

  it('is sorted ascending with no duplicates', () => {
    // zoomIn/zoomOut walk this by index, so order is behaviour, not tidiness.
    const sorted = [...ZOOM_STEPS].sort((a, b) => a - b)
    expect([...ZOOM_STEPS]).toEqual(sorted)
    expect(new Set(ZOOM_STEPS).size).toBe(ZOOM_STEPS.length)
  })
})

describe('snapZoom', () => {
  it('returns an exact step unchanged', () => {
    for (const step of ZOOM_STEPS) expect(snapZoom(step)).toBe(step)
  })

  it('snaps an arbitrary value to the nearest step', () => {
    expect(snapZoom(1.02)).toBe(1.0)
    expect(snapZoom(1.2)).toBe(1.25)
    expect(snapZoom(10)).toBe(MAX_ZOOM)
    expect(snapZoom(0.1)).toBe(MIN_ZOOM)
  })

  it('resolves junk to the default rather than snapping', () => {
    // The load-bearing case: Math.abs(NaN - x) is NaN, so a naive nearest-search
    // never updates `best` and silently returns whichever step happened to be first.
    for (const junk of [NaN, Infinity, -Infinity, undefined, null, '1.5', {}]) {
      expect(snapZoom(junk)).toBe(DEFAULT_ZOOM)
    }
  })
})

describe('stepping', () => {
  it('moves one step at a time', () => {
    expect(zoomIn(1.0)).toBe(1.1)
    expect(zoomOut(1.0)).toBe(0.9)
  })

  it('saturates at the bounds instead of wrapping', () => {
    // Wrapping would send a user who holds Ctrl+= from 200% straight to 80%.
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM)
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM)
  })

  it('steps sanely from an off-ladder value', () => {
    expect(zoomIn(1.19)).toBe(1.5)   // snaps to 1.25, then up
    expect(zoomOut(1.19)).toBe(1.1)  // snaps to 1.25, then down
  })
})

describe('formatZoom', () => {
  it('renders whole percentages', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(1.25)).toBe('125%')
    expect(formatZoom(0.8)).toBe('80%')
  })
})

describe('zoomIntentFromKey', () => {
  const ev = (over: Partial<Parameters<typeof zoomIntentFromKey>[0]>) => ({
    key: 'x', ctrlKey: false, metaKey: false, altKey: false, ...over,
  })

  it('recognises the three commands under Ctrl and under Cmd', () => {
    expect(zoomIntentFromKey(ev({ key: '=', ctrlKey: true }))).toBe('in')
    expect(zoomIntentFromKey(ev({ key: '-', metaKey: true }))).toBe('out')
    expect(zoomIntentFromKey(ev({ key: '0', ctrlKey: true }))).toBe('reset')
  })

  it('accepts the layout variants of the same physical keys', () => {
    // `+`/`_` arrive when Shift is held; `Add`/`Subtract` from the numpad. Matching
    // only `=`/`-` would leave the shortcut dead for anyone using either.
    expect(zoomIntentFromKey(ev({ key: '+', ctrlKey: true }))).toBe('in')
    expect(zoomIntentFromKey(ev({ key: 'Add', ctrlKey: true }))).toBe('in')
    expect(zoomIntentFromKey(ev({ key: '_', ctrlKey: true }))).toBe('out')
    expect(zoomIntentFromKey(ev({ key: 'Subtract', ctrlKey: true }))).toBe('out')
  })

  it('ignores the same keys without a modifier', () => {
    // Load-bearing: a bare `0` is a code shortcut in the coding workbenches. If this
    // claimed it, pressing 0 to apply a code would resize the app instead.
    expect(zoomIntentFromKey(ev({ key: '0' }))).toBeNull()
    expect(zoomIntentFromKey(ev({ key: '=' }))).toBeNull()
  })

  it('ignores Alt-modified combinations', () => {
    expect(zoomIntentFromKey(ev({ key: '0', ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('ignores unrelated keys', () => {
    for (const key of ['a', 'z', '1', 'Escape', 'ArrowUp']) {
      expect(zoomIntentFromKey(ev({ key, ctrlKey: true }))).toBeNull()
    }
  })
})

describe('agreement with electron/zoom.js', () => {
  /**
   * Two packages, hand-maintained mirrors — the Seam B shape, where each toolchain
   * validates its own side and both stay green while disagreeing. Same remedy as
   * `media-constants.test.ts` ↔ `TestMediaConstantsMirror`: read the other side's
   * source and assert the numbers match, so the renderer can never offer a step main
   * would silently clamp away.
   */
  const electronSrc = readFileSync(
    join(__dirname, '..', '..', '..', 'electron', 'zoom.js'),
    'utf8',
  )

  const constant = (name: string): number => {
    const m = electronSrc.match(new RegExp(`const ${name} = ([\\d.]+)`))
    if (!m) throw new Error(`${name} not found in electron/zoom.js`)
    return Number(m[1])
  }

  it('the bounds match on both sides', () => {
    expect(constant('MIN_ZOOM_FACTOR')).toBe(MIN_ZOOM)
    expect(constant('MAX_ZOOM_FACTOR')).toBe(MAX_ZOOM)
  })

  it('the defaults match on both sides', () => {
    expect(constant('DEFAULT_ZOOM_FACTOR')).toBe(DEFAULT_ZOOM)
  })

  it('every offered step survives the main-process clamp', () => {
    // The property that actually matters: a user picking a step from the UI must get
    // that step, not a clamped neighbour.
    const min = constant('MIN_ZOOM_FACTOR')
    const max = constant('MAX_ZOOM_FACTOR')
    for (const step of ZOOM_STEPS) {
      expect(step, `step ${step} would be clamped by main`).toBeGreaterThanOrEqual(min)
      expect(step, `step ${step} would be clamped by main`).toBeLessThanOrEqual(max)
    }
  })
})
