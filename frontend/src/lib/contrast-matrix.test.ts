/**
 * #7 / #6 — every text token must clear WCAG AA on every background it ACTUALLY
 * lands on, in both themes; the focus ring must clear SC 1.4.11's 3:1.
 *
 * ## Why this exists alongside `chrome-contrast.test.ts`
 *
 * That file is a model of its kind — it parses the shipped stylesheet rather than a
 * copy of the values, checks both themes, and composites the real translucent
 * overlays. It covers **two tokens**. The app has 23. Previous contrast fixes
 * (#394, #434) each moved one token correctly *for the surface named in that
 * report*, which is per-incident rather than systematic — and three tokens were
 * still below AA when an external review measured the whole set.
 *
 * ## Why this is a curated pair list and NOT a cross-product
 *
 * A full text × surface cross-product is *wrong*, not merely noisy. `--mm-blue-text`
 * on solid `--mm-blue` would fail — and that pairing does not exist: measured, the
 * selection text always sits on a 12–30% **alpha tint** of blue over an ordinary
 * surface, or on the opaque `--mm-blue-cell`. Testing it against solid blue would
 * have produced a false failure and prompted a "fix" to a healthy token.
 *
 * So every pair below was verified against real usage before being written down. The
 * tempting shortcut — deriving pairs from the `--X-text` / `--X` naming convention —
 * is exactly the trap: the convention holds for the `--mm-ctx-*` family (which does
 * sit on its solid surface) and breaks for the blue family.
 *
 * ## What makes it fail-closed anyway
 *
 * `every text token is covered` asserts that each `*-text` / `*-foreground` token in
 * `index.css` appears either in PAIRS or in EXEMPT with a reason. A new token is
 * therefore a test failure until someone states where it lands.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf-8')

type Rgb = [number, number, number]
type Theme = 'light' | 'dark'

/** A background is either a solid token, or a tint of one token over another. */
type Bg = string | { tint: string; alpha: number; over: string }

interface Pair {
  text: string
  on: Bg[]
  /** 4.5 = normal text (SC 1.4.3); 3 = large text or a UI component (SC 1.4.11). */
  min: number
  why: string
}

// ── Every pair below reflects MEASURED usage, not the naming convention. ──
const PAIRS: Pair[] = [
  // General body text, on the surfaces it is actually painted over.
  { text: 'mm-text', on: ['mm-bg', 'mm-surface', 'mm-surface-hover', 'card', 'popover', 'muted', 'secondary'],
    min: 4.5, why: 'primary body text, everywhere' },
  { text: 'mm-text-secondary', on: ['mm-bg', 'mm-surface', 'mm-surface-hover', 'card'],
    min: 4.5, why: 'second tier, panels and rows' },
  { text: 'mm-text-muted', on: ['mm-bg', 'mm-surface', 'mm-surface-hover', 'card', 'muted', 'secondary'],
    min: 4.5, why: 'third tier; #434 moved it for the speaker tints' },
  { text: 'mm-text-faint', on: ['mm-bg', 'mm-surface', 'mm-surface-hover', 'muted'],
    min: 4.5, why: 'measured usage: 26x on mm-bg, 14x on mm-surface, 7x on hover' },
  { text: 'muted-foreground', on: ['mm-bg', 'mm-surface', 'card', 'popover', 'muted'],
    min: 4.5, why: 'shadcn primitives; 78 direct uses' },
  { text: 'foreground', on: ['background', 'mm-bg'], min: 4.5, why: 'shadcn base' },
  { text: 'card-foreground', on: ['card'], min: 4.5, why: 'shadcn card' },
  { text: 'popover-foreground', on: ['popover'], min: 4.5, why: 'shadcn popover' },
  { text: 'secondary-foreground', on: ['secondary'], min: 4.5, why: 'shadcn secondary' },
  { text: 'accent-foreground', on: ['accent'], min: 4.5, why: 'shadcn accent' },

  // Contextual families that DO sit on their own solid surface (verified).
  { text: 'mm-ctx-comments-text', on: ['mm-ctx-comments'], min: 4.5, why: 'text-coding context header' },
  { text: 'mm-ctx-demo-text', on: ['mm-ctx-demo'], min: 4.5, why: 'text-coding context header' },
  { text: 'mm-ctx-responses-text', on: ['mm-ctx-responses'], min: 4.5, why: 'text-coding context header' },

  // Selection blue: NEVER on solid --mm-blue. Alpha tint over a surface, or the cell token.
  { text: 'mm-blue-text',
    on: [{ tint: 'mm-blue', alpha: 0.2, over: 'mm-surface' }, { tint: 'mm-blue', alpha: 0.2, over: 'mm-bg' },
         { tint: 'mm-blue', alpha: 0.12, over: 'mm-surface' }, 'mm-blue-cell'],
    min: 4.5, why: 'lib/selection.ts SELECTED_TINT (0.20 light / 0.30 dark) + SELECTED_CELL' },

  // Canvas accent text sits on a 6-12% tint of its own accent over the page or a card.
  { text: 'mm-canvas-text',
    on: [{ tint: 'mm-canvas', alpha: 0.06, over: 'mm-bg' }, { tint: 'mm-canvas', alpha: 0.12, over: 'mm-bg' },
         { tint: 'mm-canvas', alpha: 0.06, over: 'mm-surface' }, { tint: 'mm-canvas', alpha: 0.12, over: 'mm-surface' }],
    min: 4.5, why: 'Overview / Analysis-hub tiles' },
]

/**
 * Tokens deliberately not in the matrix. Each needs a reason — "I did not get to
 * it" is not one, and a stale entry is caught by the test below.
 */
