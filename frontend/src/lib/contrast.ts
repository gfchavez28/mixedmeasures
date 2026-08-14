/**
 * WCAG contrast arithmetic over the SHIPPED design tokens (#645 / #699).
 *
 * Extracted from `chrome-contrast.test.ts`, which had these inline. It is now
 * two consumers — the rail guard and the token×surface matrix — and two copies
 * of a luminance formula is the shape that propagates a defect verbatim rather
 * than merely drifting (#733).
 *
 * ⚠️ **Everything here reads `index.css` itself, never a mirrored table of
 * values.** That is the original guard's load-bearing choice: a duplicated
 * table would keep passing while the shipped CSS regressed. A token edit is a
 * one-character change with app-wide reach and no natural test.
 */
export type Rgb = [number, number, number]

/** HSL → RGB in 0..1, matching the CSS `hsl()` the tokens are consumed through. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = s / 100
  const L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

/** Composite `fg` over `bg` at `alpha` — for tokens painted as `bg-white/[α]`. */
export const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map(i => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Read one `--token` out of a theme block of `index.css`.
 *
 * `.dark` is declared after `:root`, so slicing at it separates the two.
 * Throws when the token is absent — a renamed token must fail the guard loudly,
 * not silently drop a pair from the matrix.
 */
export function readToken(css: string, theme: 'light' | 'dark', name: string): Rgb {
  const darkAt = css.indexOf('.dark {')
  if (darkAt < 0) throw new Error('index.css declares no .dark block')
  const block = theme === 'light' ? css.slice(0, darkAt) : css.slice(darkAt)
  const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`))
  if (!m) throw new Error(`--${name} not found in the ${theme} block of index.css`)
  const [, h, s, l] = m
  return hslToRgb(Number(h), Number(s), Number(l))
}

/**
 * OKLCH → sRGB, for Tailwind's own palette — #728.
 *
 * Tailwind v4 ships its default palette as `oklch()` in `tailwindcss/theme.css`.
 * The app's ENTITY colours (status pills, source badges, filter chips) are raw
 * palette utilities rather than `mm-*` tokens — deliberately, since a banned-hue
 * ESLint rule (#481) exempts exactly those cases where the hue IS the category
 * identity. So `readToken` above cannot reach them, and neither contrast guard
 * could see the entity colour system at all.
 *
 * ⚠️ **Gamma-encode the result.** An implementation that returns linear values
 * here looks right and is wrong by a wide margin: it told a confident story
 * about which pairs fail (an even light/dark split) that reversed once the
 * transfer function was applied. `TAILWIND_REFERENCE_RATIOS` below exists so
 * that mistake cannot be made silently again.
 */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const lin: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
  return lin.map(c => {
    const v = Math.max(0, Math.min(1, c))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }) as Rgb
}

/**
 * Tailwind's shipped palette, keyed `"amber-600"`.
 *
 * Read out of `node_modules/tailwindcss/theme.css` for the same reason
 * `readToken` reads `index.css`: a mirrored table keeps passing while the
 * artifact that ships moves underneath it. A palette entry that stops parsing
 * is absent rather than wrong, which the population assertion catches.
 */
export function parseTailwindPalette(css: string): Map<string, Rgb> {
  const out = new Map<string, Rgb>()
  const re = /--color-([a-z]+)-(\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g
  for (const m of css.matchAll(re)) {
    out.set(`${m[1]}-${m[2]}`, oklchToRgb(Number(m[3]) / 100, Number(m[4]), Number(m[5])))
  }
  return out
}

/**
 * Independently-measured ratios, used to prove the conversion above.
 *
 * These six come from #728's own measurement of the search source badges, taken
 * by a different route. They are the only reason the missing gamma step was
 * caught — every internally-consistent check passed while the numbers were
 * wrong. Treat them as fixed points, not as examples.
 */
export const TAILWIND_REFERENCE_RATIOS: Array<[fg: string, bg: string, ratio: number]> = [
  ['green-600', 'green-100', 2.93],
  ['purple-600', 'purple-100', 4.68],
  ['teal-600', 'teal-100', 3.25],
  ['green-800', 'green-100', 6.45],
  ['purple-800', 'purple-100', 7.51],
  ['teal-800', 'teal-100', 6.69],
]

/** WCAG 2.2 thresholds. Large text is ≥18.66px bold or ≥24px. */
export const AA_NORMAL = 4.5
export const AA_LARGE = 3
/** SC 1.4.11 — non-text contrast (focus rings, control boundaries, icons). */
export const NON_TEXT = 3
