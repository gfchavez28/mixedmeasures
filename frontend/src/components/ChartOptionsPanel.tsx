import { useState, useMemo, useEffect } from 'react'
import {
  Hash,
  RotateCcw,
  GripVertical,
  ArrowUpDown,
  Tag,
  Percent,
  Maximize2,
  ArrowDownUp,
  Users,
  EyeOff,
  Eye,
  Type,
  ALargeSmall,
  Palette,
  GripHorizontal,
  Columns3,
  Circle,
  Activity,
  Minus,
  MoveHorizontal,
  SlidersHorizontal,
  Layers,
  Plus,
  ArrowLeftRight,
  Spline,
} from 'lucide-react'
import OptionRow from '@/components/analysis/OptionRow'
import { OptionsAccordion, AccordionSection, useAccordionState } from '@/components/analysis/OptionsAccordion'
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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getVisibleOptions,
  COLOR_PALETTES,
  HEATMAP_PRESETS,
  HEATMAP_LABELS,
  PALETTE_LABELS,
  resolveColorPalette,
  type ChartType,
  type ChartFormatting,
  type LabelMode,
  type DataWidthMode,
  type GroupOrganization,
} from '@/lib/chart-data'
import type { AnalysisDemographicItem } from '@/lib/api'

interface ChartOptionsPanelProps {
  chartType: ChartType | null
  metricType: string

  // Data options
  sortOrder: string
  display: string
  scaling: string
  scaleOrder: string
  groupingColumnId: number | null
  groupingColumnId2: number | null
  excludeValues: string[]
  hiddenResponseOptions: string[]

  // Decompose (show individual variables within a domain)
  decompose?: boolean
  canDecompose?: boolean
  onDecomposeChange?: (v: boolean) => void

  // Group filter + organization
  hiddenGroupValues: string[]
  availableGroupValues: string[]
  onHiddenGroupValuesChange: (vals: string[]) => void
  groupOrganization: GroupOrganization
  onGroupOrganizationChange: (v: GroupOrganization) => void

  // Available options for pickers
  demographics: AnalysisDemographicItem[]
  responseLabels: string[]
  canGroupBy: boolean
  groupByDisabledReason?: string
  /** Dataset ID(s) of the currently selected questions — used to filter demographics. */
  relevantDatasetIds: Set<number>
  /** Current grouping mode: 'column' (default) or 'dataset' */
  groupingMode?: 'column' | 'dataset'
  /** Whether "By Dataset" grouping is available (domain spans 2+ datasets) */
  datasetGroupingAvailable?: boolean
  /** Shared demographics available across all datasets in multi-dataset domains */
  sharedDemographics?: Array<{
    anchor: AnalysisDemographicItem
    label: string
    datasetNames: string[]
  }>

  // Appearance
  chartTitle: string
  chartSubtitle: string
  chartFootnote: string
  formatting: ChartFormatting

  // Annotations
  showCI: boolean
  showChartN: boolean
  showGroupN: boolean
  showVariableN: string
  showSampleSizes: boolean

  // Labels
  labelMode: LabelMode
  hasShortLabels: boolean

  // Custom reorder
  customOrder: number[]
  metricLabels: Map<number, string>

  // Status
  isComputing: boolean

  // Callbacks
  onLabelModeChange: (mode: LabelMode) => void
  onCustomOrderChange: (order: number[]) => void
  onSortChange: (v: string) => void
  onDisplayChange: (v: string) => void
  onScalingChange: (v: string) => void
  onScaleOrderChange: (v: string) => void
  onGroupingChange: (id: number | null, mode?: 'column' | 'dataset') => void
  onGrouping2Change: (id: number | null) => void
  onExcludeValuesChange: (vals: string[]) => void
  onHiddenResponseOptionsChange: (vals: string[]) => void
  onTitleChange: (v: string) => void
  onSubtitleChange: (v: string) => void
  onFootnoteChange: (v: string) => void
  onFormattingChange: (f: Partial<ChartFormatting>) => void
  onShowCIChange: (v: boolean) => void
  onToggleSampleSizes: (v: boolean) => void
  onShowChartNChange: (v: boolean) => void
  onShowGroupNChange: (v: boolean) => void
  onShowVariableNChange: (v: string) => void

  // Proportion threshold config
  proportionMode?: 'numeric' | 'values'
  proportionOperator?: string
  proportionThreshold?: number
  proportionValues?: string[]
  availableScaleValues?: string[]
  onProportionConfigChange?: (config: {
    mode: string
    operator?: string
    threshold_numeric?: number
    threshold_values?: string[]
  }) => void

  // Diverging stacked bar
  divergingMode?: boolean
  divergingCenter?: string | null
  divergingCenterAuto?: { centerLabel: string | null; mode: 'center' | 'boundary' }
  hasMixedScales?: boolean
  onDivergingModeChange?: (v: boolean) => void
  onDivergingCenterChange?: (v: string | null) => void

  // Line chart options
  showErrorBand?: boolean
  lineStyle?: 'connected' | 'markers'
  lineOverlay?: boolean
  onShowErrorBandChange?: (v: boolean) => void
  onLineStyleChange?: (v: 'connected' | 'markers') => void
  onLineOverlayChange?: (v: boolean) => void

