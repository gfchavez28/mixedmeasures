/**
 * Auto-name derivation for "Add to Materials" saves (#419).
 *
 * The name must reflect the surface actually being saved: a Relationships &
 * Comparisons save previously inherited the stale Descriptives metric type
 * ("Freq Dist · …") because the old derivation only looked at `metricType`.
 * Labels are stored FULL (auto_name is String(500) server-side) — display
 * surfaces CSS-truncate; storage must not bake in an ellipsis.
 */

export interface MaterialAutoNameInput {
  /** AnalysisView tab: 'rc' for Relationships & Comparisons, else descriptives-like. */
  activeTab: string
  /** Descriptives metric type — only used when activeTab is NOT 'rc'. */
  metricType: string
  /** Full display labels of the selected variables (columns/domains). */
  metricLabels: string[]
  rcView?: 'correlations' | 'comparisons'
  rcChartType?: string | null
  showScatter?: boolean
  compareByLabel?: string | null
  compareBy2Label?: string | null
}

const DESCRIPTIVE_TYPE_LABELS: Record<string, string> = {
  frequency_distribution: 'Freq Dist',
  proportion: 'Proportion',
  mean: 'Mean',
  domain_aggregate: 'Group Agg',
}

const RC_CHART_LABELS: Record<string, string> = {
  comparison_table: 'Comparison',
  comparison_grouped_bar: 'Comparison',
  comparison_dumbbell: 'Comparison',
}

function joinLabels(labels: string[]): string {
  const shown = labels.slice(0, 3)
  const suffix = labels.length > 3 ? `, +${labels.length - 3}` : ''
  return `${shown.join(', ')}${suffix}`
}

export function generateMaterialAutoName(input: MaterialAutoNameInput): string {
  let name: string
  if (input.activeTab === 'rc' && input.rcView === 'comparisons') {
    const typeLabel = RC_CHART_LABELS[input.rcChartType ?? ''] ?? 'Comparison'
    const by = input.compareByLabel
      ? ` by ${input.compareByLabel}${input.compareBy2Label ? ` × ${input.compareBy2Label}` : ''}`
      : ''
    name = `${typeLabel} · ${joinLabels(input.metricLabels)}${by}`
  } else if (input.activeTab === 'rc') {
    name = `${input.showScatter ? 'Scatter Matrix' : 'Correlations'} · ${joinLabels(input.metricLabels)}`
  } else {
    const typeLabel = DESCRIPTIVE_TYPE_LABELS[input.metricType] || input.metricType
    name = `${typeLabel} · ${joinLabels(input.metricLabels)}`
  }
  // Server cap, not display truncation — only trips on pathological label sets.
  return name.length > 500 ? name.slice(0, 499) + '…' : name
}
