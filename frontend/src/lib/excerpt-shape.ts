/**
 * The excerpt SHAPE decision, single-sourced (slab 5b, plan §8j.0.2).
 *
 * An excerpt has exactly three shapes, enforced by the backend's
 * `ck_excerpt_one_shape` XOR + `ck_excerpt_times_both_or_neither`:
 *
 *   whole       — all four range columns NULL. "This whole segment/clip."
 *   char-range  — start_offset/end_offset set. Conversation + document only.
 *   time-range  — start_time/end_time set, in ABSOLUTE timeline seconds.
 *                 Observation clips only (slab 5a, D29).
 *
 * ⚠️ WHY THIS MODULE EXISTS. Before slab 5a, `start_offset === null` *meant*
 * "whole-segment quote" — there was no other shape it could match. The moment
 * `start_time` shipped, that predicate began matching TWO shapes, and every
 * inline copy of it silently became a bug: the workbench's quote map reported
 * a sub-clip quote as the whole-clip one, and its unquote path would
 * find-and-DELETE a time excerpt believing it was the whole quote (and `.find`
 * takes the FIRST match, so with both shapes present *which* one died depended
 * on list order). Never re-inline the check — import from here.
 *
 * The two consumer classes are deliberately different, mirroring the backend's
 * `whole_segment_excerpt_filter` / `segment_has_any_quote_filter` split (D32):
 *
 *   shape-EXACT   (`isWholeExcerpt`)  — toggle state, unquote deletes, dup
 *                                       guards. "Is THE whole-segment quote."
 *   shape-AGNOSTIC (`isQuoteExcerpt`) — row indicators, delete gates, display
 *                                       flags. "Is this quoted at all?"
 *
 * Note `isQuoteExcerpt` deliberately EXCLUDES the char shape, matching the
 * backend predicate: a char-range excerpt is a sub-quote of a text segment and
 * has never driven the "this segment is quoted" indicator.
 */

import type { ExcerptCreatePayload } from '@/lib/api/excerpts'

/** The range columns any shape check needs. Structural so both
 * `ExcerptResponse` and `QuotedExcerptItem` satisfy it without a cast. */
export interface ExcerptShapeFields {
  start_offset: number | null
  end_offset?: number | null
  /**
   * Optional so a payload with NO time columns satisfies this structurally
   * (#785). `SegmentExcerptInfo` — the conversation/document row's excerpt
   * shape — carries `start_offset`/`end_offset` and nothing else, because the
   * router refuses the time shape on a non-observation parent, so a text
   * segment's excerpt can only ever be whole or char-range.
   *
   * ⚠️ Making it required forced those call sites to re-inline a bare
   * `start_offset === null`, which is exactly what this module exists to stop.
   * The loose `== null` below already treats a MISSING field as null, so the
   * runtime answer was correct all along — only the type disagreed.
   */
  start_time?: number | null
  end_time?: number | null
}

// All three use loose `== null` deliberately, on two grounds. It treats a
// MISSING field the same as an explicit null, so a payload that predates the
// time columns reads as the whole shape rather than silently as neither. And it
// is the only safe presence test here: `start_time` of 0 is a legitimate quote
// at the very start of the timeline, so any falsy check (`!e.start_time`) would
// misclassify it — the falsy-zero trap this codebase has been bitten by before.

/** Shape-EXACT: the whole-segment/whole-clip quote. Drives the `s` toggle's
 * state and — load-bearing — which excerpt an unquote DELETES. */
export function isWholeExcerpt(e: ExcerptShapeFields): boolean {
  return e.start_offset == null && e.start_time == null
}

/** A sub-clip time-range quote on an observation clip. */
export function isTimeExcerpt(e: ExcerptShapeFields): boolean {
  return e.start_time != null
}

/** A character-range quote inside a conversation/document segment's text. */
export function isCharExcerpt(e: ExcerptShapeFields): boolean {
  return e.start_offset != null
}

/** Shape-AGNOSTIC: "is this segment quoted?" in the researcher's sense —
 * whole OR time-range. The display/gate counterpart of `isWholeExcerpt`, and
 * the mirror of the backend's `segment_has_any_quote_filter`. */
export function isQuoteExcerpt(e: ExcerptShapeFields): boolean {
  return isWholeExcerpt(e) || isTimeExcerpt(e)
}

/**
 * The payload that re-creates an excerpt exactly as it was — the "undo a
 * delete" rule, single-sourced (slab 5b).
 *
 * It restores the SHAPE, not just the target. QuoteBoard's unquote-undo used to
 * copy the char offsets only, keyed on the char-only `is_sub_segment` flag, so
 * undoing a sub-clip quote posted a bare `{segment_id}` and re-created it as a
 * WHOLE-clip quote: the researcher's marked range was gone, through an "Undo"
 * they had every reason to trust. Shape is read from the range columns rather
 * than that flag, so a new shape can never fall silently into the whole branch.
 */
export function excerptRestorePayload(
  e: ExcerptShapeFields & { segment_id: number | null; dataset_value_id: number | null },
): ExcerptCreatePayload {
  if (e.segment_id != null) {
    if (isCharExcerpt(e)) {
      return { segment_id: e.segment_id, start_offset: e.start_offset, end_offset: e.end_offset ?? null }
    }
    if (isTimeExcerpt(e)) {
      return { segment_id: e.segment_id, start_time: e.start_time, end_time: e.end_time ?? null }
    }
    return { segment_id: e.segment_id }
  }
  if (e.dataset_value_id != null) return { dataset_value_id: e.dataset_value_id }
  return {}
}

/** True when `range` sits inside `clip` — the D30 attach rule's test.
 *
 * CLOSED interval on both ends, deliberately: it mirrors the backend's
 * containment check (`excerpts.py::_segment_excerpt_shape_error`), which is
 * what actually accepts or 400s the create. This is NOT the half-open rule
 * `playback-utils::findClipsAtTime` uses for "which clip is playing" — a point
 * quote at exactly `clip.end_time` is legally CONTAINED by the clip while not
 * being AT it. Two different questions; don't collapse them.
 */
export function clipContainsRange(
  clip: { start_time: number; end_time: number },
  range: { start: number; end: number },
): boolean {
  return range.start >= clip.start_time && range.end <= clip.end_time
}
