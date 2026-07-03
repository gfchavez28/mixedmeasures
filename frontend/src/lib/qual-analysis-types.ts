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
export type QualChartType = 'heatmap' | 'bar' | 'stacked_bar' | 'summary' | 'saturation'
export type QualValueMode = 'count' | 'segment_proportion' | 'text_coverage'
export type QualDenominatorMode = 'total' | 'coded'
export type QualSortOrder = 'import' | 'alpha' | 'count_desc' | 'count_asc' | 'custom'
export type QualOrientation = 'sources-rows' | 'codes-rows'
export type QualRelView = 'cooccurrence' | 'comparisons'
export type QualCooccurrenceLevel = 'segment' | 'source'
export type QualComparisonChartMode = 'table' | 'bar'
export type QualContentMode = 'by-code' | 'by-source'
export type QuoteGroupBy = 'none' | 'code' | 'source' | 'category'
export type QuoteSort = 'source' | 'date' | 'quoted' | 'custom'
export type QuoteDensity = 'quote' | 'full'
export type QuoteLayout = 'auto' | '1' | '2'
