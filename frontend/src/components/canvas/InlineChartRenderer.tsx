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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { metricsApi, codeAnalysisApi, comparisonsApi } from '@/lib/api'
import type { MetricDefinitionResponse, AnalysisCrossTabResponse } from '@/lib/api'
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
  shapeHistogramBars,
  describeHistogramBasis,
  shapeDumbbellRows,
  computeDumbbellChartN,
  shapeSummaryStats,
} from '@/lib/chart-data'
import HorizontalBarChart from '@/components/charts/HorizontalBarChart'
import HeatmapTable from '@/components/charts/HeatmapTable'
import FrequencyBarChart from '@/components/charts/FrequencyBarChart'
import StackedHorizontalBarChart from '@/components/charts/StackedHorizontalBarChart'
import VerticalBarChart from '@/components/charts/VerticalBarChart'
import LineChartComponent from '@/components/charts/LineChart'
import DumbbellChart from '@/components/charts/DumbbellChart'
import SummaryStatsTable from '@/components/charts/SummaryStatsTable'
import DetailedFrequencyTable from '@/components/charts/DetailedFrequencyTable'
import AnalysisCrossTabTable from '@/components/charts/AnalysisCrossTabTable'
import {
  extractComputeParams,
  buildRequest,
  extractQualComputeParams,
  buildQualSaturationParams,
  buildQualComparisonRequest,
  qualChartKind,
  qualChartHasEnoughToFetch,
  extractComparisonParams,
  isComparisonMaterialConfig,
  isCorrelationMaterialConfig,
  isCrossTabMaterialConfig,
  extractCrossTabParams,
} from './inline-chart-params'
import ComparisonChartRouter from './ComparisonChartRouter'
import {
  fingerprintComparison,
  fingerprintMetrics,
  fingerprintSourceFrequencies,
  type FigureFingerprint,
} from './figure-baseline'
import QualChartRouter from './QualChartRouter'
import { isQualitativeMaterialConfig } from '@/lib/material-kind'
import { describeUnavailable } from '@/lib/comparison-unavailable'

// ── Props ────────────────────────────────────────────────────────────────────

