import { useState, useMemo, useCallback } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import {
  ChevronDown,
  Trash2,
  ListChecks,
  SlidersHorizontal,
  SwatchBook,
  Pencil,
  GripVertical,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  MetricDefinitionResponse,
  MetricDefinitionSummaryResponse,
  MaterialResponse,
  AnalysisColumnsResponse,
  AnalysisColumnItem,
  AnalysisDemographicItem,
  AnalysisDomainResponse,
  CorrelationMatrixResponse,
  GroupComparisonResponse,
  McarTestResponse,
} from '@/lib/api'
import { canvasApi } from '@/lib/api'
import {
  HEATMAP_PRESETS,
  HEATMAP_LABELS,
  PALETTE_LABELS,
  COLOR_PALETTES,
  type ChartType,
  type ChartFormatting,
  type SortOrder,
  type LabelMode,
  type GroupOrganization,
} from '@/lib/chart-data'
import ChartOptionsPanel from '@/components/ChartOptionsPanel'
import { ColumnPicker, type PickerMode } from '@/components/ColumnPicker'
import { DataQualitySidebar } from '@/components/analysis/DataQualityTab'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { OptionsAccordion, AccordionSection, useAccordionState } from '@/components/analysis/OptionsAccordion'
import SegmentedControl from '@/components/ui/segmented-control'
import SendToCanvasMenu from '@/components/canvas/SendToCanvasMenu'

// ── Constants ────────────────────────────────────────────────────────────────

const METRIC_TYPE_OPTIONS = [
  { value: 'frequency_distribution', label: 'Frequency Distribution' },
  { value: 'proportion', label: 'Proportion' },
  { value: 'mean', label: 'Mean' },
  { value: 'domain_aggregate', label: 'Group Aggregate' },
]

// ── Sortable material row (#375a) ──────────────────────────────────────────────

