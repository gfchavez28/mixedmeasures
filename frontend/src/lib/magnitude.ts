/**
 * Magnitude coding — the client half of the declared instrument (#35).
 *
 * The server owns validation (`services/magnitude.py`); this module owns DISPLAY:
 * how a rating positions itself within its own scale, and what it announces.
 *
 * ## Why a normalized position exists at all
 *
 * Scales are declared PER CODE, so one segment can carry `Perceived joy 0–100 = 72`
 * and `Anxiety −1…+1 = −0.5` at once. **No competitor has to render that** — Dedoose
 * shows one weight at a time in a side panel, MAXQDA has a single global 0–100 — and
 * a bare `72` beside a bare `−0.5` is not comparable to anything. `normalizedPosition`
 * maps each value into 0–1 *within its own range* so a small fill is comparable
 * across scales while the printed number stays exact.
 *
 * 🔴 **The fill is decorative and `aria-hidden`; `describeMagnitude` carries the
 * fact.** A bar announces nothing, and "−0.5" alone is a number whose scale the
 * reader cannot see. Same split #753 settled for the coder-attribution badge: the
 * visual encoding is hidden and the meaning travels as text.
 *
 * 🔴 **UNRATED IS `null`, AND IT IS NEVER ZERO.** Every predicate here tests
 * `== null` rather than truthiness. On a −1…+1 scale zero is a real, meaningful
 * neutral, so a falsy check silently renders a genuine rating as "not rated" — the
 * falsy-zero class, and the reason the fixtures in the tests are bipolar.
 */

export interface MagnitudeAnchor {
  value: number
  label: string
}

export interface MagnitudeScale {
  min: number
  max: number
  step: number
  anchors: MagnitudeAnchor[]
}

/** A rating, or `null` for UNRATED. Never conflate with 0. */
export type Magnitude = number | null | undefined

/**
 * True when this application carries no rating.
 *
 * ⚠️ `value == null` catches both `null` and `undefined` (a payload from a server
 * that predates the field) and — critically — does NOT catch `0`.
 */
export function isUnrated(value: Magnitude): boolean {
  return value == null
}

/**
 * Integer-aware formatting. `String(10)` for a whole number, `−0.5` otherwise.
 *
 * Mirrors the backend's `_fmt`, and for the same reason: these strings are read
 * aloud and pasted into methods sections, where "10.0 out of 10.0" is noise.
 *
 * ⚠️ Uses the Unicode MINUS SIGN (U+2212) for negatives, not the hyphen. A hyphen
 * in a proportional font reads as a dash at 10px, which on a bipolar scale is the
 * difference between −1 and 1.
 */
export function formatMagnitude(value: number): string {
  const rounded = Number.isInteger(value) ? String(value) : String(value)
  return rounded.startsWith('-') ? `−${rounded.slice(1)}` : rounded
}

/**
 * #1115 — the fill behind a chip's rating number: a tint AWAY from its text.
 *
 * The badge used to tint toward its own text colour (`rgba(ink, 0.22)`), which
 * lowers contrast on every chip colour by construction — measured live, white on
 * the default grey chip went 4.83 → 3.16:1, and 3.5:1 on the default blue. Tinted
 * the other way the number can only gain: `getContrastColor` already guarantees
 * the chip's own text ≥ 4.58:1 on ANY colour, and moving the background away from
 * the text keeps that floor (`lib/rating-badge-contrast.test.ts` sweeps the
 * palette and the colour cube).
 *
 * @param textColor the chip's text, `getContrastColor`'s pure black or white.
 */
export function ratingBadgeFill(textColor: string, unrated: boolean): string {
  const away = textColor === '#000000' ? '255, 255, 255' : '0, 0, 0'
  return `rgba(${away}, ${unrated ? RATING_BADGE_ALPHA.unrated : RATING_BADGE_ALPHA.rated})`
}
/** The two fill strengths: an unrated dash sits lighter than a rating. */
export const RATING_BADGE_ALPHA = { rated: 0.28, unrated: 0.14 } as const

