/**
 * Mounts a qualitative Descriptives chart inside a canvas embed (#652 slab 1).
 *
 * The four components below are already standalone and props-driven — the same
 * instances `DescriptivesPanel` mounts in the analysis view — so this router
 * only maps a saved material config onto their props. It deliberately does NOT
 * wrap them in `ChartExportWrapper` the way the analysis view does: that
 * wrapper carries per-chart export buttons, which belong on the analysis
 * surface and not inside a document the researcher is writing. The title /
 * subtitle / footnote chrome it also provides is rendered by
 * `InlineChartRenderer` instead, so the embed keeps that fidelity without the
 * controls.
 *
 * The click-through handlers (`onCellClick` / `onCodeClick` / `onBarClick`) are
 * intentionally omitted: on the analysis view they jump to the Content tab, a
 * destination that does not exist from inside a canvas. The embed's own
 * "Open in Analysis" link is the affordance for that.
 */
import type {
  SourceFrequenciesResponse,
  SaturationResponse,
  DemographicComparisonResponse,
} from '@/lib/api'
import type { ChartFormatting } from '@/lib/chart-data'
import QualHeatmap from '@/components/qualitative-analysis/QualHeatmap'
import QualBarChart from '@/components/qualitative-analysis/QualBarChart'
import QualStackedBar from '@/components/qualitative-analysis/QualStackedBar'
import QualSummaryTable from '@/components/qualitative-analysis/QualSummaryTable'
import SaturationCurve from '@/components/qualitative-analysis/SaturationCurve'
import QualCooccurrence from '@/components/qualitative-analysis/QualCooccurrence'
import QualComparisonTable from '@/components/qualitative-analysis/QualComparisonTable'
import QualComparisonBar from '@/components/qualitative-analysis/QualComparisonBar'
import QualTimelineEmbed from './QualTimelineEmbed'
import {
  buildQualCooccurrenceParams,
  qualChartKind,
  type QualComputeParams,
} from './inline-chart-params'

export interface QualChartRouterProps {
  projectId: number
  params: QualComputeParams
  formatting: ChartFormatting
  /** The source-frequency four only. */
  data?: SourceFrequenciesResponse
  saturation?: SaturationResponse
  comparison?: DemographicComparisonResponse
  /**
   * Co-occurrence reports its own N once loaded (it is the one component that
   * fetches for itself, so the parent cannot read the payload).
   */
  onCooccurrenceLoad?: (info: { totalSegments: number; totalComments: number }) => void
}

export default function QualChartRouter({
  projectId,
  params,
  formatting,
  data,
  saturation,
  comparison,
  onCooccurrenceLoad,
}: QualChartRouterProps) {
  const kind = qualChartKind(params)

  // Co-occurrence is the odd one out: it takes `projectId` + filter params and
  // runs its OWN query, so it mounts without the parent having fetched anything.
  if (kind === 'cooccurrence') {
    return (
      <QualCooccurrence
        projectId={projectId}
        filterParams={buildQualCooccurrenceParams(params)}
        cooccurrenceLevel={params.cooccurrenceLevel}
        showProportion={params.showProportion}
        colorPreset={params.cooccurrencePreset}
        labelFontSize={formatting.labelFontSize}
        onDataLoad={onCooccurrenceLoad}
      />
    )
  }

  // The Timeline is the OTHER self-fetching child (#652 slab 4): it has no
  // endpoint at all, so it assembles its own reference data and lets
  // `TimedAnalytics` fetch one clip list per observation.
  if (kind === 'timeline') {
    return (
      <QualTimelineEmbed
        projectId={projectId}
        params={params}
        labelFontSize={formatting.labelFontSize}
      />
    )
  }

  if (kind === 'saturation') {
    return saturation ? <SaturationCurve data={saturation} /> : null
  }

  if (kind === 'comparison_table') {
    return comparison ? <QualComparisonTable data={comparison} showEffectSize={params.showEffectSize} /> : null
  }

  if (kind === 'comparison_bar') {
    return comparison ? <QualComparisonBar data={comparison} colorPalette={params.comparisonPalette} /> : null
  }

  if (!data) return null

  switch (kind) {
    case 'heatmap':
      return (
        <QualHeatmap
          data={data}
          valueMode={params.valueMode}
          denominatorMode={params.denominatorMode}
          orientation={params.orientation}
          sortOrder={params.sortOrder}
          customOrder={params.customOrder}
          showSummaryRow={params.showSummaryRow}
          showRowN={params.showRowN}
          heatmapPreset={formatting.heatmapPreset}
          labelFontSize={formatting.labelFontSize}
          dataFontSize={formatting.dataLabelFontSize}
        />
      )

    case 'bar':
      return (
        <QualBarChart
          data={data}
          valueMode={params.valueMode}
          denominatorMode={params.denominatorMode}
          sortOrder={params.sortOrder}
          customOrder={params.customOrder}
          groupBy={params.groupBy}
          labelFontSize={formatting.labelFontSize}
          dataFontSize={formatting.dataLabelFontSize}
          dataLabels={formatting.dataLabels}
        />
      )

    case 'stacked_bar':
      return (
        <QualStackedBar
          data={data}
          orientation={params.orientation}
          sortOrder={params.sortOrder}
          customOrder={params.customOrder}
          valueMode={params.valueMode}
          denominatorMode={params.denominatorMode}
          labelFontSize={formatting.labelFontSize}
          dataFontSize={formatting.dataLabelFontSize}
          dataLabels={formatting.dataLabels}
        />
      )

    case 'summary':
      return (
        <QualSummaryTable
          data={data}
          categoryMode={params.categoryMode}
        />
      )

    default:
      // Unreachable: the parent gates on `qualChartKind`, the single source for
      // this set. Kept total so a kind added there without a case here fails
      // visibly rather than rendering blank.
      return (
        <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
          This chart type can&rsquo;t be drawn on the canvas yet.
        </div>
      )
  }
}
