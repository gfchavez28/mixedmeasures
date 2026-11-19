/**
 * #1324 — char-range quotes may OVERLAP and NEST (decided 2026-10-31), so a passage is
 * drawn as RUNS, not as one element per quote.
 *
 * ## The defect this replaces
 *
 * `SegmentRow`'s renderer walked the quotes in start order, emitted each quote's words
 * and set `lastEnd = end`. For a nested quote that moves `lastEnd` BACKWARDS, so the
 * shared words were drawn twice (a 47-character turn rendered 55 characters with two
 * crossing quotes, 84 with a nested pair). `lib/text-offsets.ts::charOffsetInElement`
 * reads the rendered `textContent`, so every later selection in that turn resolved to
 * other words — or past the end, a 400 — and the row's accessible name
 * (`role="option"` is name-from-content) read the passage twice.
 *
 * ## The shape: a boundary sweep
 *
 * Every quote's start and end is a CUT. Between two adjacent cuts the set of quotes
 * covering the text is constant, so each run is drawn ONCE with that set. The runs
 * tile `[0, codePointLength(text))` exactly, which is what makes "each character
 * once" true by construction rather than by care.
 *
 * - Offsets are CODE POINTS (#687) — the caller slices with `sliceByCodePoints`.
 * - A quote outside the text (past damage, #1319's out-of-scope rows) is CLAMPED, and
 *   one that clamps to nothing is dropped: it can draw no words, and an empty `<mark>`
 *   is a highlight with nothing in it.
 * - `quoteIds` is OUTERMOST first (longest span, then earliest start, then id) — the
 *   order a reader of the run's tooltip meets the quotes in.
 */
import { codePointLength, sliceByCodePoints } from './text-offsets'

export interface CharQuoteLike {
  id: number
  start_offset: number | null
  end_offset: number | null
}

export interface QuoteRun {
  /** Code-point offsets into the segment text, `[start, end)`. */
  start: number
  end: number
  /** The quotes covering every character of this run, outermost first. Empty = unquoted. */
  quoteIds: number[]
}

export function quoteRuns(text: string, quotes: readonly CharQuoteLike[]): QuoteRun[] {
  const length = codePointLength(text)
  if (length === 0) return []

  const spans: { id: number; s: number; e: number }[] = []
  for (const q of quotes) {
    if (q.start_offset == null || q.end_offset == null) continue
    const s = Math.max(0, q.start_offset)
    const e = Math.min(length, q.end_offset)
    if (e > s) spans.push({ id: q.id, s, e })
  }
  spans.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.s - b.s || a.id - b.id)

  const cuts = [...new Set([0, length, ...spans.flatMap(sp => [sp.s, sp.e])])].sort((a, b) => a - b)
  const runs: QuoteRun[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i]
    const end = cuts[i + 1]
    runs.push({
      start,
      end,
      quoteIds: spans.filter(sp => sp.s <= start && end <= sp.e).map(sp => sp.id),
    })
  }
  return runs
}

/**
 * The highlight for a run, by how many quotes cover it — THE one place the overlap's
 * look is decided (#1324 D24). One quote keeps the pre-#1324 amber exactly; two or
 * more take one step deeper. Deliberately capped at two steps: a third tint step is not
 * separable by eye from the second, and depth is also stated in the run's tooltip.
 *
 * ⚠️ Text keeps `text-inherit`, as before — the tint is a background under body text,
 * so a deeper step must stay light enough in light mode and dark enough in dark mode
 * for body text; re-drive both themes (jsdom paints nothing). Measured 2026-11-01d:
 * the dark deeper step is 4.56:1 at its lowest (a SELECTED interviewer row, whose text
 * is dimmed) — a pass with a thin margin; the light tints are opaque, so no row state
 * moves them (5.75:1). `excerpt-shapes.md` §5 has the states and the rejected value.
 */
