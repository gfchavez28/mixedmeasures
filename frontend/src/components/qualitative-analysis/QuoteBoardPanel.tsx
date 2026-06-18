import { useState } from 'react'
import {
  ChevronDown,
  Layers,
  SlidersHorizontal,
  TableProperties,
  ALargeSmall,
  EyeOff,
} from 'lucide-react'
import type { Code, CodeCategory, TextColumnInfo, ConversationOption } from '@/lib/api'
import type { QuoteGroupBy, QuoteSort, QuoteLayout } from '@/lib/qual-analysis-types'
import type { QualitativeAnalysisState, QualitativeAnalysisActions } from '@/hooks/useQualitativeAnalysis'
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
import QuoteBoardFilters from '@/components/qualitative-analysis/QuoteBoardFilters'

// ── Sidebar ──────────────────────────────────────────────────────────────────

interface DocumentOption {
  id: number
  name: string
}

export interface QuoteBoardSidebarProps {
  qa: QualitativeAnalysisState & QualitativeAnalysisActions
  codes: Code[]
  categories: CodeCategory[]
  qbConversations: ConversationOption[]
  qbTextColumns: TextColumnInfo[]
  qbDocuments?: DocumentOption[]
  hasActiveQbFilters: boolean
  qbFilterCount: number
  // Board display options (owned by parent, shared with content)
  showBoardNotes: boolean
  showBoardCodes: boolean
  showBoardSpeaker: boolean
  showBoardSource: boolean
  setShowBoardNotes: (v: boolean) => void
  setShowBoardCodes: (v: boolean) => void
  setShowBoardSpeaker: (v: boolean) => void
  setShowBoardSource: (v: boolean) => void
}

export function QuoteBoardSidebar(props: QuoteBoardSidebarProps) {
  const {
    qa, codes, categories, qbConversations, qbTextColumns, qbDocuments,
    hasActiveQbFilters, qbFilterCount,
    showBoardNotes, showBoardCodes, showBoardSpeaker, showBoardSource,
    setShowBoardNotes, setShowBoardCodes, setShowBoardSpeaker, setShowBoardSource,
  } = props

  const [qbFiltersOpen, setQbFiltersOpen] = useState(true)
  const [boardOptionsOpen, setBoardOptionsOpen] = useState(true)
  const boardAccordion = useAccordionState('data')

  return (
    <>
      {/* Hide from Board filters */}
      <div className={`border-t ${!qbFiltersOpen ? 'shrink-0' : 'flex-1 min-h-0 flex flex-col'}`}>
        <button
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
          onClick={() => setQbFiltersOpen(prev => !prev)}
          aria-expanded={qbFiltersOpen}
        >
          <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!qbFiltersOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
          <EyeOff className="w-4 h-4 text-mm-text-muted" />
          Hide from Board
          {qbFilterCount > 0 && (
            <span className="text-xs bg-orange-200 dark:bg-orange-800/50 text-orange-800 dark:text-orange-200 rounded-full px-1.5 py-0.5 leading-none ml-auto">
              {qbFilterCount}
            </span>
          )}
        </button>
        {qbFiltersOpen && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <QuoteBoardFilters
              codes={codes}
              categories={categories}
              conversations={qbConversations}
              textColumns={qbTextColumns}
              documents={qbDocuments}
              hiddenCodeIds={qa.qbHiddenCodeIds}
              hideUncoded={qa.qbHideUncoded}
              hiddenConversationIds={qa.qbHiddenConversationIds}
              hiddenTextColumnIds={qa.qbHiddenTextColumnIds}
              hiddenDocumentIds={qa.qbHiddenDocumentIds}
              onHiddenCodeIdsChange={qa.setQbHiddenCodeIds}
              onHideUncodedChange={qa.setQbHideUncoded}
              onHiddenConversationIdsChange={qa.setQbHiddenConversationIds}
              onHiddenTextColumnIdsChange={qa.setQbHiddenTextColumnIds}
              onHiddenDocumentIdsChange={qa.setQbHiddenDocumentIds}
              onClearAll={qa.clearQbFilters}
              hasActiveFilters={hasActiveQbFilters}
            />
          </div>
        )}
      </div>

      {/* Board Options */}
      <div className={`border-t ${!boardOptionsOpen ? 'shrink-0' : 'flex-1 min-h-0 flex flex-col'}`}>
        <button
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
          onClick={() => setBoardOptionsOpen(prev => !prev)}
          aria-expanded={boardOptionsOpen}
        >
          <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!boardOptionsOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
          <SlidersHorizontal className="w-4 h-4 text-mm-text-muted" />
          Board Options
        </button>
        {boardOptionsOpen && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <OptionsAccordion>
              <AccordionSection name="data" label="Data" expanded={boardAccordion.expanded} onToggle={boardAccordion.toggle} idPrefix="board-options">
                <OptionRow icon={Layers} label="Group By">
                  <div className={qa.quoteSort === 'custom' ? 'opacity-50' : ''} title={qa.quoteSort === 'custom' ? 'Grouping is disabled during custom sort' : undefined}>
                    <Select value={qa.quoteGroupBy} onValueChange={v => qa.setQuoteGroupBy(v as QuoteGroupBy)} disabled={qa.quoteSort === 'custom'}>
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No grouping</SelectItem>
                        <SelectItem value="code">By Code</SelectItem>
                        <SelectItem value="source">By Source</SelectItem>
                        <SelectItem value="category">By Category</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </OptionRow>
                <OptionRow icon={TableProperties} label="Sort">
                  <Select value={qa.quoteSort} onValueChange={v => qa.setQuoteSort(v as QuoteSort)}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="source">Source order</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                      <SelectItem value="quoted">Date quoted</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              </AccordionSection>
              <AccordionSection name="appearance" label="Appearance" expanded={boardAccordion.expanded} onToggle={boardAccordion.toggle} idPrefix="board-options">
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold text-mm-text-faint uppercase tracking-wider">Display</div>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Checkbox checked={showBoardNotes} onCheckedChange={v => setShowBoardNotes(v === true)} />
                    Notes
                  </label>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Checkbox checked={showBoardCodes} onCheckedChange={v => setShowBoardCodes(v === true)} />
                    Codes
                  </label>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Checkbox checked={showBoardSpeaker} onCheckedChange={v => setShowBoardSpeaker(v === true)} />
                    Speaker
                  </label>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Checkbox checked={showBoardSource} onCheckedChange={v => setShowBoardSource(v === true)} />
                    Source
                  </label>
                </div>
                <OptionRow icon={ALargeSmall} label="Density">
                  <SegmentedControl
                    options={[
                      { value: 'quote' as const, label: 'Quote only' },
                      { value: 'full' as const, label: 'Full context' },
                    ]}
                    value={qa.quoteDensity}
                    onChange={qa.setQuoteDensity}
                    ariaLabel="Excerpt density"
                    idPrefix="board-density"
                  />
                </OptionRow>
                <OptionRow icon={Layers} label="Layout">
                  <SegmentedControl
                    options={[
                      { value: '1' as const, label: '1 Col' },
                      { value: '2' as const, label: '2 Col' },
                      { value: 'auto' as const, label: 'Auto' },
                    ]}
                    value={qa.quoteLayout}
                    onChange={v => qa.setQuoteLayout(v as QuoteLayout)}
                    ariaLabel="Card layout"
                    idPrefix="board-layout"
                  />
                </OptionRow>
              </AccordionSection>
            </OptionsAccordion>
          </div>
        )}
      </div>
    </>
  )
}
