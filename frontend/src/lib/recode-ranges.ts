/**
 * Range bands, client side — #823(d), 2026-08-31.
 *
 * The MIRROR of `services/recode_ranges.py`, and deliberately not the authority.
 * The server decides what `value_numeric` holds; this exists so the Data view's
 * display lens and the rule editor's preview show the same answer the apply will
 * produce.
 *
 * 🔴 **Why a mirror is required rather than optional here.** `EditableCell`
 * resolves a cell through the active definition entirely client-side. Without a
 * band channel it would render a banded cell as unmapped plain text while the
 * server has written the band's code into `value_numeric` — the #578
 * display-vs-storage drift, on the one grid a researcher checks a recode
 * against.
 *
 * ⚠️ **What this mirror deliberately CANNOT do: the null set.** Deciding whether
 * a cell is missing needs `_is_na`'s prefix list and the column's declaration,
 * which is exactly the derivation #600 forbids the client from attempting. So
 * the caller applies its own exclude check first (as `EditableCell` already
 * does) and this answers only "which band, if any". A cell the server NULLs and
 * this bands is not a disagreement about bands — it is the caller skipping the
 * check that runs before them.
 */

/** One band. `lo`/`hi` are inclusive; either may be null for an open end. */
export interface RecodeRange {
  lo: number | null
  hi: number | null
  output: number | string
}

/**
 * The glyphs `_strip_numeric` removes, in its order and its set:
 * `$ € £ ¥ , %`. Removed ANYWHERE in the string, not just at the ends — so
 * `"1$2"` is 12 on both sides. That is odd, and it is the rule; a mirror that
 * "improved" on it would disagree with the number actually stored.
 */
const STRIPPED_GLYPHS = /[$€£¥,%]/g

