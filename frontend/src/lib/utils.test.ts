import { describe, it, expect } from 'vitest'
import { formatTimecode, getContrastColor, getHslTextColor, parseTimecode } from './utils'

describe('getContrastColor', () => {
  it('returns dark text for white background', () => {
    expect(getContrastColor('#ffffff')).toBe('#000000')
  })

  it('returns white text for black background', () => {
    expect(getContrastColor('#000000')).toBe('#ffffff')
  })

  it('returns dark text for light gray', () => {
    expect(getContrastColor('#cccccc')).toBe('#000000')
  })

  it('returns white text for dark blue', () => {
    expect(getContrastColor('#1a237e')).toBe('#ffffff')
  })

  it('handles short hex strings gracefully', () => {
    expect(getContrastColor('#fff')).toBe('#ffffff')
  })
})

describe('getHslTextColor', () => {
  it('returns dark text for very light background (L=96)', () => {
    expect(getHslTextColor(142, 76, 96)).toBe('#000000')
  })

  it('returns white text for dark background (L=30)', () => {
    expect(getHslTextColor(142, 76, 30)).toBe('#ffffff')
  })

  it('returns dark text for pure white (0, 0, 100)', () => {
    expect(getHslTextColor(0, 0, 100)).toBe('#000000')
  })

  it('returns white text for pure black (0, 0, 0)', () => {
    expect(getHslTextColor(0, 0, 0)).toBe('#ffffff')
  })
})

describe('formatTimecode (slab 3c) — sub-second clip display', () => {
  it('renders tenths, multi-digit minutes, and the hour form', () => {
    expect(formatTimecode(0)).toBe('0:00.0')
    expect(formatTimecode(8.25)).toBe('0:08.3')          // rounds to tenths
    expect(formatTimecode(83.4)).toBe('1:23.4')
    expect(formatTimecode(754.05)).toBe('12:34.1')       // ≥10-minute case
    expect(formatTimecode(3723.9)).toBe('1:02:03.9')     // hour form
  })

  it('never renders float dust (integer-tenths arithmetic)', () => {
    // 0.1 + 0.2 style dust: 3.1 stored as 3.1000000000000005
    expect(formatTimecode(3.1000000000000005)).toBe('0:03.1')
  })

  it('is empty for null/undefined/non-finite', () => {
    expect(formatTimecode(null)).toBe('')
    expect(formatTimecode(undefined)).toBe('')
    expect(formatTimecode(Number.NaN)).toBe('')
    expect(formatTimecode(Infinity)).toBe('')
  })
})

describe('parseTimecode (slab 3c) — the clip time inputs', () => {
  it('accepts bare seconds, m:ss, h:mm:ss, and fractions', () => {
    expect(parseTimecode('225')).toBe(225)
    expect(parseTimecode('3:45')).toBe(225)
    expect(parseTimecode('3:45.2')).toBeCloseTo(225.2, 6)
    expect(parseTimecode('1:03:45.2')).toBeCloseTo(3825.2, 6)
    expect(parseTimecode('.5')).toBe(0.5)
    expect(parseTimecode('  12:34 ')).toBe(754)
  })

  it('round-trips what formatTimecode renders', () => {
    for (const t of [0, 8.3, 83.4, 754.1, 3723.9]) {
      expect(parseTimecode(formatTimecode(t))).toBeCloseTo(t, 6)
    }
  })

  it('rejects garbage rather than guessing', () => {
    for (const bad of ['', '  ', 'abc', '-3', '1:2:3:4', '3:', ':45', '1h30']) {
      expect(parseTimecode(bad)).toBeNull()
    }
  })
})

// ── The AA guarantee (2026-08-02) ──────────────────────────────────────────
//
// `getContrastColor` picks one of two text colours for an ARBITRARY,
// user-chosen background, so "is it readable?" is answerable by arithmetic
// rather than by eye — and it was NOT, for four months: returning `#1a1a1a`
// instead of black dropped the worst case to 3.80:1 and failed 3 of the 16
// palette swatches, all in the indigo/violet band. These are fail-closed: a
// new palette colour, or a re-softened text colour, fails the suite.
describe('getContrastColor holds the WCAG AA floor', () => {
  const AA = 4.5

  const luminance = (hex: string): number => {
    const h = hex.replace('#', '')
    const ch = (i: number) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
  }
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  it('clears AA on every colour in the app’s own code palette', () => {
    // Inlined rather than imported: this asserts the palette a researcher can
    // actually pick, so it must fail loudly if CATEGORY_COLORS drifts from it.
    const PALETTE = [
      '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308',
      '#ef4444', '#22c55e', '#6366f1', '#06b6d4', '#f43f5e', '#a855f7',
      '#f59e0b', '#0ea5e9', '#84cc16', '#78716c',
    ]
    const failures = PALETTE
      .map(c => ({ c, r: ratio(c, getContrastColor(c)) }))
      .filter(({ r }) => r < AA)
    expect(failures).toEqual([])
  })

  // The three that were actually broken, named so a regression is legible
  // rather than appearing as an anonymous count.
  it.each([
    ['#8b5cf6', 'violet'],
    ['#6366f1', 'indigo'],
    ['#a855f7', 'purple'],
  ])('%s (%s) — the band researchers reported as unreadable', (hex) => {
    expect(ratio(hex, getContrastColor(hex))).toBeGreaterThanOrEqual(AA)
  })

  // The palette is a sample; the picker accepts any hex. Sweep the cube so no
  // reachable background can fall through.
  it('clears AA across a dense sweep of the whole colour cube', () => {
    let worst = { hex: '', r: Infinity }
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
          const got = ratio(hex, getContrastColor(hex))
          if (got < worst.r) worst = { hex, r: got }
        }
      }
    }
    expect(worst.r).toBeGreaterThanOrEqual(AA)
  })
})
