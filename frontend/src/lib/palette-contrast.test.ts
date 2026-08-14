/**
 * #728 — the ENTITY colour system, which no contrast guard could see.
 *
 * ## The structural gap this closes
 *
 * Both existing guards parse `mm-*` design tokens out of `index.css`. The
 * entity colours are not tokens — they are raw Tailwind palette utilities
 * written inline (`bg-amber-50 text-amber-700`), deliberately, because the
 * banned-palette ESLint rule (#481) exempts exactly the cases where the hue IS
 * the category identity. So no addition to those guards' PAIRS lists could ever
 * reach these, and the app's status pills, source badges and filter chips had
 * never been contrast-checked by anything. Three separate incidents (#667, #699
 * and this one) were each found by someone happening to edit the component.
 *
 * ## Why the pairs are DERIVED, not curated
 *
 * `contrast-matrix.test.ts` hand-curates its pairs because a cross-product over
 * tokens is mostly pairs that never co-occur. Here the co-occurrences are
 * readable from the source itself — a class string states which foreground sits
 * on which background — so deriving them means a new badge is covered the day
 * it is written, rather than the day someone remembers this file.
 *
 * ## 🔴 The parser is the hard part, and a naive one reports PHANTOMS
 *
 * Measured while building this, twice, on real strings:
 *
 * - `dark:hover:bg-red-950/20` — a variant CHAIN. A regex that reads only the
 *   immediately-preceding prefix files that dark background under light mode
 *   and invents light-text-on-dark-background pairs that no user ever sees.
 * - `dark:[&_[data-type=mention]]:bg-indigo-900/30` — an ARBITRARY variant. The
 *   bracket syntax is not `[a-z-]+:`, so the `dark:` is dropped entirely and
 *   every utility in the string reads as light mode. Only 8 of ~615 colour
 *   strings do this — but they produced the two WORST entries in the first fix
 *   list, both fictional. Low volume, high rank: the worst place for noise.
 *
 * Hence `UNPARSEABLE_ALLOWLIST`: a string this scan cannot read is EXCLUDED and
 * accounted for, never guessed at. A new one fails the suite with instructions.
 *
 * - A template literal with an embedded ternary holds BOTH branches, which are
 *   mutually exclusive at render time. Naively that pairs one branch's text with
 *   the other's background — `orange-700 on purple-100`, from a speaker-initial
 *   badge whose two arms are facilitator-purple and participant-orange. So
 *   `expandBranches` emits one variant per alternative instead, which is the
 *   render model rather than the source text.
 *
 * ⚠️ **Residual:** one class string can still style several sibling elements,
 * which no parser can see. If that ever surfaces a phantom, hold it in
 * `KNOWN_BELOW_AA` with a note rather than recolouring something that never
 * paints — a change made for the guard's benefit rather than a user's.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  contrast, over, parseTailwindPalette, readToken,
  TAILWIND_REFERENCE_RATIOS, AA_NORMAL, type Rgb,
} from './contrast'

const SRC = join(__dirname, '..')
const PALETTE = parseTailwindPalette(
  readFileSync(join(__dirname, '../../node_modules/tailwindcss/theme.css'), 'utf8'),
)
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8')

/** The hues #481 exempts — where the colour IS the category identity. */
const HUES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
].join('|')

/**
 * Class strings this scan cannot parse, excluded by name.
 *
 * Arbitrary variants (`[&_...]:`) break the prefix grammar, so the theme cannot
 * be determined and the pair would be filed under the wrong mode. Failing here
 * rather than silently mis-bucketing is the #730 lesson applied to INPUT: a scan
 * that quietly drops what it cannot read reports clean and means blind.
 */
const UNPARSEABLE_ALLOWLIST = ['EquivalenceRow.tsx', 'ThemeEditor.tsx']

/**
 * Pairs below AA that are deliberately NOT fixed, with the ratio they must not
 * fall below — the `token-contrast.test.ts` floor pattern.
 */
const KNOWN_BELOW_AA: Array<[pair: string, floor: number, why: string]> = []

interface Pair { theme: 'light' | 'dark'; fg: string; bg: string; alpha: number | null; count: number }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !name.includes('.test.')) out.push(p)
  }
  return out
}

