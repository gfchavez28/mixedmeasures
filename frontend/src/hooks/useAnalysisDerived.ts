import { useMemo } from 'react'
import type {
  MetricDefinitionResponse,
  AnalysisColumnsResponse,
  ProjectColumnListResponse,
  AnalysisDomainListResponse,
} from '@/lib/api'
import {
  getApplicableChartTypes,
  getGroupValues,
  buildColumnDomainColorMap,
  detectDivergingCenter,
  getMetricSortValue,
  type ChartType,
  type SortOrder,
  type LabelMode,
} from '@/lib/chart-data'
import { metricDisplayLabel } from '@/lib/metric-label'
import { CATEGORICAL_GROUPING_TYPES } from '@/lib/dataset-constants'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get the display label for a metric (used for alphabetical sorting). */
function getMetricLabel(m: MetricDefinitionResponse): string {
  return (m.input_source_label ?? m.name).toLowerCase()
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface UseAnalysisDerivedParams {
  selectedMetrics: MetricDefinitionResponse[]
  customOrder: number[]
  // URL state
  sortOrder: SortOrder
  metricType: string
  selectedColumnIds: Set<number>
  selectedDomainIds: Set<number>
  chartTypeParam: ChartType | null
  excludeValues: string[]
  groupingColumnId: number | null
  groupingMode: 'column' | 'dataset'
  labelMode: LabelMode
  // Query data
  analysisColumnsData: AnalysisColumnsResponse | undefined
  columnsData: ProjectColumnListResponse | undefined
  domainsData: AnalysisDomainListResponse | undefined
}

export function useAnalysisDerived(params: UseAnalysisDerivedParams) {
  const {
    selectedMetrics, customOrder,
    sortOrder, metricType, selectedColumnIds, selectedDomainIds,
    chartTypeParam, excludeValues, groupingColumnId, groupingMode,
    labelMode,
    analysisColumnsData, columnsData, domainsData,
  } = params

  const selectedMetricIds = useMemo(() => selectedMetrics.map(m => m.id), [selectedMetrics])

  // Detect mixed column types in selection (e.g., ordinal + nominal)
  const hasMixedTypes = useMemo(() => {
    if (!analysisColumnsData) return false
    const types = new Set<string>()
    for (const ds of analysisColumnsData.datasets) {
      for (const q of ds.columns) {
        if (selectedColumnIds.has(q.id)) types.add(q.column_type)
      }
    }
    return types.size > 1
  }, [analysisColumnsData, selectedColumnIds])

  // Reorder metrics based on sort mode
  const orderedMetrics = useMemo(() => {
    if (sortOrder === 'custom' && customOrder.length > 0) {
      // Metrics in customOrder that still exist, in that order
      const ordered: MetricDefinitionResponse[] = []
      for (const id of customOrder) {
        const m = selectedMetrics.find(mm => mm.id === id)
        if (m) ordered.push(m)
      }
      // New metrics not in customOrder — appended at end
      for (const m of selectedMetrics) {
        if (!customOrder.includes(m.id)) ordered.push(m)
      }
      return ordered
    }
    if (sortOrder === 'asc' || sortOrder === 'desc') {
      const copy = [...selectedMetrics]
      copy.sort((a, b) => {
        const aLabel = getMetricLabel(a)
        const bLabel = getMetricLabel(b)
        return sortOrder === 'asc' ? aLabel.localeCompare(bLabel) : bLabel.localeCompare(aLabel)
      })
      return copy
    }
    if (sortOrder === 'data_desc' || sortOrder === 'data_asc') {
      const copy = [...selectedMetrics]
      copy.sort((a, b) => {
        const aVal = getMetricSortValue(a)
        const bVal = getMetricSortValue(b)
        // Null values sort to end
        if (aVal == null && bVal == null) return 0
        if (aVal == null) return 1
        if (bVal == null) return -1
        return sortOrder === 'data_desc' ? bVal - aVal : aVal - bVal
      })
      return copy
    }
    return selectedMetrics
  }, [selectedMetrics, customOrder, sortOrder])

  // Labels for the DnD reorder list in ChartOptionsPanel
  const metricLabelsMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const m of selectedMetrics) {
      map.set(m.id, metricDisplayLabel(m))
    }
    return map
  }, [selectedMetrics])

  // Build short label lookup: metricId → column_name or bare column_text (no dataset prefix)
  const shortLabelMap = useMemo(() => {
    const map = new Map<number, string>()
    const datasets = analysisColumnsData?.datasets ?? []
    // Build columnId → {column_name, column_text} lookup
    const colLookup = new Map<number, { column_name: string | null; column_text: string }>()
    for (const ds of datasets) {
      for (const q of ds.columns) {
        colLookup.set(q.id, { column_name: q.column_name, column_text: q.column_text })
      }
    }
    for (const m of selectedMetrics) {
      if (m.input_source_type === 'dataset_column') {
        const col = colLookup.get(m.input_source_id)
        if (col) {
          map.set(m.id, col.column_name || col.column_text)
        }
      } else if (m.input_source_type === 'dataset_domain' && m.config?.decompose_label) {
        // Decomposed domain metrics use their decompose_label as short label
        map.set(m.id, m.config.decompose_label as string)
      }
      // Non-decomposed domain metrics keep their default label (input_source_label) — no short form available
    }
    return map
  }, [selectedMetrics, analysisColumnsData])

  // Available scale values for proportion "values" mode picker — union of scale_labels from selected questions
  const availableScaleValues = useMemo(() => {
    const datasets = analysisColumnsData?.datasets ?? []
    const vals = new Set<string>()
    for (const ds of datasets) {
      for (const q of ds.columns) {
        if (selectedColumnIds.has(q.id) && q.scale_labels) {
          for (const label of q.scale_labels) vals.add(label)
        }
      }
    }
    return Array.from(vals)
  }, [analysisColumnsData, selectedColumnIds])

  // Whether any selected metrics have short labels available (controls UI toggle visibility)
  const hasShortLabels = shortLabelMap.size > 0

  // Active label overrides — only used when mode is 'short'
  const activeLabelMap = useMemo(
    () => labelMode === 'short' ? shortLabelMap : undefined,
    [labelMode, shortLabelMap],
  )

  // ── Derived data ───────────────────────────────────────────────────────

  const colorMap = useMemo(
    () => buildColumnDomainColorMap(domainsData?.domains ?? []),
    [domainsData],
  )

  const hasGrouping = useMemo(
    () => selectedMetrics.some(m => m.grouping_column_id != null || m.grouping_mode === 'dataset'),
    [selectedMetrics],
  )

  const hasResults = selectedMetrics.some(m => m.results.length > 0)
  const hasAnySelection = selectedColumnIds.size > 0 || selectedDomainIds.size > 0

  // Extract response labels from current metric results (for Exclude Values + Hide from Chart).
  // Also include currently-excluded values so they remain visible in the checkbox list
  // even after recomputation removes them from result data.
  const responseLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const m of selectedMetrics) {
      for (const r of m.results) {
        if (r.result_data?.scale_order) {
          (r.result_data.scale_order as string[]).forEach(k => labels.add(k))
        } else if (r.result_data?.counts) {
          Object.keys(r.result_data.counts).forEach(k => labels.add(k))
        }
      }
    }
    for (const v of excludeValues) labels.add(v)
    return Array.from(labels)
  }, [selectedMetrics, excludeValues])

  // Detect whether selected metrics have mixed scale orders
  const hasMixedScales = useMemo(() => {
    const scaleOrders: string[] = []
    for (const m of orderedMetrics) {
      for (const r of m.results) {
        if (r.result_data?.scale_order) {
          scaleOrders.push(JSON.stringify(r.result_data.scale_order))
        }
      }
    }
    if (scaleOrders.length <= 1) return false
    return new Set(scaleOrders).size > 1
  }, [orderedMetrics])

  // Scale compatibility: disable frequency charts when types or scales are mixed
  const scaleCompatible = !hasMixedTypes && !hasMixedScales

  const chartTypeInfo = useMemo(
    () => getApplicableChartTypes(metricType, hasGrouping, selectedMetrics.length, scaleCompatible),
    [metricType, hasGrouping, selectedMetrics.length, scaleCompatible],
  )

  const activeChartType: ChartType | null = useMemo(() => {
    if (selectedMetrics.length === 0) return null
    if (chartTypeParam && chartTypeInfo.available.includes(chartTypeParam)) return chartTypeParam
    return chartTypeInfo.default
  }, [chartTypeParam, chartTypeInfo, selectedMetrics.length])

  const chartType = activeChartType

  // Diverging stacked bar: auto-detect center point from response labels
  const divergingCenterAuto = useMemo(() => {
    if (responseLabels.length < 3) return { centerLabel: null, mode: 'boundary' as const }
    return detectDivergingCenter(responseLabels)
  }, [responseLabels])

  // Compute dataset IDs from selected metrics (columns + domains)
  const relevantDatasetIds = useMemo(() => {
    const dsIds = new Set<number>()
    const allQ = columnsData?.columns ?? []
    const dsNameToId = new Map<string, number>()
    for (const ds of analysisColumnsData?.datasets ?? []) {
      dsNameToId.set(ds.name, ds.id)
    }
    for (const m of selectedMetrics) {
      if (m.input_source_type === 'dataset_column') {
        const q = allQ.find(q => q.id === m.input_source_id)
        if (q) dsIds.add(q.dataset_id)
      } else if (m.input_source_type === 'dataset_domain') {
        // Resolve domain dataset names → IDs
        const domain = (analysisColumnsData?.domains ?? []).find(d => d.id === m.input_source_id)
        if (domain) {
          for (const dsName of domain.datasets) {
            const dsId = dsNameToId.get(dsName)
            if (dsId) dsIds.add(dsId)
          }
        }
      }
    }
    return dsIds
  }, [selectedMetrics, columnsData, analysisColumnsData])

  // Stable string key for selected column IDs (for React Query deps)
  const selectedColumnIdsKey = useMemo(
    () => Array.from(selectedColumnIds).sort((a, b) => a - b).join(','),
    [selectedColumnIds],
  )

  // Cross-tab eligible columns: categorical columns in the same dataset as the
  // selected column, excluding the selected column itself.
  const crossTabEligibleColumns = useMemo(() => {
    if (selectedColumnIds.size !== 1) return []
    const selectedColId = Array.from(selectedColumnIds)[0]
    const allQ = columnsData?.columns ?? []
    const selectedCol = allQ.find(q => q.id === selectedColId)
    if (!selectedCol) return []
    return allQ
      .filter(q =>
        q.dataset_id === selectedCol.dataset_id &&
        q.id !== selectedColId &&
        // #399: cross-tab axes are categorical-only (the backend buckets the cross
        // axis by value_text). Continuous numeric/percentage are excluded — bin via
        // recode first. Shared with the other grouping surfaces (invariant I-D).
        CATEGORICAL_GROUPING_TYPES.includes(q.column_type)
      )
      .map(q => ({
        id: q.id,
        label: q.column_name || q.column_text,
        datasetId: q.dataset_id,
      }))
  }, [selectedColumnIds, columnsData])

  // Group By availability — nuanced logic for domains vs columns
  const groupByAvailability = useMemo(() => {
    if (selectedMetrics.length === 0) {
      return { enabled: false, datasetGroupingAvailable: false, reason: '' }
    }
    const hasDomains = selectedDomainIds.size > 0
    const hasColumns = selectedColumnIds.size > 0

    // Mixed column + domain → disabled
    if (hasDomains && hasColumns) {
      return {
        enabled: false,
        datasetGroupingAvailable: false,
        reason: 'Select only variable group metrics or only individual variables to enable grouping',
      }
    }

    if (hasDomains) {
      // Check if any selected domain spans 2+ datasets
      const domains = analysisColumnsData?.domains ?? []
      const selectedDomains = domains.filter(d => selectedDomainIds.has(d.id))
      const anySpansMultiple = selectedDomains.some(d => d.datasets.length >= 2)

      if (anySpansMultiple) {
        // Multi-dataset domain → "By Dataset" only (no demographics)
        return { enabled: true, datasetGroupingAvailable: true, reason: '' }
      }
      // Single-dataset domain → demographic columns from that dataset
      return { enabled: true, datasetGroupingAvailable: false, reason: '' }
    }

    // Column metrics only
    if (relevantDatasetIds.size !== 1) {
      return {
        enabled: false,
        datasetGroupingAvailable: false,
        reason: 'Select variables from one dataset to enable Group By',
      }
    }
    return { enabled: true, datasetGroupingAvailable: false, reason: '' }
  }, [selectedMetrics.length, selectedDomainIds, selectedColumnIds, relevantDatasetIds, analysisColumnsData])

  const canGroupBy = groupByAvailability.enabled
  const groupByDisabledReason = groupByAvailability.reason || undefined

  // Decompose: show individual variables within a domain
  const canDecompose = selectedDomainIds.size > 0 && metricType !== 'domain_aggregate'

  // Shared demographics across datasets in multi-dataset domains
  const sharedDemographics = useMemo(() => {
    if (!groupByAvailability.datasetGroupingAvailable) return []
    const allDemographics = analysisColumnsData?.demographics ?? []
    const domains = analysisColumnsData?.domains ?? []
    const selectedDomains = domains.filter(d => selectedDomainIds.has(d.id))

    // Collect all dataset names from selected multi-dataset domains
    const relevantDsNames = new Set<string>()
    for (const d of selectedDomains) {
      if (d.datasets.length >= 2) {
        for (const name of d.datasets) relevantDsNames.add(name)
      }
    }
    if (relevantDsNames.size < 2) return []

    // Group demographics by match key: subtype (primary) > column_name lowercase (fallback)
    const groups = new Map<string, typeof allDemographics>()
    for (const demo of allDemographics) {
      if (!relevantDsNames.has(demo.dataset_name)) continue
      const key = demo.subtype
        ? `subtype:${demo.subtype.toLowerCase()}`
        : demo.column_name
          ? `name:${demo.column_name.trim().toLowerCase()}`
          : null
      if (!key) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(demo)
    }

    // Keep groups covering at least 2 relevant datasets
    const result: Array<{ anchor: typeof allDemographics[0]; label: string; datasetNames: string[] }> = []
    for (const [, demos] of groups) {
      const coveredDs = new Set(demos.map(d => d.dataset_name))
      if (coveredDs.size >= 2) {
        // Use first as anchor, derive a clean label
        const anchor = demos[0]
        const label = anchor.column_name || anchor.column_text
        result.push({ anchor, label, datasetNames: Array.from(coveredDs) })
      }
    }
    return result
  }, [groupByAvailability.datasetGroupingAvailable, analysisColumnsData, selectedDomainIds])

  // Available group values from current metrics (for group filter UI)
  const availableGroupValues = useMemo(() => {
    if (!groupingColumnId && groupingMode !== 'dataset') return [] as string[]
    return getGroupValues(selectedMetrics)
  }, [selectedMetrics, groupingColumnId, groupingMode])

  return {
    selectedMetricIds,
    orderedMetrics,
    metricLabelsMap,
    shortLabelMap,
    availableScaleValues,
    hasShortLabels,
    activeLabelMap,
    colorMap,
    hasGrouping,
    chartTypeInfo,
    activeChartType,
    chartType,
    hasResults,
    hasAnySelection,
    responseLabels,
    hasMixedScales,
    hasMixedTypes,
    divergingCenterAuto,
    relevantDatasetIds,
    selectedColumnIdsKey,
    crossTabEligibleColumns,
    groupByAvailability,
    canGroupBy,
    groupByDisabledReason,
    canDecompose,
    sharedDemographics,
    availableGroupValues,
  }
}

export type AnalysisDerived = ReturnType<typeof useAnalysisDerived>
