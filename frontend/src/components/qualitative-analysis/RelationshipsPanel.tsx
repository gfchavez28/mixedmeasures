import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Download,
  ChevronDown,
  Layers,
  Palette,
  SlidersHorizontal,
  TableProperties,
  Type,
  ALargeSmall,
  Users,
} from 'lucide-react'
import {
  type CodeAnalysisFilterParams,
  type DemographicFilter,
  type DemographicComparisonResponse,
  exportApi,
} from '@/lib/api'
import { HEATMAP_LABELS, PALETTE_LABELS, COLOR_PALETTES } from '@/lib/chart-data'
import type { QualRelView, QualComparisonChartMode } from '@/lib/qual-analysis-types'
import type { QualitativeAnalysisState, QualitativeAnalysisActions } from '@/hooks/useQualitativeAnalysis'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import SegmentedControl from '@/components/ui/segmented-control'
import { OptionsAccordion, AccordionSection, useAccordionState } from '@/components/analysis/OptionsAccordion'
import OptionRow from '@/components/analysis/OptionRow'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'
import QualCooccurrence from '@/components/qualitative-analysis/QualCooccurrence'
import QualComparisonTable from '@/components/qualitative-analysis/QualComparisonTable'
import QualComparisonBar from '@/components/qualitative-analysis/QualComparisonBar'

// ── Sidebar ──────────────────────────────────────────────────────────────────

export interface RelationshipsSidebarProps {
  qa: QualitativeAnalysisState & QualitativeAnalysisActions
  demoFilters: DemographicFilter[]
  setSrAnnouncement: (msg: string) => void
}