/**
 * Where this value sits in its own range, as 0–1, for the chip's fill.
 *
 * ⚠️ Returns 0 for a degenerate scale rather than `NaN`. The server refuses
 * `min >= max`, so this is unreachable through the API — but a stale cached payload
 * or a hand-edited database would otherwise put `NaN` into a `width` style, which
 * renders as a full-width bar: the most confident possible display of a value we
 * could not compute.
 *
 * ⚠️ Clamped to 0–1. A value outside its range is refused on write, so a stored one
 * predates a scale edit; showing it pinned at an end is honest, while a >100% fill
 * would overflow the chip.
 */
export function normalizedPosition(value: number, scale: MagnitudeScale): number {
  const span = scale.max - scale.min
  if (!Number.isFinite(span) || span <= 0) return 0
  const t = (value - scale.min) / span
  if (!Number.isFinite(t)) return 0
  return Math.min(1, Math.max(0, t))
}

/**
 * The spoken form of a rating — what the chip's accessible name must carry.
 *
 * Mirrors `services/magnitude.py::describe_value`. Agreement between the two is
 * pinned from the PYTHON side by
 * `backend/tests/test_magnitude_contract.py::test_the_two_describe_implementations_agree`,
 * which reads this file — the house direction for a cross-language contract, and
 * the same shape as `test_ci_method_contract.py`. They are two implementations of
 * one sentence, and a silent divergence would mean the screen and the export
 * describe the same number differently.
 *
 * - unrated → `"not rated"`, never `"0"`.
 * - a scale starting at 0 → `"8 out of 10"` (the natural reading).
 * - any other scale → `"−0.5 on a scale from −1 to 1"`, because "−0.5 out of 1"
 *   invites the reader to assume a floor of zero.
 * - an anchored value appends its label: `"0 … , neither"`.
 */
export function describeMagnitude(value: Magnitude, scale: MagnitudeScale | null | undefined): string {
  if (isUnrated(value)) return 'not rated'
  const v = value as number
  if (!scale) return formatMagnitude(v)
  const base = scale.min === 0
    ? `${formatMagnitude(v)} out of ${formatMagnitude(scale.max)}`
    : `${formatMagnitude(v)} on a scale from ${formatMagnitude(scale.min)} to ${formatMagnitude(scale.max)}`
  const anchor = scale.anchors.find(a => a.value === v)
  return anchor ? `${base}, ${anchor.label}` : base
}

/**
 * The discrete values a rating control offers, derived from the declaration.
 *
 * ⚠️ **Bounded, and the bound is a real design constraint rather than paranoia.**
 * A 0–100 scale with step 1 is 101 ticks, which is not a control anyone can hit at
 * 640×360 — so beyond `MAX_TICKS` the caller should render a numeric input instead.
 * `tickValues` returns an empty array there rather than a list nobody can use, and
 * `isTickable` is the predicate the control branches on.
 */
export const MAX_TICKS = 21

/**
 * Absorbs binary floating point on a fractional step (`0.3 / 0.1` is
 * 2.9999999999999996 — measured; `1 / 0.1` happens to be exactly 10), and
 * nothing larger: a real fraction of a step is far bigger than this.
 */
const STEP_EPSILON = 1e-9

/**
 * How many WHOLE steps fit between the minimum and the maximum.
 *
 * 🔴 **Floored, never rounded (#1114).** A step that does not divide the range
 * (0–10 by 4) leaves a remainder, and rounding `2.5` up to 3 put a tick at 12 —
 * past the maximum, offered as a button whose commit the server then refused.
 * The epsilon keeps a fractional step that DOES divide (0–0.3 by 0.1) from
 * losing its last tick to the floor.
 */
function wholeSteps(scale: MagnitudeScale): number {
  const span = scale.max - scale.min
  const step = scale.step > 0 ? scale.step : 1
  return Math.floor(span / step + STEP_EPSILON)
}

