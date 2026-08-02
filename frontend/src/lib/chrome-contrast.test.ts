/**
 * #645 — the TopRail's text tokens must clear WCAG AA on every background the
 * rail actually composites them over, in BOTH themes.
 *
 * This is a fail-closed guard on a token pair, not a component test. #645 was
 * "newly visible, not newly broken": the rail long predates the v1.3.0 delta and
 * shipped below AA in dark mode because nothing was watching — the 2026-07-10 UX
 * pass drove both themes but ran Lighthouse only in light. A token edit is a
 * one-character change with app-wide reach and no natural test, which is exactly
 * the shape that rots silently.
 *
 * It reads index.css rather than a duplicated table of values on purpose: a
 * mirror of the tokens here would pass while the shipped CSS regressed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf-8')

/** The rail paints `bg-[hsl(var(--mm-chrome))]`; its controls sit on white
 *  overlays of it. These three alphas are what TopRail.tsx actually uses:
 *  0 = bare rail (breadcrumbs, icon buttons), 0.06 = the action chips
 *  (Search / Participants / Memos / Jot / Export), 0.10 = the nav count badge
 *  and the chips' hover state. */
const RAIL_OVERLAYS: Array<[label: string, alpha: number]> = [
  ['bare rail', 0],
  ['action chip (bg-white/[0.06])', 0.06],
  ['count badge (bg-white/10)', 0.1],
]

type Rgb = [number, number, number]

function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = s / 100
  const L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map(i => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Pull `--name: H S% L%;` out of the `:root` (light) or `.dark` block. */
function token(theme: 'light' | 'dark', name: string): Rgb {
  // `.dark` is declared after `:root`, so slicing at it separates the two.
  const darkAt = CSS.indexOf('.dark {')
  expect(darkAt, 'index.css must declare a .dark block').toBeGreaterThan(-1)
  const block = theme === 'light' ? CSS.slice(0, darkAt) : CSS.slice(darkAt)
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`))
  expect(m, `--${name} not found in the ${theme} block`).not.toBeNull()
  const [, h, s, l] = m!
  return hslToRgb(Number(h), Number(s), Number(l))
}

describe('TopRail chrome contrast (#645)', () => {
  // The rail is dark chrome in BOTH themes, so both need checking — light is
  // not automatically the safe one.
  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      for (const [label, alpha] of RAIL_OVERLAYS) {
        it(`muted text clears AA on the ${label}`, () => {
          const bg = alpha === 0
            ? token(theme, 'mm-chrome')
            : over([255, 255, 255], token(theme, 'mm-chrome'), alpha)
          const ratio = contrast(token(theme, 'mm-chrome-text-muted'), bg)
          expect(ratio, `--mm-chrome-text-muted on ${label} = ${ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(4.5)
        })

        it(`primary text clears AA on the ${label}`, () => {
          const bg = alpha === 0
            ? token(theme, 'mm-chrome')
            : over([255, 255, 255], token(theme, 'mm-chrome'), alpha)
          const ratio = contrast(token(theme, 'mm-chrome-text'), bg)
          expect(ratio, `--mm-chrome-text on ${label} = ${ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(4.5)
        })
      }
    })
  }

  it('keeps muted visibly distinct from primary (a fix that just merges them is not a fix)', () => {
    for (const theme of ['light', 'dark'] as const) {
      const muted = relativeLuminance(token(theme, 'mm-chrome-text-muted'))
      const primary = relativeLuminance(token(theme, 'mm-chrome-text'))
      expect(Math.abs(primary - muted), `${theme}: muted and primary are too close`)
        .toBeGreaterThan(0.1)
    }
  })
})