/**
 * What Python's `float()` accepts, minus what it doesn't: a plain decimal
 * literal with an optional sign and exponent.
 *
 * ⚠️ **The gate exists to keep the client from being WIDER than the server.**
 * `Number()` accepts radix literals — `0x10` is 16, `0b101` is 5, `0o17` is 15 —
 * and `float()` rejects all three. Client-wider is the dangerous direction: the
 * grid would show a band the apply will never write.
 */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Parse a cell the way the backend's `_strip_numeric` does, so a `"$50,000"`
 * lands in the same band on both sides.
 *
 * 🔴 **#862 — this docstring used to make that claim while stripping commas and
 * nothing else, and `Number()` is not `float()`.** MEASURED across 39 inputs,
 * **16 disagreed**: every currency and percent cell (`"$50,000"` → 50000 on the
 * server, nothing on the client — on exactly the column types bands exist for),
 * every radix literal in the opposite direction, and `"1_000"`. The
 * cross-language fixture carried no glyph-bearing cell, so both suites passed.
 *
 * The rule, in the backend's order: strip the ends · remove the glyphs anywhere
 * · strip again · parse as a decimal literal.
 *
 * ⚠️ **`%` does NOT divide by 100.** `_strip_numeric("45%")` is 45, so a band of
 * 40–50 claims it. Surprising, deliberate, and the mirror's job is to agree.
 *
 * ⚠️ **Underscores between digits are removed, because `float()` accepts them**
 * (PEP 515) and `Number()` does not. The lookbehind/lookahead pair is what
 * matches Python's *"single underscores, between digits only"*: `"1_0"` → 10,
 * while `"1__0"`, `"_10"` and `"10_"` keep theirs and fail the grammar, exactly
 * as `float()` refuses them.
 *
 * 🔴 **THE ONE REMAINING DIVERGENCE, STATED RATHER THAN DISCOVERED LATER:
 * non-ASCII decimal digits.** `float()` accepts them (measured: `"٣٤"` → 34,
 * `"１２３"` → 123, `"۵"` → 5, via CPython's decimal-to-ASCII transform); this
 * does not, so such a cell renders as raw text while the server bands it. That
 * is the SAFE direction — under-claiming, not showing a code the apply will not
 * write — and closing it needs a Unicode `Nd`-block transform, which is more
 * cleverness than the case has earned.
 *
 * ⚠️ **`NFKC` normalisation is NOT the cheap fix for that, and was rejected on a
 * measurement:** it would newly accept `"²"` as 2 and `"５％"` as 5, both of
 * which `float()` refuses — i.e. it buys one narrow case by opening two in the
 * dangerous direction.
 */
export function parseCellNumber(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null
  const trimmed = String(text).trim()
  if (trimmed === '') return null
  const cleaned = trimmed.replace(STRIPPED_GLYPHS, '').trim()
  const withoutSeparators = cleaned.replace(/(?<=\d)_(?=\d)/g, '')
  if (!DECIMAL_LITERAL.test(withoutSeparators)) return null
  const n = Number(withoutSeparators)
  return Number.isFinite(n) ? n : null
}

/**
 * The band a cell falls in, or `undefined` when none does.
 *
 * `undefined` rather than `null` so a caller can distinguish "no band matched"
 * from a band whose output legitimately IS null-ish — and so it composes with
 * `mapping`'s lookup, which also yields `undefined` on a miss.
 *
 * Bounds are INCLUSIVE at both ends and the FIRST matching band wins, so a
 * narrow special case listed above a catch-all shadows it. Both rules mirror
 * `resolve_range_output`.
 */
export function resolveRangeOutput(
  valueText: string | null | undefined,
  ranges: RecodeRange[] | undefined | null,
): number | string | undefined {
  if (!ranges || ranges.length === 0) return undefined
  const n = parseCellNumber(valueText)
  if (n === null) return undefined
  for (const band of ranges) {
    if (band.lo !== null && band.lo !== undefined && n < band.lo) continue
    if (band.hi !== null && band.hi !== undefined && n > band.hi) continue
    return band.output
  }
  return undefined
}

/** Human wording for one band — used by the editor and by the cell tooltip. */
export function describeRange(band: RecodeRange): string {
  const { lo, hi } = band
  if (lo !== null && hi !== null) return lo === hi ? `${lo}` : `${lo} to ${hi}`
  if (lo !== null) return `${lo} and above`
  if (hi !== null) return `${hi} and below`
  return 'any value'
}

/**
 * Index pairs whose bands overlap — for DISCLOSURE, never refusal.
 *
 * Overlap is legal and sometimes deliberate, so the editor SAYS which row
 * shadows which rather than blocking the save.
 *
 * ⚠️ **The CLIENT owns this rule outright (#866).** There was a Python twin,
 * `recode_ranges.describe_overlaps`, with no production caller and nothing
 * binding it to this function — the server never refuses an overlap and never
 * reports one, because the disclosure is an AUTHORING concern. It was deleted
 * rather than pinned: an unconsumed mirror can only drift.
 */
export function rangeOverlaps(ranges: RecodeRange[]): [number, number][] {
  const pairs: [number, number][] = []
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const aLo = ranges[i].lo ?? -Infinity
      const aHi = ranges[i].hi ?? Infinity
      const bLo = ranges[j].lo ?? -Infinity
      const bHi = ranges[j].hi ?? Infinity
      if (aLo <= bHi && bLo <= aHi) pairs.push([i, j])
    }
  }
  return pairs
}

/** A row mid-edit: bounds stay strings so the inputs stay controlled. */
export interface RangeRow {
  lo: string
  hi: string
  output: string
}

export interface RangeValidation {
  ok: boolean
  msg: string
  ranges: RecodeRange[]
  badRow?: number
}

const isBlankRow = (r: RangeRow) =>
  r.lo.trim() === '' && r.hi.trim() === '' && r.output.trim() === ''

/**
 * One editor row's bounds, or `null` when the row cannot take part in a
 * comparison at all.
 *
 * 🔴 **ONE eligibility rule, and #863 is what two of them cost.** The editor
 * used to filter with *"at least one bound is finite"* and then hand the
 * survivors to `rangeOverlaps`, which compares with `lo ?? -Infinity` — and
 * `??` does **not** catch `NaN`, so a row like `{lo: "abc", hi: "40"}` passed
 * the filter and then compared false against everything. Two rules for one
 * question, disagreeing silently.
 *
 * A row takes part iff **at least one bound is written AND every bound that is
 * written parses to a finite number.** A half-typed `"abc"` is not an open end:
 * treating it as one would invent a band the researcher never wrote and flag an
 * overlap against it.
 */