export interface InlineChartRendererProps {
  projectId: number
  materialId: number
  content: Record<string, unknown>
  /**
   * 🔴 `isStale?: boolean` and `onRefresh?: () => void` USED TO BE HERE, and
   * neither was ever passed — `git log -S"isStale"` on the only consumer,
   * `extensions/ChartEmbedView.tsx`, is empty. They were optional, so nothing
   * type-errored and nothing linted, and the "Data stale" indicator they drove
   * could not render (#795, the #624/#626/#627/#630 half-landed-wire class).
   *
   * Do not re-add them. The wording was also wrong for this component: the
   * chart re-fetches through `quickCompute` on every render, so its figures are
   * never old. What CAN be out of date is an upstream computed column, and that
   * is now derived in `ChartEmbedView` beside the `missingRefs` warning — where
   * it cannot depend on a caller remembering to pass anything.
   */
  /**
   * The heading the embed already renders above this component (the material's
   * name). Passed in only so an identical config-side title is not printed a
   * second line below it — a config `title` that differs is still shown.
   */
  embedTitle?: string | null
  /**
   * #808 — report the numbers this embed DREW, so the view can diff them
   * against the baseline stored on the node.
   *
   * ⚠️ **REQUIRED, and that is the whole point.** The `isStale` prop this
   * component used to carry was optional and was never once passed (#795, the
   * half-landed-wire class) — nothing type-errored and the indicator could not
   * render. A second mount site cannot forget a required prop.
   *
   * ⚠️ Called on every successful data change, so the receiver must be stable
   * and must no-op on an unchanged value — the same guard the co-occurrence N
   * callback needs, for the same reason.
   */
  onFigure: (fingerprint: FigureFingerprint | null) => void
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
  embedTitle,
  onFigure,
}: InlineChartRendererProps) {
  // #652: a material is quantitative or qualitative by its CONFIG — the same
  // discriminator the "Open in Analysis" link routes on. Both branches' queries
  // are declared unconditionally and gated by `enabled`, so hook order is
  // stable across a config change.
  const isQual = useMemo(() => isQualitativeMaterialConfig(content), [content])

  // #817 — a QUANTITATIVE group comparison. Detected before the metric branch
  // because its config carries `column_ids` too, so `hasSelection` would be
  // true and it would compute a metric on the comparison's own variables — a
  // plausible wrong figure under the right title, which is exactly what shipped.
  const isComparisonMaterial = useMemo(() => !isQual && isComparisonMaterialConfig(content), [isQual, content])

  // #831 — a CORRELATION or SCATTER matrix. Detected for the same reason the
  // comparison is (its config carries `column_ids`, so the metric branch would
  // happily draw a frequency chart of the correlation's own variables) but
  // handled differently: there is no inline correlation renderer, so this
  // branch REFUSES rather than draws. A visible limit beats a silent wrong
  // figure — the whole lesson of #817.
  const isCorrelationMaterial = useMemo(
    () => !isQual && !isComparisonMaterial && isCorrelationMaterialConfig(content),
    [isQual, isComparisonMaterial, content],
  )
  const comparisonParams = useMemo(() => extractComparisonParams(content), [content])

  const params = useMemo(() => extractComputeParams(content), [content])
  const hasSelection = !isQual && !isComparisonMaterial && !isCorrelationMaterial
    && (params.columnIds.length > 0 || params.domainIds.length > 0)

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

  // #823(g) — a cross-tab is the one missing descriptives type that needs its
  // OWN endpoint; the other three shape from the metrics already fetched.
  //
  // ⚠️ #832: the axis derivation moved to `inline-chart-params.ts` so the EXPORT
  // reads the same one. It was inline here, and the export never learned it —
  // so `.md` carried the marginal distribution while this drew the cross-tab.
  const crossTabParams = useMemo(() => extractCrossTabParams(content), [content])
  const {
    data: crossTabData,
    isLoading: crossTabLoading,
  } = useQuery({
    queryKey: ['canvas-cross-tab', projectId, materialId, crossTabParams.request],
    queryFn: () => metricsApi.crossTabulation(projectId, crossTabParams.request!),
    enabled: !isQual && !isComparisonMaterial && !isCorrelationMaterial
      && isCrossTabMaterialConfig(content)
      && crossTabParams.request != null,
    staleTime: 5 * 60 * 1000,
  })

  const {
    data: comparisonData,
    isLoading: comparisonEmbedLoading,
    isError: comparisonEmbedError,
  } = useQuery({
    queryKey: ['canvas-comparison', projectId, materialId, comparisonParams.request],
    queryFn: () => comparisonsApi.groupComparison(projectId, comparisonParams.request!),
    enabled: isComparisonMaterial && comparisonParams.request != null,
    staleTime: 5 * 60 * 1000,
  })

  // ── Qualitative branch (#652 slabs 1–2) ─────────────────────────────────
  //
  // One query per endpoint, all declared unconditionally and gated by `enabled`
  // on the SAME derived kind, so hook order never depends on the config.
  const qualParams = useMemo(() => extractQualComputeParams(content), [content])
  const kind = isQual ? qualChartKind(qualParams) : null
  const qualEnabled = kind !== null && qualChartHasEnoughToFetch(qualParams)
  const isSourceFrequencyChart =
    kind === 'heatmap' || kind === 'bar' || kind === 'stacked_bar' || kind === 'summary'
  const isComparison = kind === 'comparison_table' || kind === 'comparison_bar'

  const {
    data: qualData,
    isLoading: qualLoading,
    isError: qualError,
  } = useQuery({
    // The coder scope rides inside `request`, so a material saved under a
    // narrowed coder filter can never read another material's cache entry
    // (the #454 keying rule, satisfied by construction here because the embed
    // sends exactly the scope it stored).
    queryKey: ['canvas-qual-chart', projectId, materialId, qualParams.request],
    queryFn: () => codeAnalysisApi.sourceFrequencies(projectId, qualParams.request),
    enabled: qualEnabled && isSourceFrequencyChart,
    staleTime: 5 * 60 * 1000,
  })

  const saturationParams = useMemo(() => buildQualSaturationParams(qualParams), [qualParams])
  const {
    data: qualSaturation,
    isLoading: saturationLoading,
    isError: saturationError,
  } = useQuery({
    queryKey: ['canvas-qual-saturation', projectId, materialId, saturationParams],
    queryFn: () => codeAnalysisApi.saturation(projectId, saturationParams),
    enabled: qualEnabled && kind === 'saturation',
    staleTime: 5 * 60 * 1000,
  })

  const comparisonRequest = useMemo(() => buildQualComparisonRequest(qualParams), [qualParams])
  const {
    data: qualComparison,
    isLoading: comparisonLoading,
    isError: comparisonError,
  } = useQuery({
    queryKey: ['canvas-qual-comparison', projectId, materialId, comparisonRequest],
    queryFn: () => codeAnalysisApi.demographicComparison(projectId, comparisonRequest!),
    enabled: qualEnabled && isComparison && comparisonRequest != null,
    staleTime: 5 * 60 * 1000,
  })

  // Co-occurrence fetches for itself, so its N arrives by callback rather than
  // from a payload we hold. The setter is guarded because the child reports on
  // every data change and an unconditional set would re-render in a loop.
  const [cooccurrenceN, setCooccurrenceN] = useState<number | null>(null)
  const handleCooccurrenceLoad = useCallback((info: { totalSegments: number; totalComments: number }) => {
    const next = info.totalSegments + info.totalComments
    setCooccurrenceN(prev => (prev === next ? prev : next))
  }, [])

  // #808 — one place computes what this embed drew, whichever branch drew it.
  // Derived rather than reported from each render path: a per-branch call would
  // be five sites to keep in step, and a branch added later would silently stop
  // reporting.
  const figure = useMemo<FigureFingerprint | null>(() => {
    if (isComparisonMaterial) {
      return comparisonData && comparisonData.rows.length > 0
        ? fingerprintComparison(comparisonData)
        : null
    }
    if (isQual) {
      return qualData ? fingerprintSourceFrequencies(qualData) : null
    }
    const ms = computeResult?.metrics ?? []
    return ms.length > 0 ? fingerprintMetrics(ms) : null
  }, [isComparisonMaterial, isQual, comparisonData, qualData, computeResult])

  useEffect(() => { onFigure(figure) }, [figure, onFigure])

  // #652: `content.auto_name` was read here and is NEVER populated — on ANY
  // path. `auto_name` is a sibling field in the create-material payload
  // (AnalysisView:1093 / QualitativeAnalysisView:737) and a sibling COLUMN on
  // the material row; it is not a config key. So this rendered the literal
  // string "Untitled" in every failure state, for quantitative charts too — a
  // quant chart whose column was deleted showed "Untitled / Chart unavailable".
  // The real title is rendered by ChartEmbedView directly above this component
  // (the only mount site), so the fallbacks below carry no name at all.
  const rawChartTitle = (content.chart_title as string) ?? (content.title as string) ?? ''
  // The embed already prints the material's name as its heading. When the
  // researcher's chart title is the same string, printing it again is just a
  // duplicated line; when it differs, both carry information and both stay.
  const chartTitle = rawChartTitle && rawChartTitle === embedTitle ? '' : rawChartTitle
  const chartSubtitle = (content.chart_subtitle as string) ?? (content.subtitle as string) ?? ''
  // The analysis view renders a footnote under every chart (`ChartExportWrapper`)
  // and researchers use it for the methods note. It was never carried onto the
  // canvas, so that note silently vanished on the surface meant for writing up.
  const chartFootnote = (content.footnote as string) ?? ''

  // Resolve chart type: prefer explicit from config, then detect from metrics
  const configChartType = (content.chart_type as ChartType) ?? null
  const metrics = useMemo(() => computeResult?.metrics ?? [], [computeResult])
  const detectedChartType = useMemo(
    () => (metrics.length > 0 ? detectChartType(metrics) : null),
    [metrics],
  )
  const chartType = configChartType ?? detectedChartType

  const formatting = useMemo(() => extractFormatting(content), [content])

  // ── Shared chrome ───────────────────────────────────────────────────────
  // Defined before the early returns so both branches print the same title /
  // subtitle / footnote furniture around whatever they draw.

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

  /**
   * `data-chart-capture-root` marks the clean subtree `captureCanvasChartPngs`
   * rasterizes for the HTML / PDF / docx exports — so everything inside this
   * frame, and nothing outside it, is what lands in an exported document.
   */
  const frame = (children: ReactNode, chartN?: number | null) => (
    <div className="max-w-[640px]" data-chart-capture-root>
      {titleBlock}
      {chartN != null && (
        <div className="text-mm-text-secondary mb-2" style={{ fontSize: formatting.labelFontSize, fontWeight: 500 }}>
          N = {chartN}
        </div>
      )}
      {children}
      {chartFootnote && (
        <div className="mt-3 text-mm-text-muted" style={{ fontSize: 11, fontStyle: 'italic' }}>
          {chartFootnote}
        </div>
      )}
    </div>
  )

  const notice = (message: ReactNode) => (
    <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
      {message}
    </div>
  )

  const spinner = (
    <div className="flex items-center justify-center py-8 text-mm-text-faint text-sm gap-2" role="status">
      <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
      Loading chart...
    </div>
  )

  // ── Qualitative branch (#652 slab 1) ────────────────────────────────────

  if (isQual) {
    if (kind === null) {
      // Since slab 4 nothing REACHABLE lands here — the only kind left without a
      // case is `qual_content`, which the save gate cannot produce. Kept because
      // it is what makes a tenth kind added to `qualChartKind` fail visibly
      // instead of rendering blank. The message still names what is true of THIS
      // chart rather than making a blanket claim about qualitative charts.
      return notice(
        <>
          This chart type can&rsquo;t be drawn on the canvas yet.
          <br />
          Open it in Analysis to view it.
        </>,
      )
    }
    if (!qualEnabled) {
      // Distinguishable from the above on purpose: the type IS supported, but
      // the saved config lacks what that particular chart needs — and what it
      // needs differs per kind, so the sentence does too.
      return notice(
        isComparison
          ? 'This comparison has no grouping variable selected.'
          : 'This chart has no codes or sources selected.',
      )
    }

    if (kind === 'saturation') {
      if (saturationLoading) return spinner
      if (saturationError || !qualSaturation) return notice('Chart unavailable')
      // Deliberately no N: the analysis view's saturation chart shows none
      // either, because the N it displays comes from the source-frequencies
      // payload and that query is disabled for this chart type.
      return frame(<QualChartRouter projectId={projectId} params={qualParams} formatting={formatting} saturation={qualSaturation} />)
    }

    if (isComparison) {
      if (comparisonLoading) return spinner
      if (comparisonError || !qualComparison) return notice('Chart unavailable')
      const comparisonN = Object.values(qualComparison.group_totals ?? {})
        .reduce((sum, g) => sum + g.total_segments, 0)
      return frame(
        <QualChartRouter projectId={projectId} params={qualParams} formatting={formatting} comparison={qualComparison} />,
        qualParams.showChartN ? comparisonN : null,
      )
    }

    if (kind === 'timeline') {
      // Self-fetching like co-occurrence, so no loading/error gate here — the
      // child renders its own states (including the two the canvas owns).
      //
      // ⚠️ `chartN` is explicitly null, never `showChartN`'s value: the analysis
      // view suppresses N for this chart type (`DescriptivesPanel.tsx:199` —
      // "the descriptives N counts segments/texts, not this chart's unit"), and
      // the source-frequencies query is disabled here anyway, so passing it
      // through would print an N from a payload this chart never used.
      return frame(
        <QualChartRouter projectId={projectId} params={qualParams} formatting={formatting} />,
        null,
      )
    }

    if (kind === 'cooccurrence') {
      // No loading/error gate here — this is the one component that owns its
      // query, so it renders its own states.
      return frame(
        <QualChartRouter
          projectId={projectId}
          params={qualParams}
          formatting={formatting}
          onCooccurrenceLoad={qualParams.showChartN ? handleCooccurrenceLoad : undefined}
        />,
        qualParams.showChartN ? cooccurrenceN : null,
      )
    }

    if (qualLoading) return spinner
    if (qualError || !qualData) return notice('Chart unavailable')

    return frame(
      <QualChartRouter
        projectId={projectId}
        params={qualParams}
        formatting={formatting}
        data={qualData}
      />,
      // Mirrors the analysis view's `descriptivesN`, from the same field.
      qualParams.showChartN ? qualData.totals?.coded_segments ?? null : null,
    )
  }

  // ── Quantitative COMPARISON branch (#817) ───────────────────────────────

  if (isCorrelationMaterial) {
    // No inline renderer for a correlation matrix or a scatter matrix. Naming
    // which it is matters: "this chart type" would read as a rendering fault,
    // where the researcher's actual next step is one click away.
    return notice(
      <>
        {content?.show_scatter ? 'Scatter matrices' : 'Correlation matrices'} can&rsquo;t be
        drawn on the canvas yet.
        <br />
        Open it in Analysis to view it.
      </>,
    )
  }

  if (isComparisonMaterial) {
    if (comparisonParams.request == null) return notice('No data configured')
    if (comparisonEmbedLoading) return spinner
    if (comparisonEmbedError || !comparisonData) return notice('Chart unavailable')
    if (comparisonData.rows.length === 0) {
      // The same reason vocabulary the analysis view reads (#823c/#827) — the
      // canvas must not invent its own sentence for an empty comparison either.
      const copy = describeUnavailable(comparisonData.unavailable_reason)
      return notice(copy?.title ?? 'No comparison data available.')
    }
    return frame(
      <ComparisonChartRouter
        data={comparisonData}
        chartType={comparisonParams.chartType}
        sigLevels={comparisonParams.sigLevels}
        nonparametric={comparisonParams.nonparametric}
        postHocExpanded={comparisonParams.postHocExpanded}
        formatting={formatting}
      />,
    )
  }

  // ── Quantitative branch ─────────────────────────────────────────────────

  if (!hasSelection) return notice('No data configured')
  if (isLoading) return spinner
  if (isError || metrics.length === 0) return notice('Chart unavailable')

  return frame(
    <ChartRouter
      chartType={chartType}
      metrics={metrics}
      metricType={params.metricType}
      formatting={formatting}
      content={content}
      crossTab={crossTabData ?? null}
      crossTabLoading={crossTabLoading}
      crossTabConfigured={crossTabParams.request != null}
      crossTabDisplay={crossTabParams.display}
      crossTabScaleOrder={crossTabParams.scaleOrder}
    />,
  )
}

