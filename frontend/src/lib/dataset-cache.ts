import type { QueryClient } from '@tanstack/react-query'

/**
 * #608 — single source for invalidating every reader of a column's DICTIONARY
 * (value labels, declared missing rules, scale metadata, the primary recode)
 * after it changes. Sibling of `coding-cache.ts::invalidateDerivedCounts`, for
 * the same reason (#450): the ValueLabelsDialog hand-listed its keys and the
 * list rotted — one key (`['data-quality']`) matched nothing, three live
 * families were missing, and the dialog cached the SAME frequencies endpoint
 * under a different key than the Recode Workbench.
 *
 * Keys are PREFIX-matched (TanStack partial match), so the bare
 * `[key, projectId]` covers every param variant (`['dq-summary', pid,
 * columnIds, includeNA, …]`, `['correlation-matrix', pid, …]`, …). The
 * analysis readers are INACTIVE while the dialog is open (their screens are
 * unmounted), so invalidating marks them stale at ZERO network cost and they
 * refetch on screen-open — do NOT micro-optimize this list per mutation arm
 * (labels-only vs missing-only); the blanket set is the cheap, safe shape.
 *
 * A declaration changes which cells feed EVERY statistic, and a label apply
 * rewrites `value_text` + the primary scale_map — hence the breadth:
 *  - the grid + column metadata (`dataset-data`, `dataset-columns`,
 *    `project-columns`, `analysis-columns` — the labels arm can change the
 *    column TYPE)
 *  - the recode workbench (`column-frequencies` — is_na flags AND label text —
 *    and `recode-definitions` — applyValueLabels writes the primary)
 *  - dataset analysis (`metrics`, `domain-scores`, `group-comparison`,
 *    `analysis-cross-tab`, `correlation-matrix`, `scatter-matrix`,
 *    `statistical-tests`)
 *  - data quality (`dq-summary` / `dq-patterns` — the REAL keys; the old
 *    hand-list invalidated a `['data-quality']` key with zero consumers)
 *
 * New dictionary-editing surfaces (the import-wizard missing entry §K.3, the
 * Variable View grid) MUST route through this helper rather than re-listing
 * keys — the hand-list drift IS the #608 root cause.
 */
export function invalidateColumnDictionary(
  qc: QueryClient,
  projectId: number | string,
  datasetId: number | string,
): void {
  const keys: (string | number)[][] = [
    ['dataset-data', projectId, datasetId],
    ['dataset-columns', projectId, datasetId],
    ['column-frequencies', projectId, datasetId],
    ['recode-definitions', projectId, datasetId],
    ['project-columns', projectId],
    ['analysis-columns', projectId],
    ['metrics', projectId],
    ['domain-scores', projectId],
    ['group-comparison', projectId],
    ['analysis-cross-tab', projectId],
    ['correlation-matrix', projectId],
    ['scatter-matrix', projectId],
    ['statistical-tests', projectId],
    ['dq-summary', projectId],
    ['dq-patterns', projectId],
  ]
  for (const key of keys) {
    qc.invalidateQueries({ queryKey: key })
  }
}

/**
 * #812 — a column's EXISTENCE changing, which is strictly more than its
 * dictionary changing.
 *
 * 🔴 Deleting a column cascades further than any edit to it. `delete_manual_column`
 * and `_cascade_delete_column_refs` also delete the `AnalysisDomainMember` rows
 * that referenced it, delete the `MetricDefinition` + `StatisticalTest` rows that
 * read it, and **auto-dissolve any equivalence group or analysis domain left
 * empty** (mutation catalog §E3). The mutation this helper was extracted from
 * invalidated `dataset-data` and `dataset-columns` only — so after deleting the
 * last column of a variable group, the crosswalk went on rendering a bracket
 * whose group the server had already dissolved.
 *
 * ⚠️ **Found while EXTRACTING that mutation for a second surface, and that is the
 * general point: a copy does not only DRIFT, it propagates the original's defect
 * verbatim (#733).** The moment a call site stops being the only one is the
 * moment to check what it was quietly getting away with.
 */
export function invalidateColumnRemoved(
  qc: QueryClient,
  projectId: number | string,
  datasetId: number | string,
): void {
  invalidateColumnDictionary(qc, projectId, datasetId)
  qc.invalidateQueries({ queryKey: ['analysis-domains', projectId] })
  qc.invalidateQueries({ queryKey: ['equivalence-groups', projectId] })
}

/**
 * Row 47 — a dataset's ROW SET changing, which is a different blast radius from
 * a column's dictionary changing.
 *
 * 🔴 **Extracted because `deleteRow` was under-invalidating and add-record would
 * have inherited it verbatim (#733: a copy does not only drift, it propagates
 * the original's defect).** That mutation invalidated `['dataset-data']` and
 * nothing else, so after deleting a record:
 *
 *  - the Datasets list went on showing the old **Records** count (`list_datasets`
 *    returns `row_count`) for the 60s `staleTime`;
 *  - the Text Coding focal-column picker went on showing the old
 *    `N/M responded` rate — #830(d) made that denominator a `DatasetRow` count,
 *    so it moves when a record appears or disappears, not only when a cell does;
 *  - the Data Quality percentages kept their old base for the same reason.
 *
 * ⚠️ **A record with every cell empty still moves those numbers.** That is the
 * non-obvious half: it is tempting to treat an empty row as invisible to
 * analysis, and the row-counting denominators say otherwise.
 *
 * ⚠️ `['participants', …]` is here for the DELETE direction — a removed row can
 * take a participant link with it, changing the dataset count shown on the
 * Participants page. Adding a record never links anyone, so this key is
 * redundant on that arm; it is kept because a blanket set that is right for both
 * verbs is cheaper than two nearly-identical helpers, and invalidating an
 * inactive query costs one cache mark and no request (the reasoning
 * `invalidateColumnDictionary` above records).
 */
export function invalidateRowSetChanged(
  qc: QueryClient,
  projectId: number | string,
  datasetId: number | string,
): void {
  const keys: (string | number)[][] = [
    ['dataset-data', projectId, datasetId],
    // The list page's "Records" column.
    ['datasets', projectId],
    // #830(d): a ROW-count denominator, not a cell-count one.
    ['text-columns', projectId],
    ['dq-summary', projectId],
    ['dq-patterns', projectId],
    // The server marks metrics stale on a row-set change; these read them.
    ['metrics', projectId],
    ['domain-scores', projectId],
    // See the note above — the delete arm.
    ['participants', projectId],
  ]
  for (const key of keys) {
    qc.invalidateQueries({ queryKey: key })
  }
}
