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

import { contrast, over, readToken, relativeLuminance, type Rgb } from './contrast'

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

/** The arithmetic and the token reader live in `lib/contrast.ts` — this guard
 *  and the #699 token×surface matrix are two consumers, and two copies of a
 *  luminance formula propagate a defect verbatim (#733). */
function token(theme: 'light' | 'dark', name: string): Rgb {
  return readToken(CSS, theme, name)
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
