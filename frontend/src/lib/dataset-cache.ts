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
