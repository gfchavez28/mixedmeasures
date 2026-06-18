import { useState, useRef, useMemo, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, useDefaultLayout } from 'react-resizable-panels'
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  FlaskConical,
  Layers,
  Download,
  SwatchBook,
} from 'lucide-react'
import { metricsApi, domainsApi, datasetsApi, materialsApi, statisticalTestsApi, correlationsApi, comparisonsApi, dataQualityApi } from '@/lib/api'
import type {
  MetricDefinitionResponse,
  MaterialResponse,
  MaterialCollectionDetailResponse,
  StatisticalTestResponse,
  AnalysisColumnItem,
  DatasetColumn,
  ManualColumnUpdate,
} from '@/lib/api'
import { extractApiError } from '@/lib/api/error-utils'
import { toast } from 'sonner'
import {
  DEFAULT_FORMATTING,
  type ChartType,
  type MetricType,
  type ChartFormatting,
  type LabelMode,
  type GroupOrganization,
} from '@/lib/chart-data'
import { ChartErrorBoundary } from '@/components/ChartErrorBoundary'
import ChartTypeToolbar from '@/components/charts/ChartTypeToolbar'
import AnalysisChartRenderer from '@/components/analysis/AnalysisChartRenderer'
import CorrelationsComparisonsContent from '@/components/analysis/CorrelationsComparisonsContent'
import { DataQualityContent } from '@/components/analysis/DataQualityTab'
import AnalysisSidebar from '@/components/analysis/AnalysisSidebar'
import { ColumnFormDialog } from '@/components/ColumnFormDialog'
import { useAnalysisUrlState } from '@/hooks/useAnalysisUrlState'
import { useAnalysisDerived } from '@/hooks/useAnalysisDerived'
import { useQuickCompute } from '@/hooks/useQuickCompute'
import { useChartAnnouncements } from '@/hooks/useChartAnnouncements'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { metricDisplayLabel } from '@/lib/metric-label'
import { generateMaterialAutoName } from '@/lib/material-auto-name'
import { VALUE_NUMERIC_TYPES } from '@/lib/dataset-constants'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ── Constants ────────────────────────────────────────────────────────────────

const METRIC_TYPE_OPTIONS = [
  { value: 'frequency_distribution', label: 'Frequency Distribution' },
  { value: 'proportion', label: 'Proportion' },
  { value: 'mean', label: 'Mean' },
  { value: 'domain_aggregate', label: 'Group Aggregate' },
]

const TEST_TYPE_LABELS: Record<string, string> = {
  cronbachs_alpha: "Cronbach's Alpha",
  independent_t_test: 'Independent T-Test',
  one_way_anova: 'One-Way ANOVA',
  split_half: 'Split-Half Reliability',
}

function formatTestResult(test: StatisticalTestResponse): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rd = test.result_data as Record<string, any> | null
  if (!rd) return 'Not yet computed'

  if (test.test_type === 'cronbachs_alpha') {
    return `Cronbach's \u03B1 = ${rd.alpha} (${rd.interpretation}), k = ${rd.k}, n = ${rd.n}`
  }
  if (test.test_type === 'independent_t_test') {
    const p = rd.p_value < 0.001 ? '< .001' : `= ${rd.p_value.toFixed(3).replace(/^0/, '')}`
    return `t(${typeof rd.df === 'number' ? rd.df.toFixed(1) : rd.df}) = ${rd.t_statistic}, p ${p}, d = ${rd.cohens_d} (${rd.effect_size_label}) \u2014 ${rd.group1_label} (M = ${rd.group1_mean}) vs ${rd.group2_label} (M = ${rd.group2_mean})`
  }
  if (test.test_type === 'one_way_anova') {
    const p = rd.p_value < 0.001 ? '< .001' : `= ${rd.p_value.toFixed(3).replace(/^0/, '')}`
    const omegaStr = rd.omega_squared != null ? `, \u03C9\u00B2 = ${rd.omega_squared}` : ''
    return `F(${rd.df_between}, ${rd.df_within}) = ${rd.f_statistic}, p ${p}, \u03B7\u00B2 = ${rd.eta_squared}${omegaStr} (${rd.effect_size_label})`
  }
  if (test.test_type === 'split_half') {
    const negNote = rd.negative_half_correlation ? ' — negative half-correlation, scale may lack internal consistency' : ''
    return `Split-half r = ${rd.split_half_r}, Spearman-Brown = ${rd.spearman_brown} (${rd.interpretation}), k = ${rd.k}, n = ${rd.n}${negNote}`
  }
  return JSON.stringify(rd)
}

function getQuickComputeConfig(
  metricType: string,
  proportionConfig: { mode: string; operator: string; threshold: number; values: string[] },
): Record<string, unknown> {
  switch (metricType) {
    case 'proportion':
      return proportionConfig.mode === 'numeric'
        ? { mode: 'numeric', operator: proportionConfig.operator, threshold_numeric: proportionConfig.threshold }
        : { mode: 'values', threshold_values: proportionConfig.values }
    case 'domain_aggregate': return { child_metric_type: 'mean', child_config: {}, aggregation: 'mean' }
    default: return {}
  }
}

// ── Main component ──────────────────────────────────────────────────────────

