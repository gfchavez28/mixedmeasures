/**
 * #699(b) — every text token against every surface it can actually land on.
 *
 * **Why a matrix and not another per-incident fix.** #394 and #434 each moved a
 * token, and each was correct *for the surface named in its ticket*. The method
 * was right; it was applied one incident at a time, so the pairs nobody filed
 * stayed unchecked. `chrome-contrast.test.ts` is a model of the technique and is
 * pointed at exactly two tokens against three rail backgrounds — the rail is
 * guarded and the other ~95% of the app is not.
 *
 * It reads the SHIPPED `index.css` (via `lib/contrast.ts`) rather than a table
 * of values, for the reason that guard's docstring gives: a mirror would keep
 * passing while the CSS regressed.
 *
 * ⚠️ **What this cannot see.** It checks tokens against tokens. A component that
 * paints text on an arbitrary user-chosen colour (a code chip) is out of scope —
 * that is `getContrastColor`'s job and `utils.test.ts` sweeps it. And a pair
 * this file does not list is a pair nobody is checking, so the pairings below
 * are deliberately over-inclusive: `NEVER_TOGETHER` is the place to record a
 * combination that cannot occur, WITH the reason, rather than quietly omitting
 * it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AA_LARGE, AA_NORMAL, NON_TEXT, contrast, over, readToken, type Rgb } from './contrast'
import { stripComments } from './strip-comments'

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf-8')

/**
 * The text tiers, most to least prominent.
 *
 * ⚠️ `muted-foreground` is shadcn's, not `mm-*`, and leaving it off this axis is
 * what hid #748: it is the token `ByTextTable` paints inside a SELECTED cell
 * ("Empty response"), so the one pair with a confirmed live co-occurrence was
 * the one pair the matrix could not see. An axis omission is not a smaller
 * mistake than a missing assertion — it is the same mistake, one level up.
 */
const TEXT_TOKENS = [
  'mm-text',
  'mm-text-secondary',
  'mm-text-muted',
  'mm-text-faint',
  'muted-foreground',
] as const

/** Surfaces those tiers are painted on. */
const SURFACES = [
  'mm-bg',
  'mm-surface',
  'card',
  'background',
  // The STATE surfaces, which is where the first draft of this matrix went
  // wrong: it listed only the resting backgrounds and reported a clean sweep,
  // while #699's own worst case is `--mm-text-faint` on `--mm-blue-cell`. A
  // selected row is not an exotic state — it is the one the researcher is
  // looking at.
  'mm-surface-hover',
  'mm-blue-cell',
] as const

/**
 * Pairs that cannot co-occur, each with the reason. An entry here is a claim
 * about the app, so it needs to be true — this is the allow-list the #699
 * entry asked for, and an empty one would be a lie by omission the moment a
 * genuinely impossible pair failed and got silently deleted instead.
 */
const NEVER_TOGETHER: Array<[text: string, surface: string, why: string]> = []

/**
 * Pairs that DO co-occur and are BELOW AA today, with the measured ratio.
 *
 * Deliberately not put in `NEVER_TOGETHER` — that list means "cannot happen",
 * and claiming it here would be a lie that also deletes the finding. These are
 * asserted against a floor instead, so they cannot get worse while the decision
 * is open, and the day one is fixed it moves to the matrix proper and this list
 * shrinks.
 *
 * ⚠️ **These are RAW TOKEN pairings, and #748 settled that the app does not
 * render them.** All three are the same value in dark (`200 6% 56%`), and the
 * decision was NOT to move it — see `lib/selection.ts::SELECTION_TEXT_FLOOR` for
 * the arithmetic that kills every token-moving option. A selection surface
 * re-points these tokens to `--mm-text-secondary` for its descendants, so
 * reaching one of these ratios now takes hand-rolling `bg-mm-blue-cell` instead
 * of using `SELECTED_CELL` — which is exactly why they stay here under a floor
 * rather than moving to `NEVER_TOGETHER`. "Cannot happen" would be false; "does
 * not happen through the recipe" is what the block below proves.
 *
 * ⚠️ The fourth text tier is retired BY VALUE in **both** themes and always was
 * (public #7, and `index.css` carries the reasoning) — light is `200 6% 40%`
 * twice, dark `200 6% 56%` twice. Do not read the dark block alone and file it
 * as a dark-mode defect; that is what #748 originally was.
 */