function rowBounds(row: RangeRow): RecodeRange | null {
  const parse = (raw: string): number | null | undefined => {
    const t = raw.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  const lo = parse(row.lo)
  const hi = parse(row.hi)
  if (lo === undefined || hi === undefined) return null
  if (lo === null && hi === null) return null
  return { lo, hi, output: row.output }
}

/**
 * Which EDITOR ROWS overlap — as indices into `rows`, not into some subset.
 *
 * 🔴 **#863: the notice named the wrong rows, and named blank ones.** The editor
 * filtered incomplete rows out and then printed `rangeOverlaps`' indices as row
 * numbers — but those index the FILTERED list, so every skipped row above a pair
 * shifted the answer down. Reproduced live: rows `[blank, 18–29, 25–40]`
 * reported *"Range 1 and range 2 overlap"*, naming an empty row and neither of
 * the two that actually did.
 *
 * ⚠️ **The index mapping lives here, once, next to the eligibility rule** —
 * putting it back at the call site is what made a pure, correct function give a
 * wrong answer. `rangeOverlaps` stays exactly as it was: the pure pair-wise
 * comparison, which the client owns outright (#866).
 *
 * ⚠️ Deliberately **not** memoised. It is O(n²) over a list capped at
 * `MAX_RECODE_RANGES` (50), i.e. ≤1,225 numeric comparisons on the extreme
 * input, against a `useMemo` whose dependency array is one more thing to get
 * wrong on a component that re-renders per keystroke anyway.
 */
export function rowOverlaps(rows: RangeRow[]): [number, number][] {
  const eligible: { band: RecodeRange; index: number }[] = []
  rows.forEach((row, index) => {
    const band = rowBounds(row)
    if (band) eligible.push({ band, index })
  })
  return rangeOverlaps(eligible.map(e => e.band)).map(
    ([a, b]) => [eligible[a].index, eligible[b].index] as [number, number],
  )
}

/**
 * How the editor names one row: its ordinal, plus its bounds when it has any.
 *
 * ⚠️ **The ordinal is the half that always works.** `describeRange` alone gives
 * two identical bands two identical names — the *"N buttons called Remove"*
 * problem (#785) this file's own docstring claims to avoid — and gives a blank
 * row the actively wrong *"any value"*, which is what an unbounded band means.
 * The ordinal also matches what the inputs are called (`Range 3 from`), so a
 * reader hears one identifier for one row.
 */
export function describeRow(rows: RangeRow[], index: number): string {
  const band = rowBounds(rows[index])
  return band ? `range ${index + 1} (${describeRange(band)})` : `range ${index + 1}`
}

/**
 * Validate the rows and build the wire payload — the mirror of
 * `normalize_ranges`, with the SAME refusals in the same order so a researcher
 * meets the message here rather than as a 400.
 *
 * `numericOutput` is true for a scale map, whose bands must produce numbers.
 * ⚠️ Blank rows are skipped rather than refused: a trailing empty row is how an
 * editor looks mid-edit, not an error to explain.
 */
export function buildRangePayload(
  rows: RangeRow[],
  numericOutput: boolean,
): RangeValidation {
  const ranges: RecodeRange[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (isBlankRow(r)) continue
    const loRaw = r.lo.trim()
    const hiRaw = r.hi.trim()
    const lo = loRaw === '' ? null : Number(loRaw)
    const hi = hiRaw === '' ? null : Number(hiRaw)
    if (lo === null && hi === null) {
      return { ok: false, msg: 'A range needs a low or a high value.', ranges: [], badRow: i }
    }
    if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) {
      return { ok: false, msg: 'Range bounds must be numbers.', ranges: [], badRow: i }
    }
    if (lo !== null && hi !== null && lo > hi) {
      return { ok: false, msg: `Range ${lo} to ${hi} is backwards.`, ranges: [], badRow: i }
    }
    const output = r.output.trim()
    if (output === '') {
      return { ok: false, msg: 'Every range needs a value to map to.', ranges: [], badRow: i }
    }
    if (numericOutput && !Number.isFinite(Number(output))) {
      return {
        ok: false,
        msg: `A scale map's ranges must map to numbers — "${output}" is text.`,
        ranges: [],
        badRow: i,
      }
    }
    ranges.push({ lo, hi, output: numericOutput ? Number(output) : output })
  }
  return { ok: true, msg: '', ranges }
}

/** Seed editor rows from a stored band list. */
export function rangesToRows(ranges: RecodeRange[] | undefined | null): RangeRow[] {
  if (!ranges) return []
  return ranges.map(r => ({
    lo: r.lo === null || r.lo === undefined ? '' : String(r.lo),
    hi: r.hi === null || r.hi === undefined ? '' : String(r.hi),
    output: String(r.output),
  }))
}
