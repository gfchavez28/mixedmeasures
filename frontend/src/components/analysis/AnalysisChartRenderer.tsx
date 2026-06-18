import { RefreshCw, Play, TriangleAlert } from 'lucide-react'
import type { MetricDefinitionResponse, AnalysisCrossTabResponse } from '@/lib/api'
import {
  getGroupValues,
  shapeScalarBars,
  shapeGroupedScalarBars,
  shapeFrequencyBars,
  shapeGroupedFrequencyBars,
  shapeHeatmapRows,
  shapeDumbbellRows,
  shapeStackedBars,
  shapeSummaryStats,
  shapeDivergingStackedBars,
  shapeLineChart,
  computeLineChartN,
  isGroupedMetrics,
  computeBarChartN,
  computeGroupedScalarChartN,
  computeHeatmapChartN,
  computeDumbbellChartN,
  computeStackedBarChartN,
  computeFreqBarChartN,
  sortGroupValues,
  resolveGroupTextColors,
  type ChartType,
  type ChartFormatting,
  type GroupOrganization,
  type SortOrder,
} from '@/lib/chart-data'
import { Button } from '@/components/ui/button'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'
import HorizontalBarChart from '@/components/charts/HorizontalBarChart'
import HeatmapTable from '@/components/charts/HeatmapTable'
import DumbbellChart from '@/components/charts/DumbbellChart'
import StackedHorizontalBarChart from '@/components/charts/StackedHorizontalBarChart'
import FrequencyBarChart from '@/components/charts/FrequencyBarChart'
import GroupedScalarBarChart from '@/components/charts/GroupedScalarBarChart'
import SummaryStatsTable from '@/components/charts/SummaryStatsTable'
import VerticalBarChart from '@/components/charts/VerticalBarChart'
import LineChartComponent from '@/components/charts/LineChart'
import DetailedFrequencyTable from '@/components/charts/DetailedFrequencyTable'
import AnalysisCrossTabTable from '@/components/charts/AnalysisCrossTabTable'

// ── Props ────────────────────────────────────────────────────────────────────

export interface AnalysisChartRendererProps {
  // State flags
  hasAnySelection: boolean
  isComputing: boolean
  qcError: string | null
  hasResults: boolean
  chartType: ChartType | null

  // Compute All action
  onComputeAll: () => void
  isComputeAllPending: boolean

  // Metric data
  orderedMetrics: MetricDefinitionResponse[]
  selectedMetrics: MetricDefinitionResponse[]
  colorMap: Map<number, string>
  activeLabelMap: Map<number, string> | undefined

  // Annotations
  chartTitle: string
  chartSubtitle: string
  chartFootnote: string

  // Display options
  display: 'percentage' | 'count'
  scaling: 'relative' | 'absolute'
  showChartN: boolean
  showGroupN: boolean
  showVariableN: 'off' | 'differing' | 'all'
  showCI: boolean
  metricType: string
  sortOrder: SortOrder
  axisTransform: 'linear' | 'log'

  // Formatting
  formatting: ChartFormatting

  // Response/scale options
  hiddenResponseOptions: string[]
  scaleOrder: 'natural' | 'reversed'
  hiddenGroupValues: string[]
  groupOrganization: GroupOrganization
  responseLabels: string[]

  // Diverging stacked bar
  divergingMode: boolean
  divergingCenter: string | null
  divergingCenterAuto: { centerLabel: string | null; mode: 'center' | 'boundary' }
  hasMixedScales: boolean
  hasMixedTypes: boolean

  // Line chart options
  showErrorBand: boolean
  lineStyle: 'connected' | 'markers'
  lineOverlay: boolean

  // Proportion config (for summary table label)
  proportionMode: 'numeric' | 'values'
  proportionOperator: string
  proportionThreshold: number
  proportionValues: string[]

