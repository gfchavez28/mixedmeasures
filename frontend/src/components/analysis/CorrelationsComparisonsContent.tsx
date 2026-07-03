import { useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  TriangleAlert,
  Download,
  FlaskConical,
  Network,
  ScatterChart,
  Table,
  GitCompareArrows,
  BarChart3,
} from 'lucide-react'
import { toast } from 'sonner'
import { correlationsApi, comparisonsApi } from '@/lib/api'
import type {
  CorrelationMatrixResponse,
  ScatterMatrixResponse,
  GroupComparisonResponse,
} from '@/lib/api'
import {
  shapeComparisonDumbbell,
  shapeComparisonGroupedBars,
  type ChartFormatting,
} from '@/lib/chart-data'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'
import CorrelationMatrixTable from '@/components/charts/CorrelationMatrixTable'
import ScatterMatrix from '@/components/charts/ScatterMatrix'
import GroupComparisonTable from '@/components/charts/GroupComparisonTable'
import DumbbellChart from '@/components/charts/DumbbellChart'
import GroupedScalarBarChart from '@/components/charts/GroupedScalarBarChart'
import ComparisonTestStrip from '@/components/analysis/ComparisonTestStrip'

// ── Props ────────────────────────────────────────────────────────────────────

export interface CorrelationsComparisonsContentProps {
  pid: number
  rcView: 'correlations' | 'comparisons'
  // Correlation state
  hasRcSelection: boolean
  rcColumnIds: number[]
  rcDomainIds: number[]
  corrType: 'pearson' | 'spearman'
  corrMatrixData: CorrelationMatrixResponse | undefined
  isCorrFetching: boolean
  showScatter: boolean
  scatterMatrixData: ScatterMatrixResponse | undefined
  isScatterFetching: boolean
  showRegLine: boolean
  showJitter: boolean
  corrCellFormat: 'r_stars' | 'r_p' | 'r_only'
  corrColors: string
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  bonferroniOn: boolean
  // Comparison state
  hasComparisonSelection: boolean
  compareBy: number | null
  compareBy2: number | null
  testType: 'auto' | 't_test' | 'anova'
  nonparametric: boolean
  rcChartType: 'comparison_table' | 'comparison_dumbbell' | 'comparison_grouped_bar'
  comparisonData: GroupComparisonResponse | undefined
  isComparisonFetching: boolean
  excludeGroups: string[]
  rcFormatting: Partial<ChartFormatting>
  postHocExpanded: boolean
  onPostHocToggle: () => void
  // Callbacks
  setUrlParam: (key: string, value: string) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CorrelationsComparisonsContent(props: CorrelationsComparisonsContentProps) {
  const {
    pid,
    rcView,
    hasRcSelection, rcColumnIds, rcDomainIds,
    corrType, corrMatrixData, isCorrFetching,
    showScatter, scatterMatrixData, isScatterFetching,
    showRegLine, showJitter, corrCellFormat, corrColors,
    sigLevels, bonferroniOn,
    hasComparisonSelection, compareBy, compareBy2, testType, nonparametric,
    rcChartType, comparisonData, isComparisonFetching,
    excludeGroups, rcFormatting, postHocExpanded, onPostHocToggle,
    setUrlParam,
  } = props

  const corrToolbarRef = useRef<HTMLDivElement>(null)
  const compToolbarRef = useRef<HTMLDivElement>(null)

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [])