export function isTickable(scale: MagnitudeScale): boolean {
  const span = scale.max - scale.min
  if (!Number.isFinite(span) || span <= 0) return false
  return wholeSteps(scale) + 1 <= MAX_TICKS
}

export function tickValues(scale: MagnitudeScale): number[] {
  if (!isTickable(scale)) return []
  const step = scale.step > 0 ? scale.step : 1
  const out: number[] = []
  const count = wholeSteps(scale)
  for (let i = 0; i <= count; i++) {
    // Accumulating `v += step` drifts over many steps on a fractional scale
    // (0.1 × 30 ≠ 3.0 in binary floating point) and would put a tick's value a
    // hair outside the range the server validates against. Multiply instead.
    const raw = scale.min + i * step
    out.push(Number(raw.toFixed(6)))
  }
  return out
}

/** The anchor label for a value, or null. Used for the tick's own title. */
export function anchorLabelFor(value: number, scale: MagnitudeScale): string | null {
  return scale.anchors.find(a => a.value === value)?.label ?? null
}

/** Is `n` a whole number, allowing for binary floating point? */
function isWhole(n: number): boolean {
  return Math.abs(n - Math.round(n)) < 1e-6
}

/**
 * Do the steps land exactly on the maximum? (#1114) When they do not (0–10 by
 * 4), the last point is 8 and the maximum cannot be chosen on the strip — the
 * dialog says so while the scale is being declared.
 */
export function stepsReachMax(scale: Pick<MagnitudeScale, 'min' | 'max' | 'step'>): boolean {
  const step = scale.step > 0 ? scale.step : 1
  return isWhole((scale.max - scale.min) / step)
}

/**
 * Is this value one of the points the strip offers — inside the range and a
 * whole number of steps from the minimum? An anchor or a rating that is not
 * (the step changed after it was given, #1112) is shown but cannot be picked.
 */
export function isScalePoint(value: number, scale: Pick<MagnitudeScale, 'min' | 'max' | 'step'>): boolean {
  if (!Number.isFinite(value) || value < scale.min - 1e-9 || value > scale.max + 1e-9) return false
  const step = scale.step > 0 ? scale.step : 1
  return isWhole((value - scale.min) / step)
}

/**
 * The part of a scale that decides the strip's TICKS — what a strip must be
 * re-mounted on when it changes (#1112). The strip sets its cursor once, on
 * mount (#870 c), so a step change under a live strip would leave the cursor on
 * an index of the old tick list. Anchors are not in it: a re-labelled anchor
 * changes no tick and needs no remount.
 */
export function scaleSignature(scale: Pick<MagnitudeScale, 'min' | 'max' | 'step'>): string {
  return `${scale.min}|${scale.max}|${scale.step}`
}

export interface AnchorPlacement {
  value: number
  /** `0 · not at all` — the value and its label, as the strip prints it. */
  text: string
  /** Left edge and width of the label's box, in percent of the strip's width. */
  left: number
  width: number
  align: 'left' | 'center' | 'right'
}

/**
 * Where each anchor label goes on the strip's single anchor line (#1113).
 *
 * The line used to print the labels at the two ENDS only, so a middle anchor
 * ("5 · somewhat") was declared, saved, read out on its tick — and never shown.
 * The line is one row high on purpose (`magnitude-coding.md` §11: the strip's
 * 84px budget at 640×360), so the anchors share it: each sits under its own
 * point, in a box that ends halfway to its neighbours, so no two labels can
 * overlap however long they are (the strip truncates and puts the full text in
 * the label's `title`).
 *
 * - With `tickCount` ticks (the strip's equal-width buttons), a value sits under
 *   the centre of its tick — `(stepsFromMin + 0.5) / tickCount`. With no ticks
 *   (the number-input arm), it sits proportionally along the range.
 * - An anchor AT the minimum is left-aligned from the strip's edge, one at the
 *   maximum right-aligned to the other edge — the two-anchor scale reads exactly
 *   as it always did. Any other anchor is centred on its point, in a box as wide
 *   as the nearer of its two neighbour boundaries allows.
 * - An anchor between points (the server accepts any value in range) sits where
 *   its value falls; the dialog says it cannot be picked.
 */