export default function AnalysisView() {
  const { projectId } = useParams<{ projectId: string }>()
  const queryClient = useQueryClient()
  const pid = Number(projectId)

  // Track last-used analysis type for hub page
  useEffect(() => {
    localStorage.setItem(`mm-last-analysis-${pid}`, 'quantitative')
  }, [pid])

  const {
    setSearchParams,
    activeTab,
    rcView, corrType, sigLevelsRaw, sigLevels, bonferroniOn,
    showScatter, showRegLine, showJitter, corrCellFormat, corrColors,
    compareBy, compareBy2, testType, nonparametric, rcChartType, excludeGroups, rcPalette,
    dqView, dqIncludeNA, dqIncludeEmpty, dqSort,
    activeMaterialId,
    columnsRaw, domainsRaw, metricType, selectedColumnIds, selectedDomainIds, decompose,
    metricIdHint,
    sortOrder, display, scaling, showChartN, showGroupN, showVariableN, showSampleSizes, showCI, chartTypeParam,
    groupingColumnId, groupingColumnId2, groupingMode, excludeValues,
    divergingMode, divergingCenter,
    axisTransform,
    crossTabColumnId, crossTabDisplay,
    setUrlParam,
  } = useAnalysisUrlState()

  // ── Local state ────────────────────────────────────────────────────────

  // Metric type switch prompt (when chart type requires different metric type)
  const [metricTypePrompt, setMetricTypePrompt] = useState<{
    chartType: ChartType
    options: MetricType[]
  } | null>(null)

  // Dismiss metric type prompt when metricType changes externally (e.g. sidebar selector)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dismiss prompt when metric type changes
    setMetricTypePrompt(null)
  }, [metricType])

  // Chart config state
  const [chartTitle, setChartTitle] = useState('')
  const [chartSubtitle, setChartSubtitle] = useState('')
  const [chartFootnote, setChartFootnote] = useState('')

  // Formatting + display-only state (not in URL — saved in chart_config)
  const [formatting, setFormatting] = useState<ChartFormatting>(DEFAULT_FORMATTING)
  const [hiddenResponseOptions, setHiddenResponseOptions] = useState<string[]>([])
  const [scaleOrder, setScaleOrder] = useState<'natural' | 'reversed'>('natural')
  const [groupByClearedNotice, setGroupByClearedNotice] = useState(false)
  const [customOrder, setCustomOrder] = useState<number[]>([])
  const [labelMode, setLabelMode] = useState<LabelMode>('full')
  const [hiddenGroupValues, setHiddenGroupValues] = useState<string[]>([])
  const [groupOrganization, setGroupOrganization] = useState<GroupOrganization>('variable-first')

  // Line chart / error band state (local, saved in chart_config)
  const [showErrorBand, setShowErrorBand] = useState(false)
  const [lineStyle, setLineStyle] = useState<'connected' | 'markers'>('connected')
  const [lineOverlay, setLineOverlay] = useState(false)

  // Proportion threshold config state
  const [proportionMode, setProportionMode] = useState<'numeric' | 'values'>('values')
  const [proportionOperator, setProportionOperator] = useState('>=')
  const [proportionThreshold, setProportionThreshold] = useState(4)
  const [proportionValues, setProportionValues] = useState<string[]>([])

  // Column details dialog (opened from ColumnPicker context menu)
  const [editColumnTarget, setEditColumnTarget] = useState<{ variable: AnalysisColumnItem; column: DatasetColumn } | null>(null)
  const [editColumnError, setEditColumnError] = useState<string | null>(null)

  const handleEditAnalysisColumn = useCallback(async (variable: AnalysisColumnItem) => {
    try {
      const data = await queryClient.fetchQuery({
        queryKey: ['dataset-data', pid, variable.dataset_id],
        queryFn: () => datasetsApi.getData(pid, variable.dataset_id),
        staleTime: 60_000,
      })
      const column = data.columns.find((c: DatasetColumn) => c.id === variable.id)
      if (column) {
        setEditColumnTarget({ variable, column })
        setEditColumnError(null)
      } else {
        toast.error('Column not found')
      }
    } catch {
      toast.error('Failed to load column data')
    }
  }, [pid, queryClient])

  const editColumnMutation = useMutation({
    mutationFn: ({ datasetId, columnId, data }: { datasetId: number; columnId: number; data: ManualColumnUpdate }) =>
      datasetsApi.updateManualColumn(pid, datasetId, columnId, data),
    onSuccess: () => {
      if (editColumnTarget) {
        queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, editColumnTarget.variable.dataset_id] })
      }
      queryClient.invalidateQueries({ queryKey: ['analysis-columns', pid] })
      setEditColumnTarget(null)
      toast.success('Column updated')
    },
    onError: (err: Error) => setEditColumnError(extractApiError(err, 'Failed to update column')),
  })

  // Resizable panel layout persistence
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'analysis-view-panels',
    storage: localStorage,
  })

  // Statistical tests state
  const [statsExpanded, setStatsExpanded] = useState(true)
  const [testDialog, setTestDialog] = useState<{
    open: boolean
    step: 1 | 2
    type: 'cronbachs_alpha' | 'group_difference' | 'split_half' | null
    targetId: number
  }>({ open: false, step: 1, type: null, targetId: 0 })
  const [postHocExpanded, setPostHocExpanded] = useState(true)

  // ── Data loading ───────────────────────────────────────────────────────

  // Materials — fetch collections list to get the default collection ID,
  // then load that collection's detail for the per-material list.
  // #375: short staleTime so materials created elsewhere (e.g. from the canvas
  // "Add to Materials" flow) or in another session show up on navigation/refocus
  // rather than being hidden behind a 10-minute cache.
  const { data: collectionsData } = useQuery({
    queryKey: ['material-collections', pid],
    queryFn: () => materialsApi.list(pid),
    enabled: !!pid,
    staleTime: 30_000,
  })

  const defaultPalette = collectionsData?.collections?.[0] ?? null
  const defaultCollectionId = defaultPalette?.id ?? null

  const { data: collectionDetail } = useQuery({
    queryKey: ['material-collection-detail', pid, defaultCollectionId],
    queryFn: () => materialsApi.get(pid, defaultCollectionId!),
    enabled: !!pid && !!defaultCollectionId,
    staleTime: 30_000,
  })

  const materials = useMemo(() => collectionDetail?.materials ?? [], [collectionDetail])

  // ── Correlation queries (R&C tab) ──────────────────────────────────────
  const rcColumnIds = useMemo(() => [...selectedColumnIds].sort((a, b) => a - b), [selectedColumnIds])
  const rcDomainIds = useMemo(() => [...selectedDomainIds].sort((a, b) => a - b), [selectedDomainIds])
  const hasRcSelection = activeTab === 'rc' && (rcColumnIds.length >= 2 || rcDomainIds.length >= 2)

  const { data: corrMatrixData, isFetching: isCorrFetching } = useQuery({
    queryKey: ['correlation-matrix', pid, rcColumnIds, rcDomainIds, corrType, bonferroniOn],
    queryFn: () => correlationsApi.correlationMatrix(pid, {
      column_ids: rcColumnIds,
      domain_ids: rcDomainIds,
      correlation_type: corrType,
      bonferroni: bonferroniOn,
    }),
    enabled: hasRcSelection && rcView === 'correlations',
    staleTime: 30_000,
  })

  const { data: scatterMatrixData, isFetching: isScatterFetching } = useQuery({
    queryKey: ['scatter-matrix', pid, rcColumnIds, rcDomainIds, showScatter],
    queryFn: () => correlationsApi.scatterMatrix(pid, {
      column_ids: rcColumnIds,
      domain_ids: rcDomainIds,
      id_type: rcColumnIds.length > 0 ? 'column' : 'domain',
      max_variables: 10,
    }),
    enabled: hasRcSelection && rcView === 'correlations' && showScatter,
    staleTime: 30_000,
  })

  // ── Comparison query (R&C tab) ──────────────────────────────────────
  const hasComparisonSelection = activeTab === 'rc' && rcView === 'comparisons'
    && (rcColumnIds.length >= 1 || rcDomainIds.length >= 1) && compareBy !== null

  const { data: comparisonData, isFetching: isComparisonFetching } = useQuery({
    queryKey: ['group-comparison', pid, rcColumnIds, rcDomainIds, compareBy, compareBy2, testType, excludeGroups, nonparametric],
    queryFn: () => comparisonsApi.groupComparison(pid, {
      column_ids: rcColumnIds,
      domain_ids: rcDomainIds,
      grouping_column_id: compareBy!,
      grouping_column_id_2: compareBy2,
      test_type: testType,
      include_effect_size_ci: true,
      exclude_groups: excludeGroups.length > 0 ? excludeGroups : undefined,
      nonparametric,
    }),
    enabled: hasComparisonSelection,
    staleTime: 30_000,
  })

  // Formatting override for R&C comparison charts
  const rcFormatting = useMemo<Partial<ChartFormatting>>(
    () => ({ colorPalette: rcPalette }),
    [rcPalette],
  )

  // Domains and columns for color mapping + backward compat
  const { data: domainsData } = useQuery({
    queryKey: ['analysis-domains', pid],
    queryFn: () => domainsApi.list(pid),
    enabled: !!pid,
    staleTime: 300_000,
  })

  const { data: columnsData } = useQuery({
    queryKey: ['project-columns', pid],
    queryFn: () => datasetsApi.allColumns(pid),
    enabled: !!pid,
    staleTime: 300_000,
  })

  const { data: analysisColumnsData } = useQuery({
    queryKey: ['analysis-columns', pid],
    queryFn: () => metricsApi.analysisColumns(pid),
    staleTime: 60_000,
    enabled: !!pid,
  })

  // Statistical tests
  const { data: testsData } = useQuery({
    queryKey: ['statistical-tests', pid],
    queryFn: () => statisticalTestsApi.list(pid),
    enabled: !!pid,
    staleTime: 300_000,
  })

  const allTests = useMemo(() => testsData?.tests ?? [], [testsData?.tests])

  // Metric list — needed for test creation dialog (grouped metrics) and backward compat
  const { data: metricList } = useQuery({
    queryKey: ['metrics', pid],
    queryFn: () => metricsApi.list(pid),
    enabled: !!pid,
    staleTime: 300_000,
  })

  const allMetrics = metricList?.metrics ?? []

  // ── Data Quality queries ──────────────────────────────────────────────
  const dqColumnIds = useMemo(() => [...selectedColumnIds].sort((a, b) => a - b), [selectedColumnIds])
  const hasDqSelection = activeTab === 'data_quality' && dqColumnIds.length > 0

  const { data: dqSummaryData, isFetching: isDqSummaryFetching, error: dqSummaryError } = useQuery({
    queryKey: ['dq-summary', pid, dqColumnIds, dqIncludeNA, dqIncludeEmpty],
    queryFn: () => dataQualityApi.summary(pid, {
      column_ids: dqColumnIds,
      include_na_as_missing: dqIncludeNA,
      include_empty_as_missing: dqIncludeEmpty,
    }),
    enabled: hasDqSelection,
    staleTime: 30_000,
  })

  const { data: dqPatternsData, isFetching: isDqPatternsFetching } = useQuery({
    queryKey: ['dq-patterns', pid, dqColumnIds, dqIncludeNA, dqIncludeEmpty],
    queryFn: () => dataQualityApi.patterns(pid, {
      column_ids: dqColumnIds,
      include_na_as_missing: dqIncludeNA,
      include_empty_as_missing: dqIncludeEmpty,
    }),
    enabled: hasDqSelection && dqView === 'patterns',
    staleTime: 30_000,
  })

  const mcarMutation = useMutation({
    mutationFn: () => dataQualityApi.mcarTest(pid, {
      column_ids: dqColumnIds,
      include_na_as_missing: dqIncludeNA,
      include_empty_as_missing: dqIncludeEmpty,
    }),
  })

  // Determine if DQ selection spans multiple datasets (for pattern/MCAR warnings)
  const dqDatasetIds = useMemo(() => {
    if (!analysisColumnsData) return new Set<number>()
    const ids = new Set<number>()
    for (const ds of analysisColumnsData.datasets) {
      for (const q of ds.columns) {
        if (selectedColumnIds.has(q.id)) ids.add(q.dataset_id)
      }
    }
    return ids
  }, [analysisColumnsData, selectedColumnIds])
  const dqIsMultiDataset = dqDatasetIds.size > 1

  // Check if DQ selection includes numeric-operand variables (#399, invariant I-D)
  const dqHasNumericVars = useMemo(() => {
    if (!analysisColumnsData) return false
    for (const ds of analysisColumnsData.datasets) {
      for (const q of ds.columns) {
        if (selectedColumnIds.has(q.id) && VALUE_NUMERIC_TYPES.includes(q.column_type)) return true
      }
    }
    return false
  }, [analysisColumnsData, selectedColumnIds])

  // ── Quick compute ──────────────────────────────────────────────────────

  const {
    metrics: qcMetrics,
    isComputing,
    error: qcError,
    compute: triggerCompute,
  } = useQuickCompute(pid)

  const quickComputeConfig = useMemo(
    () => getQuickComputeConfig(metricType, {
      mode: proportionMode,
      operator: proportionOperator,
      threshold: proportionThreshold,
      values: proportionValues,
    }),
    [metricType, proportionMode, proportionOperator, proportionThreshold, proportionValues],
  )

  // Trigger quick-compute when selections or metric type change
  useEffect(() => {
    const columnIds = columnsRaw
      ? columnsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      : []
    const domainIds = domainsRaw
      ? domainsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      : []
    triggerCompute({
      columnIds,
      domainIds,
      metricType,
      config: quickComputeConfig,
      groupingColumnId,
      groupingColumnId2,
      groupingMode: groupingMode !== 'column' ? groupingMode : null,
      excludeValues: excludeValues.length > 0 ? excludeValues : null,
      decompose: decompose || undefined,
    })
  }, [columnsRaw, domainsRaw, metricType, quickComputeConfig, groupingColumnId, groupingColumnId2, groupingMode, excludeValues, decompose, triggerCompute])

  // Quick-compute metrics are the source of truth for chart rendering
  const selectedMetrics: MetricDefinitionResponse[] = qcMetrics
  const {
    selectedMetricIds, orderedMetrics, metricLabelsMap,
    availableScaleValues, hasShortLabels, activeLabelMap,
    colorMap, hasGrouping, chartTypeInfo, activeChartType, chartType,
    hasResults, hasAnySelection, responseLabels, hasMixedScales, hasMixedTypes,
    divergingCenterAuto, relevantDatasetIds, selectedColumnIdsKey,
    crossTabEligibleColumns, groupByAvailability, canGroupBy, groupByDisabledReason,
    canDecompose, sharedDemographics, availableGroupValues,
  } = useAnalysisDerived({
    selectedMetrics, customOrder,
    sortOrder, metricType, selectedColumnIds, selectedDomainIds,
    chartTypeParam, excludeValues, groupingColumnId, groupingMode,
    labelMode,
    analysisColumnsData, columnsData, domainsData,
  })

  // Auto-select top two scale values for proportion "values" mode when none are selected
  useEffect(() => {
    if (proportionMode === 'values' && proportionValues.length === 0 && availableScaleValues.length >= 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-populate default proportion values
      setProportionValues(availableScaleValues.slice(-2))
    }
  }, [proportionMode, availableScaleValues]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally omit proportionValues to avoid re-triggering after user clears

  // ── Grouping cascade: 3 effects that MUST stay separate ──
  // Effect A clears groupBy/groupBy2/groupMode when invalid.
  // Effect B cascades: clears groupBy2 when groupBy is null (child depends on parent).
  // Effect C resets local hiddenGroupValues when any grouping param changes.
  // Merging these would lose the dependency chain — B must observe A's output.
  /* eslint-disable react-hooks/set-state-in-effect -- auto-clear invalid grouping from URL params */
  useEffect(() => {
    if (!canGroupBy) {
      // Clear both demographic and dataset grouping
      if (groupingColumnId != null || groupingMode !== 'column') {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev)
          next.delete('groupBy')
          next.delete('groupBy2')
          next.delete('groupMode')
          return next
        }, { replace: true })
        setGroupByClearedNotice(true)
        const timer = setTimeout(() => setGroupByClearedNotice(false), 4000)
        return () => clearTimeout(timer)
      }
    } else if (groupByAvailability.datasetGroupingAvailable && groupingColumnId != null) {
      // Switching to domain with 2+ datasets → clear demographic grouping
      // UNLESS the selected demographic is a shared one (available across all datasets)
      const isShared = sharedDemographics.some(sd => sd.anchor.id === groupingColumnId)
      if (!isShared) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev)
          next.delete('groupBy')
          next.delete('groupBy2')
          return next
        }, { replace: true })
      }
    } else if (!groupByAvailability.datasetGroupingAvailable && groupingMode === 'dataset') {
      // Switching away from multi-dataset domain → clear dataset grouping
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('groupBy2')
        next.delete('groupMode')
        return next
      }, { replace: true })
      setGroupByClearedNotice(true)
      const timer = setTimeout(() => setGroupByClearedNotice(false), 4000)
      return () => clearTimeout(timer)
    } else {
      setGroupByClearedNotice(false)
    }
  }, [canGroupBy, groupByAvailability.datasetGroupingAvailable, groupingColumnId, groupingMode, sharedDemographics, setSearchParams])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-clear second dimension when first dimension is cleared
  useEffect(() => {
    if (groupingColumnId == null && groupingColumnId2 != null) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('groupBy2')
        return next
      }, { replace: true })
    }
  }, [groupingColumnId, groupingColumnId2, setSearchParams])

  // Auto-clear group filters when grouping changes (column ID, column ID 2, or mode)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset group filters on grouping change
    setHiddenGroupValues([])
  }, [groupingColumnId, groupingColumnId2, groupingMode])

  // ── Auto-clear independent URL params when they become invalid ──
  // These 4 validations are independent (no cascading dependencies)
  // so they're safe in one effect with a single setSearchParams call.
  useEffect(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      let changed = false

      // Decompose: invalid when no domains selected or domain_aggregate
      if (decompose && !canDecompose) {
        next.delete('decompose'); changed = true
      }

      // Diverging: only valid for stacked_bar chart type
      if (divergingMode && chartType !== 'stacked_bar') {
        next.delete('diverging'); next.delete('divergingCenter'); changed = true
      }

      // Axis transform: log only valid for scalar bar/line/dumbbell + non-frequency
      if (axisTransform !== 'linear' && chartType) {
        const scalarBarTypes: ChartType[] = ['horizontal_bar', 'vertical_bar', 'line', 'dumbbell']
        const supportsLog = scalarBarTypes.includes(chartType) && metricType !== 'frequency_distribution'
        if (!supportsLog) { next.delete('axisTransform'); changed = true }
      }

      // Cross-tab: only valid for cross_tab chart type
      if (crossTabColumnId && chartType !== 'cross_tab') {
        next.delete('crossTabCol'); next.delete('crossTabDisplay'); changed = true
      }

      return changed ? next : prev
    }, { replace: true })
  }, [decompose, canDecompose, divergingMode, chartType, axisTransform, metricType, crossTabColumnId, setSearchParams])

  // Cross-tab query — only when cross_tab chart type + column selected
  const { data: crossTabData } = useQuery({
    queryKey: ['analysis-cross-tab', pid, selectedColumnIdsKey, crossTabColumnId],
    queryFn: () => {
      const rowColId = Array.from(selectedColumnIds)[0]
      return metricsApi.crossTabulation(pid, {
        row_column_id: rowColId,
        col_column_id: crossTabColumnId!,
        include_chi_square: true,
      })
    },
    enabled: !!pid && chartType === 'cross_tab' && selectedColumnIds.size === 1 && crossTabColumnId != null,
    staleTime: 60_000,
  })

  // Chart announcements (aria-live)
  const chartAnnouncement = useChartAnnouncements({
    isComputing,
    metricCount: selectedMetrics.length,
    chartType: activeChartType,
    groupingColumnId,
    groupingColumnId2,
    demographics: analysisColumnsData?.demographics ?? [],
    divergingMode,
    axisTransform,
  })

  // Comparison test type announcement (screen reader)
  const [compAnnouncement, setCompAnnouncement] = useState('')
  const prevCompTestType = useRef<string | null>(null)
  useEffect(() => {
    const currentType = comparisonData?.rows[0]?.test?.test_type ?? null
    if (currentType && prevCompTestType.current !== null && currentType !== prevCompTestType.current) {
      const labels: Record<string, string> = {
        independent_t_test: "Welch's t-test",
        one_way_anova: 'One-way ANOVA',
        mann_whitney_u: 'Mann-Whitney U test',
        kruskal_wallis: 'Kruskal-Wallis H test',
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ARIA announcement when comparison test type changes
      setCompAnnouncement(`Test changed to ${labels[currentType] || currentType}`)
    }
    prevCompTestType.current = currentType
  }, [comparisonData?.rows])

  // Build chart config for saving — useCallback so save/saveAs/unsaved detection share one reference
  const buildCurrentChartConfig = useCallback(() => ({
    title: chartTitle,
    subtitle: chartSubtitle,
    footnote: chartFootnote,
    sort: sortOrder,
    display,
    scaling,
    showChartN: showChartN || undefined,
    showGroupN: showGroupN || undefined,
    showVariableN: showVariableN !== 'off' ? showVariableN : undefined,
    showCI: showCI || undefined,
    selected_columns: Array.from(selectedColumnIds),
    selected_domains: Array.from(selectedDomainIds),
    metric_type: metricType,
    chart_type: chartTypeParam || undefined,
    grouping_column_id: groupingColumnId || undefined,
    grouping_column_id_2: groupingColumnId2 || undefined,
    grouping_mode: groupingMode !== 'column' ? groupingMode : undefined,
    decompose: decompose || undefined,
    exclude_values: excludeValues.length > 0 ? excludeValues : undefined,
    hiddenResponseOptions: hiddenResponseOptions.length > 0 ? hiddenResponseOptions : undefined,
    scaleOrder: scaleOrder !== 'natural' ? scaleOrder : undefined,
    formatting: JSON.stringify(formatting) !== JSON.stringify(DEFAULT_FORMATTING) ? formatting : undefined,
    custom_order: sortOrder === 'custom' && customOrder.length > 0 ? customOrder : undefined,
    label_mode: labelMode !== 'full' ? labelMode : undefined,
    hidden_group_values: hiddenGroupValues.length > 0 ? hiddenGroupValues : undefined,
    group_organization: groupOrganization !== 'variable-first' ? groupOrganization : undefined,
    proportion_config: metricType === 'proportion' ? {
      mode: proportionMode,
      operator: proportionOperator,
      threshold_numeric: proportionThreshold,
      threshold_values: proportionValues,
    } : undefined,
    diverging: divergingMode || undefined,
    diverging_center: divergingCenter || undefined,
    show_error_band: showErrorBand || undefined,
    line_style: lineStyle !== 'connected' ? lineStyle : undefined,
    line_overlay: lineOverlay || undefined,
    axis_transform: axisTransform !== 'linear' ? axisTransform : undefined,
    cross_tab_column_id: crossTabColumnId || undefined,
    cross_tab_display: crossTabDisplay !== 'count' ? crossTabDisplay : undefined,
    // R&C tab params
    rc_view: rcView !== 'correlations' ? rcView : undefined,
    corr_type: corrType !== 'pearson' ? corrType : undefined,
    sig_levels: sigLevels,
    bonferroni: bonferroniOn || undefined,
    cell_format: corrCellFormat !== 'r_stars' ? corrCellFormat : undefined,
    corr_colors: corrColors !== 'diverging_blue_red' ? corrColors : undefined,
    compare_by: compareBy || undefined,
    compare_by_2: compareBy2 || undefined,
    test_type: testType !== 'auto' ? testType : undefined,
    nonparametric: nonparametric,
    post_hoc_expanded: postHocExpanded,
    rc_chart_type: rcChartType !== 'comparison_table' ? rcChartType : undefined,
    exclude_groups: excludeGroups.length > 0 ? excludeGroups : undefined,
    rc_palette: rcPalette !== 'default' ? rcPalette : undefined,
    show_scatter: showScatter || undefined,
    show_reg_line: showRegLine,
    show_jitter: showJitter || undefined,
  }), [
    chartTitle, chartSubtitle, chartFootnote, sortOrder, display, scaling,
    showChartN, showGroupN, showVariableN, showCI,
    selectedColumnIds, selectedDomainIds, metricType, chartTypeParam,
    groupingColumnId, groupingColumnId2, groupingMode, decompose, excludeValues, hiddenResponseOptions, scaleOrder, formatting,
    customOrder, labelMode, hiddenGroupValues, groupOrganization,
    proportionMode, proportionOperator, proportionThreshold, proportionValues,
    divergingMode, divergingCenter, showErrorBand, lineStyle, lineOverlay, axisTransform,
    crossTabColumnId, crossTabDisplay,
    rcView, corrType, sigLevels, bonferroniOn, corrCellFormat, corrColors, compareBy, compareBy2, testType, nonparametric, postHocExpanded, rcChartType, showScatter, showRegLine, showJitter,
    excludeGroups, rcPalette,
  ])

  // Relevant statistical tests — filter to those matching selected metrics/domains
  // On Descriptives tab, only show Cronbach's alpha (reliability)
  const relevantTests = useMemo(() => {
    if (!allTests.length) return []
    // Descriptives tab: reliability tests target a variable group chosen in the dialog,
    // independent of which metric is charted — so don't gate them on chart selection (#372).
    if (activeTab === 'descriptives') {
      return allTests.filter(t => t.test_type === 'cronbachs_alpha' || t.test_type === 'split_half')
    }
    if (!selectedMetricIds.length) return []
    const selectedDomains = new Set<number>()
    for (const m of selectedMetrics) {
      if (m.input_source_type === 'dataset_domain') {
        selectedDomains.add(m.input_source_id)
      }
    }
    const metricIdSet = new Set(selectedMetricIds)
    return allTests.filter(t => {
      if (t.target_type === 'metric_definition') return metricIdSet.has(t.target_id)
      if (t.target_type === 'analysis_domain') return selectedDomains.has(t.target_id)
      return false
    })
  }, [allTests, selectedMetricIds, selectedMetrics, activeTab])

  // ── Mutations ──────────────────────────────────────────────────────────

  const computeAllMutation = useMutation({
    mutationFn: (staleOnly: boolean = true) => metricsApi.computeAll(pid, staleOnly),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metrics', pid] })
      // Re-trigger quick-compute to pick up freshly computed results
      const columnIds = columnsRaw ? columnsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0) : []
      const domainIds = domainsRaw ? domainsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0) : []
      triggerCompute({ columnIds, domainIds, metricType, config: quickComputeConfig, groupingColumnId, groupingColumnId2, groupingMode: groupingMode !== 'column' ? groupingMode : null, excludeValues, decompose: decompose || undefined })
    },
  })

  // Phase 4.7: DomainPickerDetail "Create scale score" — invokes the same
  // analysis-domains/{id}/create-score-metric endpoint the crosswalk uses.
  // Idempotent on the backend, so a stray double-click is safe.
  const createScoreMetricMutation = useMutation({
    mutationFn: (domainId: number) => domainsApi.createScoreMetric(pid, domainId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['metrics', pid] })
      if (data.computed) {
        toast.success('Scale score created')
      } else {
        toast.warning('Scale score created but could not be computed', {
          description: 'Check that members are paired across datasets.',
        })
      }
    },
    onError: () => {
      toast.error('Could not create scale score')
    },
  })

  // Material mutations
  const addToMaterialsMutation = useMutation({
    mutationFn: (data: { material_type: string; config: Record<string, unknown>; auto_name: string; source_tab?: string }) =>
      materialsApi.createMaterial(pid, defaultCollectionId!, data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
      queryClient.invalidateQueries({ queryKey: ['material-collections', pid] })
      // Set as active material (for memos and re-load).
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('element')  // clear any legacy alias
        next.set('material', String(created.id))
        return next
      }, { replace: true })
      // Toast with undo
      toast.success('Added to Materials', {
        action: {
          label: 'Undo',
          onClick: () => deleteMaterialMutation.mutate(created.id),
        },
        duration: 5000,
      })
    },
  })

  const renameMaterialMutation = useMutation({
    mutationFn: ({ materialId, name }: { materialId: number; name: string }) =>
      materialsApi.updateMaterial(pid, defaultCollectionId!, materialId, { custom_name: name || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
      queryClient.invalidateQueries({ queryKey: ['materials-all', pid] })
    },
  })

  const deleteMaterialMutation = useMutation({
    mutationFn: (materialId: number) =>
      materialsApi.deleteMaterial(pid, defaultCollectionId!, materialId),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
      queryClient.invalidateQueries({ queryKey: ['material-collections', pid] })
      if (activeMaterialId === deletedId) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev)
          next.delete('material')
          next.delete('element')  // legacy alias
          return next
        }, { replace: true })
      }
    },
  })

  // #375a: reorder materials with optimistic cache update + rollback.
  const reorderMaterialsMutation = useMutation({
    mutationFn: (orderedIds: number[]) =>
      materialsApi.reorder(pid, defaultCollectionId!, orderedIds),
    onMutate: async (orderedIds: number[]) => {
      const key = ['material-collection-detail', pid, defaultCollectionId]
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<MaterialCollectionDetailResponse>(key)
      if (previous?.materials) {
        const byId = new Map(previous.materials.map(m => [m.id, m]))
        const reordered = orderedIds.map(id => byId.get(id)).filter((m): m is MaterialResponse => !!m)
        queryClient.setQueryData(key, { ...previous, materials: reordered })
      }
      return { key, previous }
    },
    onError: (_e, _ids, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(ctx.key, ctx.previous)
      toast.error('Could not reorder materials')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
    },
  })

  // Statistical test mutations
  const createTestMutation = useMutation({
    mutationFn: (data: { test_type: string; target_type: string; target_id: number }) =>
      statisticalTestsApi.create(pid, data),
    onSuccess: async (created) => {
      setTestDialog({ open: false, step: 1, type: null, targetId: 0 })
      // Auto-compute the newly created test
      try {
        await statisticalTestsApi.compute(pid, created.id)
      } catch { /* ignore compute errors — test stays stale */ }
      queryClient.invalidateQueries({ queryKey: ['statistical-tests', pid] })
    },
  })

  // #395: guard against creating a byte-identical statistical test. A test is a
  // duplicate when it shares (test_type, target_type, target_id) with an existing
  // one — same construct + same item set. Skip-with-toast instead of stacking
  // identical rows (the reliability panel was the worst-felt case).
  const submitTest = (testType: string, targetType: string, targetId: number) => {
    const existing = allTests.find(
      t => t.test_type === testType && t.target_type === targetType && t.target_id === targetId,
    )
    if (existing) {
      const isReliability = testType === 'cronbachs_alpha' || testType === 'split_half'
      toast.info(
        isReliability
          ? `A ${TEST_TYPE_LABELS[testType] || 'reliability'} test for ${existing.target_label || 'this scale'} already exists.`
          : `This test for ${existing.target_label || 'this target'} already exists.`,
      )
      setTestDialog({ open: false, step: 1, type: null, targetId: 0 })
      return
    }
    createTestMutation.mutate({ test_type: testType, target_type: targetType, target_id: targetId })
  }

  const computeTestMutation = useMutation({
    mutationFn: (testId: number) => statisticalTestsApi.compute(pid, testId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statistical-tests', pid] })
    },
  })

  const deleteTestMutation = useMutation({
    mutationFn: (testId: number) => statisticalTestsApi.delete(pid, testId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statistical-tests', pid] })
    },
  })

  const computeAllTestsMutation = useMutation({
    mutationFn: (staleOnly: boolean) => statisticalTestsApi.computeAll(pid, staleOnly),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statistical-tests', pid] })
    },
  })

  // ── Palette helpers ────────────────────────────────────────────────────

  const loadMaterial = useCallback((element: MaterialResponse) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (element.config || {}) as Record<string, any>
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('element')  // clear any legacy alias
      next.set('material', String(element.id))

      // Switch to correct tab
      if (element.source_tab && element.source_tab !== 'descriptives') {
        next.set('tab', element.source_tab === 'correlations' || element.source_tab === 'comparisons' ? 'rc' : element.source_tab)
      } else {
        next.delete('tab')
      }

      // Apply column/domain selections
      if (config.column_ids?.length > 0) next.set('columns', config.column_ids.join(','))
      else next.delete('columns')
      if (config.domain_ids?.length > 0) next.set('domains', config.domain_ids.join(','))
      else next.delete('domains')
      if (config.metric_type) next.set('metricType', config.metric_type)
      else next.delete('metricType')

      // Chart display config
      if (config.sort) next.set('sort', config.sort)
      else next.delete('sort')
      if (config.display) next.set('display', config.display)
      else next.delete('display')
      if (config.scaling) next.set('scaling', config.scaling)
      else next.delete('scaling')
      if (config.showChartN) next.set('showChartN', '1')
      else next.delete('showChartN')
      if (config.showGroupN) next.set('showGroupN', '1')
      else next.delete('showGroupN')
      if (config.showVariableN) next.set('showVariableN', config.showVariableN)
      else next.delete('showVariableN')
      if (config.showCI) next.set('showCI', '1')
      else next.delete('showCI')

      const ct = config.chart_type === 'bar' ? 'horizontal_bar' : config.chart_type
      if (ct) next.set('chartType', ct)
      else next.delete('chartType')

      if (config.grouping_column_id) next.set('groupBy', String(config.grouping_column_id))
      else next.delete('groupBy')
      if (config.grouping_column_id_2) next.set('groupBy2', String(config.grouping_column_id_2))
      else next.delete('groupBy2')
      if (config.grouping_mode && config.grouping_mode !== 'column') next.set('groupMode', config.grouping_mode)
      else next.delete('groupMode')
      if (config.exclude_values?.length) next.set('exclude', config.exclude_values.join(','))
      else next.delete('exclude')

      if (config.decompose) next.set('decompose', '1')
      else next.delete('decompose')
      if (config.diverging) next.set('diverging', '1')
      else next.delete('diverging')
      if (config.diverging_center) next.set('divergingCenter', config.diverging_center)
      else next.delete('divergingCenter')
      if (config.axis_transform && config.axis_transform !== 'linear') next.set('axisTransform', config.axis_transform)
      else next.delete('axisTransform')
      if (config.cross_tab_column_id) next.set('crossTabCol', String(config.cross_tab_column_id))
      else next.delete('crossTabCol')
      if (config.cross_tab_display && config.cross_tab_display !== 'count') next.set('crossTabDisplay', config.cross_tab_display)
      else next.delete('crossTabDisplay')

      // R&C tab params
      if (config.rc_view && config.rc_view !== 'correlations') next.set('rcView', config.rc_view)
      else next.delete('rcView')
      if (config.corr_type && config.corr_type !== 'pearson') next.set('corrType', config.corr_type)
      else next.delete('corrType')
      if (config.sig_levels) {
        const sl = config.sig_levels
        next.set('sigLevels', [sl.show_05 ? '05' : '', sl.show_01 ? '01' : '', sl.show_001 ? '001' : ''].filter(Boolean).join(',') || '05')
      }
      if (config.bonferroni) next.set('bonferroni', '1')
      else next.delete('bonferroni')
      if (config.cell_format && config.cell_format !== 'r_stars') next.set('cellFormat', config.cell_format)
      else next.delete('cellFormat')
      if (config.corr_colors && config.corr_colors !== 'diverging_blue_red') next.set('corrColors', config.corr_colors)
      else next.delete('corrColors')
      if (config.compare_by) next.set('compareBy', String(config.compare_by))
      else next.delete('compareBy')
      if (config.compare_by_2) next.set('compareBy2', String(config.compare_by_2))
      else next.delete('compareBy2')
      if (config.test_type && config.test_type !== 'auto') next.set('testType', config.test_type)
      else next.delete('testType')
      if (config.nonparametric === true) next.set('nonparametric', '1')
      else next.delete('nonparametric')
      if (config.rc_chart_type && config.rc_chart_type !== 'table') next.set('rcChartType', config.rc_chart_type)
      else next.delete('rcChartType')
      if (config.exclude_groups?.length) next.set('excludeGroups', config.exclude_groups.join(','))
      else next.delete('excludeGroups')
      if (config.rc_palette && config.rc_palette !== 'default') next.set('rcPalette', config.rc_palette)
      else next.delete('rcPalette')
      if (config.show_scatter) next.set('showScatter', '1')
      else next.delete('showScatter')
      if (config.show_reg_line === false) next.set('showRegLine', '0')
      else next.delete('showRegLine')
      if (config.show_jitter) next.set('showJitter', '1')
      else next.delete('showJitter')

      return next
    }, { replace: true })

    setChartTitle(config.title || '')
    setChartSubtitle(config.subtitle || '')
    setChartFootnote(config.footnote || '')
    setHiddenResponseOptions(config.hiddenResponseOptions || [])
    setScaleOrder(config.scaleOrder || 'natural')
    setFormatting({ ...DEFAULT_FORMATTING, ...(config.formatting || {}) })
    setCustomOrder(config.custom_order || [])
    setLabelMode(config.label_mode || 'full')
    setHiddenGroupValues(config.hidden_group_values || [])
    setGroupOrganization(
      config.group_organization === 'question-first'
        ? 'variable-first'  // backward-compat alias for legacy saved Material configs (#309)
        : (config.group_organization || 'variable-first')
    )
    setShowErrorBand(!!config.show_error_band)
    setLineStyle(config.line_style || 'connected')
    setLineOverlay(!!config.line_overlay)
    setPostHocExpanded(config.post_hoc_expanded !== false)
    if (config.proportion_config) {
      setProportionMode(config.proportion_config.mode || 'numeric')
      setProportionOperator(config.proportion_config.operator || '>=')
      setProportionThreshold(config.proportion_config.threshold_numeric ?? 4)
      setProportionValues(config.proportion_config.threshold_values || [])
    } else {
      setProportionMode('values')
      setProportionOperator('>=')
      setProportionThreshold(4)
      setProportionValues([])
    }
    setMetricTypePrompt(null)
  }, [setSearchParams])

  // Auto-load material when navigating from canvas with ?element=ID
  const autoLoadedRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeMaterialId || !materials.length) return
    if (columnsRaw || domainsRaw) return // already has chart state
    if (autoLoadedRef.current === activeMaterialId) return // already loaded this one
    const m = materials.find(x => x.id === activeMaterialId)
    if (m) {
      autoLoadedRef.current = activeMaterialId
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot auto-load of the active material's chart state (guarded by autoLoadedRef); loadMaterial sets state
      loadMaterial(m)
    }
  }, [activeMaterialId, materials, columnsRaw, domainsRaw, loadMaterial])

  /** Generate auto-name from the surface being saved (#419 — an R&C save
   * must not inherit the stale Descriptives metric type). */
  const generateAutoName = useCallback(() => {
    const columnLabel = (id: number | null) => {
      if (id == null) return null
      const col = columnsData?.columns.find(c => c.id === id)
      return col ? (col.column_name || col.column_text || col.column_code) : null
    }
    return generateMaterialAutoName({
      activeTab,
      metricType,
      metricLabels: selectedMetrics.map(m => metricDisplayLabel(m)),
      rcView,
      rcChartType,
      showScatter,
      compareByLabel: columnLabel(compareBy),
      compareBy2Label: columnLabel(compareBy2),
    })
  }, [activeTab, metricType, selectedMetrics, rcView, rcChartType, showScatter, compareBy, compareBy2, columnsData])

  const handleAddToMaterials = useCallback(() => {
    if (!defaultCollectionId || !hasAnySelection) return
    const config = buildCurrentChartConfig()
    // Transform to material config shape: selected_columns → column_ids, etc.
    const { selected_columns, selected_domains, ...rest } = config
    const materialConfig: Record<string, unknown> = {
      ...rest,
      column_ids: selected_columns,
      domain_ids: selected_domains,
    }
    let materialType: string
    if (activeTab === 'rc') {
      if (rcView === 'comparisons') {
        materialType = rcChartType === 'comparison_table' ? 'comparison_table' : rcChartType || 'comparison_table'
      } else {
        materialType = showScatter ? 'scatter_matrix' : 'correlation_matrix'
      }
    } else {
      materialType = chartTypeParam || chartType || 'horizontal_bar'
    }
    addToMaterialsMutation.mutate({
      material_type: materialType,
      config: materialConfig,
      auto_name: generateAutoName(),
      source_tab: activeTab === 'rc' ? (rcView === 'comparisons' ? 'comparisons' : 'correlations') : 'descriptives',
    })
  }, [defaultCollectionId, hasAnySelection, buildCurrentChartConfig, chartTypeParam, chartType, addToMaterialsMutation, generateAutoName, activeTab, rcView, rcChartType, showScatter])

  const handleChartTypeSelect = useCallback((type: ChartType) => {
    const req = chartTypeInfo.requiresMetricTypeChange[type]
    if (req === null || req === undefined) {
      // Compatible — just switch chart type
      setUrlParam('chartType', type)
      setMetricTypePrompt(null)
    } else if (req.length === 1) {
      // Single compatible metric type — switch silently
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('chartType', type)
        next.set('metricType', req[0])
        return next
      }, { replace: true })
      setMetricTypePrompt(null)
    } else {
      // Multiple options — show prompt
      setMetricTypePrompt({ chartType: type, options: req })
    }
  }, [chartTypeInfo, setUrlParam, setSearchParams])

  const handleMetricTypePromptSelect = useCallback((mt: MetricType) => {
    if (!metricTypePrompt) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('chartType', metricTypePrompt.chartType)
      next.set('metricType', mt)
      return next
    }, { replace: true })
    setMetricTypePrompt(null)
  }, [metricTypePrompt, setSearchParams])

  // ── Active analysis name ───────────────────────────────────────────────

  const activeMaterial = materials.find(e => e.id === activeMaterialId)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="bg-mm-surface border-b px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <h1 className="text-lg font-semibold">
          {activeMaterial ? (activeMaterial.custom_name || activeMaterial.auto_name) : 'Quantitative Analysis'}
        </h1>
        <div className="flex-1" />
        <Link to={`/projects/${pid}/datasets/variable-groups`}>
          <Button variant="ghost" size="sm" className="text-mm-text-muted">
            <Layers className="w-4 h-4 mr-1" />
            Variable Groups
          </Button>
        </Link>
        {selectedMetrics.some(m => m.metric_type !== 'frequency_distribution' && m.results.length > 0) && (
          <Button variant="outline" size="sm" onClick={() => {
            const ids = selectedMetrics
              .filter(m => m.metric_type !== 'frequency_distribution' && m.results.length > 0)
              .map(m => m.id)
            metricsApi.rowMatrix(Number(pid), ids, 'csv')
          }} title="Export record x variable matrix as CSV">
            <Download className="w-3 h-3 mr-1" /> Export Matrix
          </Button>
        )}
        {hasAnySelection && defaultCollectionId && (
          <Button size="sm" onClick={handleAddToMaterials} disabled={addToMaterialsMutation.isPending}>
            <SwatchBook className="w-3 h-3 mr-1" />
            Add to Materials
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div
        className="bg-mm-surface border-b px-4 flex items-end gap-0 flex-shrink-0"
        role="tablist"
        aria-label="Analysis tabs"
        onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
          const tabs: ('descriptives' | 'rc' | 'data_quality')[] = ['descriptives', 'rc', 'data_quality']
          const idx = tabs.indexOf(activeTab)
          let next: typeof tabs[number] | undefined
          if (e.key === 'ArrowRight') {
            next = tabs[(idx + 1) % tabs.length]
          } else if (e.key === 'ArrowLeft') {
            next = tabs[(idx - 1 + tabs.length) % tabs.length]
          } else if (e.key === 'Home') {
            next = 'descriptives'
          } else if (e.key === 'End') {
            next = 'data_quality'
          }
          if (next) {
            e.preventDefault()
            setUrlParam('tab', next)
            const target = (e.currentTarget as HTMLDivElement).querySelector(`[data-tab="${next}"]`) as HTMLButtonElement | null
            target?.focus()
          }
        }}
      >
        {(['descriptives', 'rc', 'data_quality'] as const).map(tab => {
          const isActive = activeTab === tab
          const label = tab === 'descriptives' ? 'Descriptives' : tab === 'rc' ? 'Relationships & Comparisons' : 'Data Quality'
          return (
            <button
              key={tab}
              id={`tab-${tab}`}
              role="tab"
              data-tab={tab}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                isActive
                  ? 'border-mm-accent text-mm-text'
                  : 'border-transparent text-mm-text-muted hover:text-mm-text-secondary hover:border-mm-border-subtle'
              }`}
              onClick={() => setUrlParam('tab', tab)}
            >
              {label}
            </button>
          )
        })}
      </div>

      <PanelGroup
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-1"
      >
        {/* Left sidebar */}
        <Panel id="sidebar" defaultSize="22" minSize="15" maxSize="32">
          <AnalysisSidebar
            pid={pid}
            activeTab={activeTab}
            setUrlParam={setUrlParam}
            setSearchParams={setSearchParams}
            materials={materials}
            activeMaterialId={activeMaterialId}
            onLoadMaterial={loadMaterial}
            onDeleteMaterial={(id) => deleteMaterialMutation.mutate(id)}
            onRenameMaterial={(id, name) => renameMaterialMutation.mutate({ materialId: id, name })}
            onReorderMaterials={(ids) => reorderMaterialsMutation.mutate(ids)}
            selectedColumnIds={selectedColumnIds}
            selectedDomainIds={selectedDomainIds}
            onEditColumn={handleEditAnalysisColumn}
            domainsFull={domainsData?.domains}
            metricsList={allMetrics}
            onCreateScoreMetric={(domainId) => createScoreMetricMutation.mutate(domainId)}
            isCreatingScoreMetric={createScoreMetricMutation.isPending}
            selectedMetricIdHint={metricIdHint}
            onPickMetric={(metricId) => setUrlParam('metric_id', String(metricId))}
            selectedMetrics={selectedMetrics}
            hasAnySelection={hasAnySelection}
            isComputing={isComputing}
            chartType={chartType}
            metricType={metricType}
            sortOrder={sortOrder}
            display={display}
            scaling={scaling}
            scaleOrder={scaleOrder}
            groupingColumnId={groupingColumnId}
            groupingColumnId2={groupingColumnId2}
            groupingMode={groupingMode}
            excludeValues={excludeValues}
            hiddenResponseOptions={hiddenResponseOptions}
            formatting={formatting}
            showCI={showCI}
            showChartN={showChartN}
            showGroupN={showGroupN}
            showVariableN={showVariableN}
            showSampleSizes={showSampleSizes}
            labelMode={labelMode}
            hasShortLabels={hasShortLabels}
            customOrder={customOrder}
            metricLabelsMap={metricLabelsMap}
            responseLabels={responseLabels}
            canGroupBy={canGroupBy}
            groupByDisabledReason={groupByDisabledReason}
            relevantDatasetIds={relevantDatasetIds}
            chartTitle={chartTitle}
            chartSubtitle={chartSubtitle}
            chartFootnote={chartFootnote}
            hiddenGroupValues={hiddenGroupValues}
            availableGroupValues={availableGroupValues}
            groupOrganization={groupOrganization}
            proportionMode={proportionMode}
            proportionOperator={proportionOperator}
            proportionThreshold={proportionThreshold}
            proportionValues={proportionValues}
            availableScaleValues={availableScaleValues}
            divergingMode={divergingMode}
            divergingCenter={divergingCenter}
            divergingCenterAuto={divergingCenterAuto}
            hasMixedScales={hasMixedScales}
            showErrorBand={showErrorBand}
            lineStyle={lineStyle}
            lineOverlay={lineOverlay}
            axisTransform={axisTransform}
            crossTabColumnId={crossTabColumnId}
            crossTabDisplay={crossTabDisplay}
            crossTabEligibleColumns={crossTabEligibleColumns}
            decompose={decompose}
            canDecompose={canDecompose}
            groupByAvailability={groupByAvailability}
            sharedDemographics={sharedDemographics}
            onFormattingChange={patch => setFormatting(prev => ({ ...prev, ...patch }))}
            onLabelModeChange={setLabelMode}
            onCustomOrderChange={setCustomOrder}
            onScaleOrderChange={v => setScaleOrder(v as 'natural' | 'reversed')}
            onHiddenResponseOptionsChange={setHiddenResponseOptions}
            onTitleChange={setChartTitle}
            onSubtitleChange={setChartSubtitle}
            onFootnoteChange={setChartFootnote}
            onShowErrorBandChange={setShowErrorBand}
            onLineStyleChange={setLineStyle}
            onLineOverlayChange={setLineOverlay}
            onHiddenGroupValuesChange={setHiddenGroupValues}
            onGroupOrganizationChange={setGroupOrganization}
            onProportionConfigChange={config => {
              if (config.mode === 'numeric') {
                setProportionMode('numeric')
                if (config.operator !== undefined) setProportionOperator(config.operator)
                if (config.threshold_numeric !== undefined) setProportionThreshold(config.threshold_numeric)
              } else {
                setProportionMode('values')
                if (config.threshold_values !== undefined) setProportionValues(config.threshold_values)
              }
            }}
            rcView={rcView}
            corrType={corrType}
            sigLevelsRaw={sigLevelsRaw}
            bonferroniOn={bonferroniOn}
            corrMatrixData={corrMatrixData}
            showScatter={showScatter}
            showRegLine={showRegLine}
            showJitter={showJitter}
            corrCellFormat={corrCellFormat}
            corrColors={corrColors}
            compareBy={compareBy}
            compareBy2={compareBy2}
            testType={testType}
            nonparametric={nonparametric}
            excludeGroups={excludeGroups}
            rcPalette={rcPalette}
            comparisonData={comparisonData}
            analysisColumnsData={analysisColumnsData}
            hasComparisonSelection={hasComparisonSelection}
            hasRcSelection={hasRcSelection}
            dqView={dqView}
            dqIncludeNA={dqIncludeNA}
            dqIncludeEmpty={dqIncludeEmpty}
            dqSort={dqSort}
            dqColumnIds={dqColumnIds}
            dqIsMultiDataset={dqIsMultiDataset}
            dqHasNumericVars={dqHasNumericVars}
            mcarIsPending={mcarMutation.isPending}
            mcarResult={mcarMutation.data ?? null}
            mcarError={mcarMutation.error as Error | null}
            onMcarRun={() => mcarMutation.mutate()}
          />
        </Panel>

        {/* Resize handle */}
        <PanelResizeHandle className="w-1.5 bg-mm-bg hover:bg-blue-200 dark:hover:bg-blue-800/40 active:bg-blue-300 dark:active:bg-blue-700/50 transition-colors cursor-col-resize flex items-center justify-center">
          <div className="w-0.5 h-8 rounded-full bg-mm-border-medium" />
        </PanelResizeHandle>

        {/* Main area */}
        <Panel id="main" defaultSize="78" minSize="50">
          <div className="h-full overflow-y-auto p-4">
            {activeTab === 'rc' ? (
              <CorrelationsComparisonsContent
                pid={pid}
                rcView={rcView}
                hasRcSelection={hasRcSelection}
                rcColumnIds={rcColumnIds}
                rcDomainIds={rcDomainIds}
                corrType={corrType}
                corrMatrixData={corrMatrixData}
                isCorrFetching={isCorrFetching}
                showScatter={showScatter}
                scatterMatrixData={scatterMatrixData}
                isScatterFetching={isScatterFetching}
                showRegLine={showRegLine}
                showJitter={showJitter}
                corrCellFormat={corrCellFormat}
                corrColors={corrColors}
                sigLevels={sigLevels}
                bonferroniOn={bonferroniOn}
                hasComparisonSelection={hasComparisonSelection}
                compareBy={compareBy}
                compareBy2={compareBy2}
                testType={testType}
                nonparametric={nonparametric}
                rcChartType={rcChartType}
                comparisonData={comparisonData}
                isComparisonFetching={isComparisonFetching}
                excludeGroups={excludeGroups}
                rcFormatting={rcFormatting}
                postHocExpanded={postHocExpanded}
                onPostHocToggle={() => setPostHocExpanded(v => !v)}
                setUrlParam={setUrlParam}
              />
            ) : activeTab === 'data_quality' ? (
              <div className="space-y-4" role="tabpanel" id="tabpanel-data_quality" aria-labelledby="tab-data_quality">
                <DataQualityContent
                  pid={pid}
                  hasDqSelection={hasDqSelection}
                  dqView={dqView}
                  dqIncludeNA={dqIncludeNA}
                  dqIncludeEmpty={dqIncludeEmpty}
                  dqSort={dqSort}
                  dqColumnIds={dqColumnIds}
                  dqIsMultiDataset={dqIsMultiDataset}
                  dqSummaryData={dqSummaryData}
                  dqSummaryError={dqSummaryError as Error | null}
                  isDqSummaryFetching={isDqSummaryFetching}
                  dqPatternsData={dqPatternsData}
                  isDqPatternsFetching={isDqPatternsFetching}
                  selectedDomainIds={selectedDomainIds}
                  selectedColumnIds={selectedColumnIds}
                  setUrlParam={setUrlParam}
                />
              </div>
            ) : <div role="tabpanel" id="tabpanel-descriptives" aria-labelledby="tab-descriptives">
            {/* Chart type toolbar */}
            {hasAnySelection && selectedMetrics.length > 0 && (
              <div className="mb-4 space-y-2" data-exclude-export="">
                <ChartTypeToolbar
                  available={chartTypeInfo.available}
                  active={activeChartType || chartTypeInfo.default}
                  onSelect={handleChartTypeSelect}
                  requiresMetricTypeChange={chartTypeInfo.requiresMetricTypeChange}
                  hasGrouping={hasGrouping}
                  disabledReasons={chartTypeInfo.disabledReasons}
                />

                {/* Metric type switch prompt */}
                {metricTypePrompt && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded text-xs text-blue-700 dark:text-blue-300">
                    <span>Show as:</span>
                    {metricTypePrompt.options.map(mt => (
                      <label key={mt} className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name="metric-type-switch"
                          className="w-3 h-3 text-blue-600 dark:text-blue-400"
                          onChange={() => handleMetricTypePromptSelect(mt)}
                        />
                        {METRIC_TYPE_OPTIONS.find(o => o.value === mt)?.label || mt}
                      </label>
                    ))}
                    <button
                      className="ml-auto text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 text-xs"
                      onClick={() => setMetricTypePrompt(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Screen reader announcements */}
            <div role="status" aria-live="polite" className="sr-only" id="chart-announcements">
              {chartAnnouncement}
              {compAnnouncement}
            </div>

            {/* Group By auto-clear notice */}
            {groupByClearedNotice && (
              <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300" role="status">
                Group By was cleared — not available for the current selection
              </div>
            )}

            {/* Chart rendering */}
            <div className="bg-mm-surface rounded-lg border">
              <ChartErrorBoundary>
                <AnalysisChartRenderer
                  hasAnySelection={hasAnySelection}
                  isComputing={isComputing}
                  qcError={qcError}
                  hasResults={hasResults}
                  chartType={chartType}
                  onComputeAll={() => computeAllMutation.mutate(false)}
                  isComputeAllPending={computeAllMutation.isPending}
                  orderedMetrics={orderedMetrics}
                  selectedMetrics={selectedMetrics}
                  colorMap={colorMap}
                  activeLabelMap={activeLabelMap}
                  chartTitle={chartTitle}
                  chartSubtitle={chartSubtitle}
                  chartFootnote={chartFootnote}
                  display={display}
                  scaling={scaling}
                  showChartN={showChartN}
                  showGroupN={showGroupN}
                  showVariableN={showVariableN}
                  showCI={showCI}
                  metricType={metricType}
                  sortOrder={sortOrder}
                  axisTransform={axisTransform}
                  formatting={formatting}
                  hiddenResponseOptions={hiddenResponseOptions}
                  scaleOrder={scaleOrder}
                  hiddenGroupValues={hiddenGroupValues}
                  groupOrganization={groupOrganization}
                  responseLabels={responseLabels}
                  divergingMode={divergingMode}
                  divergingCenter={divergingCenter}
                  divergingCenterAuto={divergingCenterAuto}
                  hasMixedScales={hasMixedScales}
                  hasMixedTypes={hasMixedTypes}
                  showErrorBand={showErrorBand}
                  lineStyle={lineStyle}
                  lineOverlay={lineOverlay}
                  proportionMode={proportionMode}
                  proportionOperator={proportionOperator}
                  proportionThreshold={proportionThreshold}
                  proportionValues={proportionValues}
                  crossTabColumnId={crossTabColumnId}
                  crossTabDisplay={crossTabDisplay}
                  crossTabData={crossTabData}
                />
              </ChartErrorBoundary>
            </div>

            {/* Statistics section */}
            {(relevantTests.length > 0 || allTests.length > 0 || hasAnySelection) && (
              <div className="mt-4 bg-mm-surface rounded-lg border">
                <button
                  className="w-full flex items-center gap-1 px-4 py-3 text-sm font-medium text-mm-text-secondary"
                  onClick={() => setStatsExpanded(!statsExpanded)}
                  aria-expanded={statsExpanded}
                  aria-controls="statistics-panel"
                >
                  {statsExpanded
                    ? <ChevronDown className="w-4 h-4" />
                    : <ChevronRight className="w-4 h-4" />
                  }
                  <FlaskConical className="w-4 h-4" />
                  {activeTab === 'descriptives' ? 'Reliability' : 'Statistics'}
                  {relevantTests.length > 0 && (
                    <span className="text-xs text-mm-text-faint ml-1">({relevantTests.length})</span>
                  )}
                  {relevantTests.some(t => t.stale) && (
                    <span className="ml-1 w-2 h-2 rounded-full bg-amber-400 inline-block" title="Some tests are stale">
                      <span className="sr-only">stale</span>
                    </span>
                  )}
                </button>
                {statsExpanded && (
                  <div id="statistics-panel" className="px-4 pb-4 space-y-2">
                    {relevantTests.length === 0 && (
                      <p className="text-sm text-mm-text-faint italic">
                        {activeTab === 'descriptives'
                          ? 'No reliability tests yet — add one with the button below.'
                          : 'No statistical tests for the selected metrics.'}
                      </p>
                    )}
                    {relevantTests.map(test => (
                      <div key={test.id} className="flex items-start gap-2 p-2 rounded border text-sm">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-mm-text">
                              {TEST_TYPE_LABELS[test.test_type] || test.test_type}
                            </span>
                            {test.target_label && (
                              <span className="text-mm-text-faint">— {test.target_label}</span>
                            )}
                            {test.stale && (
                              <span className="ml-1 w-2 h-2 rounded-full bg-amber-400 inline-block flex-shrink-0" title="Stale — recompute needed">
                                <span className="sr-only">stale</span>
                              </span>
                            )}
                          </div>
                          <div className="text-mm-text-secondary mt-0.5 font-mono text-xs">
                            {formatTestResult(test)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => computeTestMutation.mutate(test.id)}
                            disabled={computeTestMutation.isPending}
                            title="Compute"
                            aria-label="Compute test"
                          >
                            <Play className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
                            onClick={() => deleteTestMutation.mutate(test.id)}
                            title="Delete"
                            aria-label="Delete test"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {/* Multiple comparisons warning */}
                    {(() => {
                      const tTests = relevantTests.filter(t => t.test_type === 'independent_t_test' && t.result_data)
                      return tTests.length > 3 ? (
                        <div className="flex items-start gap-1.5 p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>Multiple t-tests detected. Consider applying Bonferroni correction (adjusted α = 0.05 / {tTests.length}).</span>
                        </div>
                      ) : null
                    })()}
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setTestDialog({ open: true, step: 1, type: null, targetId: 0 })}
                      >
                        <Plus className="w-3 h-3 mr-1" /> {activeTab === 'descriptives' ? 'Add Reliability Test' : 'Add Statistical Test'}
                      </Button>
                      {relevantTests.some(t => t.stale) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => computeAllTestsMutation.mutate(true)}
                          disabled={computeAllTestsMutation.isPending}
                        >
                          <RefreshCw className={`w-3 h-3 mr-1 ${computeAllTestsMutation.isPending ? 'animate-spin' : ''}`} />
                          Compute Stale
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            </div>}
          </div>
        </Panel>
      </PanelGroup>

      {/* Create Statistical Test Dialog */}
      <Dialog open={testDialog.open} onOpenChange={open => {
        setTestDialog(open ? { ...testDialog, open } : { open: false, step: 1, type: null, targetId: 0 })
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Statistical Test</DialogTitle>
            <DialogDescription>
              {testDialog.step === 1 ? 'What would you like to test?' : 'Select a target'}
            </DialogDescription>
          </DialogHeader>

          {testDialog.step === 1 && (
            <div className="space-y-2">
              <button
                className="w-full text-left p-3 rounded border hover:bg-mm-surface-hover transition-colors"
                onClick={() => setTestDialog(prev => ({ ...prev, type: 'cronbachs_alpha', step: 2 }))}
              >
                <div className="font-medium text-sm">Reliability (Cronbach's Alpha)</div>
                <div className="text-xs text-mm-text-muted mt-0.5">Assess internal consistency of a group's variables</div>
              </button>
              <button
                className="w-full text-left p-3 rounded border hover:bg-mm-surface-hover transition-colors"
                onClick={() => setTestDialog(prev => ({ ...prev, type: 'split_half', step: 2 }))}
              >
                <div className="font-medium text-sm">Split-Half Reliability</div>
                <div className="text-xs text-mm-text-muted mt-0.5">Assess reliability by correlating odd/even item-half scores</div>
              </button>
              {activeTab !== 'descriptives' && (
                <button
                  className="w-full text-left p-3 rounded border hover:bg-mm-surface-hover transition-colors"
                  onClick={() => setTestDialog(prev => ({ ...prev, type: 'group_difference', step: 2 }))}
                >
                  <div className="font-medium text-sm">Group Difference (T-Test / ANOVA)</div>
                  <div className="text-xs text-mm-text-muted mt-0.5">Compare means between groups on a metric</div>
                </button>
              )}
            </div>
          )}

          {testDialog.step === 2 && (testDialog.type === 'cronbachs_alpha' || testDialog.type === 'split_half') && (
            <div className="space-y-3">
              <label className="text-sm font-medium">Variable Group</label>
              <Select
                value={testDialog.targetId ? String(testDialog.targetId) : ''}
                onValueChange={v => setTestDialog(prev => ({ ...prev, targetId: Number(v) }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a group..." />
                </SelectTrigger>
                <SelectContent>
                  {(domainsData?.domains ?? []).map(d => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {testDialog.step === 2 && testDialog.type === 'group_difference' && (
            <div className="space-y-3">
              <label className="text-sm font-medium">Grouped Metric</label>
              <p className="text-xs text-mm-text-muted">Only metrics with a grouping variable or dataset grouping are eligible.</p>
              <Select
                value={testDialog.targetId ? String(testDialog.targetId) : ''}
                onValueChange={v => setTestDialog(prev => ({ ...prev, targetId: Number(v) }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a metric..." />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const eligible = allMetrics.filter(
                      m => m.grouping_column_id != null || m.grouping_mode === 'dataset',
                    )
                    const scaleScores = eligible.filter(m => m.origin_context === 'crosswalk_auto')
                    const custom = eligible.filter(m => m.origin_context !== 'crosswalk_auto')
                    return (
                      <>
                        {scaleScores.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Scale scores</SelectLabel>
                            {scaleScores.map(m => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {metricDisplayLabel(m)}
                                {m.result_count > 0 && <span className="text-mm-text-faint ml-1">({m.result_count} groups)</span>}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        {custom.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Custom metrics</SelectLabel>
                            {custom.map(m => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {metricDisplayLabel(m)}
                                {m.result_count > 0 && <span className="text-mm-text-faint ml-1">({m.result_count} groups)</span>}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                      </>
                    )
                  })()}
                </SelectContent>
              </Select>
              {testDialog.targetId > 0 && (() => {
                const m = allMetrics.find(mm => mm.id === testDialog.targetId)
                if (m && m.result_count > 0) {
                  return (
                    <p className="text-xs text-mm-text-muted">
                      {m.result_count === 2 ? 'Will use independent t-test (2 groups)' :
                       m.result_count >= 3 ? `Will use one-way ANOVA (${m.result_count} groups)` :
                       'Need at least 2 groups with computed results'}
                    </p>
                  )
                }
                return <p className="text-xs text-amber-600 dark:text-amber-400">Compute this metric first to determine group count.</p>
              })()}
            </div>
          )}

          <DialogFooter>
            {testDialog.step === 2 && (
              <Button variant="ghost" size="sm" onClick={() => setTestDialog(prev => ({ ...prev, step: 1, type: null, targetId: 0 }))}>
                Back
              </Button>
            )}
            <Button
              size="sm"
              disabled={testDialog.step !== 2 || !testDialog.targetId || createTestMutation.isPending}
              onClick={() => {
                if (testDialog.type === 'cronbachs_alpha') {
                  submitTest('cronbachs_alpha', 'analysis_domain', testDialog.targetId)
                } else if (testDialog.type === 'split_half') {
                  submitTest('split_half', 'analysis_domain', testDialog.targetId)
                } else if (testDialog.type === 'group_difference') {
                  const m = allMetrics.find(mm => mm.id === testDialog.targetId)
                  const testType = m && m.result_count === 2 ? 'independent_t_test' : 'one_way_anova'
                  submitTest(testType, 'metric_definition', testDialog.targetId)
                }
              }}
            >
              {createTestMutation.isPending ? 'Creating...' : 'Create & Compute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Column details dialog (from ColumnPicker context menu) */}
      {editColumnTarget && (
        <ColumnFormDialog
          open
          onOpenChange={(open) => { if (!open) setEditColumnTarget(null) }}
          onSubmit={(data) => {
            editColumnMutation.mutate({
              datasetId: editColumnTarget.variable.dataset_id,
              columnId: editColumnTarget.variable.id,
              data: data as ManualColumnUpdate,
            })
          }}
          isSubmitting={editColumnMutation.isPending}
          submitError={editColumnError}
          initial={editColumnTarget.column}
          title="Column Details"
        />
      )}
    </div>
  )
}

