import { useState } from 'react'
import {
  ChevronDown,
  SlidersHorizontal,
} from 'lucide-react'
import type {
  DemographicFilter,
  SourceFrequenciesResponse,
  SaturationResponse,
} from '@/lib/api'
import type { QualitativeAnalysisState, QualitativeAnalysisActions } from '@/hooks/useQualitativeAnalysis'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'
import QualChartTypeToolbar from '@/components/qualitative-analysis/QualChartTypeToolbar'
import QualChartOptionsPanel from '@/components/qualitative-analysis/QualChartOptionsPanel'
import QualHeatmap from '@/components/qualitative-analysis/QualHeatmap'
import QualBarChart from '@/components/qualitative-analysis/QualBarChart'
import QualSummaryTable from '@/components/qualitative-analysis/QualSummaryTable'
import QualStackedBar from '@/components/qualitative-analysis/QualStackedBar'
import SaturationCurve from '@/components/qualitative-analysis/SaturationCurve'
import TimedAnalytics, {
  type TimedCodeLite, type TimedCoderLite, type TimedObservationLite,
} from '@/components/qualitative-analysis/TimedAnalytics'
import type { CoderInclude } from '@/lib/timed-analytics'
import type { QualValueMode, QualDenominatorMode } from '@/lib/qual-analysis-types'

function getMetricDescription(
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
  source: 'all' | 'conversations' | 'text',
  excludeFacilitator: boolean,
): string {
  let desc: string
  switch (valueMode) {
    case 'count':
      desc = source === 'text' ? 'Text count per source'
        : source === 'conversations' ? 'Segment count per source'
        : 'Segment + text count per source'
      break
    case 'segment_proportion':
      desc = denominatorMode === 'coded'
        ? 'Proportion of coded segments' : 'Proportion of all segments'
      break
    case 'text_coverage':
      desc = 'Word coverage per source'
      break
  }
  if (excludeFacilitator && source !== 'text') {
    desc += ' · Facilitator excluded'
  }
  return desc
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

export interface DescriptivesSidebarProps {
  qa: QualitativeAnalysisState & QualitativeAnalysisActions
  /**
   * The entities on the chart's CODE AXIS — categories under
   * `codeMode === 'categories'`, active codes otherwise (#675). Decided by the
   * view, which is the one place that knows the mode.
   */
  axisEntities: { id: number; name: string }[]
  demoFilters: DemographicFilter[]
  onValueModeChange: (mode: QualitativeAnalysisState['valueMode']) => void
  onOrientationChange: (orient: QualitativeAnalysisState['orientation']) => void
}

export function DescriptivesSidebar({ qa, axisEntities, demoFilters, onValueModeChange, onOrientationChange }: DescriptivesSidebarProps) {
  const [chartOptionsOpen, setChartOptionsOpen] = useState(false)

  return (
    <div className={`border-t ${!chartOptionsOpen ? 'shrink-0' : 'flex-1 min-h-0 flex flex-col'}`}>
      <button
        className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
        onClick={() => setChartOptionsOpen(prev => !prev)}
        aria-expanded={chartOptionsOpen}
      >
        <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!chartOptionsOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
        <SlidersHorizontal className="w-4 h-4 text-mm-text-muted" />
        Chart Options
      </button>
      {chartOptionsOpen && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <QualChartOptionsPanel
            chartType={qa.chartType}
            valueMode={qa.valueMode}
            onValueModeChange={onValueModeChange}
            denominatorMode={qa.denominatorMode}
            onDenominatorModeChange={qa.setDenominatorMode}
            sortOrder={qa.sortOrder}
            onSortOrderChange={qa.setSortOrder}
            showSummaryRow={qa.showSummaryRow}
            onShowSummaryRowChange={qa.setShowSummaryRow}
            showRowN={qa.showRowN}
            onShowRowNChange={qa.setShowRowN}
            formatting={qa.formatting}
            onFormattingChange={qa.onFormattingChange}
            customOrder={qa.customOrder}
            onCustomOrderChange={qa.setCustomOrder}
            axisEntities={axisEntities}
            categoryMode={qa.codeMode === 'categories'}
            groupBy={qa.groupBy}
            onGroupByChange={qa.setGroupBy}
            demoFilters={demoFilters}
            orientation={qa.orientation}
            onOrientationChange={onOrientationChange}
            title={qa.descTitle}
            subtitle={qa.descSubtitle}
            footnote={qa.descFootnote}
            onTitleChange={qa.setDescTitle}
            onSubtitleChange={qa.setDescSubtitle}
            onFootnoteChange={qa.setDescFootnote}
            showChartN={qa.showChartN}
            onShowChartNChange={qa.setShowChartN}
          />
        </div>
      )}
    </div>
  )
}

// ── Content ──────────────────────────────────────────────────────────────────

export interface DescriptivesContentProps {
  qa: QualitativeAnalysisState & QualitativeAnalysisActions
  codes: { id: number; is_active: boolean }[]
  hasQualSelection: boolean
  hasCodeSelection: boolean
  hasSourceSelection: boolean
  conversationSourceCount: number
  descriptivesN: number | null
  sourceFreqData: SourceFrequenciesResponse | undefined
  sourceFreqLoading: boolean
  saturationData: SaturationResponse | undefined
  saturationLoading: boolean
  onChartTypeChange: (type: QualitativeAnalysisState['chartType']) => void
  // ── Timeline chart type (slab 6c, §8q) ──
  projectId: number
  timedObservations: TimedObservationLite[]
  timedCodes: TimedCodeLite[]
  timedCategories: { id: number; name: string }[]
  coderInclude: CoderInclude
  multiCoder: boolean
  coderMap: ReadonlyMap<number, TimedCoderLite>
}