export function RelationshipsSidebar({ qa, demoFilters, setSrAnnouncement }: RelationshipsSidebarProps) {
  const [chartOptionsRelOpen, setChartOptionsRelOpen] = useState(false)
  const relAccordion = useAccordionState('data')

  return (
    <>
      {/* Sub-view toggle */}
      <div className="border-t px-3 py-3 shrink-0">
        <SegmentedControl
          options={[
            { value: 'cooccurrence' as QualRelView, label: 'Co-occurrence' },
            { value: 'comparisons' as QualRelView, label: 'Comparisons' },
          ]}
          value={qa.relView}
          onChange={(v) => {
            qa.setRelView(v)
            setSrAnnouncement(`${v === 'cooccurrence' ? 'Co-occurrence' : 'Comparisons'} selected`)
          }}
          ariaLabel="Relationships view"
          idPrefix="relview"
        />
      </div>

      {/* Chart Options for Relationships */}
      <div className={`border-t ${!chartOptionsRelOpen ? 'shrink-0' : 'flex-1 min-h-0 flex flex-col'}`}>
        <button
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
          onClick={() => setChartOptionsRelOpen(prev => !prev)}
          aria-expanded={chartOptionsRelOpen}
        >
          <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!chartOptionsRelOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
          <SlidersHorizontal className="w-4 h-4 text-mm-text-muted" />
          Chart Options
        </button>
        {chartOptionsRelOpen && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {qa.relView === 'cooccurrence' ? (
              <OptionsAccordion>
                <AccordionSection
                  name="data"
                  label="Data"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-options"
                >
                  <OptionRow icon={Layers} label="Level" fullWidth>
                    <SegmentedControl
                      options={[
                        { value: 'segment', label: 'Segment' },
                        { value: 'source', label: 'Source' },
                      ]}
                      value={qa.cooccurrenceLevel}
                      onChange={(v) => {
                        qa.setCooccurrenceLevel(v)
                        setSrAnnouncement(`Showing ${v}-level co-occurrence`)
                      }}
                      ariaLabel="Co-occurrence level"
                      idPrefix="co-level"
                    />
                  </OptionRow>
                </AccordionSection>
                <AccordionSection
                  name="appearance"
                  label="Appearance"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-options"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
                      <Type className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
                      Text
                    </div>
                    <Input
                      value={qa.relTitle}
                      onChange={e => qa.setRelTitle(e.target.value)}
                      placeholder="Title..."
                      className="h-7 text-xs"
                    />
                    <Input
                      value={qa.relSubtitle}
                      onChange={e => qa.setRelSubtitle(e.target.value)}
                      placeholder="Subtitle..."
                      className="h-7 text-xs"
                    />
                    <Input
                      value={qa.relFootnote}
                      onChange={e => qa.setRelFootnote(e.target.value)}
                      placeholder="Footnote..."
                      className="h-7 text-xs"
                    />
                  </div>
                  <OptionRow icon={Palette} label="Matrix Colors">
                    <Select
                      value={qa.cooccurrencePreset}
                      onValueChange={v => qa.setCooccurrencePreset(v)}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(HEATMAP_LABELS)
                          .filter(([k]) => k !== 'diverging_blue_red')
                          .map(([k, label]) => (
                            <SelectItem key={k} value={k}>{label}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                  <OptionRow icon={ALargeSmall} label="Font Size">
                    <Select
                      value={String(qa.formatting.labelFontSize)}
                      onValueChange={v => qa.onFormattingChange({ labelFontSize: Number(v) })}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="11">Small (11px)</SelectItem>
                        <SelectItem value="12">Medium (12px)</SelectItem>
                        <SelectItem value="14">Large (14px)</SelectItem>
                      </SelectContent>
                    </Select>
                  </OptionRow>
                </AccordionSection>
                <AccordionSection
                  name="annotations"
                  label="Annotations"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-options"
                >
                  <label className="flex items-center gap-2 text-xs text-mm-text-secondary cursor-pointer">
                    <Checkbox
                      checked={qa.showChartN}
                      onCheckedChange={v => qa.setShowChartN(v === true)}
                    />
                    Chart N
                  </label>
                  <label className="flex items-center gap-2 text-xs text-mm-text-secondary cursor-pointer">
                    <Checkbox
                      checked={qa.showProportion}
                      onCheckedChange={v => qa.setShowProportion(v === true)}
                    />
                    Show proportions
                  </label>
                </AccordionSection>
              </OptionsAccordion>
            ) : (
              <OptionsAccordion>
                <AccordionSection
                  name="data"
                  label="Data"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-options"
                >
                  <OptionRow icon={Users} label="Compare By">
                    <Select
                      value={qa.groupBy ?? '_none'}
                      onValueChange={v => qa.setGroupBy(v === '_none' ? null : v)}
                    >
                      <SelectTrigger className="h-7 text-xs border-2 border-[hsl(var(--mm-accent)/0.4)] bg-[hsl(var(--mm-accent)/0.05)]">
                        <SelectValue placeholder="Select variable..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">None</SelectItem>
                        {demoFilters.map(f => (
                          <SelectItem key={f.subtype} value={f.subtype}>
                            {f.label} ({f.values.length})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                  <OptionRow icon={TableProperties} label="Chart Mode" fullWidth>
                    <SegmentedControl
                      options={[
                        { value: 'table' as QualComparisonChartMode, label: 'Table' },
                        { value: 'bar' as QualComparisonChartMode, label: 'Bar Chart' },
                      ]}
                      value={qa.comparisonChartMode}
                      onChange={(v) => qa.setComparisonChartMode(v)}
                      ariaLabel="Comparison chart mode"
                      idPrefix="comp-mode"
                    />
                  </OptionRow>
                </AccordionSection>
                <AccordionSection
                  name="appearance"
                  label="Appearance"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-comp"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
                      <Type className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
                      Text
                    </div>
                    <Input
                      value={qa.relTitle}
                      onChange={e => qa.setRelTitle(e.target.value)}
                      placeholder="Title..."
                      className="h-7 text-xs"
                    />
                    <Input
                      value={qa.relSubtitle}
                      onChange={e => qa.setRelSubtitle(e.target.value)}
                      placeholder="Subtitle..."
                      className="h-7 text-xs"
                    />
                    <Input
                      value={qa.relFootnote}
                      onChange={e => qa.setRelFootnote(e.target.value)}
                      placeholder="Footnote..."
                      className="h-7 text-xs"
                    />
                  </div>
                  <OptionRow icon={Palette} label="Color Palette">
                    <Select
                      value={qa.comparisonPalette}
                      onValueChange={v => qa.setComparisonPalette(v)}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(COLOR_PALETTES).map(k => (
                          <SelectItem key={k} value={k}>{PALETTE_LABELS[k] || k}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                </AccordionSection>
                <AccordionSection
                  name="annotations"
                  label="Annotations"
                  expanded={relAccordion.expanded}
                  onToggle={relAccordion.toggle}
                  idPrefix="rel-comp"
                >
                  <label className="flex items-center gap-2 text-xs text-mm-text-secondary cursor-pointer">
                    <Checkbox
                      checked={qa.showChartN}
                      onCheckedChange={v => qa.setShowChartN(v === true)}
                    />
                    Chart N
                  </label>
                  <label className="flex items-center gap-2 text-xs text-mm-text-secondary cursor-pointer">
                    <Checkbox
                      checked={qa.showEffectSize}
                      onCheckedChange={v => qa.setShowEffectSize(v === true)}
                    />
                    Effect Size
                  </label>
                </AccordionSection>
              </OptionsAccordion>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ── Content ──────────────────────────────────────────────────────────────────

export interface RelationshipsContentProps {
  pid: number
  qa: QualitativeAnalysisState & QualitativeAnalysisActions
  codes: { id: number; is_active: boolean }[]
  filterParams: CodeAnalysisFilterParams
  demoFilters: DemographicFilter[]
  cooccurrenceN: number | null
  comparisonData: DemographicComparisonResponse | undefined
  comparisonLoading: boolean
  comparisonN: number | null
  onCooccurrenceDataLoad: (info: { totalSegments: number; totalComments: number }) => void
}

export function RelationshipsContent(props: RelationshipsContentProps) {
  const {
    pid, qa, codes, filterParams, demoFilters,
    cooccurrenceN, comparisonData, comparisonLoading, comparisonN,
    onCooccurrenceDataLoad,
  } = props

  const navigate = useNavigate()

  const handleComparisonExport = useCallback(() => {
    if (!qa.groupBy) return
    const params: Record<string, string> = { group_by_subtype: qa.groupBy }
    if (qa.selectedCodeIds.size > 0) params.code_ids = Array.from(qa.selectedCodeIds).join(',')
    if (qa.selectedConversationIds.size > 0) params.conversation_ids = Array.from(qa.selectedConversationIds).join(',')
    if (qa.selectedTextColumnIds.size > 0) params.text_column_ids = Array.from(qa.selectedTextColumnIds).join(',')
    if (qa.excludeFacilitator) params.exclude_facilitator = 'true'
    if (qa.participantIds.length > 0) params.participant_ids = qa.participantIds.join(',')
    // #499: carry the EFFECTIVE coder/layer scope (blind-forced — filterParams
    // already holds it) so the CSV matches the on-screen numbers.
    if (filterParams.coder_ids) params.coder_ids = filterParams.coder_ids
    if (filterParams.layer_scope) params.layer_scope = filterParams.layer_scope
    exportApi.demographicComparisonCsv(pid, params)
  }, [pid, qa.groupBy, qa.selectedCodeIds, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.excludeFacilitator, qa.participantIds, filterParams.coder_ids, filterParams.layer_scope])

  return (
    <div>
      {/* Co-occurrence sub-view */}
      {qa.relView === 'cooccurrence' && (
        codes.filter(c => c.is_active).length < 2 ? (
          <div className="text-center py-16 text-mm-text-muted">
            <p>Select at least 2 codes to view co-occurrence patterns.</p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <ChartExportWrapper
              formatting={qa.formatting}
              filename="qual-cooccurrence"
              supportsSvg={false}
              title={qa.relTitle}
              subtitle={qa.relSubtitle}
              footnote={qa.relFootnote}
              chartN={cooccurrenceN ?? undefined}
              showChartN={qa.showChartN}
            >
              <QualCooccurrence
                projectId={pid}
                filterParams={filterParams}
                cooccurrenceLevel={qa.cooccurrenceLevel}
                showProportion={qa.showProportion}
                colorPreset={qa.cooccurrencePreset}
                labelFontSize={qa.formatting.labelFontSize}
                onDataLoad={onCooccurrenceDataLoad}
              />
            </ChartExportWrapper>
          </div>
        )
      )}

      {/* Comparisons sub-view */}
      {qa.relView === 'comparisons' && (
        demoFilters.length === 0 ? (
          <div className="text-center py-16 text-mm-text-muted">
            <p>Link participants to demographic data to enable group comparisons.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => navigate(`/projects/${pid}/participants`)}
            >
              Go to Participants
            </Button>
          </div>
        ) : (
          <div>
            {qa.groupBy && comparisonData && (
              <div className="flex items-center justify-end mb-4">
                <Button variant="outline" size="sm" onClick={handleComparisonExport} className="h-7 text-xs">
                  <Download className="w-3 h-3 mr-1" />
                  Export CSV
                </Button>
              </div>
            )}

            {/* Comparison content */}
            {!qa.groupBy ? (
              <div className="text-center py-16 text-mm-text-muted">
                <p>Select a demographic variable to compare code frequencies across groups.</p>
              </div>
            ) : comparisonLoading ? (
              <div className="text-center py-8 text-mm-text-muted">Loading comparison data...</div>
            ) : comparisonData ? (
              <div className="rounded-lg border overflow-hidden">
                <ChartExportWrapper
                  formatting={qa.formatting}
                  filename={`qual-comparison-${qa.comparisonChartMode}`}
                  supportsSvg={qa.comparisonChartMode === 'bar'}
                  title={qa.relTitle}
                  subtitle={qa.relSubtitle}
                  footnote={qa.relFootnote}
                  chartN={comparisonN ?? undefined}
                  showChartN={qa.showChartN}
                >
                  {qa.comparisonChartMode === 'table' ? (
                    <QualComparisonTable
                      data={comparisonData}
                      showEffectSize={qa.showEffectSize}
                      onCodeClick={qa.viewCodeInContent}
                    />
                  ) : (
                    <QualComparisonBar
                      data={comparisonData}
                      colorPalette={qa.comparisonPalette}
                      onCodeClick={qa.viewCodeInContent}
                    />
                  )}
                </ChartExportWrapper>
              </div>
            ) : null}
          </div>
        )
      )}
    </div>
  )
}
