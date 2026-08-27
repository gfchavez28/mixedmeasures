/**
 * Which grouping variables a comparison can actually use (#827).
 *
 * 🔴 **The offer used to be unconditional, and the entry's proposed gate would
 * have been the wrong one.** #827 attributed the cross-dataset failure to
 * participant links being one-row-one-person, and concluded that the gate is
 * *"are these two datasets linked?"*. **Verified by execution on 2026-08-25:
 * with 12 of 12 rows linked one-to-one, a cross-dataset comparison still
 * returns no groups.** `services/comparisons.py::_load_grouping_map` reads the
 * grouping column's values on the ROW IDS the analysis is built from, and never
 * consults `participant_id` — so linking changes nothing here.
 *
 * What decides it is whether the grouping column's dataset appears among the
 * rows the analysis is built from. That is not the same as "same dataset as the
 * variable", either: **a cross-dataset variable GROUP has row scores in both of
 * its datasets, so grouping it by a column in either one works** — also
 * verified, groups came back with n=3 per side. So the predicate is over the
 * SET of analysed datasets, and both narrower forms would refuse a case that
 * works.
 *
 * ⚠️ **A blocked option stays VISIBLE and disabled, carrying its reason.** That
 * is this codebase's rule for a control blocked by the absence of a data shape
 * (the `Code Text` decision, 2026-08-24; the identifier-guard precedent in
 * `dataset-semantics.md`): hiding it removes the only surface where the
 * researcher could discover the capability and why it does not apply.
 */

export interface ScopeColumn {
  id: number
  dataset_id: number
  domain_ids: number[]
}

export interface ScopeSelection {
  columnIds: number[]
  domainIds: number[]
}

/**
 * The datasets whose rows the analysis will actually be built from.
 *
 * A selected COLUMN contributes its own dataset. A selected variable GROUP
 * contributes every dataset holding one of its member columns, because its
 * per-row scores are written against all of them.
 *
 * An empty set means "nothing selected yet" — the caller must then gate
 * nothing, since every grouping column is still potentially valid.
 */
export function analysedDatasetIds(
  selection: ScopeSelection,
  columns: ScopeColumn[],
): Set<number> {
  const out = new Set<number>()
  const wanted = new Set(selection.columnIds)
  const domains = new Set(selection.domainIds)
  for (const col of columns) {
    if (wanted.has(col.id)) out.add(col.dataset_id)
    else if (col.domain_ids.some(d => domains.has(d))) out.add(col.dataset_id)
  }
  return out
}

/**
 * Why this grouping column cannot group the current selection, or `null` when
 * it can (including when nothing is selected yet).
 */
export function groupingScopeBlock(
  groupingDatasetId: number,
  analysed: Set<number>,
): 'other_dataset' | null {
  if (analysed.size === 0) return null
  return analysed.has(groupingDatasetId) ? null : 'other_dataset'
}

/** The sentence a blocked option carries, so the disabling is never mute. */
export const OTHER_DATASET_NOTE = 'needs a variable from this dataset'