export function DescriptivesContent(props: DescriptivesContentProps) {
  const {
    qa, codes,
    hasQualSelection, hasCodeSelection, hasSourceSelection,
    conversationSourceCount, descriptivesN,
    sourceFreqData, sourceFreqLoading,
    saturationData, saturationLoading,
    onChartTypeChange,
    projectId, timedObservations, timedCodes, timedCategories,
    coderInclude, multiCoder, coderMap,
  } = props

  return (
    <div className="space-y-3">
      <QualChartTypeToolbar
        chartType={qa.chartType}
        onChartTypeChange={onChartTypeChange}
        selectedCodeCount={qa.selectedCodeIds.size > 0 ? qa.selectedCodeIds.size : codes.filter(c => c.is_active).length}
        conversationSourceCount={conversationSourceCount}
        observationSourceCount={timedObservations.length}
        humanLayer={qa.layerScope !== 'consensus'}
        categoryMode={qa.codeMode === 'categories'}
      />

      {/* Metric context line — timeline states its own denominators per block */}
      {hasQualSelection && qa.chartType !== 'saturation' && qa.chartType !== 'timeline' && (
        <p className="text-xs text-mm-text-muted px-1">
          {getMetricDescription(qa.valueMode, qa.denominatorMode, qa.source, qa.excludeFacilitator)}
        </p>
      )}

      {!hasQualSelection ? (
        <div className="text-center py-16">
          <p className="text-mm-text-muted">
            {!hasCodeSelection && !hasSourceSelection
              ? 'No codes or sources selected.'
              : !hasCodeSelection
                ? 'No codes selected.'
                : 'No sources selected.'}
          </p>
          <p className="text-sm text-mm-text-faint mt-1">
            Select codes and sources from the sidebar to visualize.
          </p>
        </div>
      ) : (
      <>
      <div>
        <div className="rounded-lg border overflow-hidden">
        <ChartExportWrapper
          formatting={qa.formatting}
          filename={`qual-${qa.chartType}`}
          supportsSvg={qa.chartType !== 'heatmap' && qa.chartType !== 'summary' && qa.chartType !== 'timeline'}
          title={qa.descTitle}
          subtitle={qa.descSubtitle}
          footnote={qa.descFootnote}
          // The descriptives N counts segments/texts — not this chart's unit.
          chartN={qa.chartType === 'timeline' ? undefined : descriptivesN ?? undefined}
          showChartN={qa.showChartN}
        >
        {qa.chartType === 'timeline' ? (
          <TimedAnalytics
            projectId={projectId}
            observations={timedObservations}
            codes={timedCodes}
            categories={timedCategories}
            include={coderInclude}
            multiCoder={multiCoder}
            coderMap={coderMap}
            consensusScope={qa.layerScope === 'consensus'}
            labelFontSize={qa.formatting.labelFontSize}
            tableMode={qa.timelineTableMode}
            onTableModeChange={qa.setTimelineTableMode}
          />
        ) : qa.chartType === 'saturation' ? (
          saturationLoading ? (
            <div className="text-center py-8 text-mm-text-muted">Loading saturation data...</div>
          ) : saturationData ? (
            <SaturationCurve data={saturationData} />
          ) : null
        ) : sourceFreqLoading ? (
          <div className="text-center py-8 text-mm-text-muted">Loading data...</div>
        ) : sourceFreqData ? (
          <>
            {qa.chartType === 'heatmap' && (
              <QualHeatmap
                data={sourceFreqData}
                valueMode={qa.valueMode}
                denominatorMode={qa.denominatorMode}
                orientation={qa.orientation}
                sortOrder={qa.sortOrder}
                customOrder={qa.customOrder}
                showSummaryRow={qa.showSummaryRow}
                showRowN={qa.showRowN}
                heatmapPreset={qa.formatting.heatmapPreset}
                labelFontSize={qa.formatting.labelFontSize}
                dataFontSize={qa.formatting.dataLabelFontSize}
                onCellClick={(rowId, colId) => {
                  const codeId = qa.orientation === 'codes-rows' ? rowId : colId
                  qa.viewCodeInContent(codeId)
                }}
              />
            )}
            {qa.chartType === 'bar' && (
              <QualBarChart
                data={sourceFreqData}
                valueMode={qa.valueMode}
                denominatorMode={qa.denominatorMode}
                sortOrder={qa.sortOrder}
                customOrder={qa.customOrder}
                groupBy={qa.groupBy}
                labelFontSize={qa.formatting.labelFontSize}
                dataFontSize={qa.formatting.dataLabelFontSize}
                dataLabels={qa.formatting.dataLabels}
                onCodeClick={qa.viewCodeInContent}
              />
            )}
            {qa.chartType === 'stacked_bar' && (
              <QualStackedBar
                data={sourceFreqData}
                orientation={qa.orientation}
                sortOrder={qa.sortOrder}
                customOrder={qa.customOrder}
                valueMode={qa.valueMode}
                denominatorMode={qa.denominatorMode}
                labelFontSize={qa.formatting.labelFontSize}
                dataFontSize={qa.formatting.dataLabelFontSize}
                dataLabels={qa.formatting.dataLabels}
                onBarClick={qa.viewCodeInContent}
              />
            )}
            {/* #749: one payload. The per-kind columns used to arrive from
                `freqData` (code-frequencies), which reads an unselected kind as
                ALL of that kind — so the table mixed two scopes. */}
            {qa.chartType === 'summary' && (
              <QualSummaryTable
                data={sourceFreqData}
                onCodeClick={qa.viewCodeInContent}
                categoryMode={qa.codeMode === 'categories'}
              />
            )}
          </>
        ) : null}
        </ChartExportWrapper>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
