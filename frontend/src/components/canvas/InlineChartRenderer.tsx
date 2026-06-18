/**
 * Renders full Recharts charts inline inside canvas material blocks.
 *
 * Uses the block's cached `content` to extract quickCompute params,
 * fetches metric data via quickCompute, then routes to the appropriate
 * chart component based on chart type.
 *
 * Supports: horizontal_bar, heatmap, vertical_bar, stacked_bar, line.
 * Unsupported chart types fall back to a text label.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { metricsApi } from '@/lib/api'
import type { MetricDefinitionResponse } from '@/lib/api'
import {
  detectChartType,
  shapeScalarBars,
  shapeFrequencyBars,
  shapeHeatmapRows,
  shapeStackedBars,
  shapeLineChart,
  computeBarChartN,
  computeHeatmapChartN,
  computeFreqBarChartN,
  computeStackedBarChartN,
  computeLineChartN,
  mergeFormatting,
  DEFAULT_FORMATTING,
  type ChartType,
  type ChartFormatting,
} from '@/lib/chart-data'
import HorizontalBarChart from '@/components/charts/HorizontalBarChart'
import HeatmapTable from '@/components/charts/HeatmapTable'
import FrequencyBarChart from '@/components/charts/FrequencyBarChart'
import StackedHorizontalBarChart from '@/components/charts/StackedHorizontalBarChart'
import VerticalBarChart from '@/components/charts/VerticalBarChart'
import LineChartComponent from '@/components/charts/LineChart'
import { extractComputeParams, buildRequest } from './inline-chart-params'

// ── Props ────────────────────────────────────────────────────────────────────

export interface InlineChartRendererProps {
  projectId: number
  materialId: number
  content: Record<string, unknown>
  isStale?: boolean
  onRefresh?: () => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// extractComputeParams / buildRequest moved to ./inline-chart-params (shared
// with the canvas export pipeline; keeps this component file Fast-Refresh-clean).

/** Extract formatting from content, falling back to defaults. */
function extractFormatting(content: Record<string, unknown>): ChartFormatting {
  const raw = content.formatting as Partial<ChartFormatting> | undefined
  return raw ? mergeFormatting(raw) : DEFAULT_FORMATTING
}

// ── Component ────────────────────────────────────────────────────────────────

export default function InlineChartRenderer({
  projectId,
  materialId,
  content,
  isStale,
  onRefresh,
}: InlineChartRendererProps) {
  const params = useMemo(() => extractComputeParams(content), [content])
  const hasSelection = params.columnIds.length > 0 || params.domainIds.length > 0

  const request = useMemo(
    () => (hasSelection ? buildRequest(params) : null),
    [params, hasSelection],
  )

  const { data: computeResult, isLoading, isError } = useQuery({
    queryKey: ['canvas-chart', projectId, materialId, request],
    queryFn: () => metricsApi.quickCompute(projectId, request!),
    enabled: hasSelection && request != null,
    staleTime: 5 * 60 * 1000,
  })

  const autoName = (content.auto_name as string) ?? 'Untitled'
  const chartTitle = (content.chart_title as string) ?? (content.title as string) ?? ''
  const chartSubtitle = (content.chart_subtitle as string) ?? (content.subtitle as string) ?? ''

  // Resolve chart type: prefer explicit from config, then detect from metrics
  const configChartType = (content.chart_type as ChartType) ?? null
  const metrics = useMemo(() => computeResult?.metrics ?? [], [computeResult])
  const detectedChartType = useMemo(
    () => (metrics.length > 0 ? detectChartType(metrics) : null),
    [metrics],
  )
  const chartType = configChartType ?? detectedChartType

  const formatting = useMemo(() => extractFormatting(content), [content])

  // ── Empty / loading / error states ──────────────────────────────────────

  if (!hasSelection) {
    return (
      <div className="text-sm text-mm-text-faint py-4 text-center">
        <div className="font-medium text-mm-text mb-1">{autoName}</div>
        No data configured
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-mm-text-faint text-sm gap-2" role="status">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading chart...
      </div>
    )
  }

  if (isError || metrics.length === 0) {
    return (
      <div className="text-sm text-mm-text-faint py-4 text-center">
        <div className="font-medium text-mm-text mb-1">{autoName}</div>
        Chart unavailable
      </div>
    )
  }

  // ── Chart rendering ────────────────────────────────────────────────────

  const staleIndicator = isStale && (
    <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mb-2">
      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
      Data stale
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="underline hover:no-underline ml-1"
        >
          Refresh
        </button>
      )}
    </div>
  )

  const titleBlock = (chartTitle || chartSubtitle) && (
    <div className="mb-2">
      {chartTitle && (
        <div className="font-semibold text-mm-text" style={{ fontSize: formatting.titleFontSize }}>
          {chartTitle}
        </div>
      )}
      {chartSubtitle && (
        <div className="text-mm-text-muted text-xs mt-0.5">{chartSubtitle}</div>
      )}
    </div>
  )

  return (
    <div className="max-w-[640px]" data-chart-capture-root>
      {staleIndicator}
      {titleBlock}
      <ChartRouter
        chartType={chartType}
        metrics={metrics}
        metricType={params.metricType}
        formatting={formatting}
        content={content}
        autoName={autoName}
      />
    </div>
  )
}