// ── Internal chart router ────────────────────────────────────────────────────

interface ChartRouterProps {
  chartType: ChartType | null
  metrics: MetricDefinitionResponse[]
  metricType: string
  formatting: ChartFormatting
  content: Record<string, unknown>
  /** #823(g) — the cross-tab's own payload; null until it resolves. */
  crossTab: AnalysisCrossTabResponse | null
  crossTabLoading: boolean
  /** Whether the saved config names both axes; a cross-tab needs two columns. */
  crossTabConfigured: boolean
  /**
   * #832 — threaded from `extractCrossTabParams` rather than re-read from
   * `content` here, so this table and the EXPORT'S table cannot disagree about
   * which cell field to show. ⚠️ `cross_tab_display` is a DIFFERENT key from the
   * `display` this router reads for every other chart type.
   */
  crossTabDisplay: string
  crossTabScaleOrder: string
}

function ChartRouter({
  chartType, metrics, metricType, formatting, content,
  crossTab, crossTabLoading, crossTabConfigured, crossTabDisplay, crossTabScaleOrder,
}: ChartRouterProps) {
  const display = (content.display as 'percentage' | 'count') ?? 'percentage'
  const scaling = (content.scaling as 'relative' | 'absolute') ?? 'relative'
  const hiddenResponseOptions = (content.hiddenResponseOptions as string[]) ?? []
  const scaleOrder = (content.scaleOrder as 'natural' | 'reversed') ?? 'natural'
  const reverseScale = scaleOrder === 'reversed'

  if (!chartType) {
    return (
      <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
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

    case 'histogram': {
      // #522 — the canvas draws the histogram rather than falling through to
      // "histogram chart", so a saved distribution stays a distribution. The
      // bins come from `formatting.binWidth`, which rides the material config
      // like every other formatting field, and the basis line rides the chart.
      const { bars, histogram } = shapeHistogramBars(metrics[0], { binWidth: formatting.binWidth })
      const nInfo = computeFreqBarChartN(metrics)
      return (
        <div>
          <VerticalBarChart
            histogram
            frequencyData={bars}
            display={display}
            sortOrder="none"
            chartN={nInfo.chartN}
            formatting={formatting}
          />
          <p className="text-xs text-mm-text-faint mt-1">{describeHistogramBasis(histogram)}</p>
        </div>
      )
    }

    // ── #823(g): the four types that used to print their own name ──────────
    //
    // They fell to the `default` below, which rendered the raw token — the
    // literal string "frequency_table chart" — on a user surface. Three of the
    // six materials the GSS pass saved were these types. The data was already
    // here for three of them; only the cross-tab needed a second request.

    case 'dumbbell': {
      const dumbbellData = shapeDumbbellRows(metrics, undefined, {
        hiddenGroupValues: (content.hidden_group_values as string[]) ?? undefined,
      })
      const nInfo = computeDumbbellChartN(dumbbellData)
      return (
        <DumbbellChart
          data={dumbbellData}
          showCI={content.showCI === true}
          chartN={nInfo.chartN}
          groupNs={nInfo.groupNs}
          hasVaryingGroupN={nInfo.hasVaryingGroupN}
          formatting={formatting}
          metricType={metricType}
        />
      )
    }

    case 'table':
      return (
        <SummaryStatsTable
          data={shapeSummaryStats(metrics, undefined, metricType)}
          showCI={content.showCI === true}
          formatting={formatting}
          metricType={metricType}
        />
      )

    case 'frequency_table':
      return (
        <DetailedFrequencyTable
          metrics={metrics}
          formatting={formatting}
          reverseScale={reverseScale}
          hiddenLabels={shapeOpts.hiddenLabels}
          hiddenGroupValues={(content.hidden_group_values as string[]) ?? undefined}
        />
      )

    case 'cross_tab': {
      // A cross-tab needs BOTH axes. The analysis view can prompt for the
      // missing one; an embed cannot, so it says which half is absent rather
      // than rendering an empty table.
      if (!crossTabConfigured) {
        return (
          <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
            This cross-tab has no comparison column saved.
          </div>
        )
      }
      if (crossTabLoading || !crossTab) {
        return (
          <div className="flex items-center justify-center py-8 text-mm-text-faint text-sm gap-2" role="status">
            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
            Loading chart...
          </div>
        )
      }
      return (
        <AnalysisCrossTabTable
          data={crossTab}
          display={crossTabDisplay}
          scaleOrder={crossTabScaleOrder}
          formatting={formatting}
        />
      )
    }

    default:
      // ⚠️ Names no type. The old fallback printed `{chartType} chart` — a raw
      // token like "frequency_table chart" — which reads as a rendering bug
      // rather than a limit, and tells the researcher nothing about what to do.
      // Wording matches the qualitative branch's equivalent notice.
      return (
        <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
          This chart type can&rsquo;t be drawn on the canvas yet.
          <br />
          Open it in Analysis to view it.
        </div>
      )
  }
}
