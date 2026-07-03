import { useState } from 'react'
import {
  ChevronDown,
  SlidersHorizontal,
} from 'lucide-react'
import type {
  DemographicFilter,
  SourceFrequenciesResponse,
  SaturationResponse,
  CodeFrequencySummary,
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
  codes: { id: number; name: string; is_active: boolean }[]
  demoFilters: DemographicFilter[]
  onValueModeChange: (mode: QualitativeAnalysisState['valueMode']) => void
  onOrientationChange: (orient: QualitativeAnalysisState['orientation']) => void
}

export function DescriptivesSidebar({ qa, codes, demoFilters, onValueModeChange, onOrientationChange }: DescriptivesSidebarProps) {
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
            codes={codes.filter(c => c.is_active).map(c => ({ id: c.id, name: c.name }))}
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
  freqData: CodeFrequencySummary | undefined
  onChartTypeChange: (type: QualitativeAnalysisState['chartType']) => void
}

export function DescriptivesContent(props: DescriptivesContentProps) {
  const {
    qa, codes,
    hasQualSelection, hasCodeSelection, hasSourceSelection,
    conversationSourceCount, descriptivesN,
    sourceFreqData, sourceFreqLoading,
    saturationData, saturationLoading,
    freqData, onChartTypeChange,
  } = props

  return (
    <div className="space-y-3">
      <QualChartTypeToolbar
        chartType={qa.chartType}
        onChartTypeChange={onChartTypeChange}
        selectedCodeCount={qa.selectedCodeIds.size > 0 ? qa.selectedCodeIds.size : codes.filter(c => c.is_active).length}
        conversationSourceCount={conversationSourceCount}
        categoryMode={qa.codeMode === 'categories'}
      />

      {/* Metric context line */}
      {hasQualSelection && qa.chartType !== 'saturation' && (
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
          supportsSvg={qa.chartType !== 'heatmap' && qa.chartType !== 'summary'}
          title={qa.descTitle}
          subtitle={qa.descSubtitle}
          footnote={qa.descFootnote}
          chartN={descriptivesN ?? undefined}
          showChartN={qa.showChartN}
        >
        {qa.chartType === 'saturation' ? (
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
                valueMode={qa.valueMode}
                denominatorMode={qa.denominatorMode}
                labelFontSize={qa.formatting.labelFontSize}
                dataFontSize={qa.formatting.dataLabelFontSize}
                dataLabels={qa.formatting.dataLabels}
                onBarClick={qa.viewCodeInContent}
              />
            )}
            {qa.chartType === 'summary' && (
              <QualSummaryTable
                data={sourceFreqData}
                onCodeClick={qa.viewCodeInContent}
                categoryMode={qa.codeMode === 'categories'}
                frequencies={freqData?.frequencies}
                source={qa.source}
                totalCoded={freqData?.total_coded_segments}
                totalConversations={freqData?.total_conversations}
                totalParticipants={freqData?.total_participants}
                unlinkedSpeakerCount={freqData?.unlinked_speaker_count}
                totalCodedComments={freqData?.total_coded_texts ?? 0}
                totalRecords={freqData?.total_rows ?? 0}
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