  // Cross-tab
  crossTabColumnId: number | null
  crossTabDisplay: string
  crossTabData: AnalysisCrossTabResponse | undefined
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AnalysisChartRenderer(props: AnalysisChartRendererProps) {
  const {
    hasAnySelection, isComputing, qcError, hasResults, chartType,
    onComputeAll, isComputeAllPending,
    orderedMetrics, selectedMetrics, colorMap, activeLabelMap,
    chartTitle, chartSubtitle, chartFootnote,
    display, scaling, showChartN, showGroupN, showVariableN, showCI,
    metricType, sortOrder, axisTransform,
    formatting,
    hiddenResponseOptions, scaleOrder, hiddenGroupValues, groupOrganization, responseLabels,
    divergingMode, divergingCenter, divergingCenterAuto, hasMixedScales, hasMixedTypes,
    showErrorBand, lineStyle, lineOverlay,
    proportionMode, proportionOperator, proportionThreshold, proportionValues,
    crossTabColumnId, crossTabDisplay, crossTabData,
  } = props

  if (!hasAnySelection) {
    return (
      <div className="text-center py-16">
        <p className="text-mm-text-muted">No variables selected.</p>
        <p className="text-sm text-mm-text-faint mt-1">
          Select variables or groups from the sidebar to visualize.
        </p>
      </div>
    )
  }

  if (isComputing) {
    return (
      <div className="flex items-center justify-center h-64 text-mm-text-faint text-sm gap-2" role="status" aria-live="polite">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Computing...
      </div>
    )
  }

  if (qcError) {
    return (
      <div role="alert" className="flex items-center justify-center h-64 text-red-400 text-sm">
        {qcError}
      </div>
    )
  }

  if (!hasResults) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-mm-text-faint text-sm gap-2">
        <span>No computed results yet</span>
        <Button
          size="sm"
          variant="outline"
          onClick={onComputeAll}
          disabled={isComputeAllPending}
        >
          <Play className="w-3 h-3 mr-1" />
          Compute All
        </Button>
      </div>
    )
  }

  if (!chartType) {
    return (
      <div className="flex items-center justify-center h-64 text-mm-text-faint text-sm">
        Incompatible metric selection — try selecting metrics of the same type
      </div>
    )
  }

  const exportFilename = chartTitle || 'chart'

  const varyingFootnote = '* Not all records have values for every variable. Per-variable sample sizes shown where they differ.'

  // Check if CI data is missing on any selected metrics (need recompute)
  const ciMissing = showCI && selectedMetrics.some(m =>
    m.results.some(r => r.result_data.ci_lower === undefined && r.result_data.ci_upper === undefined)
  )

  const ciNotice = ciMissing ? (
    <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300">
      <span>Recompute metrics to enable error bars</span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={onComputeAll}
        disabled={isComputeAllPending}
      >
        <RefreshCw className="w-3 h-3 mr-1" />
        Compute All
      </Button>
    </div>
  ) : null

  const scaleWarning = (hasMixedTypes || hasMixedScales) ? (
    <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300" role="status">
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
      <span>
        {hasMixedTypes
          ? 'Selected variables have different measurement types — heatmap and stacked bar are disabled.'
          : 'Selected variables have different response scales — heatmap and stacked bar are disabled.'}
      </span>
    </div>
  ) : null

  const reverseScale = scaleOrder === 'reversed'
  // Compute WCAG-safe group text colors from all group values for consistent coloring
  const allGroupValsForColors = getGroupValues(orderedMetrics)
  const groupTextColors = allGroupValsForColors.length > 0
    ? resolveGroupTextColors(allGroupValsForColors, formatting.colorPalette)
    : undefined
  const shapeOpts = {
    hiddenLabels: hiddenResponseOptions.length > 0 ? hiddenResponseOptions : undefined,
    reverseScale: reverseScale || undefined,
    customColors: Object.keys(formatting.customColors).length > 0 ? formatting.customColors : undefined,
    hiddenGroupValues: hiddenGroupValues.length > 0 ? hiddenGroupValues : undefined,
    groupOrganization: groupOrganization !== 'variable-first' ? groupOrganization : undefined,
    sortOrder: sortOrder !== 'none' ? sortOrder : undefined,
    groupTextColors,
  }

  const chartContent = (() => { switch (chartType) {
    case 'horizontal_bar': {
      if (metricType === 'frequency_distribution') {
        // Per-question frequency bars
        const nInfo = computeFreqBarChartN(orderedMetrics)
        const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
        return (
          <ChartExportWrapper
            title={chartTitle}
            subtitle={chartSubtitle}
            footnote={chartFootnote}
            filename={exportFilename}
            chartN={nInfo.chartN}
            showChartN={showChartN}
            hasVaryingN={nInfo.hasVaryingN}
            autoFootnote={autoFootnote}
            formatting={formatting}
          >
            <FrequencyBarChart
              metrics={orderedMetrics}
              display={display}
              sortOrder={sortOrder}
              showVariableN={showVariableN}
              chartN={nInfo.chartN}
              formatting={formatting}
              hiddenLabels={shapeOpts.hiddenLabels}
              reverseScale={reverseScale}
              labelMap={activeLabelMap}
              hiddenGroupValues={shapeOpts.hiddenGroupValues}
            />
          </ChartExportWrapper>
        )
      }
      // Scalar bar chart — grouped or ungrouped
      if (isGroupedMetrics(orderedMetrics)) {
        const allGroupVals = getGroupValues(orderedMetrics)
        const filteredGroupVals = hiddenGroupValues.length > 0
          ? allGroupVals.filter(gv => !hiddenGroupValues.includes(gv))
          : allGroupVals
        const visibleGroupVals = sortGroupValues(filteredGroupVals, sortOrder, orderedMetrics)
        const groupedSections = shapeGroupedScalarBars(orderedMetrics, visibleGroupVals, activeLabelMap)
        const nInfo = computeGroupedScalarChartN(groupedSections)
        const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
        return (
          <>
            {ciNotice}
            <ChartExportWrapper
              title={chartTitle}
              subtitle={chartSubtitle}
              footnote={chartFootnote}
              filename={exportFilename}
              chartN={nInfo.chartN}
              showChartN={showChartN}
              hasVaryingN={nInfo.hasVaryingN}
              autoFootnote={autoFootnote}
              formatting={formatting}
            >
              <GroupedScalarBarChart
                sections={groupedSections}
                groupValues={visibleGroupVals}
                sortOrder={sortOrder}
                showVariableN={showVariableN}
                chartN={nInfo.chartN}
                showCI={showCI}
                formatting={formatting}
                metricType={metricType}
                axisTransform={axisTransform}
              />
            </ChartExportWrapper>
          </>
        )
      }
      const barData = shapeScalarBars(orderedMetrics, colorMap, activeLabelMap)
      const nInfo = computeBarChartN(barData)
      const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
      return (
        <>
          {ciNotice}
          <ChartExportWrapper
            title={chartTitle}
            subtitle={chartSubtitle}
            footnote={chartFootnote}
            filename={exportFilename}
            chartN={nInfo.chartN}
            showChartN={showChartN}
            hasVaryingN={nInfo.hasVaryingN}
            autoFootnote={autoFootnote}
            formatting={formatting}
          >
            <HorizontalBarChart
              data={barData}
              sortOrder={sortOrder}
              showVariableN={showVariableN}
              chartN={nInfo.chartN}
              showCI={showCI}
              formatting={formatting}
              metricType={metricType}
              lineOverlay={lineOverlay}
              axisTransform={axisTransform}
            />
          </ChartExportWrapper>
        </>
      )
    }
    case 'stacked_bar': {
      const stackedData = shapeStackedBars(orderedMetrics, formatting.colorPalette, shapeOpts, activeLabelMap)
      const nInfo = computeStackedBarChartN(stackedData)
      const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined

      // Diverging layout
      let divergingData = null
      if (divergingMode) {
        const effectiveCenter = divergingCenter || divergingCenterAuto.centerLabel
        const effectiveMode = divergingCenter ? 'center' as const : divergingCenterAuto.mode
        divergingData = shapeDivergingStackedBars(stackedData, effectiveCenter, effectiveMode, hasMixedScales)
      }

      return (
        <ChartExportWrapper
          title={chartTitle}
          subtitle={chartSubtitle}
          footnote={chartFootnote}
          filename={exportFilename}
          chartN={nInfo.chartN}
          showChartN={showChartN}
          hasVaryingN={nInfo.hasVaryingN}
          autoFootnote={autoFootnote}
          formatting={formatting}
        >
          <StackedHorizontalBarChart
            data={stackedData}
            mode={divergingMode ? '100%' : (display === 'count' ? 'count' : '100%')}
            sortOrder={sortOrder}
            showVariableN={showVariableN}
            chartN={nInfo.chartN}
            formatting={formatting}
            divergingData={divergingData}
          />
        </ChartExportWrapper>
      )
    }
    case 'heatmap': {
      const heatmapData = shapeHeatmapRows(orderedMetrics, shapeOpts, activeLabelMap)
      const nInfo = computeHeatmapChartN(heatmapData)
      const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
      return (
        <ChartExportWrapper
          title={chartTitle}
          subtitle={chartSubtitle}
          footnote={chartFootnote}
          supportsSvg={false}
          filename={exportFilename}
          chartN={nInfo.chartN}
          showChartN={showChartN}
          hasVaryingN={nInfo.hasVaryingN}
          autoFootnote={autoFootnote}
          formatting={formatting}
        >
          <HeatmapTable
            data={heatmapData}
            display={display}
            scaling={scaling}
            showVariableN={showVariableN}
            chartN={nInfo.chartN}
            formatting={formatting}
          />
        </ChartExportWrapper>
      )
    }
    case 'dumbbell': {
      const dumbbellData = shapeDumbbellRows(orderedMetrics, activeLabelMap, {
        hiddenGroupValues: shapeOpts.hiddenGroupValues,
        sortOrder: shapeOpts.sortOrder,
      })
      const nInfo = computeDumbbellChartN(dumbbellData)
      const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
      return (
        <>
          {ciNotice}
          <ChartExportWrapper
            title={chartTitle}
            subtitle={chartSubtitle}
            footnote={chartFootnote}
            filename={exportFilename}
            chartN={nInfo.chartN}
            showChartN={showChartN}
            hasVaryingN={nInfo.hasVaryingN}
            autoFootnote={autoFootnote}
            formatting={formatting}
          >
            <DumbbellChart
              data={dumbbellData}
              showGroupN={showGroupN}
              showVariableN={showVariableN}
              chartN={nInfo.chartN}
              groupNs={nInfo.groupNs}
              hasVaryingGroupN={nInfo.hasVaryingGroupN}
              showCI={showCI}
              formatting={formatting}
              metricType={metricType}
              axisTransform={axisTransform}
            />
          </ChartExportWrapper>
        </>
      )
    }
    case 'table': {
      const statsData = shapeSummaryStats(orderedMetrics, activeLabelMap, metricType)
      const tablePropLabel = metricType === 'proportion'
        ? (proportionMode === 'values' && proportionValues.length > 0
          ? proportionValues.join(', ')
          : proportionMode === 'numeric'
            ? `${proportionOperator} ${proportionThreshold}`
            : undefined)
        : undefined
      return (
        <ChartExportWrapper
          title={chartTitle}
          subtitle={chartSubtitle}
          footnote={chartFootnote}
          supportsSvg={false}
          filename={exportFilename}
          formatting={formatting}
        >
          <SummaryStatsTable
            data={statsData}
            showCI={showCI}
            formatting={formatting}
            metricType={metricType}
            proportionLabel={tablePropLabel}
          />
        </ChartExportWrapper>
      )
    }
    case 'vertical_bar': {
      if (metricType === 'frequency_distribution') {
        // Single-question freq → vertical bars
        if (isGroupedMetrics(orderedMetrics)) {
          const allGroupVals = getGroupValues(orderedMetrics)
          const filteredGroupVals = hiddenGroupValues.length > 0
            ? allGroupVals.filter(gv => !hiddenGroupValues.includes(gv))
            : allGroupVals
          const visibleGroupVals = sortGroupValues(filteredGroupVals, sortOrder, orderedMetrics)
          const groupedFreqData = shapeGroupedFrequencyBars(orderedMetrics[0], visibleGroupVals, shapeOpts)
          const nInfo = computeFreqBarChartN(orderedMetrics)
          const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
          return (
            <ChartExportWrapper
              title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
              filename={exportFilename} chartN={nInfo.chartN} showChartN={showChartN}
              hasVaryingN={nInfo.hasVaryingN} autoFootnote={autoFootnote} formatting={formatting}
            >
              <VerticalBarChart
                groupedFrequencyData={groupedFreqData}
                display={display}
                sortOrder={sortOrder}
                showVariableN={showVariableN}
                chartN={nInfo.chartN}
                formatting={formatting}
                responseLabels={responseLabels}
                groupValues={visibleGroupVals}
              />
            </ChartExportWrapper>
          )
        }
        const freqBars = shapeFrequencyBars(orderedMetrics[0], shapeOpts)
        const nInfo = computeFreqBarChartN(orderedMetrics)
        const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
        return (
          <ChartExportWrapper
            title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
            filename={exportFilename} chartN={nInfo.chartN} showChartN={showChartN}
            hasVaryingN={nInfo.hasVaryingN} autoFootnote={autoFootnote} formatting={formatting}
          >
            <VerticalBarChart
              frequencyData={freqBars}
              display={display}
              sortOrder={sortOrder}
              showVariableN={showVariableN}
              chartN={nInfo.chartN}
              formatting={formatting}
            />
          </ChartExportWrapper>
        )
      }
      // Scalar ungrouped / grouped
      if (isGroupedMetrics(orderedMetrics)) {
        const allGroupVals = getGroupValues(orderedMetrics)
        const filteredGroupVals = hiddenGroupValues.length > 0
          ? allGroupVals.filter(gv => !hiddenGroupValues.includes(gv))
          : allGroupVals
        const visibleGroupVals = sortGroupValues(filteredGroupVals, sortOrder, orderedMetrics)
        const groupedSections = shapeGroupedScalarBars(orderedMetrics, visibleGroupVals, activeLabelMap)
        const nInfo = computeGroupedScalarChartN(groupedSections)
        const autoFootnote = showChartN && nInfo.hasVaryingN ? varyingFootnote : undefined
        return (
          <>
            {ciNotice}
            <ChartExportWrapper
              title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
              filename={exportFilename} chartN={nInfo.chartN} showChartN={showChartN}
              hasVaryingN={nInfo.hasVaryingN} autoFootnote={autoFootnote} formatting={formatting}
            >
              <VerticalBarChart
                groupedScalarData={groupedSections}
                showCI={showCI}
                formatting={formatting}
                metricType={metricType}
                groupValues={visibleGroupVals}
                axisTransform={axisTransform}
              />
            </ChartExportWrapper>
          </>
        )
      }
      const barData = shapeScalarBars(orderedMetrics, colorMap, activeLabelMap)
      const vBarNInfo = computeBarChartN(barData)
      const vBarAutoFootnote = showChartN && vBarNInfo.hasVaryingN ? varyingFootnote : undefined
      return (
        <>
          {ciNotice}
          <ChartExportWrapper
            title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
            filename={exportFilename} chartN={vBarNInfo.chartN} showChartN={showChartN}
            hasVaryingN={vBarNInfo.hasVaryingN} autoFootnote={vBarAutoFootnote} formatting={formatting}
          >
            <VerticalBarChart
              scalarData={barData}
              showVariableN={showVariableN}
              showCI={showCI}
              chartN={vBarNInfo.chartN}
              formatting={formatting}
              metricType={metricType}
              axisTransform={axisTransform}
            />
          </ChartExportWrapper>
        </>
      )
    }
    case 'line': {
      const lineData = shapeLineChart(orderedMetrics, colorMap, activeLabelMap, {
        hiddenGroupValues: shapeOpts.hiddenGroupValues,
        sortOrder: shapeOpts.sortOrder,
      })
      const lineNInfo = computeLineChartN(lineData)
      const autoFootnote = showChartN && lineNInfo.hasVaryingN ? varyingFootnote : undefined
      return (
        <>
          {ciNotice}
          <ChartExportWrapper
            title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
            filename={exportFilename} chartN={lineNInfo.chartN} showChartN={showChartN}
            hasVaryingN={lineNInfo.hasVaryingN} autoFootnote={autoFootnote} formatting={formatting}
          >
            <LineChartComponent
              data={lineData}
              showCI={showCI}
              showErrorBand={showErrorBand}
              lineStyle={lineStyle}
              showVariableN={showVariableN}
              showGroupN={showGroupN}
              chartN={lineNInfo.chartN}
              groupNs={lineNInfo.groupNs}
              formatting={formatting}
              metricType={metricType}
              axisTransform={axisTransform}
            />
          </ChartExportWrapper>
        </>
      )
    }
    case 'frequency_table': {
      return (
        <ChartExportWrapper
          title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
          supportsSvg={false} filename={exportFilename} formatting={formatting}
        >
          <DetailedFrequencyTable
            metrics={orderedMetrics}
            formatting={formatting}
            labelMap={activeLabelMap}
            reverseScale={scaleOrder === 'reversed'}
            hiddenLabels={hiddenResponseOptions}
            hiddenGroupValues={hiddenGroupValues}
            sortOrder={sortOrder}
          />
        </ChartExportWrapper>
      )
    }
    case 'cross_tab': {
      if (!crossTabColumnId) {
        return (
          <ChartExportWrapper
            title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
            supportsSvg={false} filename={exportFilename} formatting={formatting}
          >
            <div className="flex items-center justify-center h-64 text-mm-text-faint text-sm">
              Select a cross-tab column from Chart Options to compare
            </div>
          </ChartExportWrapper>
        )
      }
      if (!crossTabData) {
        return (
          <div className="flex items-center justify-center h-64 text-mm-text-faint text-sm gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading cross-tabulation...
          </div>
        )
      }
      return (
        <ChartExportWrapper
          title={chartTitle} subtitle={chartSubtitle} footnote={chartFootnote}
          supportsSvg={false} filename={exportFilename} formatting={formatting}
        >
          <AnalysisCrossTabTable
            data={crossTabData}
            display={crossTabDisplay}
            scaleOrder={scaleOrder}
            formatting={formatting}
          />
        </ChartExportWrapper>
      )
    }
    default:
      return null
  } })()

  return (
    <>
      {scaleWarning}
      {chartContent}
    </>
  )
}
