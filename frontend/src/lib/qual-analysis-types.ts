export type AnalysisSource =
  | { type: 'conversation'; id: number; label: string; importOrder: number }
  | { type: 'text_column'; id: number; label: string; datasetId: number; datasetName: string; columnName: string }
  | { type: 'document'; id: number; label: string }

export type QualTab = 'content' | 'descriptives' | 'relationships' | 'reconciliation' | 'irr' | 'quoteboard'

/**
 * Track J · J2-5 M-1 — the Reconciliation tab/grid is offered only when the project
 * is multi-coder AND a consensus layer exists. Hidden while BLIND (DEC-G — the
 * reconciliation grid reveals every coder side-by-side; you must Reveal first). Pure.
 */
export function isReconciliationTabVisible(multiCoder: boolean, consensusAvailable: boolean, blind = false): boolean {
  return multiCoder && consensusAvailable && !blind
}

/**
 * Track J · J2-5 — the Reliability (IRR) tab is offered whenever the project is
 * multi-coder. Unlike Reconciliation it does NOT require a consensus layer (IRR is
 * human-roster agreement, independent of consensus). Hidden while BLIND (DEC-G — it
 * names coders + shows agreement). Pure (unit-tested).
 */
export function isIrrTabVisible(multiCoder: boolean, blind = false): boolean {
  return multiCoder && !blind
}
export type QualCodeMode = 'codes' | 'categories'
export type QualChartType = 'heatmap' | 'bar' | 'stacked_bar' | 'summary' | 'saturation' | 'timeline'
export type QualValueMode = 'count' | 'segment_proportion' | 'text_coverage'
export type QualDenominatorMode = 'total' | 'coded'
export type QualSortOrder = 'import' | 'alpha' | 'count_desc' | 'count_asc' | 'custom'
export type QualOrientation = 'sources-rows' | 'codes-rows'

/**
 * Orientation is the ONE display option that travels as a short URL token
 * (`sr` / `cr`) rather than as its own type — and a saved material config
 * stores the TOKEN, because `buildCurrentConfig` writes `orientRaw` verbatim
 * while every sibling option (`value_mode`, `sort_order`, `chart_type`) is
 * written already-typed.
 *
 * ⚠️ That asymmetry is a silent-corruption trap, which is why both directions
 * live here instead of being re-inlined per consumer (#652 slab 1): a consumer
 * that passes the stored `'sr'` straight into a chart component sends a value
 * outside `QualOrientation`, and every component treats anything that isn't
 * exactly `'codes-rows'` as sources-rows. So the bug is INVISIBLE on the
 * default and appears only for a researcher who chose codes-rows — the
 * coinciding-values shape this codebase keeps re-filing.
 */
export function orientationFromToken(token: unknown): QualOrientation {
  return token === 'cr' || token === 'codes-rows' ? 'codes-rows' : 'sources-rows'
}

export function orientationToToken(orientation: QualOrientation): 'sr' | 'cr' {
  return orientation === 'codes-rows' ? 'cr' : 'sr'
}
export type QualRelView = 'cooccurrence' | 'comparisons'
export type QualCooccurrenceLevel = 'segment' | 'source'
export type QualComparisonChartMode = 'table' | 'bar'
export type QualContentMode = 'by-code' | 'by-source'
export type QuoteGroupBy = 'none' | 'code' | 'source' | 'category'
export type QuoteSort = 'source' | 'date' | 'quoted' | 'custom'
export type QuoteDensity = 'quote' | 'full'
export type QuoteLayout = 'auto' | '1' | '2'
