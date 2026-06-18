import { useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ChartType, SortOrder } from '@/lib/chart-data'
import { parseIntParam } from '@/lib/utils'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultForKey(key: string): string {
  switch (key) {
    case 'tab': return 'descriptives'
    case 'sort': return 'none'
    case 'display': return 'percentage'
    case 'scaling': return 'relative'
    case 'metricType': return 'frequency_distribution'
    case 'chartType': return ''
    case 'showChartN': return ''
    case 'showGroupN': return ''
    case 'showVariableN': return 'off'
    case 'showCI': return ''
    case 'axisTransform': return 'linear'
    case 'crossTabDisplay': return 'count'
    case 'rcView': return 'correlations'
    case 'corrType': return 'pearson'
    case 'sigLevels': return '05,01,001'
    case 'bonferroni': return ''
    case 'showScatter': return ''
    case 'showRegLine': return '1'
    case 'showJitter': return ''
    case 'cellFormat': return 'r_stars'
    case 'compareBy': return ''
    case 'compareBy2': return ''
    case 'testType': return 'auto'
    case 'rcChartType': return 'comparison_table'
    case 'dqView': return 'summary'
    case 'dqIncludeNA': return '1'
    case 'dqIncludeEmpty': return '1'
    case 'dqSort': return 'pct_missing'
    default: return ''
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAnalysisUrlState() {
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Tab state ────────────────────────────────────────────────────────
  const activeTab = (searchParams.get('tab') || 'descriptives') as 'descriptives' | 'rc' | 'data_quality'

  // ── R&C sub-tab and correlation state ──────────────────────────────────
  const rcView = (searchParams.get('rcView') || 'correlations') as 'correlations' | 'comparisons'
  const corrType = (searchParams.get('corrType') || 'pearson') as 'pearson' | 'spearman'
  const sigLevelsRaw = searchParams.get('sigLevels') || '05,01,001'
  const sigLevels = useMemo(() => {
    const parts = new Set(sigLevelsRaw.split(','))
    return { show_05: parts.has('05'), show_01: parts.has('01'), show_001: parts.has('001') }
  }, [sigLevelsRaw])
  const bonferroniOn = searchParams.get('bonferroni') === '1'
  const showScatter = searchParams.get('showScatter') === '1'
  const showRegLine = searchParams.get('showRegLine') !== '0'  // default on
  const showJitter = searchParams.get('showJitter') === '1'
  const corrCellFormat = (searchParams.get('cellFormat') || 'r_stars') as 'r_stars' | 'r_p' | 'r_only'
  const corrColors = searchParams.get('corrColors') || 'diverging_blue_red'

  // ── Comparison state ──────────────────────────────────────────────────
  const compareBy = parseIntParam(searchParams.get('compareBy'))
  const compareBy2 = parseIntParam(searchParams.get('compareBy2'))
  const testType = (searchParams.get('testType') || 'auto') as 'auto' | 't_test' | 'anova'
  const nonparametric = searchParams.get('nonparametric') === '1'
  // Sanitize rather than cast: stale deep links may still carry retired values
  // (e.g. 'forest_plot', removed with #426).
  const rcChartTypeRaw = searchParams.get('rcChartType')
  const rcChartType: 'comparison_table' | 'comparison_dumbbell' | 'comparison_grouped_bar' =
    rcChartTypeRaw === 'comparison_dumbbell' || rcChartTypeRaw === 'comparison_grouped_bar'
      ? rcChartTypeRaw
      : 'comparison_table'
  const excludeGroupsRaw = searchParams.get('excludeGroups') || ''
  const excludeGroups = useMemo(() => excludeGroupsRaw ? excludeGroupsRaw.split(',').filter(Boolean) : [], [excludeGroupsRaw])
  const rcPalette = searchParams.get('rcPalette') || 'default'

  // ── Data Quality tab URL state ───────────────────────────────────────────
  const dqView = (searchParams.get('dqView') || 'summary') as 'summary' | 'bar' | 'patterns'
  const dqIncludeNA = searchParams.get('dqIncludeNA') !== '0'
  const dqIncludeEmpty = searchParams.get('dqIncludeEmpty') !== '0'
  const dqSort = (searchParams.get('dqSort') || 'pct_missing') as 'pct_missing' | 'name' | 'dataset'

  // ── URL state extraction ───────────────────────────────────────────────

  // Active material (loaded from materials click).
  // Backward-compat: accept legacy ?element= bookmarks for one release (#343).
  const activeMaterialId = useMemo(() => {
    return parseIntParam(searchParams.get('material') ?? searchParams.get('element'))
  }, [searchParams])

  // Question/domain selection from URL
  const columnsRaw = searchParams.get('columns') || ''
  const domainsRaw = searchParams.get('domains') || ''
  const metricType = searchParams.get('metricType') || 'frequency_distribution'

  const selectedColumnIds = useMemo(() => {
    if (!columnsRaw) return new Set<number>()
    return new Set(columnsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0))
  }, [columnsRaw])

  const selectedDomainIds = useMemo(() => {
    if (!domainsRaw) return new Set<number>()
    return new Set(domainsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0))
  }, [domainsRaw])

  const decompose = searchParams.get('decompose') === '1'

  // Hint param written by crosswalk Σ-badge navigation (`navigateToScaleScore`)
  // and DomainPickerDetail's multi-metric radio. Pre-selects a specific
  // domain_aggregate metric variant when a domain has more than one. AnalysisView
  // does not strip unknown params on filter changes (see useAnalysisUrlState.ts
  // setUrlParam — it reads `prev` and only mutates the targeted key), so the
  // hint survives subsequent filter changes.
  const metricIdHint = parseIntParam(searchParams.get('metric_id'))

  const sortOrder = (searchParams.get('sort') || 'none') as SortOrder
  const display = (searchParams.get('display') || 'percentage') as 'percentage' | 'count'
  const scaling = (searchParams.get('scaling') || 'relative') as 'relative' | 'absolute'

  // N display URL state
  const showChartN = searchParams.get('showChartN') === '1'
  const showGroupN = searchParams.get('showGroupN') === '1'
  // Backward-compat: legacy bookmarks/saved configs may use 'showQuestionN'
  const showVariableN = (
    searchParams.get('showVariableN')
    ?? searchParams.get('showQuestionN')
    ?? 'off'
  ) as 'off' | 'differing' | 'all'
  const showSampleSizes = showChartN || showGroupN || showVariableN !== 'off'

  // CI / error bar URL state
  const showCI = searchParams.get('showCI') === '1'

  // Chart type URL state
  const chartTypeParam = searchParams.get('chartType') as ChartType | null

  // Group By and Exclude Values URL state
  const groupingColumnId = useMemo(() => {
    return parseIntParam(searchParams.get('groupBy'))
  }, [searchParams])
  const groupingColumnId2 = useMemo(() => {
    return parseIntParam(searchParams.get('groupBy2'))
  }, [searchParams])
  const groupingMode = (searchParams.get('groupMode') || 'column') as 'column' | 'dataset'
  const excludeValuesRaw = searchParams.get('exclude') || ''
  const excludeValues = useMemo(() => {
    return excludeValuesRaw ? excludeValuesRaw.split(',').filter(Boolean) : []
  }, [excludeValuesRaw])

  // Diverging stacked bar URL state
  const divergingMode = searchParams.get('diverging') === '1'
  const divergingCenter = searchParams.get('divergingCenter') || null

  // Axis transform URL state
  const axisTransform = (searchParams.get('axisTransform') || 'linear') as 'linear' | 'log'

  // Cross-tab URL state
  const crossTabColumnId = useMemo(() => {
    return parseIntParam(searchParams.get('crossTabCol'))
  }, [searchParams])
  const crossTabDisplay = searchParams.get('crossTabDisplay') || 'count'

  // ── URL state helpers ──────────────────────────────────────────────────

  const setUrlParam = useCallback((key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === getDefaultForKey(key)) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  return {
    // Raw access for callbacks that need direct searchParams manipulation
    searchParams,
    setSearchParams,
    // Parsed tab state
    activeTab,
    // R&C state
    rcView, corrType, sigLevelsRaw, sigLevels, bonferroniOn,
    showScatter, showRegLine, showJitter, corrCellFormat, corrColors,
    // Comparison state
    compareBy, compareBy2, testType, nonparametric, rcChartType, excludeGroups, rcPalette,
    // Data Quality state
    dqView, dqIncludeNA, dqIncludeEmpty, dqSort,
    // Palette
    activeMaterialId,
    // Selection state
    columnsRaw, domainsRaw, metricType, selectedColumnIds, selectedDomainIds, decompose,
    metricIdHint,
    // Chart display state
    sortOrder, display, scaling,
    showChartN, showGroupN, showVariableN, showSampleSizes, showCI,
    chartTypeParam,
    // Grouping state
    groupingColumnId, groupingColumnId2, groupingMode, excludeValuesRaw, excludeValues,
    // Diverging state
    divergingMode, divergingCenter,
    // Axis transform
    axisTransform,
    // Cross-tab state
    crossTabColumnId, crossTabDisplay,
    // Helpers
    setUrlParam,
  }
}

export type AnalysisUrlState = ReturnType<typeof useAnalysisUrlState>
