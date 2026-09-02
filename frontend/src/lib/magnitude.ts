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

export function isTickable(scale: MagnitudeScale): boolean {
  const span = scale.max - scale.min
  if (!Number.isFinite(span) || span <= 0) return false
  const step = scale.step > 0 ? scale.step : 1
  return Math.round(span / step) + 1 <= MAX_TICKS
}

export function tickValues(scale: MagnitudeScale): number[] {
  if (!isTickable(scale)) return []
  const step = scale.step > 0 ? scale.step : 1
  const out: number[] = []
  const count = Math.round((scale.max - scale.min) / step)
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