// ── Internal chart router ────────────────────────────────────────────────────

interface ChartRouterProps {
  chartType: ChartType | null
  metrics: MetricDefinitionResponse[]
  metricType: string
  formatting: ChartFormatting
  content: Record<string, unknown>
  autoName: string
}

function ChartRouter({ chartType, metrics, metricType, formatting, content, autoName }: ChartRouterProps) {
  const display = (content.display as 'percentage' | 'count') ?? 'percentage'
  const scaling = (content.scaling as 'relative' | 'absolute') ?? 'relative'
  const hiddenResponseOptions = (content.hiddenResponseOptions as string[]) ?? []
  const scaleOrder = (content.scaleOrder as 'natural' | 'reversed') ?? 'natural'
  const reverseScale = scaleOrder === 'reversed'

  if (!chartType) {
    return (
      <div className="text-sm text-mm-text-faint py-4 text-center">
        <div className="font-medium text-mm-text mb-1">{autoName}</div>
        {metricType} chart
      </div>
    )
  }

  const shapeOpts = {
    hiddenLabels: hiddenResponseOptions.length > 0 ? hiddenResponseOptions : undefined,
    reverseScale: reverseScale || undefined,
  }

  switch (chartType) {
    case 'horizontal_bar': {
      if (metricType === 'frequency_distribution') {
        const nInfo = computeFreqBarChartN(metrics)
        return (
          <FrequencyBarChart
            metrics={metrics}
            display={display}
            formatting={formatting}
            hiddenLabels={shapeOpts.hiddenLabels}
            reverseScale={reverseScale}
            chartN={nInfo.chartN}
          />
        )
      }
      const barData = shapeScalarBars(metrics)
      const nInfo = computeBarChartN(barData)
      return (
        <HorizontalBarChart
          data={barData}
          formatting={formatting}
          metricType={metricType}
          chartN={nInfo.chartN}
          isAnimationActive={false}
        />
      )
    }

    case 'heatmap': {
      const heatmapData = shapeHeatmapRows(metrics, shapeOpts)
      const nInfo = computeHeatmapChartN(heatmapData)
      return (
        <HeatmapTable
          data={heatmapData}
          display={display}
          scaling={scaling}
          formatting={formatting}
          chartN={nInfo.chartN}
        />
      )
    }

    case 'vertical_bar': {
      if (metricType === 'frequency_distribution' && metrics.length > 0) {
        const freqBars = shapeFrequencyBars(metrics[0], shapeOpts)
        const nInfo = computeFreqBarChartN(metrics)
        return (
          <VerticalBarChart
            frequencyData={freqBars}
            display={display}
            formatting={formatting}
            chartN={nInfo.chartN}
          />
        )
      }
      const barData = shapeScalarBars(metrics)
      return (
        <VerticalBarChart
          scalarData={barData}
          formatting={formatting}
          metricType={metricType}
        />
      )
    }

    case 'stacked_bar': {
      const stackedData = shapeStackedBars(metrics, formatting.colorPalette, shapeOpts)
      const nInfo = computeStackedBarChartN(stackedData)
      return (
        <StackedHorizontalBarChart
          data={stackedData}
          mode={display === 'count' ? 'count' : '100%'}
          formatting={formatting}
          chartN={nInfo.chartN}
        />
      )
    }

    case 'line': {
      const lineData = shapeLineChart(metrics)
      const nInfo = computeLineChartN(lineData)
      return (
        <LineChartComponent
          data={lineData}
          formatting={formatting}
          metricType={metricType}
          chartN={nInfo.chartN}
        />
      )
    }

    default:
      // Fallback for unsupported chart types (dumbbell, table, frequency_table, cross_tab)
      return (
        <div className="text-sm text-mm-text-faint py-4 text-center">
          <div className="font-medium text-mm-text mb-1">{autoName}</div>
          {chartType} chart
        </div>
      )
  }
}
