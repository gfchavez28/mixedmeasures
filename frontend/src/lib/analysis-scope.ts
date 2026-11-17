/**
 * #1615 — the coder scope a QUANTITATIVE read sends while blind, and what the marks on the
 * variable list mean.
 *
 * A participant score (the participant table's `{code} (score)` / `(rated passages)` columns,
 * and every column computed or derived from one) is ONE shared snapshot of every coder's
 * ratings. #1608 withheld those columns where the table is SHOWN; a chart, test, correlation,
 * cross-tab or Data Quality read over one still handed a blind coder a number holding her
 * colleagues' judgements (her own 2.0, the table's 3.5 over two raters ⇒ the colleague's 5).
 *
 * So every quantitative read sends the viewer's scope while `withholding` — the same rule as
 * `hooks/useBlindScope.ts` (the viewer alone; fail closed with no self id, D96) — and the
 * server, which alone knows whose ratings the snapshot holds (`withheld_rating_column_ids`,
 * D222: the raters never ride the wire), leaves those columns out and says so. The variable
 * list MARKS a withheld column (`withheld_while_blind`) rather than dropping it, so a saved
 * chart can still be NAMED; the pickers hide what is marked and say how many.
 *
 * Pure, so the Canvas export (no hooks) asks the same function as the page.
 */
import type { AnalysisColumnsResponse } from '@/lib/api'

export interface AnalysisScope {
  /** The JSON body's `coder_ids`: the viewer alone while withholding, `null` (every coder) otherwise. */
  coderIds: number[] | null
  /** The query string's `coder_ids`, or `undefined` for every coder. */
  coderScope: string | undefined
  /** A query-KEY element that is never `undefined`, so two scopes never share a cache entry. */
  scopeKey: string
}

/**
 * The scope for `withholding` and the viewer's id, or `null` when there is no scope a read may
 * be sent with: withholding with no self id (D96). 🔴 Never an empty list — `coder_ids` absent
 * OR EMPTY means every coder on the server, so "nobody" has no spelling; the caller must not
 * read (the hook reports `scopeReady: false`; the Canvas export says why it drew nothing).
 */
export function analysisScope(withholding: boolean, self: number | null): AnalysisScope | null {
  if (!withholding) return { coderIds: null, coderScope: undefined, scopeKey: 'every-coder' }
  if (self == null) return null
  return { coderIds: [self], coderScope: String(self), scopeKey: String(self) }
}

/**
 * The body field to spread into a POST: `{ coder_ids }` while scoped, NOTHING for every coder —
 * so a request made when blind mode is off is byte-for-byte the request it was before #1615.
 */
export function coderIdsField(coderIds: number[] | null): { coder_ids?: number[] } {
  return coderIds ? { coder_ids: coderIds } : {}
}

/**
 * #1615 (D297's Canvas path) — the same scope, spelled for a QUALITATIVE Canvas embed's two
 * grouping requests (source frequencies, the comparison): `{ ratings_viewer_id }` while scoped,
 * NOTHING for every coder (byte-for-byte today's request). Its own name because that request's
 * `coder_ids` is the FIGURE's saved scope (`inline-chart-params.ts`), so it cannot also say who
 * is looking; the server asks the grouping gate with it and nothing else.
 */
export function ratingsViewerField(coderIds: number[] | null): { ratings_viewer_id?: number } {
  return coderIds ? { ratings_viewer_id: coderIds[0] } : {}
}

/** The scope a hook hands out before it is ready: every coder's SHAPE, never sent (enabled is false). */
export const UNSENT_SCOPE: AnalysisScope = { coderIds: null, coderScope: undefined, scopeKey: 'unsettled' }

/** Anything the variable list can mark (a column, a grouping variable, a variable group). */
export interface WithheldMark { withheld_while_blind?: boolean }

export function isWithheld(item: WithheldMark | null | undefined): boolean {
  return item?.withheld_while_blind === true
}

/**
 * The suffix a grouping-variable OPTION carries when it is a rating score hidden while blind.
 * A grouping list keeps the option, disabled with this note — the `OTHER_DATASET_NOTE`
 * precedent (`lib/grouping-scope.ts`), and a selection made before blind mode still has its
 * name in the trigger — where the variable PICKER hides the scores and counts them (the Data
 * view's way, `withheldRatingColumnsNotice`).
 */
export const WITHHELD_OPTION_NOTE = 'a rating score, hidden while blind'

/**
 * The variable list a PICKER shows: marked columns, grouping variables and variable groups
 * taken out, with how many columns each dataset lost (the picker says so under that dataset —
 * the Data view's sentence, `withheldRatingColumnsNotice`). A dataset left with no columns
 * stays listed, so the sentence has somewhere to sit.
 */
export function visibleAnalysisColumns(data: AnalysisColumnsResponse): {
  data: AnalysisColumnsResponse
  withheldByDataset: Map<number, number>
} {
  const withheldByDataset = new Map<number, number>()
  const datasets = data.datasets.map(ds => {
    const kept = ds.columns.filter(c => !isWithheld(c))
    if (kept.length !== ds.columns.length) withheldByDataset.set(ds.id, ds.columns.length - kept.length)
    return kept.length === ds.columns.length ? ds : { ...ds, columns: kept }
  })
  return {
    data: {
      ...data,
      datasets,
      // Tolerant of a member a fixture or an older server leaves out (the picker read
      // `data.domains` alone before this).
      demographics: data.demographics?.filter(d => !isWithheld(d)) ?? data.demographics,
      domains: data.domains?.filter(d => !isWithheld(d)) ?? data.domains,
    },
    withheldByDataset,
  }
}

/**
 * The selected ids the list marks withheld — a selection can name one the picker no longer
 * offers (a link, back/forward, a Material saved before blind mode was on). Unknown ids (the
 * list not loaded yet, a deleted column) are NOT counted: the server is the guard, this only
 * decides what the page says.
 */
export function withheldSelection(
  data: AnalysisColumnsResponse | undefined,
  columnIds: Iterable<number>,
  domainIds: Iterable<number> = [],
  groupingIds: Array<number | null | undefined> = [],
): number {
  if (!data) return 0
  const marked = new Set<number>()
  for (const ds of data.datasets) for (const c of ds.columns) if (isWithheld(c)) marked.add(c.id)
  for (const d of data.demographics ?? []) if (isWithheld(d)) marked.add(d.id)
  const markedDomains = new Set((data.domains ?? []).filter(isWithheld).map(d => d.id))
  let n = 0
  const seen = new Set<number>()
  for (const id of [...columnIds, ...groupingIds.filter((g): g is number => g != null)]) {
    if (marked.has(id) && !seen.has(id)) { seen.add(id); n += 1 }
  }
  for (const id of domainIds) if (markedDomains.has(id)) n += 1
  return n
}