export function quoteRunClass(depth: number): string {
  return depth >= 2
    ? 'bg-amber-200 dark:bg-amber-800/60 text-inherit border-b-2 border-amber-600 dark:border-amber-400 cursor-default'
    : 'bg-amber-100 dark:bg-amber-900/30 text-inherit border-b-2 border-amber-400 dark:border-amber-600 cursor-default'
}

/**
 * The order the row menu lists quotes in (#1324 D25): passage order, and at a shared
 * start the OUTER quote first. A whole-segment quote covers the whole turn, so it comes
 * before every char-range one.
 *
 * ONE comparator for both of the menu's quote lists, so *Remove Excerpt* and *Add Note
 * to Excerpt* name the same quotes in the same order — the prototype sorted only the
 * first, and the second kept the server's order (found at the build's pickup).
 */
export function compareQuotesInPassageOrder(a: CharQuoteLike, b: CharQuoteLike): number {
  const aStart = a.start_offset ?? -1
  const bStart = b.start_offset ?? -1
  if (aStart !== bStart) return aStart - bStart
  return (b.end_offset ?? 0) - (a.end_offset ?? 0)
}

/**
 * How a quote is named in a menu or tooltip — by its words, head and tail.
 *
 * #1324: nested quotes routinely share a START ("We rolled it out…" and "We rolled it
 * out in March and nobody…"), so the old first-30-units label named two different
 * quotes identically in the row's "Remove Excerpt" menu. Head + tail tells them apart
 * whenever their words differ. It also slices by CODE POINTS — the old `.slice(0, 30)`
 * cut UTF-16 units and could split an emoji's surrogate pair.
 *
 * Each half is cut at a WORD boundary when it holds one (found by driving the build:
 * "what would be…l expectations" and "…fic integrity?" are fragments a reader has to
 * decode). Only the CUT side moves — the head keeps its first word and the tail its
 * last, which are what tell two quotes apart. A half with no space in it (one long
 * word, or a script written without spaces) keeps its code-point cut.
 *
 * `max` is the label's length in code points (the row's menus: 30; a whole quote's name,
 * `wholeQuoteLabel`: 60).
 */
export const QUOTE_LABEL_MAX = 30

export function quoteLabel(text: string, start: number, end: number, max: number = QUOTE_LABEL_MAX): string {
  const words = sliceByCodePoints(text, start, end)
  const n = codePointLength(words)
  if (n <= max) return words
  const half = Math.floor((max - 1) / 2)

  let head = sliceByCodePoints(words, 0, half)
  if (!/\s/u.test(sliceByCodePoints(words, half, half + 1))) {
    const whole = head.replace(/\s+\S*$/u, '')
    if (whole.trim()) head = whole
  }
  let tail = sliceByCodePoints(words, n - half, n)
  if (!/\s/u.test(sliceByCodePoints(words, n - half - 1, n - half))) {
    const whole = tail.replace(/^\S*\s+/u, '')
    if (whole.trim()) tail = whole
  }
  return `${head.trimEnd()}…${tail.trimStart()}`
}

/**
 * A WHOLE quote's name in a control — the joint display's pins and the pin picker's *Pin*
 * (#1714, D397–D398). The quote's text with its whitespace collapsed (a passage's paragraphs
 * read as one line in a name), named by `quoteLabel`'s head…tail: code points, cut at a word,
 * so two quotes sharing their first words still get different names. Empty text gives ''
 * (the caller says "this quote").
 *
 * ⚠️ The review (D398) asked for a new `lib/quote-label.ts::shortQuote`, on the premise that no
 * shared helper existed; this module's `quoteLabel` is that helper, so a second one was not made.
 */
export const WHOLE_QUOTE_LABEL_MAX = 60

export function wholeQuoteLabel(text: string, max: number = WHOLE_QUOTE_LABEL_MAX): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return quoteLabel(flat, 0, codePointLength(flat), max)
}