const STRING_RE = /`([^`]*)`|"([^"\n]*)"|'([^'\n]*)'/g
const INTERP_RE = /\$\{[\s\S]*?\}/g
const QUOTED_RE = /'([^'\n]*)'|"([^"\n]*)"/g

/**
 * One variant per render, from a template literal that embeds a ternary.
 *
 * `` `base ${cond ? 'bg-purple-100 text-purple-600' : 'bg-orange-100 text-orange-700'}` ``
 * renders as EITHER branch, never both. Read as one string it yields
 * `orange-700 on purple-100`, a pair that cannot appear on screen. Returns the
 * static text combined with each alternative separately, so a legitimate pair
 * split across the static part and a branch still forms.
 */
function expandBranches(chunk: string): string[] {
  const interps = chunk.match(INTERP_RE)
  if (!interps) return [chunk]
  const staticText = chunk.replace(INTERP_RE, ' ')
  const alternatives = interps.flatMap(i =>
    [...i.matchAll(QUOTED_RE)].map(m => m[1] ?? m[2] ?? ''))
  if (alternatives.length === 0) return [staticText]
  return alternatives.map(alt => `${staticText} ${alt}`)
}
const UTIL_RE = new RegExp(String.raw`\b((?:[a-z-]+:)*)(text|bg)-(${HUES})-(\d{2,3})(?:/(\d{1,3}))?\b`, 'g')

function scan() {
  const pairs = new Map<string, Pair>()
  const unparseable = new Set<string>()

  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(STRING_RE)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? ''
      // ⚠️ Test for a PALETTE utility, not for `text-`: the app is full of
      // `text-mm-*` tokens, and a looser test drags every one of them into the
      // unparseable set the moment its string also uses an arbitrary variant.
      if (!new RegExp(UTIL_RE.source).test(raw)) continue
      // An arbitrary variant makes the prefix chain unreadable — record the file
      // and skip, rather than filing its utilities under a guessed theme.
      if (raw.includes('[&')) { unparseable.add(file.split('/').pop()!); continue }

      for (const chunk of expandBranches(raw)) {
        const parsed = [...chunk.matchAll(UTIL_RE)].map(u => {
          const parts = (u[1] ?? '').split(':').filter(Boolean)
          return {
            theme: (parts.includes('dark') ? 'dark' : 'light') as 'light' | 'dark',
            // Resting text over a HOVER background is a combination nobody
            // sees, so a pair is real only when both halves share the state.
            state: parts.filter(p => p !== 'dark').sort().join('.'),
            kind: u[2], shade: `${u[3]}-${u[4]}`, alpha: u[5] ? Number(u[5]) : null,
          }
        })
        for (const fg of parsed.filter(p => p.kind === 'text')) {
          for (const bg of parsed.filter(p => p.kind === 'bg')) {
            if (fg.theme !== bg.theme || fg.state !== bg.state) continue
            const key = `${fg.theme}|${fg.shade}|${bg.shade}|${bg.alpha ?? ''}`
            const found = pairs.get(key)
            if (found) found.count++
            else pairs.set(key, { theme: fg.theme, fg: fg.shade, bg: bg.shade, alpha: bg.alpha, count: 1 })
          }
        }
      }
    }
  }
  return { pairs: [...pairs.values()], unparseable }
}

const { pairs, unparseable } = scan()

/** The surface an alpha-composited background is painted over. */
function surfaceFor(theme: 'light' | 'dark'): Rgb {
  return readToken(CSS, theme, 'mm-surface')
}

function ratioOf(p: Pair): number | null {
  const fg = PALETTE.get(p.fg)
  const raw = PALETTE.get(p.bg)
  if (!fg || !raw) return null
  const bg = p.alpha == null ? raw : over(raw, surfaceFor(p.theme), p.alpha / 100)
  return contrast(fg, bg)
}

describe('#728 — the scan can see, and says when it cannot', () => {
  /**
   * The population assertion (#730). A walk that resolved to nothing, or a
   * palette that stopped parsing, would report zero failures and look exactly
   * like success.
   */
  it('finds the palette and a substantial pair population', () => {
    expect(PALETTE.size, 'tailwindcss/theme.css parsed no palette entries').toBeGreaterThan(200)
    expect(PALETTE.get('amber-600')).toBeDefined()
    expect(pairs.length, 'the source walk found almost no colour pairs').toBeGreaterThan(100)
  })

  it('resolves every pair it reports on', () => {
    // A shade absent from the palette would silently drop out of the check.
    const unresolved = pairs.filter(p => ratioOf(p) == null)
    expect(unresolved.map(p => `${p.fg} on ${p.bg}`)).toEqual([])
  })

  /**
   * Fail LOUDLY on syntax the parser cannot read. Adding a file here is a
   * deliberate act with a reason; arriving here by accident is the defect.
   */
  it('accounts for every class string it could not parse', () => {
    expect(
      [...unparseable].sort(),
      'a class string uses an arbitrary variant ([&_...]:) this scan cannot theme. '
      + 'Either write the colour without one, or add the file to UNPARSEABLE_ALLOWLIST '
      + 'and check its contrast by hand.',
    ).toEqual([...UNPARSEABLE_ALLOWLIST].sort())
  })

  /**
   * The conversion's fixed points. Six ratios measured for #728 by a different
   * route; they are the only reason a missing gamma step was ever caught.
   */
  it.each(TAILWIND_REFERENCE_RATIOS)(
    'reproduces the independently measured %s on %s = %s:1',
    (fg, bg, expected) => {
      const ratio = contrast(PALETTE.get(fg)!, PALETTE.get(bg)!)
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeCloseTo(expected, 1)
    },
  )
})

describe('#728 — every entity colour pair clears AA', () => {
  it('holds the documented exceptions at or above their floor', () => {
    for (const [label, floor, why] of KNOWN_BELOW_AA) {
      const p = pairs.find(x => `${x.fg} on ${x.bg}` === label)
      expect(p, `${label} no longer occurs — delete its KNOWN_BELOW_AA row (${why})`).toBeDefined()
      const ratio = ratioOf(p!)!
      expect(ratio, `${label} = ${ratio.toFixed(2)}:1 fell below its floor`).toBeGreaterThanOrEqual(floor - 0.01)
    }
  })

  it('has no undocumented pair below 4.5:1', () => {
    const known = new Set(KNOWN_BELOW_AA.map(([label]) => label))
    const failures = pairs
      .map(p => ({ p, ratio: ratioOf(p)! }))
      .filter(({ p, ratio }) => ratio < AA_NORMAL && !known.has(`${p.fg} on ${p.bg}`))
      .sort((a, b) => a.ratio - b.ratio)
      .map(({ p, ratio }) =>
        `${ratio.toFixed(2)}:1  ${p.theme}  ${p.fg} on ${p.bg}${p.alpha ? `/${p.alpha}` : ''}  (x${p.count})`)
    expect(failures, `entity colour pairs below AA:\n  ${failures.join('\n  ')}`).toEqual([])
  })
})
