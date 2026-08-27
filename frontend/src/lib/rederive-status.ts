/**
 * #584 step 2 — the re-derive plan's status vocabulary, and what may be acted on.
 *
 * Mirrors `services/recode_rederive.py`'s `STATUS_*`. Split out of the dialog
 * because a predicate that decides whether a control may WRITE stored numbers is
 * not a rendering detail — the same reason `excerpt-shape.ts` and
 * `bulk-code-result.ts` live here rather than in their consumers.
 *
 * ⚠️ **`blocked` is a refusal, not a warning.** A blocked dependent shares no
 * mapping values with the source (the label-remapped crosswalk copy), so copying
 * onto it would write keys no cell carries and silently NULL the column on the
 * next apply. The server 409s a batch containing one, so the UI must not offer it.
 */

export const STATUS_READY = 'ready'
export const STATUS_NO_CHANGE = 'no_change'
export const STATUS_BLOCKED = 'blocked'

/**
 * Only a `ready` row may be selected.
 *
 * ⚠️ Written as an allow-list on purpose: a status added to the backend later
 * defaults to NOT selectable, which is the safe direction. A deny-list
 * (`!== blocked`) would make every future status silently eligible for a write
 * that changes numbers a researcher may already have reported.
 */
export function isSelectable(item: { status: string }): boolean {
  return item.status === STATUS_READY
}
