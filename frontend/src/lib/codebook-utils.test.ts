import { describe, it, expect } from 'vitest'
import { fitViewportToBounds, legibleDefaultViewport } from './codebook-utils'

describe('fitViewportToBounds', () => {
  it('wraps the bounds with padding and centers', () => {
    const vp = fitViewportToBounds({ minX: 0, maxX: 100, minY: 0, maxY: 200 }, 10)
    expect(vp).toEqual({ x: -10, y: -10, width: 120, height: 220 })
  })
})

describe('legibleDefaultViewport (#428b)', () => {
  // A tall/narrow tree (e.g. 31 codes in stacked categories) in a wide/short canvas.
  const tallFit = { x: 0, y: -18, width: 1038, height: 2527 }
  const wideCanvas = { width: 1114, height: 528 }

  it('fits a tall codebook to width (height clamped to the canvas aspect)', () => {
    const vp = legibleDefaultViewport(tallFit, wideCanvas, 0)
    // Same width and left edge as fit-everything…
    expect(vp.x).toBe(tallFit.x)
    expect(vp.width).toBe(tallFit.width)
    // …but height clamped so width fills the canvas under `meet`.
    expect(vp.height).toBeCloseTo(tallFit.width * (wideCanvas.height / wideCanvas.width), 5)
    expect(vp.height).toBeLessThan(tallFit.height)
    // Displayed scale is now width-driven and legible (~1.07), not ~0.21.
    const scale = Math.min(wideCanvas.width / vp.width, wideCanvas.height / vp.height)
    expect(scale).toBeGreaterThan(1)
  })

  it('nudges the top down by topChromePx (in SVG units) to clear the toolbar', () => {
    const withChrome = legibleDefaultViewport(tallFit, wideCanvas, 56)
    const widthScale = wideCanvas.width / tallFit.width
    expect(withChrome.y).toBeCloseTo(tallFit.y - 56 / widthScale, 5)
    expect(withChrome.y).toBeLessThan(tallFit.y) // shifted up so content starts lower
  })

  it('returns fit-everything unchanged for wide/short content (nothing to gain)', () => {
    const wideFit = { x: 0, y: 0, width: 2000, height: 300 }
    expect(legibleDefaultViewport(wideFit, wideCanvas, 56)).toEqual(wideFit)
  })

  it('returns fit-everything unchanged when content is wider than the canvas aspect', () => {
    // canvas aspect ~2.11; content aspect 2.8 is wider → width already fills.
    const widerThanCanvas = { x: 0, y: 0, width: 1400, height: 500 }
    expect(legibleDefaultViewport(widerThanCanvas, wideCanvas, 56)).toEqual(widerThanCanvas)
  })

  it('falls back to fit-everything when the container is unmeasured', () => {
    expect(legibleDefaultViewport(tallFit, null)).toBe(tallFit)
    expect(legibleDefaultViewport(tallFit, { width: 0, height: 0 })).toBe(tallFit)
  })
})