const KNOWN_BELOW_AA: Array<[theme: string, text: string, surface: string, ratio: number]> = [
  ['dark', 'mm-text-muted', 'mm-blue-cell', 3.50],
  ['dark', 'mm-text-faint', 'mm-blue-cell', 3.50],
  ['dark', 'muted-foreground', 'mm-blue-cell', 3.50],
]

const themes = ['light', 'dark'] as const

describe('#699(b) — text tokens vs the surfaces they land on', () => {
  it('reads every token it claims to check (the scan cannot go blind)', () => {
    // The population assertion (#730): a matrix whose tokens all failed to
    // resolve would report zero failures and look like a pass.
    let read = 0
    for (const theme of themes) {
      for (const name of [...TEXT_TOKENS, ...SURFACES]) {
        expect(() => readToken(CSS, theme, name)).not.toThrow()
        read++
      }
    }
    expect(read).toBe(themes.length * (TEXT_TOKENS.length + SURFACES.length))
  })

  for (const theme of themes) {
    describe(theme, () => {
      for (const text of TEXT_TOKENS) {
        for (const surface of SURFACES) {
          const skipped = NEVER_TOGETHER.find(([t, s]) => t === text && s === surface)
          const known = KNOWN_BELOW_AA.find(([th, t, s]) => th === theme && t === text && s === surface)
          const label = `--${text} on --${surface}`
          if (skipped) {
            it.skip(`${label} — never co-occurs: ${skipped[2]}`, () => {})
            continue
          }
          if (known) {
            it(`${label} is BELOW AA at ${known[3]}:1 and must not get worse (#748)`, () => {
              const ratio = contrast(readToken(CSS, theme, text), readToken(CSS, theme, surface))
              expect(ratio, `${label} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(known[3] - 0.01)
              // If it now clears AA, the decision landed — move it out of the
              // list rather than leaving a passing test that says "below AA".
              expect(ratio, `${label} now clears AA — remove it from KNOWN_BELOW_AA`)
                .toBeLessThan(AA_NORMAL)
            })
            continue
          }
          it(`${label} clears AA`, () => {
            const ratio = contrast(readToken(CSS, theme, text), readToken(CSS, theme, surface))
            // `mm-text-faint` is frequently paired with text-[10px]/[11px], so
            // the large-text allowance does not apply to it — it is the SMALLEST
            // text in the app, not the largest.
            expect(ratio, `${theme} ${label} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL)
          })
        }
      }
    })
  }
})

/**
 * #748 — the STATE surfaces, checked as they actually render.
 *
 * The matrix above pairs a text token with an OPAQUE surface token. A selected
 * row is neither: it is `hsl(var(--mm-blue)/α)` composited over whatever it sits
 * on, and it re-points the dim text tokens for everything inside it. Both halves
 * have to be read from the shipped source or this block would be a mirror of the
 * thing it checks — so the alphas and the aliases come out of `selection.ts`
 * itself, and a recipe edited without its floor fails here.
 */
const SELECTION_SRC = readFileSync(join(__dirname, 'selection.ts'), 'utf-8')

/** The tiers a selection surface must re-point, and the tier they land on. */
const DIM_TOKENS = ['mm-text-muted', 'mm-text-faint', 'muted-foreground'] as const
const RAISED_TO = 'mm-text-secondary'

/** `bg-[hsl(var(--mm-blue)/0.20)] dark:bg-[hsl(var(--mm-blue)/0.30)]` → the two alphas. */
function tintAlphas(): { light: number; dark: number } {
  const m = SELECTION_SRC.match(
    /bg-\[hsl\(var\(--mm-blue\)\/([\d.]+)\)\]\s+dark:bg-\[hsl\(var\(--mm-blue\)\/([\d.]+)\)\]/,
  )
  if (!m) throw new Error('SELECTED_TINT no longer declares two --mm-blue alphas')
  return { light: Number(m[1]), dark: Number(m[2]) }
}

/** Every surface a selection recipe can paint, per theme. */
function selectionSurfaces(theme: 'light' | 'dark'): Array<[string, Rgb]> {
  const alpha = tintAlphas()[theme]
  const blue = readToken(CSS, theme, 'mm-blue')
  return [
    [`tint/${alpha} over --mm-surface`, over(blue, readToken(CSS, theme, 'mm-surface'), alpha)],
    [`tint/${alpha} over --mm-bg`, over(blue, readToken(CSS, theme, 'mm-bg'), alpha)],
    ['--mm-blue-cell', readToken(CSS, theme, 'mm-blue-cell')],
  ]
}

describe('#748 — dim text on a selection surface', () => {
  it('every dim tier is re-pointed by the recipe (all three, or the floor has a hole)', () => {
    for (const token of DIM_TOKENS) {
      expect(
        SELECTION_SRC,
        `SELECTION_TEXT_FLOOR must re-point --${token}; a tier left out renders at the raw value`,
      ).toContain(`[--${token}:var(--${RAISED_TO})]`)
    }
    // Population (#730): the assertions above pass vacuously if DIM_TOKENS is
    // ever emptied, and both recipes must actually carry the floor.
    expect(DIM_TOKENS.length).toBe(3)
    for (const recipe of ['SELECTED_TINT', 'SELECTED_CELL']) {
      const line = SELECTION_SRC.match(new RegExp(`export const ${recipe} =[^\\n]*(\\n[^\\n]*)?`))?.[0] ?? ''
      expect(line, `${recipe} must compose SELECTION_TEXT_FLOOR`).toContain('SELECTION_TEXT_FLOOR')
    }
  })

  for (const theme of ['light', 'dark'] as const) {
    for (const [surfaceName, surface] of selectionSurfaces(theme)) {
      it(`${theme}: raised dim text clears AA on ${surfaceName}`, () => {
        const ratio = contrast(readToken(CSS, theme, RAISED_TO), surface)
        expect(ratio, `${theme} --${RAISED_TO} on ${surfaceName} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(AA_NORMAL)
      })
    }
  }

  it('the floor is load-bearing — the UNRAISED tier fails on the worst surface', () => {
    // Without this, a future global re-tone could make the aliases redundant and
    // nothing would say so. The number here is the defect #748 was filed for.
    const [, worst] = selectionSurfaces('dark')[0]
    const raw = contrast(readToken(CSS, 'dark', 'mm-text-muted'), worst)
    expect(raw, `dark --mm-text-muted on the tint = ${raw.toFixed(2)}:1 — if this now clears AA, `
      + 'the token moved and SELECTION_TEXT_FLOOR should be re-justified or removed')
      .toBeLessThan(AA_NORMAL)
  })
})

/**
 * The sibling state surface. `NOW_PLAYING_ROW` is deliberately NOT selection
 * (D27 — it is a playback fact), but it is a tint painted under the same clip
 * rows, whose metadata is `text-mm-text-faint`. It is checked here because the
 * question "is dim text readable on this state" is a property of tinted rows,
 * not of what the tint means.
 */
describe('#748 sibling — dim text on the now-playing tint', () => {
  function nowPlayingAlphas(): { light: number; dark: number } {
    const m = SELECTION_SRC.match(
      /bg-\[hsl\(var\(--mm-green\)\/([\d.]+)\)\]\s+dark:bg-\[hsl\(var\(--mm-green\)\/([\d.]+)\)\]/,
    )
    if (!m) throw new Error('NOW_PLAYING_ROW no longer declares two --mm-green alphas')
    return { light: Number(m[1]), dark: Number(m[2]) }
  }

  it('the now-playing recipe carries the floor', () => {
    const line = SELECTION_SRC.match(/export const NOW_PLAYING_ROW =[^\n]*(\n[^\n]*)?/)?.[0] ?? ''
    expect(line, 'NOW_PLAYING_ROW must compose SELECTION_TEXT_FLOOR').toContain('SELECTION_TEXT_FLOOR')
  })

  for (const theme of ['light', 'dark'] as const) {
    const alpha = nowPlayingAlphas()[theme]
    for (const base of ['mm-surface', 'mm-bg'] as const) {
      it(`${theme}: raised dim text clears AA on the now-playing tint over --${base}`, () => {
        const surface = over(readToken(CSS, theme, 'mm-green'), readToken(CSS, theme, base), alpha)
        const ratio = contrast(readToken(CSS, theme, RAISED_TO), surface)
        expect(ratio, `${theme} --${RAISED_TO} on green/${alpha} over --${base} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(AA_NORMAL)
      })
    }
  }

  it('the floor is load-bearing here too — some pair is below AA unraised', () => {
    // 3.91:1 dark over --mm-surface and 4.38:1 light over --mm-bg when this was
    // found. Asserted as "the worst pair fails" rather than per pair: two of the
    // four clear AA on their own, and a per-pair test would have to hard-code
    // which — a mirror of the values it is checking.
    const raw = (['light', 'dark'] as const).flatMap(theme =>
      (['mm-surface', 'mm-bg'] as const).map(base => {
        const alpha = nowPlayingAlphas()[theme]
        const surface = over(readToken(CSS, theme, 'mm-green'), readToken(CSS, theme, base), alpha)
        return [`${theme}/${base}`, contrast(readToken(CSS, theme, 'mm-text-faint'), surface)] as const
      }),
    )
    const worst = Math.min(...raw.map(([, r]) => r))
    expect(worst, `unraised faint on the now-playing tint: `
      + `${raw.map(([k, r]) => `${k} ${r.toFixed(2)}`).join(', ')} — if the worst now clears AA, `
      + 're-justify SELECTION_TEXT_FLOOR on NOW_PLAYING_ROW or drop it').toBeLessThan(AA_NORMAL)
  })
})

/**
 * #699(c) — the CONTROL boundary, and the tokens borrowed to paint foregrounds.
 *
 * Two halves of one defect: a token whose job is a 1px line, used where a reader
 * has to make something out.
 *
 * **The boundary.** `Input`, `Textarea` and `SelectTrigger` are all
 * `bg-transparent`, so `--input` is the only thing that says a control is there
 * — SC 1.4.11's case exactly, with no fill to fall back on. It measured
 * 1.33–1.54:1 in light and 1.23–1.41:1 in dark.
 *
 * **The borrowings.** `--mm-border-medium` was also being used as a TEXT and
 * ICON colour at 22 sites, which no contrast axis could see because border
 * tokens were on neither the text axis nor a non-text one. Three of them were
 * error messages — the sentence naming what went wrong, at `text-xs`, at
 * 1.49:1 — plus a keyboard-chord hint, a missing-value dash, and eight control
 * icons at 1.05:1 on a selected row.
 *
 * ⚠️ `--border` is deliberately NOT raised. A table gridline or a card edge
 * carries no information, and 1.4.11 does not ask for it; raising it would make
 * every divider in the app a hard rule. The split between the two tokens is the
 * fix, so they are asserted separately.
 */
const CONTROL_SURFACES = ['card', 'background', 'mm-surface', 'mm-bg'] as const

describe('#699(c) — a control boundary is identifiable (SC 1.4.11)', () => {
  for (const theme of themes) {
    for (const surface of CONTROL_SURFACES) {
      it(`${theme}: --input on --${surface} clears 3:1`, () => {
        const ratio = contrast(readToken(CSS, theme, 'input'), readToken(CSS, theme, surface))
        expect(ratio, `${theme} --input on --${surface} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(NON_TEXT)
      })
    }
  }

  it('--input is a SEPARATE decision from --border', () => {
    // They held the same value in both themes, which is what made "just raise
    // the border token" look like the fix. If a future re-tone collapses them
    // again, this says so rather than silently re-toning every divider.
    for (const theme of themes) {
      const input = readToken(CSS, theme, 'input')
      const border = readToken(CSS, theme, 'border')
      expect(input, `${theme}: --input and --border are equal again — the control `
        + 'boundary needs 3:1 and a divider does not; re-split them').not.toEqual(border)
    }
  })
})

describe('#699(c) — border tokens are not foreground colours', () => {
  const SRC_DIR = join(__dirname, '..')

  it('no component paints text or an icon with a border token', () => {
    const offenders: string[] = []
    let scanned = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
        scanned++
        const src = readFileSync(path, 'utf-8')
        for (const [line, i] of src.split('\n').map((l, i) => [l, i] as const)) {
          // `text-…` only: `border-mm-border-*` and `bg-mm-border-*` are the
          // token doing its own job.
          if (/\btext-mm-border-[a-z]+/.test(line)) {
            offenders.push(`${path.slice(SRC_DIR.length + 1)}:${i + 1}`)
          }
        }
      }
    }
    walk(SRC_DIR)
    // Population (#730): a scan that walked nothing would report a clean sweep.
    expect(scanned).toBeGreaterThan(200)
    expect(offenders, 'a border token is a 1px line, not a foreground — use a '
      + '--mm-text-* tier (they are contrast-guarded above); 22 sites did this, '
      + 'three of them error messages at 1.49:1').toEqual([])
  })
})

describe('#699 — the focus ring stays a visible indicator (SC 1.4.11)', () => {
  // Guarding the fix that already landed: `--ring` was 152 56% 42% and gave
  // 2.99:1 / 2.57:1 in light — the kind of miss only arithmetic catches, since
  // 2.99 looks identical to 3.01 on a screen.
  for (const theme of themes) {
    for (const surface of ['mm-surface', 'mm-bg'] as const) {
      it(`${theme}: --ring on --${surface} clears 3:1`, () => {
        const ratio = contrast(readToken(CSS, theme, 'ring'), readToken(CSS, theme, surface))
        expect(ratio, `${theme} ring/${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_LARGE)
      })
    }
  }
})

/** Reported as data, not as a pass/fail — a failing matrix should say how far
 *  off each pair is, so the fix can be one token move rather than four. */
export function matrixReport(): Array<[string, number]> {
  const rows: Array<[string, number]> = []
  for (const theme of themes) {
    for (const text of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        const a: Rgb = readToken(CSS, theme, text)
        const b: Rgb = readToken(CSS, theme, surface)
        rows.push([`${theme} --${text} on --${surface}`, contrast(a, b)])
      }
    }
  }
  return rows.sort((x, y) => x[1] - y[1])
}

describe('#852 — a blue tint is painted with the TEXT token, not the fill hue', () => {
  const SRC_DIR = join(__dirname, '..')

  /**
   * `--mm-blue` is a FILL colour. Measured as TEXT on its own tint over
   * `--mm-surface` it reads 3.35:1 light / 4.35:1 dark — below AA — while
   * `--mm-blue-text` on the same tint reads 5.88 / 6.93. Three components had
   * paired the tint with the raw hue (`DatasetTabs`, and the crosswalk's
   * `UnassignedPanel` + `CrosswalkHeader`); ~40 others already used the text
   * token, so this scan pins the majority rule rather than inventing one.
   *
   * ⚠️ Scoped to the CO-OCCURRENCE, deliberately. A blanket ban on
   * `text-mm-blue` would be a false-positive machine: it is used ~127 times,
   * overwhelmingly on ICONS, where the bar is 3:1 non-text and the raw hue
   * passes (3.76 light / 5.00 dark on a plain surface). Distinguishing an icon
   * from text in JSX statically is exactly the unreliable-grep problem — so the
   * scan asks the narrower question it CAN answer: is this element painting
   * text on a blue tint it declares in the same class string?
   */
  const TINT_THEN_TEXT = /bg-mm-blue\/\d+[^'"`]*?\btext-mm-blue\b(?!-)/
  const TEXT_THEN_TINT = /\btext-mm-blue\b(?!-)[^'"`]*?bg-mm-blue\/\d+/
  const CORRECT = /bg-mm-blue\/\d+[^'"`]*?\btext-mm-blue-text\b|\btext-mm-blue-text\b[^'"`]*?bg-mm-blue\/\d+/

  const scan = () => {
    const offenders: string[] = []
    let correctPairings = 0
    let scanned = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) continue
        scanned++
        // Strip first: the prose explaining this very fix names both classes,
        // and a scan that matches its own comments is the #772 failure mode.
        for (const [line, i] of stripComments(readFileSync(path, 'utf-8'), entry.name)
          .split('\n').map((l, i) => [l, i] as const)) {
          if (TINT_THEN_TEXT.test(line) || TEXT_THEN_TINT.test(line)) {
            offenders.push(`${path.slice(SRC_DIR.length + 1)}:${i + 1}`)
          } else if (CORRECT.test(line)) {
            correctPairings++
          }
        }
      }
    }
    walk(SRC_DIR)
    return { offenders, correctPairings, scanned }
  }

  it('no component paints text-mm-blue on a blue tint', () => {
    const { offenders } = scan()
    expect(offenders, 'a blue tint must carry `text-mm-blue-text`; the raw '
      + '`--mm-blue` fill hue is below AA as text on its own tint (#852)').toEqual([])
  })

  it('the scan reaches real class strings (it cannot pass by seeing nothing)', () => {
    // The self-check a narrowing needs (#814): if the regex, the extension
    // filter or the comment-stripper broke, `offenders` would be empty for the
    // wrong reason. The CORRECT pairing is the positive control — it is the
    // same shape, one token different, and it is everywhere.
    const { correctPairings, scanned } = scan()
    expect(scanned).toBeGreaterThan(100)
    expect(correctPairings, 'the tint+text-token pairing vanished from the '
      + 'source — the scan is looking at the wrong thing').toBeGreaterThan(25)
  })
})
