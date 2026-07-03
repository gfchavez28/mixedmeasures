import type { ChartType } from './chart-data'

/**
 * Decide which chart-dependent URL params have become INVALID and must be
 * auto-cleared (#505). Pure so the hydration behavior is unit-testable.
 *
 * Load-bearing: `chartType == null` means the quick-compute metrics are still
 * hydrating — that state is INDETERMINATE, not invalid. Chart-dependent params
 * (`diverging`, `crossTabCol`, `axisTransform`) must survive it, or deep-links,
 * reloads, and saved-material restores strip their own config and render a
 * different chart than saved. Only a *known* chart type may invalidate them.
 * (`decompose` is chart-independent — `canDecompose` derives synchronously
 * from the URL, so it may clear regardless of hydration.)
 */
export function computeInvalidAnalysisParams(i: {
  decompose: boolean
  canDecompose: boolean
  divergingMode: boolean
  chartType: ChartType | null
  axisTransform: string
  metricType: string
  crossTabColumnId: number | null
}): string[] {
  const invalid: string[] = []

  // Decompose: invalid when no domains selected or domain_aggregate
  if (i.decompose && !i.canDecompose) invalid.push('decompose')

  // Diverging: only valid for stacked_bar chart type
  if (i.chartType && i.divergingMode && i.chartType !== 'stacked_bar') {
    invalid.push('diverging', 'divergingCenter')
  }

  // Axis transform: log only valid for scalar bar/line/dumbbell + non-frequency
  if (i.axisTransform !== 'linear' && i.chartType) {
    const scalarBarTypes: ChartType[] = ['horizontal_bar', 'vertical_bar', 'line', 'dumbbell']
    const supportsLog = scalarBarTypes.includes(i.chartType) && i.metricType !== 'frequency_distribution'
    if (!supportsLog) invalid.push('axisTransform')
  }

  // Cross-tab: only valid for cross_tab chart type
  if (i.chartType && i.crossTabColumnId && i.chartType !== 'cross_tab') {
    invalid.push('crossTabCol', 'crossTabDisplay')
  }

  return invalid
}
