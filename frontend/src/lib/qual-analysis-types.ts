export type AnalysisSource =
  | { type: 'conversation'; id: number; label: string; importOrder: number }
  | { type: 'text_column'; id: number; label: string; datasetId: number; datasetName: string; columnName: string }
  | { type: 'document'; id: number; label: string }

export type QualTab = 'content' | 'descriptives' | 'relationships' | 'quoteboard'
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
