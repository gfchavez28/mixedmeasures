/**
 * Coding-progress predicate — single client-side definition of "a segment is coded"
 * (invariant J-A, #398). A segment counts as coded iff it has at least one
 * NON-universal code applied; a segment whose only codes are universal markers
 * ("Unclear" / "Unsubstantive/Artifact") is NOT coded — matching the backend
 * `coded_segment_count` and every other surface.
 *
 * The document coding workbench previously counted any-code (`codes.length > 0`),
 * which disagreed with the backend (e.g. a document showing 4/14 coded in the
 * workbench but 2/14 everywhere else). Route every client-side "is this coded?"
 * derivation (gauge count, progress gradient, jump-to-uncoded) through this.
 */
import { isCoderVisible } from './coder-color'

export interface CodeLike {
  is_universal: boolean
}

export function isSegmentCoded(codes: readonly CodeLike[]): boolean {
  return codes.some(c => !c.is_universal)
}

// ── Coder-aware coverage (Track J · J1, item 3c) ────────────────────────────
// A per-application detail carries the applying coder (or null for legacy/
// unattributed). All coverage math below is single-sourced here so the gauges,
// the per-coder breakdown, the bar gradient, and jump-to-uncoded can never drift.

export interface CodeDetailLike {
  is_universal: boolean
  user_id: number | null
}

/**
 * Coded by at least one VISIBLE coder (filter-aware). Universal-only = not coded
 * (matches `isSegmentCoded`). Your own + unattributed applications are always
 * visible (see `isCoderVisible`), so hiding a colleague reveals segments only
 * they coded as uncoded-for-you — which is exactly what `j` should jump to.
 */
export function isSegmentCodedVisible(details: readonly CodeDetailLike[], hidden?: Set<number>): boolean {
  return details.some(d => !d.is_universal && isCoderVisible(d.user_id, hidden))
}

export interface Coverage {
  /** denominator — number of items considered (e.g. participant segments). */
  total: number
  /** coded by anyone (all-coder total; filter-independent). */
  codedAny: number
  /** coded by a visible coder (reflects the active per-coder filter). */
  codedVisible: number
}

export function computeCoverage<T>(
  items: readonly T[],
  getDetails: (item: T) => readonly CodeDetailLike[],
  hidden?: Set<number>,
): Coverage {
  let codedAny = 0
  let codedVisible = 0
  for (const item of items) {
    const details = getDetails(item)
    if (details.some(d => !d.is_universal)) codedAny++
    if (isSegmentCodedVisible(details, hidden)) codedVisible++
  }
  return { total: items.length, codedAny, codedVisible }
}

// ── Per-(code, coder) chip rendering + active-coder membership (#441 / #446) ──
// The new CodeApplication grain ((target, code, coder)) means the bare
// applied_codes/applied_code_ids arrays carry one entry PER coder, not per code.
// These helpers are the single source for rendering and membership so renderers
// stop keying by code_id (duplicate React keys + last-write-wins attribution) and
// toggles stop treating any-coder presence as the active coder's.

export interface AppliedCodeDetailLike {
  code_id: number
  user_id: number | null
  /**
   * #35 — this coder's rating, or null for UNRATED.
   *
   * 🔴 REQUIRED, not optional, since #868 (a). It was optional "so every
   * existing caller and fixture keeps compiling", and that is exactly how the
   * document workbench came to project `{ code_id, user_id }` from a payload
   * that carried no rating: the projection compiled, `InlineCodeActions` took
   * the details-known branch, and every scaled-code chip on a document
   * announced "not rated" over a rating it could not see. A required field
   * turns that projection into a compile error. ⚠️ NEVER default it to 0 — that
   * is a legal rating on any scale whose range includes it.
   */
  magnitude: number | null
  /** #35 — the rating a merged copy carried when it differed; null = no conflict. */
  magnitude_conflict: number | null
}

/**
 * The IDENTITY half of a detail — what a consumer that only asks "which code,
 * which coder?" needs. `distinctVisibleCodeIds`, `isCodeAppliedByActiveCoder`
 * and the timed analytics read nothing else, so they accept this rather than
 * the full detail: a caller with bare ids can build one honestly, while the
 * chip-row chokepoint (`visibleCodeChipRows`), which RENDERS the rating, keeps
 * demanding the full shape so a projection cannot fabricate "not rated".
 */
export type CodeApplicationIdentity = Pick<AppliedCodeDetailLike, 'code_id' | 'user_id'>

export interface CodeChipRow {
  /** Unique render key — (code, coder); array index disambiguates null appliers. */
  key: string
  codeId: number
  userId: number | null
  /**
   * #35 — carried HERE rather than looked up by each renderer.
   *
   * A chip row is already the (code, coder) pair, which is exactly the grain a
   * rating lives at, so a renderer that reached back into `applied_code_details`
   * to find "the magnitude for this code" would have to re-solve the per-coder
   * join this chokepoint exists to solve — the #441 class, one field over.
   */
  magnitude: number | null
  /**
   * #35 — the merge disagreement flag, carried by the same chokepoint for the
   * same reason: it is a fact about ONE (code, coder) application.
   */
  magnitudeConflict: number | null
}

/**
 * One render row per VISIBLE application detail, keyed uniquely on (code, coder)
 * — the INV-3 chokepoint (#441). A code applied by N coders yields N rows (one
 * attribution badge each), never N duplicate `code_id` keys collapsing to the
 * last coder. Pass `hidden` to apply the per-coder visibility lens.
 */
export function visibleCodeChipRows(
  details: readonly AppliedCodeDetailLike[],
  hidden?: Set<number>,
): CodeChipRow[] {
  const rows: CodeChipRow[] = []
  details.forEach((d, i) => {
    if (!isCoderVisible(d.user_id, hidden)) return
    rows.push({
      key: `${d.code_id}-${d.user_id ?? `na${i}`}`,
      codeId: d.code_id,
      userId: d.user_id,
      // `?? null` normalises a missing field to the unrated sentinel WITHOUT
      // touching a real 0 — `||` here would erase every zero rating.
      magnitude: d.magnitude ?? null,
      magnitudeConflict: d.magnitude_conflict ?? null,
    })
  })
  return rows
}

/**
 * Distinct visible code ids — for read-only chip lists / counts that do NOT show
 * attribution (one entry per code regardless of how many coders applied it).
 * Omit `hidden` to count across all coders (e.g. a data-loss warning).
 */
export function distinctVisibleCodeIds(
  details: readonly CodeApplicationIdentity[],
  hidden?: Set<number>,
): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const d of details) {
    if (!isCoderVisible(d.user_id, hidden)) continue
    if (seen.has(d.code_id)) continue
    seen.add(d.code_id)
    out.push(d.code_id)
  }
  return out
}

/**
 * Active-coder membership for the apply/remove toggle (INV-6 / #446): "did the
 * acting coder apply this code?", NOT "did anyone?". Falls back to any-coder
 * presence when details or the active coder are unavailable (single-coder /
 * legacy payloads) — there any-coder == my-coder, so behavior is unchanged.
 */
export function isCodeAppliedByActiveCoder(
  details: readonly CodeApplicationIdentity[] | undefined,
  appliedCodeIds: readonly number[],
  codeId: number,
  activeCoderId: number | null,
): boolean {
  if (details && activeCoderId != null) {
    return details.some(d => d.code_id === codeId && d.user_id === activeCoderId)
  }
  return appliedCodeIds.includes(codeId)
}