  const handleToolbarKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    if (!buttons || buttons.length === 0) return
    const current = document.activeElement as HTMLButtonElement
    const idx = Array.from(buttons).indexOf(current)
    if (idx < 0) return
    if (e.key === 'ArrowRight') { e.preventDefault(); buttons[(idx + 1) % buttons.length].focus() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); buttons[(idx - 1 + buttons.length) % buttons.length].focus() }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus() }
  }, [])

  const handleExportCorrelationCsv = useCallback(async () => {
    try {
      const blob = await correlationsApi.correlationMatrixCsv(pid, {
        column_ids: rcColumnIds,
        domain_ids: rcDomainIds,
        correlation_type: corrType,
        bonferroni: bonferroniOn,
      })
      downloadBlob(blob, `correlation_matrix_${corrType}.csv`)
    } catch {
      toast.error('Failed to export correlation matrix')
    }
  }, [pid, rcColumnIds, rcDomainIds, corrType, bonferroniOn, downloadBlob])

  const handleExportScatterCsv = useCallback(async () => {
    try {
      const blob = await correlationsApi.scatterDataCsv(pid, {
        column_ids: rcColumnIds,
        domain_ids: rcDomainIds,
        id_type: rcColumnIds.length > 0 ? 'column' : 'domain',
      })
      downloadBlob(blob, 'scatter_data.csv')
    } catch {
      toast.error('Failed to export scatter data')
    }
  }, [pid, rcColumnIds, rcDomainIds, downloadBlob])

  const handleExportComparisonCsv = useCallback(async () => {
    if (!compareBy) return
    try {
      const blob = await comparisonsApi.groupComparisonCsv(pid, {
        column_ids: rcColumnIds,
        domain_ids: rcDomainIds,
        grouping_column_id: compareBy,
        grouping_column_id_2: compareBy2,
        test_type: testType,
        exclude_groups: excludeGroups.length > 0 ? excludeGroups : undefined,
        nonparametric: nonparametric || undefined,
      })
      downloadBlob(blob, 'group_comparison.csv')
    } catch {
      toast.error('Failed to export group comparison')
    }
  }, [pid, rcColumnIds, rcDomainIds, compareBy, compareBy2, testType, excludeGroups, nonparametric, downloadBlob])

  return (
    <div className="space-y-6" role="tabpanel" id="tabpanel-rc" aria-labelledby="tab-rc">
      {/* #394: the correlations/comparisons toggle is a <select>, not a tablist —
          so no tab button with id "rctab-*" exists. A tabpanel role +
          aria-labelledby pointing at a missing id is an invalid-aria-value
          failure, so the two inner regions below are plain divs (not tabpanels). */}
      {rcView === 'correlations' ? (
        <div id="rctabpanel-correlations">
          {/* Output type toolbar */}
          {hasRcSelection && (
            <div className="flex items-center gap-3" data-exclude-export="">
              <div
                ref={corrToolbarRef}
                role="toolbar"
                aria-label="Correlation output types"
                className="flex items-center gap-0.5 p-1 bg-mm-bg rounded-lg border"
                onKeyDown={handleToolbarKeyDown}
              >
                <button
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-mm-blue/12 text-mm-blue-text transition-colors"
                  aria-pressed="true"
                  tabIndex={0}
                  title="Correlation Matrix"
                >
                  <Network className="w-3.5 h-3.5" />
                  Matrix
                </button>
                <button
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    showScatter
                      ? 'bg-mm-blue/12 text-mm-blue-text font-medium'
                      : 'text-mm-text-muted hover:bg-mm-surface-hover hover:text-mm-text-secondary'
                  }`}
                  onClick={() => setUrlParam('showScatter', showScatter ? '' : '1')}
                  aria-pressed={showScatter}
                  tabIndex={showScatter ? 0 : -1}
                  title="Scatter Matrix"
                >
                  <ScatterChart className="w-3.5 h-3.5" />
                  Scatter
                </button>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button
                  className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-mm-text-muted border border-mm-surface-border hover:text-mm-text hover:border-mm-text-faint transition-colors"
                  onClick={handleExportCorrelationCsv}
                  title="Export correlation matrix as CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
                {showScatter && (
                  <button
                    className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-mm-text-muted border border-mm-surface-border hover:text-mm-text hover:border-mm-text-faint transition-colors"
                    onClick={handleExportScatterCsv}
                    title="Export scatter data as CSV"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Scatter CSV
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Correlation matrix */}
          {!hasRcSelection ? (
            <div className="flex flex-col items-center justify-center py-20 text-mm-text-faint">
              <Network className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-base font-medium text-mm-text-secondary mb-1">Correlation Matrix</p>
              <p className="text-sm">Select 2 or more variables in the sidebar to compute correlations.</p>
            </div>
          ) : isCorrFetching ? (
            <div className="flex items-center justify-center py-16 text-mm-text-faint text-sm gap-2">
              <div className="animate-spin w-4 h-4 border-2 border-mm-accent border-t-transparent rounded-full" />
              Computing {corrType === 'pearson' ? 'Pearson' : 'Spearman'} correlations...
            </div>
          ) : corrMatrixData ? (
            <ChartExportWrapper
              title={`${corrType === 'pearson' ? 'Pearson' : 'Spearman'} Correlation Matrix`}
              supportsSvg={false}
              filename={`correlation-matrix-${corrType}`}
            >
              <CorrelationMatrixTable
                labels={corrMatrixData.labels}
                fullLabels={corrMatrixData.full_labels}
                matrix={corrMatrixData.matrix}
                sigLevels={sigLevels}
                bonferroni={bonferroniOn}
                adjustedAlpha={corrMatrixData.adjusted_alpha}
                cellFormat={corrCellFormat}
                heatmapPreset={corrColors}
              />
            </ChartExportWrapper>
          ) : null}

          {/* Scatter matrix */}
          {showScatter && hasRcSelection && (
            <>
              {(rcColumnIds.length > 10 || rcDomainIds.length > 10) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-mm-blue/12 border border-mm-blue/30 text-mm-blue-text text-xs">
                  <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0" />
                  Scatter matrix limited to 10 variables. The correlation matrix above shows all.
                </div>
              )}
              <ChartExportWrapper
                title="Scatter Matrix"
                supportsSvg={false}
                filename="scatter-matrix"
              >
                <ScatterMatrix
                  labels={scatterMatrixData?.labels ?? []}
                  fullLabels={scatterMatrixData?.full_labels ?? []}
                  pairs={scatterMatrixData?.pairs ?? []}
                  correlationMatrix={corrMatrixData?.matrix}
                  showRegLine={showRegLine}
                  showJitter={showJitter}
                  isLoading={isScatterFetching}
                />
              </ChartExportWrapper>
            </>
          )}
        </div>
      ) : (
        <div id="rctabpanel-comparisons">
          {/* Comparison output toolbar */}
          {hasComparisonSelection && (
            <div className="flex items-center gap-3" data-exclude-export="">
              <div
                ref={compToolbarRef}
                role="toolbar"
                aria-label="Comparison output types"
                className="flex items-center gap-0.5 p-1 bg-mm-bg rounded-lg border flex-wrap"
                onKeyDown={handleToolbarKeyDown}
              >
                {([
                  { type: 'comparison_table' as const, icon: Table, label: 'Table' },
                  { type: 'comparison_dumbbell' as const, icon: GitCompareArrows, label: 'Dumbbell' },
                  { type: 'comparison_grouped_bar' as const, icon: BarChart3, label: 'Grouped' },
                ]).map(({ type, icon: Icon, label }) => (
                  <button
                    key={type}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                      rcChartType === type
                        ? 'bg-mm-blue/12 text-mm-blue-text font-medium'
                        : 'text-mm-text-muted hover:bg-mm-surface-hover hover:text-mm-text-secondary'
                    }`}
                    onClick={() => setUrlParam('rcChartType', type)}
                    aria-pressed={rcChartType === type}
                    tabIndex={rcChartType === type ? 0 : -1}
                    title={label}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              <div className="ml-auto">
                <button
                  className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-mm-text-muted border border-mm-surface-border hover:text-mm-text hover:border-mm-text-faint transition-colors"
                  onClick={handleExportComparisonCsv}
                  title="Export comparison as CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
              </div>
            </div>
          )}

          {/* Comparison content */}
          {!compareBy ? (
            <div className="flex flex-col items-center justify-center py-20 text-mm-text-faint">
              <FlaskConical className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-base font-medium text-mm-text-secondary mb-1">Group Comparisons</p>
              <p className="text-sm">Select a grouping column in the sidebar to compare groups.</p>
            </div>
          ) : !hasComparisonSelection ? (
            <div className="flex flex-col items-center justify-center py-20 text-mm-text-faint">
              <FlaskConical className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-base font-medium text-mm-text-secondary mb-1">Group Comparisons</p>
              <p className="text-sm">Select variables to compare across groups.</p>
            </div>
          ) : isComparisonFetching ? (
            <div className="flex items-center justify-center py-16 text-mm-text-faint text-sm gap-2">
              <div className="animate-spin w-4 h-4 border-2 border-mm-accent border-t-transparent rounded-full" />
              Computing group comparisons...
            </div>
          ) : comparisonData && comparisonData.rows.length > 0 ? (
            <>
              {/* Bonferroni warning */}
              {comparisonData.bonferroni_warning && comparisonData.bonferroni_threshold && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
                  <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{comparisonData.rows.length} comparisons. Consider Bonferroni-adjusted threshold: p &lt; {comparisonData.bonferroni_threshold.toFixed(4)}</span>
                </div>
              )}

              {rcChartType === 'comparison_table' && (
                <ChartExportWrapper
                  title={`Group Comparison: ${comparisonData.group_column_label}`}
                  supportsSvg={false}
                  filename={`comparison-${comparisonData.group_column_label}`}
                >
                  <GroupComparisonTable
                    groups={comparisonData.groups}
                    rows={comparisonData.rows}
                    sigLevels={sigLevels}
                    nonparametric={nonparametric}
                    postHocExpanded={postHocExpanded}
                    onPostHocToggle={onPostHocToggle}
                  />
                </ChartExportWrapper>
              )}

              {rcChartType === 'comparison_dumbbell' && (
                <ChartExportWrapper
                  title={`Group Comparison: ${comparisonData.group_column_label}`}
                  supportsSvg={false}
                  filename={`comparison-dumbbell-${comparisonData.group_column_label}`}
                >
                  <DumbbellChart
                    data={shapeComparisonDumbbell(comparisonData.rows, comparisonData.groups)}
                    showCI
                    metricType="mean"
                    formatting={rcFormatting}
                  />
                  <ComparisonTestStrip rows={comparisonData.rows} sigLevels={sigLevels} nonparametric={nonparametric} />
                </ChartExportWrapper>
              )}

              {rcChartType === 'comparison_grouped_bar' && (
                <ChartExportWrapper
                  title={`Group Comparison: ${comparisonData.group_column_label}`}
                  supportsSvg={false}
                  filename={`comparison-grouped-bar-${comparisonData.group_column_label}`}
                >
                  <GroupedScalarBarChart
                    sections={shapeComparisonGroupedBars(comparisonData.rows, comparisonData.groups)}
                    groupValues={comparisonData.groups}
                    showCI
                    metricType="mean"
                    formatting={rcFormatting}
                  />
                  <ComparisonTestStrip rows={comparisonData.rows} sigLevels={sigLevels} nonparametric={nonparametric} />
                </ChartExportWrapper>
              )}
            </>
          ) : comparisonData ? (
            <div className="flex flex-col items-center justify-center py-16 text-mm-text-faint text-sm">
              <p>No comparison data available. The selected demographic may have fewer than 2 groups.</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