const EXEMPT: Record<string, string> = {
  'mm-chrome-text': 'covered by chrome-contrast.test.ts, incl. the rail overlays',
  'mm-chrome-text-muted': 'covered by chrome-contrast.test.ts, incl. the rail overlays',
  'destructive-foreground': 'white on a filled destructive button — pairs with --destructive, not a surface',
  'primary-foreground': 'white on a filled primary button — pairs with --primary, not a surface',
  'mm-green-text': 'status/entity accent on its own alpha tint; tint alphas vary per call site',
  'mm-orange-text': 'status/entity accent on its own alpha tint; tint alphas vary per call site',
  'mm-purple-text': 'status/entity accent on its own alpha tint; tint alphas vary per call site',
  'mm-teal-text': 'status/entity accent on its own alpha tint; tint alphas vary per call site',
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = s / 100, L = l / 100
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

const DARK_AT = CSS.indexOf('.dark {')

function token(theme: Theme, name: string): Rgb {
  const block = theme === 'light' ? CSS.slice(0, DARK_AT) : CSS.slice(DARK_AT)
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`))
  expect(m, `--${name} not found in the ${theme} block`).not.toBeNull()
  const [, h, s, l] = m!
  return hslToRgb(Number(h), Number(s), Number(l))
}

function resolve(theme: Theme, bg: Bg): [Rgb, string] {
  if (typeof bg === 'string') return [token(theme, bg), `--${bg}`]
  // The selection tint is heavier in dark mode (lib/selection.ts).
  const alpha = theme === 'dark' && bg.tint === 'mm-blue' ? 0.3 : bg.alpha
  return [over(token(theme, bg.tint), token(theme, bg.over), alpha),
          `--${bg.tint}/${alpha} over --${bg.over}`]
}

describe('contrast matrix (#7)', () => {
  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      for (const pair of PAIRS) {
        for (const bg of pair.on) {
          const [, label] = resolve(theme, bg)
          it(`--${pair.text} on ${label}`, () => {
            const [bgRgb] = resolve(theme, bg)
            const ratio = contrast(token(theme, pair.text), bgRgb)
            expect(ratio, `${ratio.toFixed(2)}:1 (need ${pair.min}) — ${pair.why}`)
              .toBeGreaterThanOrEqual(pair.min)
          })
        }
      }
    })
  }
})

describe('focus indicator (#6)', () => {
  // SC 1.4.11: 3:1 for "visual information required to identify UI components and
  // states". W3C's Understanding document treats focus indication as exactly that.
  const SURFACES = ['mm-bg', 'mm-surface', 'card', 'muted', 'secondary']
  for (const theme of ['light', 'dark'] as const) {
    for (const surface of SURFACES) {
      it(`${theme}: --ring on --${surface}`, () => {
        const ratio = contrast(token(theme, 'ring'), token(theme, surface))
        expect(ratio, `${ratio.toFixed(2)}:1 (need 3.0)`).toBeGreaterThanOrEqual(3)
      })
    }
  }
})

describe('fail-closed coverage', () => {
  /**
   * Every text-carrying token declared in the light block.
   *
   * ⚠️ Matches `-text` ANYWHERE, not as a suffix. A suffix-only rule silently
   * skipped `--mm-chrome-text-muted` (it ends in `-muted`), which means it would
   * also skip the next `--foo-text-<variant>` — an under-inclusive coverage check
   * is a guard that quietly stops guarding.
   */
  function declaredTextTokens(): string[] {
    const light = CSS.slice(0, DARK_AT)
    const names = new Set<string>()
    for (const m of light.matchAll(/--([\w-]+):\s*[\d.]+\s+[\d.]+%\s+[\d.]+%\s*;/g)) {
      const n = m[1]
      if (n.includes('-text') || n.endsWith('-foreground')) names.add(n)
    }
    return [...names].sort()
  }

  it('every text token is either covered or explicitly exempt', () => {
    const declared = declaredTextTokens()
    // #730 in token space rather than file space: this asserts an EMPTY
    // `missing` list, which is satisfied just as well by a token set that came
    // back empty. `declaredTextTokens` parses index.css with a regex against a
    // `DARK_AT` slice — a stylesheet reorganisation, a renamed token or a
    // changed HSL format all yield [] silently, and this arm plus the stale-
    // exemption arm below would both go quietly green. 20 text tokens today;
    // the floor detects the parse collapsing, not palette growth.
    expect(
      declared.length,
      `only ${declared.length} text tokens parsed out of index.css — the regex or `
        + 'the .dark slice no longer matches the stylesheet, so this test and the '
        + 'stale-exemption test below would both pass vacuously. Fix the parse; do '
        + 'NOT lower this floor.',
    ).toBeGreaterThan(10)

    const covered = new Set(PAIRS.map(p => p.text))
    const missing = declared.filter(n => !covered.has(n) && !(n in EXEMPT))
    expect(
      missing,
      'A new text token must say where it lands. Add it to PAIRS with the surfaces ' +
        'it is ACTUALLY painted over (check real usage — do not derive the pairing ' +
        'from the --X-text / --X naming convention, which is false for the blue ' +
        'family), or to EXEMPT with a reason.',
    ).toEqual([])
  })

  it('every exemption is still a real token — a stale exemption is a blind spot', () => {
    const declared = new Set(declaredTextTokens())
    for (const name of Object.keys(EXEMPT)) {
      expect(declared.has(name), `exempt token no longer exists: --${name}`).toBe(true)
    }
  })

  it('the matrix can actually fail', () => {
    // A guard that cannot fail is not a guard: prove the maths rejects a known-bad
    // pair. Pure black-on-black is 1:1 by definition.
    expect(contrast([0, 0, 0], [0, 0, 0])).toBeCloseTo(1, 5)
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0)
  })
})
