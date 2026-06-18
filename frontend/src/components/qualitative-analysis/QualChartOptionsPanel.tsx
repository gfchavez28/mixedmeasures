import { useCallback } from 'react'
import {
  GripVertical,
  ArrowUpDown,
  Percent,
  Hash,
  Palette,
  Users,
  ArrowLeftRight,
  Type,
  ALargeSmall,
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import OptionRow from '@/components/analysis/OptionRow'
import { OptionsAccordion, AccordionSection, useAccordionState } from '@/components/analysis/OptionsAccordion'
import { type ChartFormatting, type DataLabelPosition } from '@/lib/chart-data'
import { QUAL_HEATMAP_LABELS } from './qual-chart-data'
import type {
  QualChartType,
  QualValueMode,
  QualDenominatorMode,
  QualSortOrder,
} from '@/lib/qual-analysis-types'

interface QualChartOptionsPanelProps {
  chartType: QualChartType
  valueMode: QualValueMode
  onValueModeChange: (v: QualValueMode) => void
  denominatorMode: QualDenominatorMode
  onDenominatorModeChange: (v: QualDenominatorMode) => void
  sortOrder: QualSortOrder
  onSortOrderChange: (v: QualSortOrder) => void
  showSummaryRow: boolean
  onShowSummaryRowChange: (v: boolean) => void
  showRowN: boolean
  onShowRowNChange: (v: boolean) => void
  formatting: ChartFormatting
  onFormattingChange: (patch: Partial<ChartFormatting>) => void
  customOrder: number[]
  onCustomOrderChange: (ids: number[]) => void
  codes: { id: number; name: string }[]
  groupBy?: string | null
  onGroupByChange?: (v: string | null) => void
  demoFilters?: { subtype: string; label: string; values: { value: string }[] }[]
  orientation: 'sources-rows' | 'codes-rows'
  onOrientationChange: (v: 'sources-rows' | 'codes-rows') => void
  title: string
  subtitle: string
  footnote: string
  onTitleChange: (v: string) => void
  onSubtitleChange: (v: string) => void
  onFootnoteChange: (v: string) => void
  showChartN: boolean
  onShowChartNChange: (v: boolean) => void
}

const VALUE_MODE_OPTIONS: { value: QualValueMode; label: string; description: string }[] = [
  { value: 'count', label: 'Count', description: 'Coded segments per source' },
  { value: 'segment_proportion', label: 'Proportion', description: 'Fraction of segments with code' },
  { value: 'text_coverage', label: 'Word Coverage', description: 'Fraction of text in coded segments' },
]

const DENOMINATOR_OPTIONS: { value: QualDenominatorMode; label: string; description: string }[] = [
  { value: 'total', label: 'All segments', description: 'Divide by total segments in source' },
  { value: 'coded', label: 'Coded only', description: 'Divide by segments with any code' },
]

const SORT_OPTIONS: { value: QualSortOrder; label: string }[] = [
  { value: 'import', label: 'Import order' },
  { value: 'alpha', label: 'Alphabetical' },
  { value: 'count_desc', label: 'Count (high to low)' },
  { value: 'count_asc', label: 'Count (low to high)' },
  { value: 'custom', label: 'Custom' },
]

const FONT_SIZE_OPTIONS = [
  { value: '10', label: '10' },
  { value: '11', label: '11' },
  { value: '12', label: '12' },
  { value: '14', label: '14' },
  { value: '16', label: '16' },
  { value: '18', label: '18' },
]

export default function QualChartOptionsPanel({
  chartType,
  valueMode,
  onValueModeChange,
  denominatorMode,
  onDenominatorModeChange,
  sortOrder,
  onSortOrderChange,
  showSummaryRow,
  onShowSummaryRowChange,
  showRowN,
  onShowRowNChange,
  formatting,
  onFormattingChange,
  customOrder,
  onCustomOrderChange,
  codes,
  groupBy,
  onGroupByChange,
  demoFilters,
  orientation,
  onOrientationChange,
  title,
  subtitle,
  footnote,
  onTitleChange,
  onSubtitleChange,
  onFootnoteChange,
  showChartN,
  onShowChartNChange,
}: QualChartOptionsPanelProps) {
  const showValueMode = chartType === 'heatmap' || chartType === 'bar' || chartType === 'stacked_bar'
  const showDenominator = showValueMode && valueMode === 'segment_proportion'
  const showSort = chartType !== 'saturation' && chartType !== 'summary'
  const showGroupBy = chartType === 'bar'
  const showOrientation = chartType === 'heatmap' || chartType === 'stacked_bar'
  const showHeatmapAppearance = chartType === 'heatmap'
  const showTotalsRow = chartType === 'heatmap' || chartType === 'summary'

  const { expanded, toggle } = useAccordionState('data')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const codeLabels = new Map(codes.map(c => [c.id, c.name]))

  const handleSortChange = useCallback((newSort: QualSortOrder) => {
    onSortOrderChange(newSort)
    if (newSort === 'custom' && customOrder.length === 0 && codes.length > 0) {
      onCustomOrderChange(codes.map(c => c.id))
    }
  }, [onSortOrderChange, customOrder.length, codes, onCustomOrderChange])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeId = Number(active.id)
    const overId = Number(over.id)
    const oldIndex = customOrder.indexOf(activeId)
    const newIndex = customOrder.indexOf(overId)
    if (oldIndex === -1 || newIndex === -1) return
    onCustomOrderChange(arrayMove(customOrder, oldIndex, newIndex))
  }, [customOrder, onCustomOrderChange])

  const hasAnyData = showValueMode || showSort || showGroupBy || showOrientation

  return (
    <OptionsAccordion>
      {/* Data section */}
      {hasAnyData && (
        <AccordionSection name="data" label="Data" expanded={expanded} onToggle={toggle} idPrefix="qual-chart-options">
          {showValueMode && (
            <OptionRow icon={Percent} label="Value display">
              <Select value={valueMode} onValueChange={v => onValueModeChange(v as QualValueMode)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALUE_MODE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span>{opt.label}</span>
                      <span className="block text-[10px] text-mm-text-faint font-normal">{opt.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </OptionRow>
          )}

          {showDenominator && (
            <OptionRow icon={Percent} label="Denominator">
              <Select value={denominatorMode} onValueChange={v => onDenominatorModeChange(v as QualDenominatorMode)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DENOMINATOR_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span>{opt.label}</span>
                      <span className="block text-[10px] text-mm-text-faint font-normal">{opt.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </OptionRow>
          )}

          {showSort && (
            <OptionRow icon={ArrowUpDown} label="Sort">
              <Select value={sortOrder} onValueChange={v => handleSortChange(v as QualSortOrder)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </OptionRow>
          )}

          {showSort && sortOrder === 'custom' && customOrder.length > 0 && (
            <div className="pl-5 space-y-1">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={customOrder} strategy={verticalListSortingStrategy}>
                  {customOrder.map(id => (
                    <SortableCodeItem
                      key={id}
                      id={id}
                      label={codeLabels.get(id) || `Code ${id}`}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <p className="text-[11px] text-mm-text-faint pl-5 mt-1">Drag to reorder codes</p>
            </div>
          )}

          {showOrientation && (
            <OptionRow icon={ArrowLeftRight} label="Orientation">
              <Select value={orientation} onValueChange={v => onOrientationChange(v as 'sources-rows' | 'codes-rows')}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sources-rows">Sources as rows</SelectItem>
                  <SelectItem value="codes-rows">Codes as rows</SelectItem>
                </SelectContent>
              </Select>
            </OptionRow>
          )}

          {showGroupBy && demoFilters && demoFilters.length > 0 && onGroupByChange && (
            <OptionRow icon={Users} label="Group by">
              <Select value={groupBy ?? '_none'} onValueChange={v => onGroupByChange(v === '_none' ? null : v)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
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
          )}
        </AccordionSection>
      )}

      {/* Appearance section */}
      <AccordionSection name="appearance" label="Appearance" expanded={expanded} onToggle={toggle} idPrefix="qual-chart-options">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
            <Type className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
            Text
          </div>
          <Input
            value={title}
            onChange={e => onTitleChange(e.target.value)}
            placeholder="Title..."
            className="h-7 text-xs"
          />
          <Input
            value={subtitle}
            onChange={e => onSubtitleChange(e.target.value)}
            placeholder="Subtitle..."
            className="h-7 text-xs"
          />
          <Input
            value={footnote}
            onChange={e => onFootnoteChange(e.target.value)}
            placeholder="Footnote..."
            className="h-7 text-xs"
          />
        </div>

        {(chartType === 'heatmap' || chartType === 'bar' || chartType === 'stacked_bar' || chartType === 'summary') && (
          <div className="border-t border-mm-border-subtle pt-2">
            <OptionRow icon={ALargeSmall} label="Fonts" fullWidth>
              <div className="grid grid-cols-3 gap-1">
                <div>
                  <Select
                    value={String(formatting.labelFontSize)}
                    onValueChange={v => onFormattingChange({ labelFontSize: Number(v) })}
                  >
                    <SelectTrigger className="h-7 text-xs px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_SIZE_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}px</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-mm-text-faint mt-0.5 block text-center">Label</span>
                </div>
                <div>
                  <Select
                    value={String(formatting.dataLabelFontSize)}
                    onValueChange={v => onFormattingChange({ dataLabelFontSize: Number(v) })}
                  >
                    <SelectTrigger className="h-7 text-xs px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_SIZE_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}px</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-mm-text-faint mt-0.5 block text-center">Data</span>
                </div>
                <div>
                  <Select
                    value={String(formatting.titleFontSize)}
                    onValueChange={v => onFormattingChange({ titleFontSize: Number(v) })}
                  >
                    <SelectTrigger className="h-7 text-xs px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_SIZE_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}px</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-mm-text-faint mt-0.5 block text-center">Title</span>
                </div>
              </div>
            </OptionRow>
          </div>
        )}

        {(chartType === 'bar' || chartType === 'stacked_bar') && (
          <OptionRow icon={Hash} label="Data labels">
            <Select
              value={formatting.dataLabels}
              onValueChange={v => onFormattingChange({ dataLabels: v as DataLabelPosition })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chartType === 'bar' && <SelectItem value="outside">Outside</SelectItem>}
                <SelectItem value="inside">Inside</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </OptionRow>
        )}

        {showHeatmapAppearance && (
          <OptionRow icon={Palette} label="Heatmap color">
            <Select value={formatting.heatmapPreset} onValueChange={v => onFormattingChange({ heatmapPreset: v })}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(QUAL_HEATMAP_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OptionRow>
        )}
      </AccordionSection>

      {/* Annotations section */}
      <AccordionSection name="annotations" label="Annotations" expanded={expanded} onToggle={toggle} idPrefix="qual-chart-options">
        <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
          <Checkbox
            checked={showChartN}
            onCheckedChange={v => onShowChartNChange(v === true)}
          />
          <Hash className="w-3.5 h-3.5 text-mm-text-faint" aria-hidden="true" />
          Chart N
        </label>

        {showHeatmapAppearance && (
          <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
            <Checkbox
              checked={showRowN}
              onCheckedChange={v => onShowRowNChange(v === true)}
            />
            <Hash className="w-3.5 h-3.5 text-mm-text-faint" aria-hidden="true" />
            Row N
          </label>
        )}

        {showTotalsRow && (
          <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
            <Checkbox
              checked={showSummaryRow}
              onCheckedChange={v => onShowSummaryRowChange(v === true)}
            />
            <Hash className="w-3.5 h-3.5 text-mm-text-faint" aria-hidden="true" />
            Totals row
          </label>
        )}
      </AccordionSection>
    </OptionsAccordion>
  )
}

function SortableCodeItem({ id, label }: { id: number; label: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-1.5 py-1 rounded border bg-mm-surface text-xs text-mm-text select-none"
    >
      <button
        className="cursor-grab text-mm-text-faint hover:text-mm-text-secondary touch-none"
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${label}`}
      >
        <GripVertical className="w-3 h-3" />
      </button>
      <span className="truncate flex-1" title={label}>{label}</span>
    </div>
  )
}
