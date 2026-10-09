/**
 * #1115 — the rating number on a code chip must stay readable on any code colour.
 *
 * The chip's colour is the researcher's, so the check is arithmetic over every
 * colour they can pick, not a look at the default: the sixteen palette swatches,
 * the uncategorised grey, and a sweep of the colour cube (the picker accepts any
 * hex). The badge is a translucent fill over the chip; what is read is the
 * COMPOSITE, which no token guard sees (#728's lesson: a mock that copied these
 * values scored Lighthouse 100 because it was `aria-hidden`).
 */
import { describe, it, expect } from 'vitest'
import { AA_NORMAL, contrast, over, type Rgb } from './contrast'
import { getContrastColor } from './utils'
import { RATING_BADGE_ALPHA, ratingBadgeFill } from './magnitude'

const rgb = (hex: string): Rgb => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb
}
const parseFill = (css: string): { color: Rgb; alpha: number } => {
  const [r, g, b, a] = css.match(/rgba\(([^)]+)\)/)![1].split(',').map(Number)
  return { color: [r / 255, g / 255, b / 255], alpha: a }
}

/** The number's contrast against the badge, as painted on `chip`. */
function badgeRatio(chip: string, fill: (text: string) => string): number {
  const text = getContrastColor(chip)
  const { color, alpha } = parseFill(fill(text))
  return contrast(rgb(text), over(color, rgb(chip), alpha))
}

const PALETTE = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308',
  '#ef4444', '#22c55e', '#6366f1', '#06b6d4', '#f43f5e', '#a855f7',
  '#f59e0b', '#0ea5e9', '#84cc16', '#78716c',
]
/** `getCodeColor`'s fallback — the colour of every uncategorised, uncoloured code. */
const DEFAULT_GREY = '#6b7280'

const cube = (): string[] => {
  const out: string[] = []
  for (let r = 0; r < 256; r += 17)
    for (let g = 0; g < 256; g += 17)
      for (let b = 0; b < 256; b += 17)
        out.push(`#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`)
  return out
}

describe('#1115 — the rating badge never lowers the chip’s own contrast', () => {
  const colours = [...PALETTE, DEFAULT_GREY, ...cube()]

  it.each([['rated', false], ['unrated', true]] as const)('%s: AA on every colour', (_, unrated) => {
    const failures = colours
      .map(c => ({ c, r: badgeRatio(c, t => ratingBadgeFill(t, unrated)) }))
      .filter(({ r }) => r < AA_NORMAL)
    expect(failures).toEqual([])
  })

  it('is never LESS readable than the chip text beside it', () => {
    // The structural claim behind the arithmetic: a fill tinted away from the
    // text can only raise its contrast, so `getContrastColor`'s floor carries.
    for (const c of colours) {
      const plain = contrast(rgb(getContrastColor(c)), rgb(c))
      expect(badgeRatio(c, t => ratingBadgeFill(t, false))).toBeGreaterThanOrEqual(plain - 1e-9)
    }
  })

  it('DISCRIMINATION: the old fill (toward the text) fails on the default grey', () => {
    // The fixture must be able to see the defect: the shipped formula measured
    // 3.16:1 live on this chip, and this test would pass on it otherwise.
    const old = (text: string) =>
      `rgba(${text === '#000000' ? '0, 0, 0' : '255, 255, 255'}, 0.22)`
    expect(badgeRatio(DEFAULT_GREY, old)).toBeLessThan(AA_NORMAL)
    expect(badgeRatio(DEFAULT_GREY, t => ratingBadgeFill(t, false))).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('an unrated dash sits lighter than a rating', () => {
    expect(RATING_BADGE_ALPHA.unrated).toBeLessThan(RATING_BADGE_ALPHA.rated)
    expect(ratingBadgeFill('#ffffff', false)).toBe(`rgba(0, 0, 0, ${RATING_BADGE_ALPHA.rated})`)
    expect(ratingBadgeFill('#000000', true)).toBe(`rgba(255, 255, 255, ${RATING_BADGE_ALPHA.unrated})`)
  })
})