export function anchorLayout(scale: MagnitudeScale, tickCount: number): AnchorPlacement[] {
  const span = scale.max - scale.min
  if (!Number.isFinite(span) || span <= 0) return []
  const step = scale.step > 0 ? scale.step : 1
  const position = (v: number) => tickCount > 0
    ? ((v - scale.min) / step + 0.5) / tickCount
    : (v - scale.min) / span
  const anchors = scale.anchors
    .filter(a => Number.isFinite(a.value) && a.value >= scale.min - 1e-9 && a.value <= scale.max + 1e-9)
    .slice()
    .sort((a, b) => a.value - b.value)
  const at = anchors.map(a => Math.min(1, Math.max(0, position(a.value))))
  const last = anchors.length - 1
  return anchors.map((a, i) => {
    const lo = i === 0 ? 0 : (at[i - 1] + at[i]) / 2
    const hi = i === last ? 1 : (at[i] + at[i + 1]) / 2
    let left = lo
    let right = hi
    let align: AnchorPlacement['align']
    if (Math.abs(a.value - scale.min) < 1e-9) {
      align = 'left'
    } else if (Math.abs(a.value - scale.max) < 1e-9) {
      align = 'right'
    } else {
      const half = Math.max(0, Math.min(at[i] - lo, hi - at[i]))
      left = at[i] - half
      right = at[i] + half
      align = 'center'
    }
    return {
      value: a.value,
      text: `${formatMagnitude(a.value)} · ${a.label}`,
      left: left * 100,
      width: (right - left) * 100,
      align,
    }
  })
}

/** A scale's range for a sentence: `0–10`, `−1–1`. En dash, Unicode minus (#35 §10). */
export function scaleRange(scale: MagnitudeScale): string {
  return `${formatMagnitude(scale.min)}–${formatMagnitude(scale.max)}`
}

/**
 * Whether two codes' declared scales DIFFER for the purpose of moving ratings
 * from one onto the other (#869 b/c): a merge, a collapse, a link.
 *
 * "Differ" is a fact about the RANGE — min or max — because that is what decides
 * whether a rating fits. Step and anchors are presentation. One side declaring a
 * scale and the other not is also a difference: ratings crossing onto a scale-less
 * code are kept but cannot be shown until it declares one.
 */
export function scalesDiffer(a: MagnitudeScale | null | undefined, b: MagnitudeScale | null | undefined): boolean {
  if (!a && !b) return false
  if (!a || !b) return true
  return a.min !== b.min || a.max !== b.max
}

/**
 * The sentence a merge or reconcile surface shows when ratings will cross scales,
 * or null when nothing needs saying. `from` is the code whose ratings move,
 * `onto` the code they land on.
 */
export function describeScaleCrossing(
  from: { name: string; scale: MagnitudeScale | null | undefined },
  onto: { name: string; scale: MagnitudeScale | null | undefined },
): string | null {
  if (!scalesDiffer(from.scale, onto.scale)) return null
  if (from.scale && onto.scale) {
    return `“${from.name}” is rated ${scaleRange(from.scale)} and “${onto.name}” ${scaleRange(onto.scale)}. `
      + `Ratings inside ${scaleRange(onto.scale)} are re-read on that scale; `
      + `ratings outside it are not moved as ratings.`
  }
  if (from.scale && !onto.scale) {
    return `“${from.name}” has a rating scale (${scaleRange(from.scale)}) and “${onto.name}” has none. `
      + `Its ratings are kept but cannot be shown until “${onto.name}” declares a scale.`
  }
  return `“${onto.name}” has a rating scale (${scaleRange(onto.scale!)}) and “${from.name}” has none — `
    + `nothing on “${from.name}” is rated, so nothing crosses.`
}