function SortableMaterialRow({
  material, isActive, pid, onLoad, onRename, onDelete, onSendToCanvas, onSendToNewCanvas,
}: {
  material: MaterialResponse
  isActive: boolean
  pid: number
  onLoad: (el: MaterialResponse) => void
  onRename: (id: number, name: string) => void
  onDelete: (id: number) => void
  onSendToCanvas: (el: MaterialResponse, canvasId: number) => void
  onSendToNewCanvas: (el: MaterialResponse, name: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: material.id })
  const style = {
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={`group/mat flex items-center rounded ${
            isActive ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-mm-surface-hover'
          }`}
        >
          {/* Drag handle — listeners only here so the row's click still loads the material */}
          <button
            type="button"
            className="flex-none px-0.5 py-1.5 text-mm-text-faint opacity-0 group-hover/mat:opacity-100 focus:opacity-100 cursor-grab active:cursor-grabbing touch-none"
            aria-label={`Reorder ${material.custom_name || material.auto_name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <button
            className={`flex-1 min-w-0 text-left pr-2 py-1.5 text-sm flex items-center gap-1.5 ${
              isActive ? 'text-blue-700 dark:text-blue-300 font-medium' : 'text-mm-text'
            }`}
            onClick={() => onLoad(material)}
          >
            <SwatchBook className="w-3 h-3 flex-shrink-0" />
            <span className="flex-1 truncate">{material.custom_name || material.auto_name}</span>
            {material.source_tab !== 'descriptives' && (
              /* #394: meaningful label — use the readable muted token (faint
                 fails WCAG AA on this small text). */
              <span className="text-[10px] text-mm-text-muted uppercase">
                {material.source_tab === 'correlations' ? 'R&C' : material.source_tab}
              </span>
            )}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SendToCanvasMenu
          projectId={pid}
          onSend={(canvasId) => onSendToCanvas(material, canvasId)}
          onSendNew={(name) => onSendToNewCanvas(material, name)}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            const name = window.prompt('Rename material:', material.custom_name || material.auto_name)
            if (name != null) onRename(material.id, name)
          }}
        >
          <Pencil className="w-3 h-3 mr-2" /> Rename
        </ContextMenuItem>
        <ContextMenuItem className="text-red-600" onClick={() => onDelete(material.id)}>
          <Trash2 className="w-3 h-3 mr-2" /> Remove
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface AnalysisSidebarProps {
  // Core
  pid: number
  activeTab: 'descriptives' | 'rc' | 'data_quality'
  setUrlParam: (key: string, value: string) => void
  setSearchParams: SetURLSearchParams

  // Palette
  materials: MaterialResponse[]
  activeMaterialId: number | null
  onLoadMaterial: (el: MaterialResponse) => void
  onDeleteMaterial: (id: number) => void
  onRenameMaterial: (id: number, name: string) => void
  onReorderMaterials?: (orderedIds: number[]) => void

  // Variables picker
  selectedColumnIds: Set<number>
  selectedDomainIds: Set<number>
  onEditColumn?: (question: AnalysisColumnItem) => void
  // Phase 4.7/4.8 — DomainPickerDetail inline expansion
  domainsFull?: AnalysisDomainResponse[]
  metricsList?: MetricDefinitionSummaryResponse[]
  onCreateScoreMetric?: (domainId: number) => void
  isCreatingScoreMetric?: boolean
  selectedMetricIdHint?: number | null
  onPickMetric?: (metricId: number) => void

  // Descriptives tab — chart options
  selectedMetrics: MetricDefinitionResponse[]
  hasAnySelection: boolean
  isComputing: boolean
  chartType: ChartType | null
  metricType: string
  sortOrder: SortOrder
  display: string
  scaling: string
  scaleOrder: 'natural' | 'reversed'
  groupingColumnId: number | null
  groupingColumnId2: number | null
  groupingMode: 'column' | 'dataset'
  excludeValues: string[]
  hiddenResponseOptions: string[]
  formatting: ChartFormatting
  showCI: boolean
  showChartN: boolean
  showGroupN: boolean
  showVariableN: string
  showSampleSizes: boolean
  labelMode: LabelMode
  hasShortLabels: boolean
  customOrder: number[]
  metricLabelsMap: Map<number, string>
  responseLabels: string[]
  canGroupBy: boolean
  groupByDisabledReason: string | undefined
  relevantDatasetIds: Set<number>
  chartTitle: string
  chartSubtitle: string
  chartFootnote: string
  hiddenGroupValues: string[]
  availableGroupValues: string[]
  groupOrganization: GroupOrganization
  proportionMode: 'numeric' | 'values'
  proportionOperator: string
  proportionThreshold: number
  proportionValues: string[]
  availableScaleValues: string[]
  divergingMode: boolean
  divergingCenter: string | null
  divergingCenterAuto: { centerLabel: string | null; mode: 'center' | 'boundary' }
  hasMixedScales: boolean
  showErrorBand: boolean
  lineStyle: 'connected' | 'markers'
  lineOverlay: boolean
  axisTransform: 'linear' | 'log'
  crossTabColumnId: number | null
  crossTabDisplay: string
  crossTabEligibleColumns: Array<{ id: number; label: string; datasetId: number }>
  decompose: boolean
  canDecompose: boolean
  groupByAvailability: { enabled: boolean; datasetGroupingAvailable: boolean; reason: string }
  sharedDemographics: Array<{ anchor: AnalysisDemographicItem; label: string; datasetNames: string[] }>

  // Chart option callbacks (state setters from parent)
  onFormattingChange: (patch: Partial<ChartFormatting>) => void
  onLabelModeChange: (mode: LabelMode) => void
  onCustomOrderChange: (order: number[]) => void
  onScaleOrderChange: (v: string) => void
  onHiddenResponseOptionsChange: (opts: string[]) => void
  onTitleChange: (v: string) => void
  onSubtitleChange: (v: string) => void
  onFootnoteChange: (v: string) => void
  onShowErrorBandChange: (v: boolean) => void
  onLineStyleChange: (v: 'connected' | 'markers') => void
  onLineOverlayChange: (v: boolean) => void
  onHiddenGroupValuesChange: (v: string[]) => void
  onGroupOrganizationChange: (v: GroupOrganization) => void
  onProportionConfigChange: (config: {
    mode: string
    operator?: string
    threshold_numeric?: number
    threshold_values?: string[]
  }) => void

  // R&C tab sidebar
  rcView: 'correlations' | 'comparisons'
  corrType: 'pearson' | 'spearman'
  sigLevelsRaw: string
  bonferroniOn: boolean
  corrMatrixData: CorrelationMatrixResponse | undefined
  showScatter: boolean
  showRegLine: boolean
  showJitter: boolean
  corrCellFormat: string
  corrColors: string
  compareBy: number | null
  compareBy2: number | null
  testType: string
  nonparametric: boolean
  excludeGroups: string[]
  rcPalette: string
  comparisonData: GroupComparisonResponse | undefined
  analysisColumnsData: AnalysisColumnsResponse | undefined
  hasComparisonSelection: boolean
  hasRcSelection: boolean

  // DQ tab sidebar
  dqView: 'summary' | 'bar' | 'patterns'
  dqIncludeNA: boolean
  dqIncludeEmpty: boolean
  dqSort: 'pct_missing' | 'name' | 'dataset'
  dqColumnIds: number[]
  dqIsMultiDataset: boolean
  dqHasNumericVars: boolean
  mcarIsPending: boolean
  mcarResult: McarTestResponse | null
  mcarError: Error | null
  onMcarRun: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AnalysisSidebar(props: AnalysisSidebarProps) {
  const {
    pid, activeTab, setUrlParam, setSearchParams,
    materials, activeMaterialId, onLoadMaterial, onDeleteMaterial, onRenameMaterial, onReorderMaterials,
    selectedColumnIds, selectedDomainIds, onEditColumn,
    domainsFull, metricsList, onCreateScoreMetric, isCreatingScoreMetric,
    selectedMetricIdHint, onPickMetric,
    selectedMetrics, hasAnySelection, isComputing,
    chartType, metricType, sortOrder, display, scaling, scaleOrder,
    groupingColumnId, groupingColumnId2, groupingMode,
    excludeValues, hiddenResponseOptions,
    formatting, showCI, showChartN, showGroupN, showVariableN, showSampleSizes,
    labelMode, hasShortLabels, customOrder, metricLabelsMap,
    responseLabels, canGroupBy, groupByDisabledReason, relevantDatasetIds,
    chartTitle, chartSubtitle, chartFootnote,
    hiddenGroupValues, availableGroupValues, groupOrganization,
    proportionMode, proportionOperator, proportionThreshold, proportionValues,
    availableScaleValues,
    divergingMode, divergingCenter, divergingCenterAuto, hasMixedScales,
    showErrorBand, lineStyle, lineOverlay, axisTransform,
    crossTabColumnId, crossTabDisplay, crossTabEligibleColumns,
    decompose, canDecompose, groupByAvailability, sharedDemographics,
    onFormattingChange, onLabelModeChange, onCustomOrderChange, onScaleOrderChange,
    onHiddenResponseOptionsChange, onTitleChange, onSubtitleChange, onFootnoteChange,
    onShowErrorBandChange, onLineStyleChange, onLineOverlayChange,
    onHiddenGroupValuesChange, onGroupOrganizationChange, onProportionConfigChange,
    rcView, corrType, sigLevelsRaw, bonferroniOn, corrMatrixData,
    showScatter, showRegLine, showJitter, corrCellFormat, corrColors,
    compareBy, compareBy2, testType, nonparametric, excludeGroups, rcPalette,
    comparisonData, analysisColumnsData, hasComparisonSelection, hasRcSelection,
    dqView, dqIncludeNA, dqIncludeEmpty, dqSort,
    dqColumnIds, dqIsMultiDataset, dqHasNumericVars,
    mcarIsPending, mcarResult, mcarError, onMcarRun,
  } = props

  // ── Sidebar-local state ─────────────────────────────────────────────────

  const [materialsOpen, setMaterialsOpen] = useState(true)
  const materialSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleMaterialsDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = materials.map(m => m.id)
    const oldIndex = ids.indexOf(Number(active.id))
    const newIndex = ids.indexOf(Number(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onReorderMaterials?.(arrayMove(ids, oldIndex, newIndex))
  }, [materials, onReorderMaterials])
  const [questionsCollapsed, setQuestionsCollapsed] = useState(false)
  const [chartOptionsCollapsed, setChartOptionsCollapsed] = useState(false)
  const [expandedDatasetId, setExpandedDatasetId] = useState<number | null>(null)
  const [openDataSectionTrigger, setOpenDataSectionTrigger] = useState(0)
  const [pickerMode, setPickerMode] = useState<PickerMode>('columns')

  const rcAccordion = useAccordionState('data')
  const queryClient = useQueryClient()

  const sendToCanvasMut = useMutation({
    mutationFn: ({ canvasId, el }: { canvasId: number; el: MaterialResponse }) =>
      canvasApi.addPendingItem(pid, canvasId, {
        item_type: 'material',
        source_id: el.id,
      }),
    onSuccess: (_data, vars) => {
      toast.success(`Added to canvas`)
      queryClient.invalidateQueries({ queryKey: ['canvas', pid, vars.canvasId] })
    },
  })

  const handleSendToCanvas = useCallback((el: MaterialResponse, canvasId: number) => {
    sendToCanvasMut.mutate({ canvasId, el })
  }, [sendToCanvasMut])

  const handleSendToNewCanvas = useCallback(async (el: MaterialResponse, canvasName: string) => {
    const canvas = await canvasApi.create(pid, canvasName)
    queryClient.invalidateQueries({ queryKey: ['canvases', pid] })
    sendToCanvasMut.mutate({ canvasId: canvas.id, el })
  }, [pid, queryClient, sendToCanvasMut])

  // Sorted column/domain arrays for R&C variable counts
  const rcColumnIds = useMemo(() => [...selectedColumnIds].sort((a, b) => a - b), [selectedColumnIds])
  const rcDomainIds = useMemo(() => [...selectedDomainIds].sort((a, b) => a - b), [selectedDomainIds])

  // ── Sidebar-local callbacks ─────────────────────────────────────────────

  const onToggleColumn = useCallback((id: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const current = (next.get('columns') || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      const idx = current.indexOf(id)
      if (idx >= 0) current.splice(idx, 1)
      else current.push(id)
      if (current.length === 0) next.delete('columns')
      else next.set('columns', current.join(','))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const onToggleDomain = useCallback((id: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const current = (next.get('domains') || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      const idx = current.indexOf(id)
      if (idx >= 0) current.splice(idx, 1)
      else current.push(id)
      if (current.length === 0) next.delete('domains')
      else next.set('domains', current.join(','))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const onViewAcrossDatasets = useCallback((domainId: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('columns')
      next.set('domains', String(domainId))
      next.set('groupMode', 'dataset')
      next.delete('groupBy')
      return next
    }, { replace: true })
    setPickerMode('domains')
    setChartOptionsCollapsed(false)
    setOpenDataSectionTrigger(n => n + 1)
  }, [setSearchParams])

  const onSelectAllDataset = useCallback((_datasetId: number, columnIds: number[], select: boolean) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const current = new Set(
        (next.get('columns') || '').split(',').map(Number).filter(n => !isNaN(n) && n > 0)
      )
      if (select) {
        columnIds.forEach(id => current.add(id))
      } else {
        columnIds.forEach(id => current.delete(id))
      }
      if (current.size === 0) next.delete('columns')
      else next.set('columns', Array.from(current).join(','))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const toggleSampleSizes = useCallback((on: boolean) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (on) {
        next.set('showChartN', '1')
        if (!next.has('showVariableN')) next.set('showVariableN', 'differing')
      } else {
        next.delete('showChartN')
        next.delete('showGroupN')
        next.delete('showVariableN')
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const handleSortChange = useCallback((newSort: string) => {
    if (newSort === 'custom' && sortOrder !== 'custom') {
      const ids = selectedMetrics.map(m => m.id)
      onCustomOrderChange(ids)
    }
    setUrlParam('sort', newSort)
  }, [sortOrder, selectedMetrics, setUrlParam, onCustomOrderChange])

  // Mutual exclusion: opening a dataset collapses Chart Options, and vice versa
  const handleToggleDataset = useCallback((dsId: number) => {
    setExpandedDatasetId(prev => {
      const opening = prev !== dsId
      if (opening) setChartOptionsCollapsed(true)
      return opening ? dsId : null
    })
  }, [])

  // All available groups: union of current response + excluded values (so excluded checkboxes stay visible)
  const allComparisonGroups = useMemo(() => {
    const groups = new Set(comparisonData?.groups ?? [])
    for (const g of excludeGroups) groups.add(g)
    return [...groups].sort()
  }, [comparisonData?.groups, excludeGroups])

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-full bg-mm-surface border-r flex flex-col">
      {/* Section 1: Palette */}
      <div className={`border-b shrink-0 ${materialsOpen ? 'max-h-[200px]' : ''}`}>
        <button
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
          onClick={() => setMaterialsOpen(prev => !prev)}
          aria-expanded={materialsOpen}
        >
          <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!materialsOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
          <SwatchBook className="w-4 h-4 text-mm-text-muted" />
          Materials
          <span className="text-xs text-mm-text-faint ml-auto">{materials.length}</span>
        </button>
        {materialsOpen && (
          <div className="p-2">
            {materials.length === 0 ? (
              <div className="text-xs text-mm-text-faint py-1 px-1">
                Use &ldquo;Add to Materials&rdquo; to save chart configurations
              </div>
            ) : (
              <DndContext sensors={materialSensors} collisionDetection={closestCenter} onDragEnd={handleMaterialsDragEnd}>
                <SortableContext items={materials.map(m => m.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
                    {materials.map(el => (
                      <SortableMaterialRow
                        key={el.id}
                        material={el}
                        isActive={el.id === activeMaterialId}
                        pid={pid}
                        onLoad={onLoadMaterial}
                        onRename={onRenameMaterial}
                        onDelete={onDeleteMaterial}
                        onSendToCanvas={handleSendToCanvas}
                        onSendToNewCanvas={handleSendToNewCanvas}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        )}
      </div>

      {/* Section 2: Metric Type Selector — Descriptives only */}
      {activeTab === 'descriptives' && <div className="px-3 pt-3 pb-2 border-b shrink-0">
        <label className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider mb-1.5 block">
          Metric Type
        </label>
        <Select
          value={metricType}
          onValueChange={v => setUrlParam('metricType', v)}
        >
          {/* #394: role=combobox takes its name from aria-label, not inner text
              (the inner text is the value), so the visible <label> above isn't enough. */}
          <SelectTrigger className="h-7 text-xs" aria-label="Metric type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_TYPE_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>}

      {/* Section 3: Variables (collapsible) — flex-grows when a dataset is expanded */}
      <div className={`flex flex-col border-b ${!questionsCollapsed && expandedDatasetId != null ? 'flex-1 min-h-0' : 'shrink-0'}`}>
        <button
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium text-mm-text transition-colors shrink-0"
          onClick={() => setQuestionsCollapsed(!questionsCollapsed)}
          aria-expanded={!questionsCollapsed}
        >
          <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${questionsCollapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
          <ListChecks className="w-4 h-4 text-mm-text-muted" />
          Variables
        </button>
        {!questionsCollapsed && (
          <ColumnPicker
            projectId={pid}
            mode={pickerMode}
            onModeChange={setPickerMode}
            selectedColumnIds={selectedColumnIds}
            selectedDomainIds={selectedDomainIds}
            onToggleColumn={onToggleColumn}
            onToggleDomain={onToggleDomain}
            onSelectAllDataset={onSelectAllDataset}
            expandedDatasetId={expandedDatasetId}
            onToggleDataset={handleToggleDataset}
            onViewAcrossDatasets={onViewAcrossDatasets}
            onEditColumn={onEditColumn}
            domainsFull={domainsFull}
            metrics={metricsList}
            onCreateScoreMetric={onCreateScoreMetric}
            isCreatingScoreMetric={isCreatingScoreMetric}
            selectedMetricIdHint={selectedMetricIdHint}
            onPickMetric={onPickMetric}
          />
        )}
      </div>

      {/* Section 4: Chart Options — Descriptives only */}
      {activeTab === 'descriptives' && <div className={`flex flex-col ${!chartOptionsCollapsed && hasAnySelection && selectedMetrics.length > 0 ? 'flex-1 min-h-0' : 'shrink-0'}`}>
        <button
          // #394: a real `disabled` button when there's nothing to configure —
          // conveys the inactive state to AT and exempts the faint label from the
          // contrast check (WCAG 1.4.3 exempts inactive components).
          disabled={!(hasAnySelection && selectedMetrics.length > 0)}
          className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg border-b text-sm font-medium transition-colors shrink-0 ${
            hasAnySelection && selectedMetrics.length > 0
              ? 'text-mm-text hover:bg-mm-surface-hover cursor-pointer'
              : 'text-mm-text-faint cursor-default'
          }`}
          onClick={() => {
            if (hasAnySelection && selectedMetrics.length > 0) {
              const opening = chartOptionsCollapsed
              if (opening) setExpandedDatasetId(null) // collapse open dataset
              setChartOptionsCollapsed(!chartOptionsCollapsed)
            }
          }}
          aria-expanded={!chartOptionsCollapsed && hasAnySelection && selectedMetrics.length > 0}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${
            chartOptionsCollapsed || !(hasAnySelection && selectedMetrics.length > 0) ? '-rotate-90' : ''
          } ${hasAnySelection && selectedMetrics.length > 0 ? 'text-mm-text-muted' : 'text-mm-text-faint'}`} aria-hidden="true" />
          <SlidersHorizontal className={`w-4 h-4 ${hasAnySelection && selectedMetrics.length > 0 ? 'text-mm-text-muted' : 'text-mm-text-faint'}`} />
          Chart Options
        </button>
        {!chartOptionsCollapsed && hasAnySelection && selectedMetrics.length > 0 ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ChartOptionsPanel
              chartType={chartType}
              metricType={metricType}
              sortOrder={sortOrder}
              display={display}
              scaling={scaling}
              scaleOrder={scaleOrder}
              groupingColumnId={groupingColumnId}
              excludeValues={excludeValues}
              hiddenResponseOptions={hiddenResponseOptions}
              demographics={analysisColumnsData?.demographics ?? []}
              responseLabels={responseLabels}
              canGroupBy={canGroupBy}
              groupByDisabledReason={groupByDisabledReason}
              relevantDatasetIds={relevantDatasetIds}
              isComputing={isComputing}
              chartTitle={chartTitle}
              chartSubtitle={chartSubtitle}
              chartFootnote={chartFootnote}
              formatting={formatting}
              showCI={showCI}
              showChartN={showChartN}
              showGroupN={showGroupN}
              showVariableN={showVariableN}
              showSampleSizes={showSampleSizes}
              labelMode={labelMode}
              hasShortLabels={hasShortLabels}
              customOrder={customOrder}
              metricLabels={metricLabelsMap}
              onLabelModeChange={onLabelModeChange}
              onCustomOrderChange={onCustomOrderChange}
              onSortChange={handleSortChange}
              onDisplayChange={v => setUrlParam('display', v)}
              onScalingChange={v => setUrlParam('scaling', v)}
              onScaleOrderChange={v => onScaleOrderChange(v)}
              groupingMode={groupingMode}
              datasetGroupingAvailable={groupByAvailability.datasetGroupingAvailable}
              sharedDemographics={sharedDemographics}
              onGroupingChange={(id, mode) => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (mode === 'dataset') {
                    next.delete('groupBy')
                    next.delete('groupBy2')
                    next.set('groupMode', 'dataset')
                  } else if (id) {
                    next.set('groupBy', String(id))
                    next.delete('groupBy2')
                    next.delete('groupMode')
                  } else {
                    next.delete('groupBy')
                    next.delete('groupBy2')
                    next.delete('groupMode')
                  }
                  return next
                }, { replace: true })
              }}
              groupingColumnId2={groupingColumnId2}
              onGrouping2Change={(id) => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (id) next.set('groupBy2', String(id))
                  else next.delete('groupBy2')
                  return next
                }, { replace: true })
              }}
              decompose={decompose}
              canDecompose={canDecompose}
              onDecomposeChange={v => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (v) next.set('decompose', '1')
                  else next.delete('decompose')
                  return next
                }, { replace: true })
              }}
              hiddenGroupValues={hiddenGroupValues}
              availableGroupValues={availableGroupValues}
              onHiddenGroupValuesChange={onHiddenGroupValuesChange}
              groupOrganization={groupOrganization}
              onGroupOrganizationChange={onGroupOrganizationChange}
              onExcludeValuesChange={vals => setUrlParam('exclude', vals.join(','))}
              onHiddenResponseOptionsChange={onHiddenResponseOptionsChange}
              onTitleChange={onTitleChange}
              onSubtitleChange={onSubtitleChange}
              onFootnoteChange={onFootnoteChange}
              onFormattingChange={patch => onFormattingChange(patch)}
              onShowCIChange={v => setUrlParam('showCI', v ? '1' : '')}
              onToggleSampleSizes={toggleSampleSizes}
              onShowChartNChange={v => setUrlParam('showChartN', v ? '1' : '')}
              onShowGroupNChange={v => setUrlParam('showGroupN', v ? '1' : '')}
              onShowVariableNChange={v => setUrlParam('showVariableN', v)}
              proportionMode={proportionMode}
              proportionOperator={proportionOperator}
              proportionThreshold={proportionThreshold}
              proportionValues={proportionValues}
              availableScaleValues={availableScaleValues}
              openDataSectionTrigger={openDataSectionTrigger}
              onProportionConfigChange={onProportionConfigChange}
              divergingMode={divergingMode}
              divergingCenter={divergingCenter}
              divergingCenterAuto={divergingCenterAuto}
              hasMixedScales={hasMixedScales}
              onDivergingModeChange={v => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (v) {
                    next.set('diverging', '1')
                    // Auto-switch to likert5 palette for 5-point scales on default palette
                    if (responseLabels.length === 5 && formatting.colorPalette === 'default') {
                      onFormattingChange({ colorPalette: 'likert5' })
                    }
                  } else {
                    next.delete('diverging')
                    next.delete('divergingCenter')
                  }
                  return next
                }, { replace: true })
              }}
              onDivergingCenterChange={v => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (v) next.set('divergingCenter', v)
                  else next.delete('divergingCenter')
                  return next
                }, { replace: true })
              }}
              showErrorBand={showErrorBand}
              lineStyle={lineStyle}
              lineOverlay={lineOverlay}
              onShowErrorBandChange={onShowErrorBandChange}
              onLineStyleChange={onLineStyleChange}
              onLineOverlayChange={onLineOverlayChange}
              axisTransform={axisTransform}
              onAxisTransformChange={v => setUrlParam('axisTransform', v)}
              crossTabColumnId={crossTabColumnId}
              crossTabDisplay={crossTabDisplay}
              crossTabEligibleColumns={crossTabEligibleColumns}
              onCrossTabColumnChange={id => {
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev)
                  if (id) next.set('crossTabCol', String(id))
                  else {
                    next.delete('crossTabCol')
                    next.delete('crossTabDisplay')
                  }
                  return next
                }, { replace: true })
              }}
              onCrossTabDisplayChange={v => setUrlParam('crossTabDisplay', v)}
            />
          </div>
        ) : !chartOptionsCollapsed && !(hasAnySelection && selectedMetrics.length > 0) ? (
          <div className="px-3 py-3 text-xs text-mm-text-faint italic">
            Select variables to configure
          </div>
        ) : null}
      </div>}

      {/* R&C tab sidebar */}
      {activeTab === 'rc' && (
        <>
          {/* Correlations / Comparisons segmented control */}
          <div className="px-3 py-3 border-b border-mm-border-subtle shrink-0">
            <SegmentedControl
              options={[
                { value: 'correlations', label: 'Correlations' },
                { value: 'comparisons', label: 'Comparisons' },
              ]}
              value={rcView}
              onChange={(v) => setUrlParam('rcView', v)}
              ariaLabel="R&C section"
              idPrefix="rctab"
            />
          </div>

          {/* Correlations accordion */}
          {rcView === 'correlations' && (
            <OptionsAccordion>
              <AccordionSection
                name="data"
                label="Data"
                expanded={rcAccordion.expanded}
                onToggle={rcAccordion.toggle}
                idPrefix="rc-corr"
              >
                {/* Correlation Type */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Correlation Type</div>
                  <div className="flex gap-1.5">
                    {(['pearson', 'spearman'] as const).map(type => (
                      <button
                        key={type}
                        className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                          corrType === type
                            ? 'bg-[hsl(var(--mm-accent)/0.1)] border-[hsl(var(--mm-accent)/0.3)] text-[hsl(var(--mm-accent))]'
                            : 'bg-mm-bg border-mm-surface-border text-mm-text-muted hover:text-mm-text hover:border-mm-text-faint'
                        }`}
                        onClick={() => setUrlParam('corrType', type)}
                      >
                        {type === 'pearson' ? 'Pearson r' : 'Spearman \u03c1'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Significance Levels */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Significance</div>
                  {[
                    { key: '05', label: 'p < .05', stars: '\u2605' },
                    { key: '01', label: 'p < .01', stars: '\u2605\u2605' },
                    { key: '001', label: 'p < .001', stars: '\u2605\u2605\u2605' },
                  ].map(({ key, label, stars }) => {
                    const active = sigLevelsRaw.split(',').includes(key)
                    return (
                      <label key={key} className="flex items-center gap-2 text-xs text-mm-text cursor-pointer">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => {
                            const current = new Set(sigLevelsRaw.split(',').filter(Boolean))
                            if (active) current.delete(key)
                            else current.add(key)
                            setUrlParam('sigLevels', [...current].join(',') || '05')
                          }}
                          className="rounded border-mm-border-medium"
                        />
                        <span>{label}</span>
                        <span className="text-mm-text-faint text-[10px]">({stars})</span>
                      </label>
                    )
                  })}
                  <label className="flex items-center gap-2 text-xs text-mm-text cursor-pointer mt-2 pt-2 border-t border-mm-border-subtle">
                    <input
                      type="checkbox"
                      checked={bonferroniOn}
                      onChange={() => setUrlParam('bonferroni', bonferroniOn ? '' : '1')}
                      className="rounded border-mm-border-medium"
                    />
                    <span>Bonferroni adjustment</span>
                  </label>
                  {bonferroniOn && corrMatrixData?.adjusted_alpha != null && (
                    <div className="text-[10px] text-mm-text-faint ml-6">
                      Adjusted &alpha; = {corrMatrixData.adjusted_alpha.toFixed(4)} for {corrMatrixData.num_comparisons} comparisons
                    </div>
                  )}
                </div>
              </AccordionSection>

              <AccordionSection
                name="appearance"
                label="Appearance"
                expanded={rcAccordion.expanded}
                onToggle={rcAccordion.toggle}
                idPrefix="rc-corr"
              >
                {/* Cell Format */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Cell Format</div>
                  <div className="flex gap-1.5">
                    {([
                      { value: 'r_stars', label: 'r + stars' },
                      { value: 'r_p', label: 'r (p)' },
                      { value: 'r_only', label: 'r only' },
                    ] as const).map(({ value, label }) => (
                      <button
                        key={value}
                        className={`flex-1 px-1.5 py-1 text-[11px] font-medium rounded border transition-colors ${
                          corrCellFormat === value
                            ? 'bg-[hsl(var(--mm-accent)/0.1)] border-[hsl(var(--mm-accent)/0.3)] text-[hsl(var(--mm-accent))]'
                            : 'bg-mm-bg border-mm-surface-border text-mm-text-muted hover:text-mm-text'
                        }`}
                        onClick={() => setUrlParam('cellFormat', value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Matrix Colors */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Matrix Colors</div>
                  <Select
                    value={corrColors}
                    onValueChange={(v) => setUrlParam('corrColors', v === 'diverging_blue_red' ? '' : v)}
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
                </div>

                {/* Scatter Options (only when scatter matrix is visible) */}
                {showScatter && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-mm-text-muted">Scatter Options</div>
                    <label className="flex items-center gap-1.5 text-xs text-mm-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showRegLine}
                        onChange={() => setUrlParam('showRegLine', showRegLine ? '0' : '1')}
                        className="accent-[hsl(var(--mm-accent))]"
                      />
                      Regression line
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-mm-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showJitter}
                        onChange={() => setUrlParam('showJitter', showJitter ? '' : '1')}
                        className="accent-[hsl(var(--mm-accent))]"
                      />
                      Jitter
                    </label>
                  </div>
                )}
              </AccordionSection>
            </OptionsAccordion>
          )}

          {/* Comparisons accordion */}
          {rcView === 'comparisons' && (
            <OptionsAccordion>
              <AccordionSection
                name="data"
                label="Data"
                expanded={rcAccordion.expanded}
                onToggle={rcAccordion.toggle}
                idPrefix="rc-comp"
              >
                {/* Compare By */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Compare By</div>
                  <Select
                    value={compareBy != null ? String(compareBy) : ''}
                    onValueChange={(v) => setUrlParam('compareBy', v)}
                  >
                    <SelectTrigger className="h-7 text-xs border-2 border-[hsl(var(--mm-accent)/0.4)] bg-[hsl(var(--mm-accent)/0.05)]">
                      <SelectValue placeholder="Select a column..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(analysisColumnsData?.demographics ?? []).map(d => (
                        <SelectItem key={d.id} value={String(d.id)}>
                          {d.column_name || d.column_text} ({d.dataset_name})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Secondary grouping */}
                {compareBy && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-mm-text-muted">Secondary Grouping</div>
                    <Select
                      value={compareBy2 != null ? String(compareBy2) : '_none'}
                      onValueChange={(v) => setUrlParam('compareBy2', v === '_none' ? '' : v)}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">None</SelectItem>
                        {(analysisColumnsData?.demographics ?? [])
                          .filter(d => d.id !== compareBy)
                          .map(d => (
                            <SelectItem key={d.id} value={String(d.id)}>
                              {d.column_name || d.column_text} ({d.dataset_name})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Group info display */}
                {compareBy && comparisonData && comparisonData.groups.length > 0 && (
                  <div className="text-[10px] text-mm-text-muted">
                    {comparisonData.groups.map((g, i) => {
                      const totalN = comparisonData.rows[0]?.group_stats.find(s => s.group === g)?.n
                      return (
                        <span key={g}>
                          {i > 0 && ' · '}
                          {g}{totalN != null && ` (n=${totalN})`}
                        </span>
                      )
                    })}
                  </div>
                )}

                {/* Exclude Groups */}
                {compareBy && allComparisonGroups.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-mm-text-muted">Exclude Groups</div>
                    <div className="space-y-1 max-h-[200px] overflow-y-auto">
                      {allComparisonGroups.map(g => {
                        const isExcluded = excludeGroups.includes(g)
                        return (
                          <label key={g} className="flex items-center gap-2 text-xs text-mm-text cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isExcluded}
                              onChange={() => {
                                const next = isExcluded
                                  ? excludeGroups.filter(v => v !== g)
                                  : [...excludeGroups, g]
                                setUrlParam('excludeGroups', next.length > 0 ? next.join(',') : '')
                              }}
                              className="rounded border-mm-border-medium"
                            />
                            <span className={isExcluded ? 'line-through text-mm-text-faint' : ''}>{g}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Test Type */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Test Type</div>
                  {([
                    { value: 'auto', label: 'Auto (t-test / ANOVA)' },
                    { value: 't_test', label: "Welch's t-test" },
                    { value: 'anova', label: 'One-way ANOVA' },
                  ] as const).map(opt => (
                    <label
                      key={opt.value}
                      className={`flex items-center gap-1.5 text-xs cursor-pointer ${nonparametric ? 'text-mm-text-faint cursor-not-allowed' : 'text-mm-text'}`}
                    >
                      <input
                        type="radio"
                        name="testType"
                        value={opt.value}
                        checked={!nonparametric && testType === opt.value}
                        onChange={() => setUrlParam('testType', opt.value)}
                        disabled={nonparametric}
                        className="accent-[hsl(var(--mm-accent))]"
                      />
                      <span title={nonparametric ? 'Disabled when non-parametric is active' : undefined}>{opt.label}</span>
                    </label>
                  ))}
                  <div className="border-t border-mm-border-subtle pt-1.5 mt-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-mm-text cursor-pointer">
                      <input
                        type="checkbox"
                        checked={nonparametric}
                        onChange={() => setUrlParam('nonparametric', nonparametric ? '' : '1')}
                        className="rounded border-mm-border-medium accent-[hsl(var(--mm-accent))]"
                      />
                      Use non-parametric test
                    </label>
                    <div className="text-[10px] text-mm-text-faint mt-0.5 ml-5">For non-normal or ordinal data</div>
                  </div>
                </div>
              </AccordionSection>

              <AccordionSection
                name="appearance"
                label="Appearance"
                expanded={rcAccordion.expanded}
                onToggle={rcAccordion.toggle}
                idPrefix="rc-comp"
              >
                {/* Color Palette */}
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Color Palette</div>
                  <Select
                    value={rcPalette}
                    onValueChange={(v) => setUrlParam('rcPalette', v === 'default' ? '' : v)}
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
                </div>
              </AccordionSection>
              <AccordionSection
                name="annotations"
                label="Annotations"
                expanded={rcAccordion.expanded}
                onToggle={rcAccordion.toggle}
                idPrefix="rc-comp"
              >
                <div className="space-y-1.5">
                  <div className="text-[11px] text-mm-text-muted">Significance</div>
                  {[
                    { key: '05', label: 'p < .05', stars: '\u2605' },
                    { key: '01', label: 'p < .01', stars: '\u2605\u2605' },
                    { key: '001', label: 'p < .001', stars: '\u2605\u2605\u2605' },
                  ].map(({ key, label, stars }) => {
                    const active = sigLevelsRaw.split(',').includes(key)
                    return (
                      <label key={key} className="flex items-center gap-2 text-xs text-mm-text cursor-pointer">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => {
                            const current = new Set(sigLevelsRaw.split(',').filter(Boolean))
                            if (active) current.delete(key)
                            else current.add(key)
                            setUrlParam('sigLevels', [...current].join(',') || '05')
                          }}
                          className="rounded border-mm-border-medium"
                        />
                        <span>{label}</span>
                        <span className="text-mm-text-faint text-[10px]">({stars})</span>
                      </label>
                    )
                  })}
                  <label className="flex items-center gap-2 text-xs text-mm-text cursor-pointer mt-2 pt-2 border-t border-mm-border-subtle">
                    <input
                      type="checkbox"
                      checked={bonferroniOn}
                      onChange={() => setUrlParam('bonferroni', bonferroniOn ? '' : '1')}
                      className="rounded border-mm-border-medium"
                    />
                    <span>Bonferroni adjustment</span>
                  </label>
                </div>
              </AccordionSection>
            </OptionsAccordion>
          )}

          {/* Variable count note */}
          {rcView === 'comparisons' && (
            <div className="px-3 py-2 text-[10px] text-mm-text-faint border-b border-mm-border-subtle">
              {!compareBy
                ? 'Select a demographic to compare groups.'
                : hasComparisonSelection
                  ? `${rcColumnIds.length + rcDomainIds.length} variable${(rcColumnIds.length + rcDomainIds.length) !== 1 ? 's' : ''} selected`
                  : 'Select variables to compare across groups.'}
            </div>
          )}

          {rcView === 'correlations' && (
            <div className="px-3 py-2 text-[10px] text-mm-text-faint border-b border-mm-border-subtle">
              {hasRcSelection
                ? `${rcColumnIds.length + rcDomainIds.length} variables selected`
                : 'Select 2+ variables for correlation matrix.'}
            </div>
          )}
        </>
      )}

      {/* Data Quality tab sidebar */}
      {activeTab === 'data_quality' && (
        <DataQualitySidebar
          dqView={dqView}
          dqIncludeNA={dqIncludeNA}
          dqIncludeEmpty={dqIncludeEmpty}
          dqSort={dqSort}
          dqColumnIds={dqColumnIds}
          dqIsMultiDataset={dqIsMultiDataset}
          dqHasNumericVars={dqHasNumericVars}
          mcarIsPending={mcarIsPending}
          mcarResult={mcarResult}
          mcarError={mcarError}
          onMcarRun={onMcarRun}
          setUrlParam={setUrlParam}
        />
      )}
    </div>
  )
}
