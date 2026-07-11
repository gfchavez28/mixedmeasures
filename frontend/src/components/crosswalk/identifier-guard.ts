/**
 * #556b — identifier columns can't join a variable group / equivalence row.
 *
 * THE single place that rejection is expressed, so it can't be mouse-only: the
 * drag gestures (`useCrosswalkDnD`) and the keyboard / accessibility fallback
 * (`BulkAssignPickerDialog` via `CrosswalkView`) both route here. A guard that
 * lived only in the drag handler would leave the dialog path — the one keyboard
 * users are pushed toward — silently producing the broken state it prevents
 * (an identifier-only group whose Σ scale score 400s to a "failed" badge, or an
 * identifier quietly contributing NULL to a numeric group's mean).
 *
 * Rejection, NOT concealment: identifier columns stay visible and draggable in
 * the Unassigned panel (see `CROSSWALK_INELIGIBLE_TYPES`) — hiding them would
 * remove the only surface where a mis-typed identity column is discoverable.
 * The gesture is what gets refused, and the toast says why and what to do.
 */
import { toast } from 'sonner'

import { CROSSWALK_INELIGIBLE_TYPES } from '@/lib/dataset-constants'

/** Minimal shape — anything with a type and a human label (ProjectColumnInfo fits). */
export interface GuardableColumn {
  id: number
  column_type: string
  column_code?: string | null
  column_text?: string
}

/** Columns among `ids` that may not be assigned to a variable group. */
export function ineligibleColumns(
  ids: number[],
  columnsById: Map<number, GuardableColumn>,
): GuardableColumn[] {
  const out: GuardableColumn[] = []
  for (const id of ids) {
    const col = columnsById.get(id)
    if (col && CROSSWALK_INELIGIBLE_TYPES.includes(col.column_type)) out.push(col)
  }
  return out
}

function label(col: GuardableColumn): string {
  return col.column_code || col.column_text || `Column ${col.id}`
}

/**
 * Reject the assignment if any column is ineligible. Returns true when it did
 * (caller must bail); false when the gesture is clear to proceed.
 */
export function rejectIneligibleAssignment(
  ids: number[],
  columnsById: Map<number, GuardableColumn>,
  onFlash?: (columnId: number) => void,
): boolean {
  const bad = ineligibleColumns(ids, columnsById)
  if (bad.length === 0) return false

  onFlash?.(bad[0].id)

  const isIdentifier = bad.some((c) => c.column_type === 'identifier')
  const why = isIdentifier
    ? 'Identifier columns hold row identity (they link rows to participants), not measurements — a group containing one can\'t compute a scale score. Change its column type in Dataset View if that\'s wrong.'
    : 'Skipped columns are excluded from analysis. Change the column type in Dataset View to use it.'

  // The gesture is refused ATOMICALLY (matching every other multi-select
  // pre-block here), so a partial rejection has to SAY that nothing moved —
  // otherwise the user reasonably assumes the eligible columns went through.
  const isPartial = bad.length < ids.length
  const message = isPartial
    ? `${bad.length} of ${ids.length} selected columns can't join a variable group.`
    : bad.length === 1
      ? `${label(bad[0])} can't join a variable group.`
      : `These ${bad.length} columns can't join a variable group.`
  const description = isPartial
    ? `${label(bad[0])}${bad.length > 1 ? ` and ${bad.length - 1} more` : ''} — nothing was moved. ${why}`
    : why

  // LIVE-FOUND (Batch 4): this toast deliberately does NOT pass a fixed `id`.
  // It originally reused one (to keep rapid repeat-drags from stacking), and the
  // live pass caught the cost: after a first rejection had come and gone, the
  // NEXT rejection in the same session rendered nothing — sonner swallowed the
  // repeat as an update to the retired toast. The refusal went completely
  // silent, which is strictly worse than the state the guard exists to prevent:
  // the user drags, nothing happens, and nothing says why. A guard whose only
  // job is to EXPLAIN must never be silent, so each rejection gets its own
  // toast (sonner caps visible toasts anyway, and a drag is one gesture).
  toast.error(message, { description })
  return true
}