  // Axis transform
  axisTransform?: 'linear' | 'log'
  onAxisTransformChange?: (v: 'linear' | 'log') => void

  // Cross-tab options
  crossTabColumnId?: number | null
  crossTabDisplay?: string
  crossTabEligibleColumns?: Array<{ id: number; label: string; datasetId: number }>
  onCrossTabColumnChange?: (id: number | null) => void
  onCrossTabDisplayChange?: (v: string) => void

  /** Increment to force the Data accordion section open (e.g. after auto-selecting Group by Dataset). */
  openDataSectionTrigger?: number
}

const FONT_SIZE_OPTIONS = [
  { value: '10', label: '10' },
  { value: '11', label: '11' },
  { value: '12', label: '12' },
  { value: '14', label: '14' },
  { value: '16', label: '16' },
  { value: '18', label: '18' },
]

const BAR_SIZE_OPTIONS = [
  { value: '16', label: 'Thin' },
  { value: '24', label: 'Medium' },
  { value: '32', label: 'Thick' },
]

const POINT_SIZE_OPTIONS = [
  { value: '3', label: 'Small' },
  { value: '5', label: 'Medium' },
  { value: '7', label: 'Large' },
]


// ── SortableMetricItem ────────────────────────────────────────────────────────

function SortableMetricItem({ id, label }: { id: number; label: string }) {
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

// ── ProportionNumericControls ─────────────────────────────────────────────────

const OPERATOR_OPTIONS = [
  { value: '>=', label: '>=' },
  { value: '>', label: '>' },
  { value: '<=', label: '<=' },
  { value: '<', label: '<' },
  { value: '=', label: '=' },
]

function ProportionNumericControls({ operator, threshold, scaleLabels, onChange }: {
  operator: string
  threshold: number
  scaleLabels?: string[]
  onChange: (operator: string, threshold: number) => void
}) {
  const [localThreshold, setLocalThreshold] = useState(String(threshold))

  // Sync local state when prop changes externally (e.g. loading saved analysis)
  useEffect(() => {
    setLocalThreshold(String(threshold))
  }, [threshold])

  const handleInputChange = (value: string) => {
    setLocalThreshold(value)
    const val = Number(value)
    if (!isNaN(val)) onChange(operator, val)
  }

  return (
    <div className="pl-5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Select value={operator} onValueChange={v => onChange(v, threshold)}>
          <SelectTrigger className="h-7 text-xs w-16 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPERATOR_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          value={localThreshold}
          onChange={e => handleInputChange(e.target.value)}
          className="h-7 text-xs w-16"
        />
      </div>
      <p className="text-[11px] text-mm-text-faint italic pl-0.5">
        % of responses {operator} {localThreshold}
      </p>
      {scaleLabels && scaleLabels.length > 0 && (
        <p className="text-[11px] text-mm-text-faint pl-0.5">
          {scaleLabels.map((label, i) => (
            <span key={label}>
              {i > 0 && ', '}
              <span className="tabular-nums">{i + 1}</span>
              <span className="mx-0.5">=</span>
              {label}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChartOptionsPanel({
  chartType,
  metricType,
  sortOrder,
  display,
  scaling,
  scaleOrder,
  groupingColumnId,
  groupingColumnId2,
  excludeValues,
  hiddenResponseOptions,
  decompose = false,
  canDecompose = false,
  onDecomposeChange,
  hiddenGroupValues,
  availableGroupValues,
  onHiddenGroupValuesChange,
  groupOrganization,
  onGroupOrganizationChange,
  demographics,
  responseLabels,
  canGroupBy,
  groupByDisabledReason,
  relevantDatasetIds,
  groupingMode = 'column',
  datasetGroupingAvailable = false,
  sharedDemographics = [],
  chartTitle,
  chartSubtitle,
  chartFootnote,
  formatting,
  showCI,
  showChartN,
  showGroupN,
  showVariableN,
  showSampleSizes,
  labelMode,
  hasShortLabels,
  customOrder,
  metricLabels,
  isComputing,
  onLabelModeChange,
  onCustomOrderChange,
  onSortChange,
  onDisplayChange,
  onScalingChange,
  onScaleOrderChange,
  onGroupingChange,
  onGrouping2Change,
  onExcludeValuesChange,
  onHiddenResponseOptionsChange,
  onTitleChange,
  onSubtitleChange,
  onFootnoteChange,
  onFormattingChange,
  onShowCIChange,
  onToggleSampleSizes,
  onShowChartNChange,
  onShowGroupNChange,
  onShowVariableNChange,
  proportionMode,
  proportionOperator,
  proportionThreshold,
  proportionValues,
  availableScaleValues,
  onProportionConfigChange,
  divergingMode = false,
  divergingCenter,
  divergingCenterAuto,
  hasMixedScales = false,
  onDivergingModeChange,
  onDivergingCenterChange,
  showErrorBand = false,
  lineStyle = 'connected',
  lineOverlay = false,
  onShowErrorBandChange,
  onLineStyleChange,
  onLineOverlayChange,
  axisTransform = 'linear',
  onAxisTransformChange,
  crossTabColumnId,
  crossTabDisplay = 'count',
  crossTabEligibleColumns = [],
  onCrossTabColumnChange,
  onCrossTabDisplayChange,
  openDataSectionTrigger = 0,
}: ChartOptionsPanelProps) {
  const { expanded: expandedSection, toggle: toggleSection } = useAccordionState('data', openDataSectionTrigger)

  const vis = getVisibleOptions(chartType, metricType)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeId = Number(active.id)
    const overId = Number(over.id)
    const oldIndex = customOrder.indexOf(activeId)
    const newIndex = customOrder.indexOf(overId)
    if (oldIndex === -1 || newIndex === -1) return
    onCustomOrderChange(arrayMove(customOrder, oldIndex, newIndex))
  }

  // Filter demographics to the dataset(s) of the currently selected questions
  const filteredDemographics = useMemo(() => {
    if (relevantDatasetIds.size === 0) return demographics
    return demographics.filter(d => relevantDatasetIds.has(d.dataset_id))
  }, [demographics, relevantDatasetIds])

  // Dimension labels — hoisted so they're accessible throughout the component
  const dim1DemoLabel = useMemo(() => {
    if (!groupingColumnId) return null
    const shared = sharedDemographics.find(sd => sd.anchor.id === groupingColumnId)
    if (shared) return shared.label
    const demo = filteredDemographics.find(d => d.id === groupingColumnId)
    return demo ? (demo.column_name || demo.column_text) : null
  }, [groupingColumnId, sharedDemographics, filteredDemographics])

  const dim2DemoLabel = useMemo(() => {
    if (!groupingColumnId2) return null
    const shared = sharedDemographics.find(sd => sd.anchor.id === groupingColumnId2)
    if (shared) return shared.label
    const demo = filteredDemographics.find(d => d.id === groupingColumnId2)
    return demo ? (demo.column_name || demo.column_text) : null
  }, [groupingColumnId2, sharedDemographics, filteredDemographics])

  // Resolve current palette colors for color picker initial values
  const paletteColors = useMemo(() => {
    const palette = resolveColorPalette(formatting.colorPalette)
    const result: Record<string, string> = {}
    responseLabels.forEach((label, i) => {
      result[label] = formatting.customColors[label] ?? palette[i % palette.length]
    })
    return result
  }, [responseLabels, formatting.colorPalette, formatting.customColors])

  const hasAnyData = vis.sort || vis.display || vis.scaling || vis.scaleOrder ||
    vis.groupBy || vis.excludeValues || vis.hideFromChart || vis.proportionThreshold ||
    vis.axisTransform || vis.crossTabColumn
  const hasAnyAnnotations = vis.showCI || vis.sampleSizes || vis.referenceLine

  return (
    <OptionsAccordion>
      {/* Data section */}
      {hasAnyData && (
        <AccordionSection name="data" label="Data" expanded={expandedSection} onToggle={toggleSection}>
              {vis.sort && (
                <OptionRow icon={ArrowUpDown} label="Variable sort">
                  <Select value={sortOrder} onValueChange={onSortChange}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium px-2 py-1">By name</SelectLabel>
                        <SelectItem value="none">Original</SelectItem>
                        <SelectItem value="asc">A → Z</SelectItem>
                        <SelectItem value="desc">Z → A</SelectItem>
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium px-2 py-1">By data</SelectLabel>
                        <SelectItem value="data_desc">Highest first</SelectItem>
                        <SelectItem value="data_asc">Lowest first</SelectItem>
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium px-2 py-1">Manual</SelectLabel>
                        <SelectItem value="custom">Custom order</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.sort && sortOrder === 'custom' && customOrder.length > 0 && (
                <div className="pl-5 space-y-1">
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={customOrder} strategy={verticalListSortingStrategy}>
                      {customOrder.map(id => (
                        <SortableMetricItem
                          key={id}
                          id={id}
                          label={metricLabels.get(id) || `Metric ${id}`}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  <p className="text-[11px] text-mm-text-faint pl-5 mt-1">Drag to reorder variables</p>
                </div>
              )}

              {vis.proportionThreshold && onProportionConfigChange && (
                <div className="border-t border-mm-border-subtle pt-2 space-y-2">
                  <OptionRow icon={SlidersHorizontal} label="Count">
                    <Select
                      value={proportionMode || 'values'}
                      onValueChange={v => {
                        if (v === 'numeric') onProportionConfigChange({ mode: 'numeric', operator: proportionOperator, threshold_numeric: proportionThreshold })
                        else onProportionConfigChange({ mode: 'values', threshold_values: proportionValues })
                      }}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="values">Specific responses</SelectItem>
                        <SelectItem value="numeric">Numeric comparison</SelectItem>
                      </SelectContent>
                    </Select>
                  </OptionRow>

                  {proportionMode === 'numeric' && (
                    <ProportionNumericControls
                      operator={proportionOperator || '>='}
                      threshold={proportionThreshold ?? 4}
                      scaleLabels={availableScaleValues}
                      onChange={(op, val) => onProportionConfigChange({ mode: 'numeric', operator: op, threshold_numeric: val })}
                    />
                  )}

                  {proportionMode === 'values' && (availableScaleValues?.length ?? 0) > 0 && (
                    <div className="pl-5 space-y-1.5">
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {availableScaleValues!.map(label => (
                          <label key={label} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                              checked={(proportionValues || []).includes(label)}
                              onChange={e => {
                                const next = e.target.checked
                                  ? [...(proportionValues || []), label]
                                  : (proportionValues || []).filter(v => v !== label)
                                onProportionConfigChange({ mode: 'values', threshold_values: next })
                              }}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {(proportionValues?.length ?? 0) > 0 && (
                        <p className="text-[11px] text-mm-text-faint italic pl-0.5">
                          % responding: {proportionValues!.join(', ')}
                        </p>
                      )}
                    </div>
                  )}

                  {proportionMode === 'values' && (availableScaleValues?.length ?? 0) === 0 && (
                    <p className="pl-5 text-[11px] text-mm-text-faint italic">
                      Select ordinal variables to see response options
                    </p>
                  )}
                </div>
              )}

              {hasShortLabels && (
                <OptionRow icon={Tag} label="Labels">
                  <Select value={labelMode} onValueChange={v => onLabelModeChange(v as LabelMode)}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="short">Short names</SelectItem>
                      <SelectItem value="full">Full variable text</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.divergingLayout && (
                <OptionRow icon={ArrowLeftRight} label="Layout">
                  <Select
                    value={divergingMode ? 'diverging' : 'standard'}
                    onValueChange={v => onDivergingModeChange?.(v === 'diverging')}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="diverging">Diverging</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.divergingLayout && divergingMode && divergingCenterAuto && (
                <div className="pl-5 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-mm-text-muted">
                    Center point:
                    <Select
                      value={divergingCenter ?? '_auto'}
                      onValueChange={v => onDivergingCenterChange?.(v === '_auto' ? null : v)}
                    >
                      <SelectTrigger className="h-6 text-[10px] flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_auto">
                          Auto{divergingCenterAuto.centerLabel ? ` (${divergingCenterAuto.centerLabel})` : ' (boundary)'}
                        </SelectItem>
                        {responseLabels.map(label => (
                          <SelectItem key={label} value={label}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {divergingCenterAuto.mode === 'boundary' && !divergingCenter && (
                    <p className="text-[11px] text-mm-text-faint italic">
                      Even-point scale — bars split at midpoint
                    </p>
                  )}
                  {hasMixedScales && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 italic">
                      Variables have different scales — center may not align
                    </p>
                  )}
                </div>
              )}

              {vis.display && !divergingMode && (
                <OptionRow icon={Percent} label="Display">
                  <Select value={display} onValueChange={onDisplayChange}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percentage">Percentage</SelectItem>
                      <SelectItem value="count">Count</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.display && divergingMode && (
                <p className="text-[11px] text-mm-text-faint italic pl-5">
                  Diverging layout uses percentages
                </p>
              )}

              {vis.scaling && (
                <OptionRow icon={Maximize2} label="Scaling">
                  <Select value={scaling} onValueChange={onScalingChange}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relative">Relative (per row)</SelectItem>
                      <SelectItem value="absolute">Absolute (0-100%)</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.scaleOrder && (
                <OptionRow icon={ArrowDownUp} label="Scale order">
                  <Select value={scaleOrder} onValueChange={onScaleOrderChange}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="natural">Natural</SelectItem>
                      <SelectItem value="reversed">Reversed</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.groupBy && (() => {
                const selectedDemographic = groupingColumnId
                  ? filteredDemographics.find(d => d.id === groupingColumnId)
                  : null
                const selectedSharedDemo = groupingColumnId
                  ? sharedDemographics.find(sd => sd.anchor.id === groupingColumnId)
                  : null
                const currentValue = groupingMode === 'dataset'
                  ? '_dataset'
                  : groupingColumnId ? String(groupingColumnId) : '_none'
                // Composite display label
                const displayLabel = groupingMode === 'dataset'
                  ? 'By Dataset'
                  : dim1DemoLabel && dim2DemoLabel
                    ? `${dim1DemoLabel} \u00d7 ${dim2DemoLabel}`
                    : dim1DemoLabel
                      ? dim1DemoLabel
                      : 'None'
                const showDemographics = !datasetGroupingAvailable && filteredDemographics.length > 0
                const showSharedDemographics = datasetGroupingAvailable && sharedDemographics.length > 0
                const triggerTitle = !canGroupBy ? groupByDisabledReason
                  : groupingMode === 'dataset'
                    ? 'By Dataset — groups results by source dataset'
                    : dim1DemoLabel && dim2DemoLabel
                      ? `${dim1DemoLabel} \u00d7 ${dim2DemoLabel} — composite grouping`
                      : selectedSharedDemo
                        ? `${selectedSharedDemo.label} — shared across ${selectedSharedDemo.datasetNames.join(', ')}`
                        : selectedDemographic
                          ? `${selectedDemographic.column_name || selectedDemographic.column_text} (${selectedDemographic.dataset_name})`
                          : undefined
                // Whether "Add dimension" is available (demographic selected, not dataset mode)
                const canAddDimension = groupingColumnId != null && groupingMode !== 'dataset'
                // Items available for the second dropdown — exclude the column already used in dimension 1
                const dim2Demographics = filteredDemographics.filter(d => d.id !== groupingColumnId)
                const dim2SharedDemographics = sharedDemographics.filter(sd => sd.anchor.id !== groupingColumnId)
                const showDim2Demographics = !datasetGroupingAvailable && dim2Demographics.length > 0
                const showDim2SharedDemographics = datasetGroupingAvailable && dim2SharedDemographics.length > 0
                return (
                <>
                <OptionRow icon={Users} label="Group by">
                  <Select
                    value={currentValue}
                    onValueChange={v => {
                      if (v === '_dataset') {
                        onGroupingChange(null, 'dataset')
                      } else if (v === '_none') {
                        onGroupingChange(null)
                      } else {
                        onGroupingChange(Number(v), 'column')
                      }
                    }}
                    disabled={!canGroupBy}
                  >
                    <SelectTrigger
                      className="h-7 text-xs"
                      title={triggerTitle}
                    >
                      <span className="truncate">{displayLabel}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">None</SelectItem>
                      {datasetGroupingAvailable && (
                        <>
                          <SelectSeparator />
                          <SelectItem value="_dataset">
                            <span aria-label="By Dataset — groups results by source dataset">By Dataset</span>
                          </SelectItem>
                        </>
                      )}
                      {showSharedDemographics && (
                        <>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium px-2 py-1">Shared demographics</SelectLabel>
                            {sharedDemographics.map(sd => (
                              <SelectItem key={sd.anchor.id} value={String(sd.anchor.id)}>
                                <span title={`${sd.label} — shared across ${sd.datasetNames.join(', ')}`}>
                                  {sd.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </>
                      )}
                      {showDemographics && (
                        <>
                          {datasetGroupingAvailable && <SelectSeparator />}
                          {filteredDemographics.map(d => (
                            <SelectItem key={d.id} value={String(d.id)}>
                              {d.column_name || d.column_text} ({d.dataset_name})
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </OptionRow>
                {canAddDimension && groupingColumnId2 == null && (
                  <div className="pl-7">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 py-0.5"
                      onClick={() => {
                        // Pick the first available demographic as a sensible default — or just reveal dropdown
                        // We reveal the second dropdown by setting a sentinel value
                        // Actually, just pick the first available option
                        const first = showDim2SharedDemographics ? dim2SharedDemographics[0]?.anchor.id
                          : showDim2Demographics ? dim2Demographics[0]?.id
                          : null
                        if (first) onGrouping2Change(first)
                      }}
                    >
                      <Plus className="w-3 h-3" />
                      Add dimension
                    </button>
                  </div>
                )}
                {canAddDimension && groupingColumnId2 != null && (
                  <>
                  <OptionRow icon={Layers} label="Group by 2">
                    <Select
                      value={groupingColumnId2 ? String(groupingColumnId2) : '_none'}
                      onValueChange={v => {
                        if (v === '_none') onGrouping2Change(null)
                        else onGrouping2Change(Number(v))
                      }}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <span className="truncate">{dim2DemoLabel || 'None'}</span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">None</SelectItem>
                        {showDim2SharedDemographics && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium px-2 py-1">Shared demographics</SelectLabel>
                              {dim2SharedDemographics.map(sd => (
                                <SelectItem key={sd.anchor.id} value={String(sd.anchor.id)}>
                                  <span title={`${sd.label} — shared across ${sd.datasetNames.join(', ')}`}>
                                    {sd.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </>
                        )}
                        {showDim2Demographics && (
                          <>
                            {showDim2SharedDemographics && <SelectSeparator />}
                            {dim2Demographics.map(d => (
                              <SelectItem key={d.id} value={String(d.id)}>
                                {d.column_name || d.column_text} ({d.dataset_name})
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                  {availableGroupValues.length > 0 && (
                    <div className="pl-7 text-[11px] text-mm-text-faint">
                      {availableGroupValues.length} groups
                      {availableGroupValues.length > 15 && (
                        <span className="text-amber-500 dark:text-amber-400 ml-1">&mdash; consider hiding some</span>
                      )}
                    </div>
                  )}
                  </>
                )}
                </>
                )
              })()}

              {vis.groupOrganization && (groupingColumnId || groupingMode === 'dataset') && (
                <OptionRow icon={ArrowDownUp} label="Group layout">
                  <Select value={groupOrganization} onValueChange={v => onGroupOrganizationChange(v as GroupOrganization)}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="variable-first">Variables, then groups</SelectItem>
                      <SelectItem value="group-first">Groups, then variables</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.groupFilter && (groupingColumnId || groupingMode === 'dataset') && availableGroupValues.length > 0 && (() => {
                const COMPOSITE_SEPARATOR = ' \u00b7 '
                const isComposite = groupingColumnId != null && groupingColumnId2 != null

                // Extract unique values per dimension for composite filtering
                const dim1Values = new Set<string>()
                const dim2Values = new Set<string>()
                if (isComposite) {
                  for (const gv of availableGroupValues) {
                    const idx = gv.indexOf(COMPOSITE_SEPARATOR)
                    if (idx >= 0) {
                      dim1Values.add(gv.substring(0, idx))
                      dim2Values.add(gv.substring(idx + COMPOSITE_SEPARATOR.length))
                    }
                  }
                }
                const sortedDim1 = Array.from(dim1Values).sort()
                const sortedDim2 = Array.from(dim2Values).sort()

                // A dimension value is "hidden" when ALL its composite groups are hidden
                const hiddenDim1 = sortedDim1.filter(d1 =>
                  sortedDim2.every(d2 => hiddenGroupValues.includes(`${d1}${COMPOSITE_SEPARATOR}${d2}`))
                )
                const hiddenDim2 = sortedDim2.filter(d2 =>
                  sortedDim1.every(d1 => hiddenGroupValues.includes(`${d1}${COMPOSITE_SEPARATOR}${d2}`))
                )

                const toggleDim = (otherDimValues: string[], val: string, hide: boolean, dimIndex: 1 | 2) => {
                  const composites = otherDimValues.map(other =>
                    dimIndex === 1 ? `${val}${COMPOSITE_SEPARATOR}${other}` : `${other}${COMPOSITE_SEPARATOR}${val}`
                  )
                  if (hide) {
                    onHiddenGroupValuesChange([...new Set([...hiddenGroupValues, ...composites])])
                  } else {
                    const toShow = new Set(composites)
                    onHiddenGroupValuesChange(hiddenGroupValues.filter(v => !toShow.has(v)))
                  }
                }

                return (
                <div className="border-t border-mm-border-subtle pt-2">
                  <OptionRow icon={EyeOff} label="Hide groups" fullWidth>
                    {isComposite && sortedDim1.length > 0 ? (
                      <div className="space-y-2">
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium mb-1">
                            {dim1DemoLabel || 'Dimension 1'}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {sortedDim1.map(v => (
                              <label key={v} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                                  checked={hiddenDim1.includes(v)}
                                  onChange={e => toggleDim(sortedDim2, v, e.target.checked, 1)}
                                />
                                {v}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-mm-text-faint font-medium mb-1">
                            {dim2DemoLabel || 'Dimension 2'}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {sortedDim2.map(v => (
                              <label key={v} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                                  checked={hiddenDim2.includes(v)}
                                  onChange={e => toggleDim(sortedDim1, v, e.target.checked, 2)}
                                />
                                {v}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {availableGroupValues.map(gv => (
                          <label key={gv} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                              checked={hiddenGroupValues.includes(gv)}
                              onChange={e => {
                                if (e.target.checked) onHiddenGroupValuesChange([...hiddenGroupValues, gv])
                                else onHiddenGroupValuesChange(hiddenGroupValues.filter(v => v !== gv))
                              }}
                            />
                            {gv}
                          </label>
                        ))}
                      </div>
                    )}
                  </OptionRow>
                </div>
                )
              })()}

              {vis.axisRange && (
                <OptionRow icon={MoveHorizontal} label="Axis range">
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      step="1"
                      value={formatting.xAxisMin ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        onFormattingChange({ xAxisMin: v === '' ? null : Number(v) })
                      }}
                      placeholder="Auto"
                      className="h-7 text-xs w-16"
                    />
                    <span className="text-mm-text-faint text-xs">to</span>
                    <Input
                      type="number"
                      step="1"
                      value={formatting.xAxisMax ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        onFormattingChange({ xAxisMax: v === '' ? null : Number(v) })
                      }}
                      placeholder="Auto"
                      className="h-7 text-xs w-16"
                    />
                  </div>
                </OptionRow>
              )}

              {vis.axisTransform && (
                <OptionRow icon={Activity} label="Axis scale">
                  <Select
                    value={axisTransform}
                    onValueChange={v => onAxisTransformChange?.(v as 'linear' | 'log')}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="linear">Linear</SelectItem>
                      <SelectItem value="log">Log</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.crossTabColumn && (
                <OptionRow icon={Columns3} label="Cross-tab column">
                  <Select
                    value={crossTabColumnId ? String(crossTabColumnId) : '_none'}
                    onValueChange={v => {
                      onCrossTabColumnChange?.(v === '_none' ? null : Number(v))
                    }}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <span className="truncate">
                        {crossTabColumnId
                          ? crossTabEligibleColumns.find(c => c.id === crossTabColumnId)?.label || 'Column'
                          : 'Select column...'}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">None</SelectItem>
                      {crossTabEligibleColumns.map(col => (
                        <SelectItem key={col.id} value={String(col.id)}>
                          {col.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {vis.crossTabDisplay && crossTabColumnId && (
                <OptionRow icon={Percent} label="Display mode">
                  <Select
                    value={crossTabDisplay}
                    onValueChange={v => onCrossTabDisplayChange?.(v)}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="count">Count</SelectItem>
                      <SelectItem value="row_pct">Row %</SelectItem>
                      <SelectItem value="col_pct">Column %</SelectItem>
                      <SelectItem value="total_pct">Total %</SelectItem>
                    </SelectContent>
                  </Select>
                </OptionRow>
              )}

              {canDecompose && (
                <OptionRow icon={Columns3} label="Show individual variables">
                  <label className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                      checked={decompose}
                      onChange={e => onDecomposeChange?.(e.target.checked)}
                    />
                    <span className="text-[11px]">Split by variable</span>
                  </label>
                </OptionRow>
              )}

              {vis.excludeValues && responseLabels.length > 0 && (
                <div className="border-t border-mm-border-subtle pt-2">
                  <OptionRow icon={EyeOff} label="Exclude values" fullWidth>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {isComputing && <span className="text-blue-500 dark:text-blue-400 text-[11px]">computing...</span>}
                      {responseLabels.map(label => (
                        <label key={label} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                            checked={excludeValues.includes(label)}
                            onChange={e => {
                              if (e.target.checked) onExcludeValuesChange([...excludeValues, label])
                              else onExcludeValuesChange(excludeValues.filter(v => v !== label))
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </OptionRow>
                </div>
              )}

              {vis.hideFromChart && responseLabels.length > 0 && (
                <div className="border-t border-mm-border-subtle pt-2">
                  <OptionRow icon={Eye} label="Hide from chart" fullWidth>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {responseLabels.map(label => (
                        <label key={label} className="flex items-center gap-1.5 text-mm-text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3 h-3"
                            checked={hiddenResponseOptions.includes(label)}
                            onChange={e => {
                              if (e.target.checked) onHiddenResponseOptionsChange([...hiddenResponseOptions, label])
                              else onHiddenResponseOptionsChange(hiddenResponseOptions.filter(v => v !== label))
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </OptionRow>
                </div>
              )}
        </AccordionSection>
      )}

      {/* Appearance section */}
      <AccordionSection name="appearance" label="Appearance" expanded={expandedSection} onToggle={toggleSection}>
            {/* Text fields — grouped with label-only inputs */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
                <Type className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
                Text
              </div>
              <Input
                value={chartTitle}
                onChange={e => onTitleChange(e.target.value)}
                placeholder="Title..."
                className="h-7 text-xs"
              />
              <Input
                value={chartSubtitle}
                onChange={e => onSubtitleChange(e.target.value)}
                placeholder="Subtitle..."
                className="h-7 text-xs"
              />
              <Input
                value={chartFootnote}
                onChange={e => onFootnoteChange(e.target.value)}
                placeholder="Footnote..."
                className="h-7 text-xs"
              />
            </div>

            {/* Font sizes — compact 4-select row */}
            <div className="border-t border-mm-border-subtle pt-2">
            <OptionRow icon={ALargeSmall} label="Fonts" fullWidth>
              <div className="grid grid-cols-4 gap-1">
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
                    value={String(formatting.axisFontSize)}
                    onValueChange={v => onFormattingChange({ axisFontSize: Number(v) })}
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
                  <span className="text-[11px] text-mm-text-faint mt-0.5 block text-center">Ticks</span>
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

            {/* Color palette */}
            {vis.colorPalette && (
              <OptionRow icon={Palette} label="Color palette">
                <Select
                  value={formatting.colorPalette}
                  onValueChange={v => onFormattingChange({ colorPalette: v })}
                >
                  <SelectTrigger className="h-auto min-h-[1.75rem] text-xs py-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(COLOR_PALETTES).map(k => (
                      <SelectItem key={k} value={k}>
                        <span className="flex items-center gap-1.5">
                          <span className="flex gap-0.5 shrink-0">
                            {COLOR_PALETTES[k].slice(0, 5).map((c, i) => (
                              <span key={`${k}-${i}`} className="w-2 h-2 rounded-sm" style={{ backgroundColor: c }} />
                            ))}
                          </span>
                          <span className="break-words" style={{ hyphens: 'auto' }}>{PALETTE_LABELS[k] || k}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {/* Custom per-response-option colors (placed next to palette) */}
            {vis.responseColors && responseLabels.length > 0 && Object.keys(formatting.customColors).length > 0 && (
              <div className="border-t pt-2 mt-1">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
                    <Palette className="w-3.5 h-3.5 text-mm-text-faint" />
                    Custom colors
                  </span>
                  <button
                    className="flex items-center gap-1 text-mm-text-faint hover:text-mm-text-secondary text-xs"
                    onClick={() => onFormattingChange({ customColors: {} })}
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reset
                  </button>
                </div>
              </div>
            )}

            {vis.responseColors && responseLabels.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {responseLabels.map(label => (
                  <label key={label} className="flex items-center gap-1 text-mm-text-secondary cursor-pointer" aria-label={`Color for ${label}`}>
                    <input
                      type="color"
                      className="w-4 h-4 rounded border border-mm-border-subtle cursor-pointer"
                      value={paletteColors[label] || '#3b82f6'}
                      onChange={e => onFormattingChange({
                        customColors: { ...formatting.customColors, [label]: e.target.value },
                      })}
                    />
                    <span className="truncate max-w-[70px]">{label}</span>
                  </label>
                ))}
              </div>
            )}

            {/* Heatmap color preset */}
            {vis.heatmapColor && (
              <OptionRow icon={Palette} label="Heatmap color">
                <Select
                  value={formatting.heatmapPreset}
                  onValueChange={v => onFormattingChange({ heatmapPreset: v })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(HEATMAP_PRESETS).map(k => (
                      <SelectItem key={k} value={k}>{HEATMAP_LABELS[k] || k}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {/* Bar width */}
            {vis.barSize && (
              <OptionRow icon={GripHorizontal} label="Bar width">
                <Select
                  value={String(formatting.barSize)}
                  onValueChange={v => onFormattingChange({ barSize: Number(v) })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BAR_SIZE_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {/* Data labels */}
            {vis.dataLabels && (
              <OptionRow icon={Hash} label="Data labels">
                <Select
                  value={vis.dataLabelsInsideOnly && formatting.dataLabels === 'outside' ? 'inside' : formatting.dataLabels}
                  onValueChange={v => onFormattingChange({ dataLabels: v as 'outside' | 'inside' | 'none' })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!vis.dataLabelsInsideOnly && (
                      <SelectItem value="outside">Outside bars</SelectItem>
                    )}
                    <SelectItem value="inside">{vis.dataLabelsInsideOnly ? 'Inside segments' : 'Inside bars'}</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {vis.dataWidth && (
              <OptionRow icon={Columns3} label="Data area">
                <Select
                  value={formatting.dataWidth}
                  onValueChange={v => onFormattingChange({ dataWidth: v as DataWidthMode })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="75%">75%</SelectItem>
                    <SelectItem value="50%">50%</SelectItem>
                    <SelectItem value="25%">25%</SelectItem>
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {/* Line style */}
            {vis.lineStyle && (
              <OptionRow icon={Spline} label="Line style">
                <Select value={lineStyle} onValueChange={v => onLineStyleChange?.(v as 'connected' | 'markers')}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="connected">Connected</SelectItem>
                    <SelectItem value="markers">Markers only</SelectItem>
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

            {/* Line overlay on horizontal bar */}
            {vis.lineOverlay && (
              <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                  checked={lineOverlay}
                  onChange={e => onLineOverlayChange?.(e.target.checked)}
                />
                <Spline className="w-3.5 h-3.5 text-mm-text-faint" />
                Line overlay
              </label>
            )}

            {/* Dumbbell dot size */}
            {vis.pointSize && (
              <OptionRow icon={Circle} label="Dot size">
                <Select
                  value={String(formatting.pointSize)}
                  onValueChange={v => onFormattingChange({ pointSize: Number(v) })}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POINT_SIZE_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OptionRow>
            )}

      </AccordionSection>

      {/* Annotations section */}
      {hasAnyAnnotations && (
        <AccordionSection name="annotations" label="Annotations" expanded={expandedSection} onToggle={toggleSection}>
              {vis.showCI && (
                <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                    checked={showCI}
                    onChange={e => onShowCIChange(e.target.checked)}
                  />
                  <Activity className="w-3.5 h-3.5 text-mm-text-faint" />
                  Error bars (95% CI)
                </label>
              )}

              {vis.errorBand && showCI && (
                <div className="pl-5">
                  <OptionRow icon={Activity} label="CI Display">
                    <Select
                      value={showErrorBand ? 'band' : 'bars'}
                      onValueChange={v => onShowErrorBandChange?.(v === 'band')}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bars">Error bars</SelectItem>
                        <SelectItem value="band">Shaded band</SelectItem>
                      </SelectContent>
                    </Select>
                  </OptionRow>
                </div>
              )}

              {vis.sampleSizes && (
                <div>
                  <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                      checked={showSampleSizes}
                      onChange={e => onToggleSampleSizes(e.target.checked)}
                    />
                    <Hash className="w-3.5 h-3.5 text-mm-text-faint" aria-hidden="true" />
                    Sample sizes
                  </label>
                  {showSampleSizes && (
                    <div className="mt-1.5 ml-5 space-y-1.5">
                      <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
                        <input
                          type="checkbox"
                          className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                          checked={showChartN}
                          onChange={e => onShowChartNChange(e.target.checked)}
                        />
                        Chart N
                      </label>
                      {vis.groupN && (
                        <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded border-mm-border-medium text-blue-600 dark:text-blue-400 w-3.5 h-3.5"
                            checked={showGroupN}
                            onChange={e => onShowGroupNChange(e.target.checked)}
                          />
                          Group n
                        </label>
                      )}
                      <div className="flex items-center gap-1.5">
                        <label htmlFor="opt-question-n" className="text-xs text-mm-text-secondary">Per-variable n:</label>
                        <Select value={showVariableN} onValueChange={onShowVariableNChange}>
                          <SelectTrigger id="opt-question-n" className="h-7 text-xs w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="off">Off</SelectItem>
                            <SelectItem value="differing">Differing only</SelectItem>
                            <SelectItem value="all">All</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {vis.referenceLine && (
                <OptionRow icon={Minus} label="Reference line">
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={formatting.referenceLine ?? ''}
                    onChange={e => {
                      const v = e.target.value
                      onFormattingChange({ referenceLine: v === '' ? null : Number(v) })
                    }}
                    placeholder="None"
                    className="h-7 text-xs w-24"
                  />
                </OptionRow>
              )}
        </AccordionSection>
      )}
    </OptionsAccordion>
  )
}
