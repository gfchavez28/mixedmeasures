import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings2, Plus, FileInput, GripVertical, Layers, Undo2, Redo2, MessageSquareText, FunctionSquare } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import {
  datasetsApi,
  recodeApi,
  domainsApi,
  crosswalkApi,
  extractApiError,
  type DatasetColumn,
  type DatasetDataResponse,
  type RecodeDefinitionSummary,
  type ManualColumnCreate,
  type ManualColumnUpdate,
  type ComputedColumnCreate,
  type ComputedColumnUpdate,
} from '@/lib/api'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ColumnFormDialog } from '@/components/ColumnFormDialog'
import { SortableColumnHeader, DataRow } from '@/components/DatasetGridComponents'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import { useHistory } from '@/hooks/useHistory'

const EMPTY_DOMAIN_SCORES: import('@/lib/api').DomainScoreColumn[] = []

// ── Memoized grid body (avoids re-rendering rows when dialog state changes) ──

const DataGridBody = memo(function DataGridBody({
  rows, columns, resolvedActiveDefinitions, handleOpenText, pid,
  linkedParticipantMap, handleLink, selectedCell, handleCellSelect,
  editingCell, handleStartEdit, handleCellSave, handleCellCancel,
  handleTabNav, handleEnterNav, handleDeleteRow, domainScoreCols,
}: {
  rows: import('@/lib/api').DatasetDataRow[]
  columns: DatasetColumn[]
  resolvedActiveDefinitions: Record<number, number | null>
  handleOpenText: (title: string, text: string) => void
  pid: number
  linkedParticipantMap: Map<number, string>
  handleLink: (rowId: number, participantId: number | null, participantName: string | null) => void
  selectedCell: { rowId: number; columnId: number } | null
  handleCellSelect: (rowId: number, columnId: number) => void
  editingCell: { rowId: number; columnId: number } | null
  handleStartEdit: (rowId: number, columnId: number) => void
  handleCellSave: (answerId: number, value: string | null) => void
  handleCellCancel: () => void
  handleTabNav: (rowId: number, columnId: number, direction: 'next' | 'prev') => void
  handleEnterNav: (rowId: number, columnId: number) => void
  handleDeleteRow: (rowId: number, recordLabel: string) => void
  domainScoreCols: import('@/lib/api').DomainScoreColumn[]
}) {
  return (
    <tbody>
      {rows.map((row, i) => (
        <DataRow
          key={row.id}
          row={row}
          rowIndex={i}
          columns={columns}
          activeDefinitions={resolvedActiveDefinitions}
          onOpenText={handleOpenText}
          projectId={pid}
          linkedParticipantMap={linkedParticipantMap}
          onLink={handleLink}
          selectedCell={selectedCell}
          onCellSelect={handleCellSelect}
          editingCell={editingCell}
          onStartEdit={handleStartEdit}
          onCellSave={handleCellSave}
          onCellCancel={handleCellCancel}
          onTabNav={handleTabNav}
          onEnterNav={handleEnterNav}
          onDeleteRow={handleDeleteRow}
          domainScoreCols={domainScoreCols}
        />
      ))}
    </tbody>
  )
})

// ── Memoized column headers (avoids re-rendering when cell/dialog state changes) ──

type EditorField = 'name' | 'label' | null

const DataGridHead = memo(function DataGridHead({
  columns, columnDerivedData, sortableIds, activeColumnId, activeField,
  handleSelectDefStable, pid, iid,
  handleEditColumn, handleDeleteColumn, handleTypeChange, handleSubtypeChange,
  handleColumnNameEdit, handleColumnTextEdit,
  handleColumnResizeStart, handleColumnResize, handleColumnResizeEnd, handleColumnResetWidth,
  handleEditComputed, handleDeleteComputed, handleRecompute,
  handleRemoveFromGroup,
  handleToggleParticipantVisibility,
  handleLinkByColumn,
  handlePopoverOpenChange, setActiveField, goNextColumn, goPrevColumn,
}: {
  columns: DatasetColumn[]
  columnDerivedData: Map<number, { activeDef: import('@/lib/api').RecodeDefinitionSummary | null; domainPills: Array<{ domain_id: number; name: string; color: string | null }> | undefined }>
  sortableIds: number[]
  activeColumnId: number | null
  activeField: EditorField
  handleSelectDefStable: (columnId: number, defId: number | null) => void
  pid: number
  iid: number
  handleEditColumn: (column: DatasetColumn) => void
  handleDeleteColumn: (column: DatasetColumn) => void
  handleTypeChange: (columnId: number, newType: string) => void
  handleSubtypeChange: (columnId: number, subtype: string | null) => void
  handleColumnNameEdit: (columnId: number, newName: string) => void
  handleColumnTextEdit: (columnId: number, newText: string) => void
  handleColumnResizeStart: (columnId: number) => void
  handleColumnResize: (columnId: number, delta: number) => void
  handleColumnResizeEnd: (columnId: number) => void
  handleColumnResetWidth: (columnId: number) => void
  handleEditComputed: (column: DatasetColumn) => void
  handleDeleteComputed: (column: DatasetColumn) => void
  handleRecompute: (column: DatasetColumn) => void
  handleRemoveFromGroup: (columnId: number, domainId: number) => void
  handleToggleParticipantVisibility: (column: DatasetColumn) => void
  handleLinkByColumn: (column: DatasetColumn) => void
  handlePopoverOpenChange: (columnId: number, open: boolean) => void
  setActiveField: (field: EditorField) => void
  goNextColumn: (field: EditorField) => void
  goPrevColumn: (field: EditorField) => void
}) {
  return (
    <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
      {columns.map((q, colIdx) => {
        const derived = columnDerivedData.get(q.id)
        return (
          <SortableColumnHeader
            key={q.id}
            column={q}
            activeDef={derived?.activeDef ?? null}
            onSelectDef={handleSelectDefStable}
            projectId={pid}
            datasetId={iid}
            onEditColumn={handleEditColumn}
            onDeleteColumn={handleDeleteColumn}
            onTypeChange={handleTypeChange}
            onSubtypeChange={handleSubtypeChange}
            onColumnNameEdit={handleColumnNameEdit}
            onColumnTextEdit={handleColumnTextEdit}
            onColumnResizeStart={handleColumnResizeStart}
            onColumnResize={handleColumnResize}
            onColumnResizeEnd={handleColumnResizeEnd}
            onColumnResetWidth={handleColumnResetWidth}
            domainPills={derived?.domainPills}
            onRemoveFromGroup={handleRemoveFromGroup}
            onToggleParticipantVisibility={handleToggleParticipantVisibility}
            onEditComputed={handleEditComputed}
            onDeleteComputed={handleDeleteComputed}
            onRecompute={handleRecompute}
            onLinkByColumn={handleLinkByColumn}
            isPopoverOpen={activeColumnId === q.id}
            onPopoverOpenChange={handlePopoverOpenChange}
            activeField={activeColumnId === q.id ? activeField : null}
            onActiveFieldChange={setActiveField}
            onNextColumn={goNextColumn}
            onPrevColumn={goPrevColumn}
            columnIndex={colIdx}
            columnCount={columns.length}
          />
        )
      })}
    </SortableContext>
  )
})

// ── Main component ───────────────────────────────────────────────────────────

export default function DatasetView() {
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>()
  const pid = parseInt(projectId || '0')
  const iid = parseInt(datasetId || '0')
  const queryClient = useQueryClient()
  const { setBreadcrumbLabel } = useProjectLayout()

  const { data, isLoading, error } = useQuery({
    queryKey: ['dataset-data', pid, iid],
    queryFn: () => datasetsApi.getData(pid, iid),
    enabled: !!pid && !!iid,
  })

  // Set breadcrumb label to dataset name
  useEffect(() => {
    if (data?.dataset?.name) setBreadcrumbLabel(data.dataset.name)
  }, [data?.dataset?.name, setBreadcrumbLabel])

  const { data: domainsData } = useQuery({
    queryKey: ['analysis-domains', pid],
    queryFn: () => domainsApi.list(pid),
    enabled: !!pid,
    staleTime: 60_000,
  })

  // Domain aggregate scores for virtual columns
  const { data: domainScoresData } = useQuery({
    queryKey: ['domain-scores', pid, iid],
    queryFn: () => datasetsApi.getDomainScores(pid, iid),
    enabled: !!pid && !!iid,
    staleTime: 60_000,
  })
  const domainScoreCols = domainScoresData?.domain_scores ?? EMPTY_DOMAIN_SCORES

  // Pre-compute domain membership by column ID and equivalence group ID.
  // Phase 4.6: include `domain_id` so ambient pills can navigate into the
  // crosswalk via `?focusDomainId=N`.
  const domainsByColumn = useMemo(() => {
    const map = new Map<number, Array<{ domain_id: number; name: string; color: string | null }>>()
    if (!domainsData?.domains) return map
    for (const domain of domainsData.domains) {
      for (const m of domain.members) {
        if (m.member_type === 'column') {
          if (!map.has(m.member_id)) map.set(m.member_id, [])
          map.get(m.member_id)!.push({
            domain_id: domain.id,
            name: domain.name,
            color: domain.color,
          })
        }
      }
    }
    return map
  }, [domainsData])

  // Domain pills for columns via equivalence group — now covered by direct column membership
  // (the equivalence_group member type is no longer used — members are direct column references)

  // Dialog state for expanded open text
  const [expandedText, setExpandedText] = useState<{ title: string; text: string } | null>(null)

  // Active definition per column (default: primary definition or null)
  const [activeDefinitions, setActiveDefinitions] = useState<Record<number, number | null>>({})

  // Cell selection & editing state
  const [selectedCell, setSelectedCell] = useState<{ rowId: number; columnId: number } | null>(null)
  const [editingCell, setEditingCell] = useState<{ rowId: number; columnId: number } | null>(null)

  // Add Column dialog
  const [addColumnOpen, setAddColumnOpen] = useState(false)
  const [addColumnError, setAddColumnError] = useState<string | null>(null)

  // Edit Column dialog
  const [editColumnTarget, setEditColumnTarget] = useState<DatasetColumn | null>(null)
  const [editColumnError, setEditColumnError] = useState<string | null>(null)

  // Delete Column confirmation
  const [deleteColumnTarget, setDeleteColumnTarget] = useState<DatasetColumn | null>(null)

  // Computed Column dialogs
  const [computedColumnOpen, setComputedColumnOpen] = useState(false)
  const [computedColumnError, setComputedColumnError] = useState<string | null>(null)
  const [editComputedColumn, setEditComputedColumn] = useState<DatasetColumn | null>(null)
  const [editComputedError, setEditComputedError] = useState<string | null>(null)

  // Delete Response confirmation
  const [deleteResponse, setDeleteResponse] = useState<{ id: number; label: string } | null>(null)

  // ── Undo/Redo for column header edits ─────────────────────────────────
  const { execute: executeHistory, undo: historyUndo, redo: historyRedo, canUndo, canRedo } = useHistory()

  const updateHeaderMutation = useMutation({
    mutationFn: ({ columnId, data: headerData }: { columnId: number; data: { column_name?: string | null; column_text?: string | null; show_in_participant_profile?: boolean } }) =>
      datasetsApi.updateColumnHeader(pid, iid, columnId, headerData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
    },
  })

  // #353: toggle whether this column appears in linked-participant profiles.
  // Default state is true; clicking the menu item flips the boolean.
  // Invalidates the participants query so the detail panel reflects
  // the change without a hard refresh.
  const handleToggleParticipantVisibility = useCallback((column: DatasetColumn) => {
    const next = !(column.show_in_participant_profile !== false)  // default true
    updateHeaderMutation.mutate(
      { columnId: column.id, data: { show_in_participant_profile: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['participants', pid] })
          queryClient.invalidateQueries({ queryKey: ['participant-detail'] })
          toast.success(
            next
              ? `"${column.column_text}" will appear in participant profiles`
              : `"${column.column_text}" hidden from participant profiles`,
          )
        },
      },
    )
  }, [updateHeaderMutation, queryClient, pid])

  // #414 (DEC-8): retro bulk-link — run the identifier-column linking over
  // this dataset's unlinked rows. Manual links are never overwritten (the
  // service counts them already_linked).
  const linkByColumnMutation = useMutation({
    mutationFn: (columnId: number) => datasetsApi.linkByColumn(pid, iid, columnId),
    onSuccess: (report) => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['participants', pid] })
      const skipped = report.skipped_missing + report.skipped_duplicate + report.skipped_conflict
      if (report.linked === 0 && skipped === 0) {
        toast.info('All rows are already linked to participants')
      } else if (report.linked === 0) {
        toast.info(`No rows linked — ${skipped} skipped (blank, duplicated, or conflicting IDs)`)
      } else {
        toast.success(
          `${report.linked} ${report.linked === 1 ? 'row' : 'rows'} linked to participants `
          + `(${report.created} new, ${report.matched} matched)`
          + (skipped > 0 ? ` · ${skipped} skipped` : ''),
        )
      }
    },
    onError: (err: unknown) => toast.error(extractApiError(err, 'Failed to link rows to participants')),
  })

  const handleLinkByColumn = useCallback((column: DatasetColumn) => {
    linkByColumnMutation.mutate(column.id)
  }, [linkByColumnMutation])

  const handleColumnNameEdit = useCallback((columnId: number, newName: string) => {
    if (!data) return
    const col = data.columns.find(c => c.id === columnId)
    if (!col) return
    const oldName = col.column_name || ''
    // Optimistic update
    queryClient.setQueryData<DatasetDataResponse>(['dataset-data', pid, iid], old => {
      if (!old) return old
      return { ...old, columns: old.columns.map(c => c.id === columnId ? { ...c, column_name: newName || null } : c) }
    })
    executeHistory({
      type: 'column_name_edit',
      description: `Rename column to "${newName || '(empty)'}"`,
      redo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: newName || null } }) },
      undo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: oldName || null } }) },
    })
  }, [data, pid, iid, queryClient, executeHistory, updateHeaderMutation])

  const handleColumnTextEdit = useCallback((columnId: number, newText: string) => {
    if (!data) return
    const col = data.columns.find(c => c.id === columnId)
    if (!col) return
    const oldText = col.column_text
    // Optimistic update
    queryClient.setQueryData<DatasetDataResponse>(['dataset-data', pid, iid], old => {
      if (!old) return old
      return { ...old, columns: old.columns.map(c => c.id === columnId ? { ...c, column_text: newText } : c) }
    })
    executeHistory({
      type: 'column_text_edit',
      description: `Update column text`,
      redo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: newText } }) },
      undo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: oldText } }) },
    })
  }, [data, pid, iid, queryClient, executeHistory, updateHeaderMutation])

  // ── Column editor popover state ───────────────────────────────────────
  const [activeColumnId, setActiveColumnId] = useState<number | null>(null)
  const [activeField, setActiveField] = useState<'name' | 'label' | null>(null)

  const openColumnEditor = useCallback((columnId: number, field?: 'name' | 'label' | null) => {
    setActiveColumnId(columnId)
    setActiveField(field ?? 'name')
  }, [])

  const closeColumnEditor = useCallback(() => {
    setActiveColumnId(null)
    setActiveField(null)
  }, [])

  const goNextColumn = useCallback((field: 'name' | 'label' | null) => {
    if (!data) return
    const idx = activeColumnId != null ? data.columns.findIndex(c => c.id === activeColumnId) : -1
    if (idx >= 0 && idx + 1 < data.columns.length) {
      setActiveColumnId(data.columns[idx + 1].id)
      setActiveField(field)
    } else {
      closeColumnEditor()
    }
  }, [data, activeColumnId, closeColumnEditor])

  const goPrevColumn = useCallback((field: 'name' | 'label' | null) => {
    if (!data) return
    const idx = activeColumnId != null ? data.columns.findIndex(c => c.id === activeColumnId) : -1
    if (idx > 0) {
      setActiveColumnId(data.columns[idx - 1].id)
      setActiveField(field)
    } else {
      closeColumnEditor()
    }
  }, [data, activeColumnId, closeColumnEditor])

  // Keyboard shortcuts: Ctrl+Z/Y undo/redo, Escape clears selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        if (canUndo) { e.preventDefault(); historyUndo() }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        if (canRedo) { e.preventDefault(); historyRedo() }
      }
      if (e.key === 'Escape' && !editingCell && selectedCell) {
        setSelectedCell(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canUndo, canRedo, historyUndo, historyRedo, editingCell, selectedCell])

  // ── Column widths (localStorage persistence) ───────────────────────────
  const DEFAULT_COL_WIDTH = 120
  const MIN_COL_WIDTH = 60
  const storageKey = `dataset-col-widths-${iid}`

  const [columnWidths, setColumnWidths] = useState<Record<number, number>>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  })

  // Persist widths to localStorage on change
  const columnWidthsRef = useRef(columnWidths)
  useEffect(() => { columnWidthsRef.current = columnWidths }, [columnWidths])
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columnWidths))
    } catch { /* ignore quota errors */ }
  }, [columnWidths, storageKey])

  // Track initial width at mouse-down for delta-based resize
  const resizeStartWidthRef = useRef<number>(0)
  const resizeCurrentWidthRef = useRef<number>(0)
  const resizeColumnIdRef = useRef<number>(0)
  const tableRef = useRef<HTMLTableElement>(null)

  const handleColumnResizeStart = useCallback((columnId: number) => {
    const startWidth = columnWidthsRef.current[columnId] || DEFAULT_COL_WIDTH
    resizeStartWidthRef.current = startWidth
    resizeCurrentWidthRef.current = startWidth
    resizeColumnIdRef.current = columnId
  }, [])

  const handleColumnResize = useCallback((_columnId: number, delta: number) => {
    const newWidth = Math.max(MIN_COL_WIDTH, resizeStartWidthRef.current + delta)
    const prevWidth = resizeCurrentWidthRef.current
    resizeCurrentWidthRef.current = newWidth
    // Update DOM directly — no React state update during drag
    const table = tableRef.current
    if (!table) return
    const qid = resizeColumnIdRef.current
    const col = table.querySelector<HTMLElement>(`col[data-col-id="${qid}"]`)
    if (col) col.style.width = `${newWidth}px`
    // Adjust total table width by the delta from last frame
    const tableWidth = parseInt(table.style.width) || 0
    table.style.width = `${tableWidth + (newWidth - prevWidth)}px`
  }, [])

  const handleColumnResizeEnd = useCallback((columnId: number) => {
    const finalWidth = resizeCurrentWidthRef.current
    setColumnWidths(prev => ({ ...prev, [columnId]: finalWidth }))
  }, [])

  const handleColumnResetWidth = useCallback((columnId: number) => {
    setColumnWidths(prev => {
      const next = { ...prev }
      delete next[columnId]
      return next
    })
  }, [])

  // ── Column drag-and-drop reorder ───────────────────────────────────────
  const [dragActiveId, setDragActiveId] = useState<number | null>(null)

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: number[]) => datasetsApi.reorderColumns(pid, iid, orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
    },
    onError: (err: Error) => {
      toast.error(extractApiError(err, 'Failed to reorder columns'))
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
    },
  })

  // ── Question type change ─────────────────────────────────────────────
  const handleTypeChange = useCallback((columnId: number, newType: string) => {
    recodeApi.bulkTypeUpdate(pid, iid, [columnId], newType).then(() => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
    }).catch((err: unknown) => toast.error(extractApiError(err, 'Failed to change column type')))
  }, [pid, iid, queryClient])

  const handleSubtypeChange = useCallback((columnId: number, subtype: string | null) => {
    datasetsApi.updateColumnSubtype(pid, iid, columnId, subtype).then(() => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
    }).catch((err: unknown) => toast.error(extractApiError(err, 'Failed to change subtype')))
  }, [pid, iid, queryClient])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragActiveId(event.active.id as number)
    closeColumnEditor()
  }, [closeColumnEditor])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDragActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id || !data) return

    const oldIndex = data.columns.findIndex(q => q.id === active.id)
    const newIndex = data.columns.findIndex(q => q.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(data.columns, oldIndex, newIndex)
    const orderedIds = newOrder.map(q => q.id)

    // Optimistic update: reorder columns in cache
    queryClient.setQueryData<DatasetDataResponse>(['dataset-data', pid, iid], old => {
      if (!old) return old
      return { ...old, columns: newOrder }
    })

    reorderMutation.mutate(orderedIds)
  }, [data, pid, iid, queryClient, reorderMutation])

  const dragActiveColumn = useMemo(() => {
    if (!dragActiveId || !data) return null
    return data.columns.find(q => q.id === dragActiveId) || null
  }, [dragActiveId, data])

  // Compute total table width
  const totalTableWidth = useMemo(() => {
    if (!data) return 0
    const fixedCols = 96 + 160 // Record + Participant
    const dataColsWidth = data.columns.reduce(
      (sum, q) => sum + (columnWidths[q.id] || DEFAULT_COL_WIDTH), 0
    )
    return fixedCols + dataColsWidth
  }, [data, columnWidths])

  // Initialize active definitions from data (set each column's primary as default)
  const resolvedActiveDefinitions = useMemo(() => {
    if (!data) return activeDefinitions
    const result: Record<number, number | null> = { ...activeDefinitions }
    for (const q of data.columns) {
      if (!(q.id in result)) {
        const primaryDef = (q.recode_definitions || []).find(d => d.is_primary)
        result[q.id] = primaryDef ? primaryDef.id : null
      }
    }
    return result
  }, [data, activeDefinitions])

  // handleSelectDef is now handleSelectDefStable (stable useCallback, post-data)

  // Manual column indices for tab navigation
  const manualColumnIds = useMemo(() => {
    if (!data) return [] as number[]
    return data.columns.filter(q => q.source === 'manual').map(q => q.id)
  }, [data])

  // Map of participant_id → row_identifier for already-linked responses
  const linkedParticipantMap = useMemo(() => {
    if (!data) return new Map<number, string>()
    const map = new Map<number, string>()
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i]
      if (r.participant_id != null) {
        map.set(r.participant_id, r.row_identifier || `R${i + 1}`)
      }
    }
    return map
  }, [data])

  // Link mutation with optimistic update
  const linkMutation = useMutation({
    mutationFn: ({ rowId, participantId }: { rowId: number; participantId: number | null; participantName: string | null }) =>
      datasetsApi.linkParticipant(pid, iid, rowId, participantId),
    onMutate: async ({ rowId, participantId, participantName }) => {
      await queryClient.cancelQueries({ queryKey: ['dataset-data', pid, iid] })
      const previous = queryClient.getQueryData<DatasetDataResponse>(['dataset-data', pid, iid])
      queryClient.setQueryData<DatasetDataResponse>(['dataset-data', pid, iid], (old) => {
        if (!old) return old
        return {
          ...old,
          rows: old.rows.map(r =>
            r.id === rowId
              ? { ...r, participant_id: participantId, participant_display_name: participantName }
              : r
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['dataset-data', pid, iid], context.previous)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['participants', pid] })
    },
  })

  const handleLink = useCallback((rowId: number, participantId: number | null, participantName: string | null) => {
    linkMutation.mutate({ rowId, participantId, participantName })
  }, [linkMutation])

  // Answer update mutation with optimistic update
  const answerMutation = useMutation({
    mutationFn: ({ answerId, valueText }: { answerId: number; valueText: string | null }) =>
      datasetsApi.updateValue(pid, iid, answerId, { value_text: valueText }),
    onMutate: async ({ answerId, valueText }) => {
      await queryClient.cancelQueries({ queryKey: ['dataset-data', pid, iid] })
      const previous = queryClient.getQueryData<DatasetDataResponse>(['dataset-data', pid, iid])
      queryClient.setQueryData<DatasetDataResponse>(['dataset-data', pid, iid], (old) => {
        if (!old) return old
        return {
          ...old,
          rows: old.rows.map(r => ({
            ...r,
            values: Object.fromEntries(
              Object.entries(r.values).map(([qid, cell]) =>
                cell.id === answerId
                  ? [qid, { ...cell, value_text: valueText }]
                  : [qid, cell]
              )
            ),
          })),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['dataset-data', pid, iid], context.previous)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
    },
  })

  const handleCellSave = useCallback((answerId: number, value: string | null) => {
    answerMutation.mutate({ answerId, valueText: value })
    setEditingCell(null)
  }, [answerMutation])

  const handleCellCancel = useCallback(() => {
    setEditingCell(null)
  }, [])

  const handleCellSelect = useCallback((rowId: number, columnId: number) => {
    setSelectedCell({ rowId, columnId })
  }, [])

  const handleStartEdit = useCallback((rowId: number, columnId: number) => {
    setSelectedCell({ rowId, columnId })
    setEditingCell({ rowId, columnId })
  }, [])

  // Tab navigation: move to next/prev manual column, wrapping at row boundaries
  const handleTabNav = useCallback((rowId: number, columnId: number, direction: 'next' | 'prev') => {
    if (!data || manualColumnIds.length === 0) return
    const currentManualIdx = manualColumnIds.indexOf(columnId)
    if (currentManualIdx === -1) return

    const rowIds = data.rows.map(r => r.id)
    const currentRowIdx = rowIds.indexOf(rowId)
    if (currentRowIdx === -1) return

    if (direction === 'next') {
      if (currentManualIdx < manualColumnIds.length - 1) {
        setEditingCell({ rowId, columnId: manualColumnIds[currentManualIdx + 1] })
      } else if (currentRowIdx < rowIds.length - 1) {
        setEditingCell({ rowId: rowIds[currentRowIdx + 1], columnId: manualColumnIds[0] })
      } else {
        setEditingCell(null)
      }
    } else {
      if (currentManualIdx > 0) {
        setEditingCell({ rowId, columnId: manualColumnIds[currentManualIdx - 1] })
      } else if (currentRowIdx > 0) {
        setEditingCell({ rowId: rowIds[currentRowIdx - 1], columnId: manualColumnIds[manualColumnIds.length - 1] })
      } else {
        setEditingCell(null)
      }
    }
  }, [data, manualColumnIds])

  // Enter navigation: move to cell below (same column, next response)
  const handleEnterNav = useCallback((rowId: number, columnId: number) => {
    if (!data) return
    const rowIds = data.rows.map(r => r.id)
    const currentRowIdx = rowIds.indexOf(rowId)
    if (currentRowIdx === -1 || currentRowIdx >= rowIds.length - 1) {
      setEditingCell(null)
      return
    }
    setEditingCell({ rowId: rowIds[currentRowIdx + 1], columnId })
  }, [data])

  // Create column mutation
  const createColumnMutation = useMutation({
    mutationFn: (data: ManualColumnCreate) => datasetsApi.createManualColumn(pid, iid, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      setAddColumnOpen(false)
      setAddColumnError(null)
      toast.success('Column added')
    },
    onError: (err: Error) => {
      setAddColumnError(extractApiError(err, 'Failed to create column'))
    },
  })

  // Update column mutation
  const updateColumnMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: ManualColumnUpdate }) =>
      datasetsApi.updateManualColumn(pid, iid, columnId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      setEditColumnTarget(null)
      setEditColumnError(null)
      toast.success('Column updated')
    },
    onError: (err: Error) => {
      setEditColumnError(extractApiError(err, 'Failed to update column'))
    },
  })

  // Delete column mutation
  const deleteColumnMutation = useMutation({
    mutationFn: ({ columnId, source }: { columnId: number; source: string }) => {
      if (source === 'computed') return datasetsApi.deleteComputedColumn(pid, iid, columnId)
      return datasetsApi.deleteManualColumn(pid, iid, columnId)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] }),
        queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] }),
      ])
      setDeleteColumnTarget(null)
      toast.success('Column deleted')
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to delete column')),
  })

  const createComputedMut = useMutation({
    mutationFn: (d: ComputedColumnCreate) => datasetsApi.createComputedColumn(pid, iid, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      setComputedColumnOpen(false)
      setComputedColumnError(null)
      toast.success('Computed column added')
    },
    onError: (err: Error) => setComputedColumnError(extractApiError(err, 'Failed to create computed column')),
  })

  const updateComputedMut = useMutation({
    mutationFn: ({ columnId, d }: { columnId: number; d: ComputedColumnUpdate }) =>
      datasetsApi.updateComputedColumn(pid, iid, columnId, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      setEditComputedColumn(null)
      setEditComputedError(null)
      toast.success('Computed column updated')
    },
    onError: (err: Error) => setEditComputedError(extractApiError(err, 'Failed to update computed column')),
  })

  const recomputeMut = useMutation({
    mutationFn: (columnId: number) => datasetsApi.recomputeColumn(pid, iid, columnId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to recompute column')),
  })

  // Phase 4.6: ambient-pill context-menu "Remove from group" wires here.
  // Calls crosswalk move-members with target_mode='strip' to fully unassign
  // the column from the variable group (severs both EG link and domain
  // membership). Same semantics as the crosswalk's "Remove from variable
  // group" cell context-menu. Invalidates the same key set the crosswalk
  // uses so both surfaces stay in sync.
  const removeFromGroupMutation = useMutation({
    mutationFn: ({ columnId, domainId }: { columnId: number; domainId: number }) =>
      crosswalkApi.moveMembers(pid, {
        column_ids: [columnId],
        source_domain_id: domainId,
        target_domain_id: null,
        target_mode: 'strip',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analysis-domains', pid] })
      queryClient.invalidateQueries({ queryKey: ['equivalence-groups', pid] })
      queryClient.invalidateQueries({ queryKey: ['project-columns', pid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      toast.success('Removed from variable group')
    },
    onError: (err: Error) =>
      toast.error(extractApiError(err, 'Failed to remove from group')),
  })

  const handleRemoveFromGroup = useCallback(
    (columnId: number, domainId: number) => {
      removeFromGroupMutation.mutate({ columnId, domainId })
    },
    [removeFromGroupMutation],
  )

  const deleteResponseMutation = useMutation({
    mutationFn: (rowId: number) => datasetsApi.deleteRow(pid, iid, rowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      toast.success('Response deleted')
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to delete row')),
  })

  const handleDeleteRow = useCallback((rowId: number, recordLabel: string) => {
    setDeleteResponse({ id: rowId, label: recordLabel })
  }, [])

  // Destructure data with safe defaults (hooks below must always run)
  const dataset = data?.dataset
  // useMemo'd so the empty-fallback array keeps a stable identity across renders
  // — the three useMemos below depend on `columns` and would otherwise recompute
  // every render while data is undefined.
  const columns = useMemo(() => data?.columns ?? [], [data])
  const rows = data?.rows ?? []

  // ── Pre-compute per-column derived data for stable references ──────────
  const columnDerivedData = useMemo(() => {
    const result = new Map<number, { activeDef: RecodeDefinitionSummary | null; domainPills: Array<{ domain_id: number; name: string; color: string | null }> | undefined }>()
    for (const q of columns) {
      const activeDefId = resolvedActiveDefinitions[q.id]
      const activeDef = activeDefId != null
        ? (q.recode_definitions || []).find(d => d.id === activeDefId) || null
        : null
      const pills = domainsByColumn.get(q.id)
      result.set(q.id, {
        activeDef,
        domainPills: pills && pills.length > 0 ? pills : undefined,
      })
    }
    return result
  }, [columns, resolvedActiveDefinitions, domainsByColumn])

  // Stable sortable IDs for SortableContext (avoids new array each render)
  const sortableIds = useMemo(() => columns.map(q => q.id), [columns])

  // Pre-compute open-text column IDs for toolbar "Code Text" link
  const openTextColumnIds = useMemo(() =>
    columns.filter(c => c.column_type === 'open_text').map(c => c.id),
    [columns]
  )

  // ── Stable callbacks that take column as argument ──────────────────────
  const handleSelectDefStable = useCallback((columnId: number, defId: number | null) => {
    setActiveDefinitions(prev => ({ ...prev, [columnId]: defId }))
  }, [])

  const handleEditColumn = useCallback((q: DatasetColumn) => {
    closeColumnEditor()
    setEditColumnTarget(q)
    setEditColumnError(null)
  }, [closeColumnEditor])

  const handleDeleteColumn = useCallback((q: DatasetColumn) => {
    closeColumnEditor()
    setDeleteColumnTarget(q)
  }, [closeColumnEditor])

  const handleEditComputed = useCallback((q: DatasetColumn) => {
    closeColumnEditor()
    setEditComputedColumn(q)
    setEditComputedError(null)
  }, [closeColumnEditor])

  const handleDeleteComputed = useCallback((q: DatasetColumn) => {
    setDeleteColumnTarget(q)
  }, [])

  const handleRecompute = useCallback((q: DatasetColumn) => {
    recomputeMut.mutate(q.id)
  }, [recomputeMut])

  const handlePopoverOpenChange = useCallback((columnId: number, open: boolean) => {
    if (open) openColumnEditor(columnId)
    else closeColumnEditor()
  }, [openColumnEditor, closeColumnEditor])

  const handleOpenText = useCallback((title: string, text: string) => {
    setExpandedText({ title, text })
  }, [])

  // ── Early returns (after all hooks) ───────────────────────────────────
  if (isLoading) {
    return <div className="p-8 text-center text-mm-text-muted">Loading dataset data...</div>
  }

  if (error || !data || !dataset) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600 mb-3">Failed to load dataset data</p>
        <Link to={`/projects/${pid}/datasets`} className="text-sm text-mm-text-muted hover:text-mm-text underline">
          Back to Datasets
        </Link>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface flex-shrink-0">
        <div className="flex items-center gap-2 text-sm text-mm-text-secondary mr-auto">
          {dataset.source && <span>Source: {dataset.source}</span>}
          <span><strong className="font-mono tabular-nums">{columns.length}</strong> columns</span>
          <span className="text-mm-text-faint">·</span>
          <span><strong className="font-mono tabular-nums">{rows.length}</strong> records</span>
        </div>
        {(canUndo || canRedo) && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => historyUndo()}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => historyRedo()}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
            >
              <Redo2 className="w-4 h-4" />
            </Button>
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          className="text-sm bg-mm-orange/8 text-mm-orange-text border-mm-orange/20 hover:bg-mm-orange/15"
          onClick={() => setAddColumnOpen(true)}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Column
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-sm bg-violet-500/8 text-violet-700 dark:text-violet-300 border-violet-500/20 hover:bg-violet-500/15"
          onClick={() => setComputedColumnOpen(true)}
        >
          <FunctionSquare className="w-4 h-4 mr-1" />
          Add Computed
        </Button>
        <Link to={`/projects/${pid}/datasets/${iid}/append`}>
          <Button variant="outline" size="sm" className="text-sm">
            <FileInput className="w-4 h-4 mr-1" />
            Append Data
          </Button>
        </Link>
        <Link to={`/projects/${pid}/datasets/variable-groups`}>
          <Button variant="outline" size="sm" className="text-sm">
            <Layers className="w-4 h-4 mr-1" />
            Variable Groups
          </Button>
        </Link>
        <Link to={`/projects/${pid}/datasets/${iid}/recode`}>
          <Button variant="outline" size="sm" className="text-sm">
            <Settings2 className="w-4 h-4 mr-1" />
            Recode
          </Button>
        </Link>
        {openTextColumnIds.length > 0 && (
          <Link to={`/projects/${pid}/datasets/text-coding?columns=${openTextColumnIds.join(',')}`}>
            <Button variant="outline" size="sm" className="text-sm">
              <MessageSquareText className="w-4 h-4 mr-1" />
              Code Text
            </Button>
          </Link>
        )}
      </div>

      <div className="flex-1 min-h-0 p-4 flex flex-col">
        {rows.length === 0 ? (
          <div className="text-center py-12 text-mm-text-muted">No rows for this dataset.</div>
        ) : (
          <DndContext
            sensors={dndSensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
          <div className="bg-mm-surface rounded-lg border overflow-auto flex-1 min-h-0">
            <table
              ref={tableRef}
              className="border-collapse"
              style={{ tableLayout: 'fixed', width: totalTableWidth }}
            >
              <colgroup>
                <col style={{ width: 96 }} />
                <col style={{ width: 160 }} />
                {columns.map(q => (
                  <col key={q.id} data-col-id={q.id} style={{ width: columnWidths[q.id] || DEFAULT_COL_WIDTH }} />
                ))}
                {domainScoreCols.map(ds => (
                  <col key={`ds-${ds.domain_id}`} style={{ width: 100 }} />
                ))}
              </colgroup>
              <caption className="sr-only">{dataset.name} — {columns.length} columns{domainScoreCols.length > 0 ? `, ${domainScoreCols.length} domain scores` : ''}, {rows.length} records</caption>
              <thead>
                <tr className="bg-mm-bg border-b">
                  <th
                    className="px-3 py-2 text-left text-xs font-semibold text-mm-text-secondary sticky left-0 top-0 z-30 bg-mm-bg"
                    title="Record ID"
                  >
                    Record
                  </th>
                  <th
                    className="px-3 py-2 text-left text-xs font-semibold text-mm-text-secondary sticky left-[96px] top-0 z-30 bg-mm-bg border-r"
                    title="Linked participant"
                  >
                    Participant
                  </th>
                  <DataGridHead
                    columns={columns}
                    columnDerivedData={columnDerivedData}
                    sortableIds={sortableIds}
                    activeColumnId={activeColumnId}
                    activeField={activeField}
                    handleSelectDefStable={handleSelectDefStable}
                    pid={pid}
                    iid={iid}
                    handleEditColumn={handleEditColumn}
                    handleDeleteColumn={handleDeleteColumn}
                    handleTypeChange={handleTypeChange}
                    handleSubtypeChange={handleSubtypeChange}
                    handleColumnNameEdit={handleColumnNameEdit}
                    handleColumnTextEdit={handleColumnTextEdit}
                    handleColumnResizeStart={handleColumnResizeStart}
                    handleColumnResize={handleColumnResize}
                    handleColumnResizeEnd={handleColumnResizeEnd}
                    handleColumnResetWidth={handleColumnResetWidth}
                    handleEditComputed={handleEditComputed}
                    handleDeleteComputed={handleDeleteComputed}
                    handleRecompute={handleRecompute}
                    handleRemoveFromGroup={handleRemoveFromGroup}
                    handleToggleParticipantVisibility={handleToggleParticipantVisibility}
                    handleLinkByColumn={handleLinkByColumn}
                    handlePopoverOpenChange={handlePopoverOpenChange}
                    setActiveField={setActiveField}
                    goNextColumn={goNextColumn}
                    goPrevColumn={goPrevColumn}
                  />
                  {domainScoreCols.map(ds => (
                    <th
                      key={`ds-${ds.domain_id}`}
                      className="px-2 py-2 text-center text-xs font-medium text-mm-text border-l sticky top-0 z-20 bg-mm-bg"
                      style={{ borderLeftColor: ds.domain_color || undefined, borderLeftWidth: ds.domain_color ? 3 : 1 }}
                      title={
                        ds.is_cross_dataset_subset
                          ? `${ds.domain_name} — ${ds.subset_dataset_name} subset. This domain spans ${ds.member_dataset_count} datasets; values shown here are computed only from this dataset's columns. Open the Analysis View for the full cross-dataset aggregation.`
                          : `Domain score: ${ds.domain_name}`
                      }
                    >
                      <div className="italic text-[10px] text-mm-text-muted leading-tight">
                        {ds.domain_name}
                        {ds.is_cross_dataset_subset && (
                          <span className="not-italic font-medium text-mm-text-faint">
                            {' '}— {ds.subset_dataset_name} subset
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-center gap-1 mt-0.5">
                        <span className="text-[10px] text-mm-text-faint">Score</span>
                        {ds.stale && (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Stale — recompute in Analysis" />
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <DataGridBody
                rows={rows}
                columns={columns}
                resolvedActiveDefinitions={resolvedActiveDefinitions}
                handleOpenText={handleOpenText}
                pid={pid}
                linkedParticipantMap={linkedParticipantMap}
                handleLink={handleLink}
                selectedCell={selectedCell}
                handleCellSelect={handleCellSelect}
                editingCell={editingCell}
                handleStartEdit={handleStartEdit}
                handleCellSave={handleCellSave}
                handleCellCancel={handleCellCancel}
                handleTabNav={handleTabNav}
                handleEnterNav={handleEnterNav}
                handleDeleteRow={handleDeleteRow}
                domainScoreCols={domainScoreCols}
              />
            </table>
          </div>
          {/* Drag overlay for column reorder */}
          <DragOverlay>
            {dragActiveColumn && (
              <div className="bg-mm-surface border rounded-lg shadow-lg px-3 py-2 text-xs font-medium text-mm-text flex items-center gap-2">
                <GripVertical className="w-3 h-3 text-mm-text-faint" />
                <span>{dragActiveColumn.column_name || dragActiveColumn.column_code || (dragActiveColumn.column_text.length > 25 ? dragActiveColumn.column_text.slice(0, 25) + '...' : dragActiveColumn.column_text)}</span>
                <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${TYPE_BADGE_CLASSES[dragActiveColumn.column_type] || 'bg-mm-bg text-mm-text-muted'}`}>
                  {dragActiveColumn.column_type}
                </span>
              </div>
            )}
          </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Status bar */}
      <div
        role="status"
        className="flex items-center gap-3 px-4 py-1.5 border-t bg-mm-surface text-xs text-mm-text-muted flex-shrink-0"
      >
        {activeColumnId ? (() => {
          const col = columns.find(c => c.id === activeColumnId)
          return col ? (
            <>
              <span className="font-medium text-mm-text-secondary">{col.column_name || col.column_code || col.column_text.slice(0, 30)}</span>
              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${TYPE_BADGE_CLASSES[col.column_type] || 'bg-mm-bg text-mm-text-muted'}`}>
                {col.column_type}
              </span>
              <span>Tab/Shift+Tab next/prev column · Enter next field · Esc close</span>
            </>
          ) : null
        })() : selectedCell ? (() => {
          const col = columns.find(c => c.id === selectedCell.columnId)
          return col ? (
            <>
              <span className="font-medium text-mm-text-secondary">{col.column_name || col.column_code}</span>
              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${TYPE_BADGE_CLASSES[col.column_type] || 'bg-mm-bg text-mm-text-muted'}`}>
                {col.column_type}
              </span>
              {col.source === 'manual' && <span>Tab to next cell · Enter to move down · Esc to deselect</span>}
              {col.source !== 'manual' && <span>Esc to deselect</span>}
            </>
          ) : <span>? for shortcuts</span>
        })() : (
          <span>Click a column header or cell to edit · ? for shortcuts</span>
        )}
      </div>

      {/* Expanded text dialog */}
      <Dialog open={!!expandedText} onOpenChange={() => setExpandedText(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{expandedText?.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-mm-text whitespace-pre-wrap">{expandedText?.text}</p>
        </DialogContent>
      </Dialog>

      {/* Add Column dialog */}
      <ColumnFormDialog
        open={addColumnOpen}
        onOpenChange={(o) => { setAddColumnOpen(o); if (!o) setAddColumnError(null) }}
        onSubmit={(data) => createColumnMutation.mutate(data as ManualColumnCreate)}
        isSubmitting={createColumnMutation.isPending}
        submitError={addColumnError}
        title="Add Column"
      />

      {/* Edit Column dialog */}
      <ColumnFormDialog
        open={!!editColumnTarget}
        onOpenChange={(o) => { if (!o) { setEditColumnTarget(null); setEditColumnError(null) } }}
        onSubmit={(data) => {
          if (editColumnTarget) {
            updateColumnMutation.mutate({ columnId: editColumnTarget.id, data: data as ManualColumnUpdate })
          }
        }}
        isSubmitting={updateColumnMutation.isPending}
        submitError={editColumnError}
        initial={editColumnTarget}
        title="Column Details"
      />

      {/* Add Computed Column dialog */}
      <ColumnFormDialog
        open={computedColumnOpen}
        onOpenChange={(o) => { setComputedColumnOpen(o); if (!o) setComputedColumnError(null) }}
        onSubmit={(data) => createComputedMut.mutate(data as ComputedColumnCreate)}
        isSubmitting={createComputedMut.isPending}
        submitError={computedColumnError}
        title="Add Computed Column"
        mode="computed"
        projectId={pid}
        datasetId={iid}
        availableColumns={columns}
      />

      {/* Edit Computed Column dialog */}
      <ColumnFormDialog
        open={!!editComputedColumn}
        onOpenChange={(o) => { if (!o) { setEditComputedColumn(null); setEditComputedError(null) } }}
        onSubmit={(data) => {
          if (editComputedColumn) {
            const oldExpr = editComputedColumn.expression || ''
            const newData = data as ComputedColumnUpdate
            const colId = editComputedColumn.id
            executeHistory({
              type: 'computed_column_update',
              description: `Update formula for ${editComputedColumn.column_text}`,
              redo: async () => { updateComputedMut.mutate({ columnId: colId, d: newData }) },
              undo: async () => { updateComputedMut.mutate({ columnId: colId, d: { expression: oldExpr } }) },
            })
          }
        }}
        isSubmitting={updateComputedMut.isPending}
        submitError={editComputedError}
        initial={editComputedColumn}
        title="Computed Column Details"
        availableColumns={columns}
        mode="computed"
        projectId={pid}
        datasetId={iid}
      />

      {/* Delete Column confirmation */}
      <AlertDialog open={!!deleteColumnTarget} onOpenChange={(o) => { if (!o) setDeleteColumnTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete column?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the column "{deleteColumnTarget?.column_text}" and all
              its cell values across all responses. Any recode definitions on this column will also
              be deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (deleteColumnTarget) {
                  deleteColumnMutation.mutate({ columnId: deleteColumnTarget.id, source: deleteColumnTarget.source })
                }
              }}
            >
              {deleteColumnMutation.isPending ? 'Deleting...' : 'Delete Column'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Response confirmation */}
      <ConfirmDialog
        open={deleteResponse !== null}
        onOpenChange={(open) => { if (!open) setDeleteResponse(null) }}
        title="Delete response?"
        description={`Delete response "${deleteResponse?.label}"? This will remove all their answers. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteResponse) {
            deleteResponseMutation.mutate(deleteResponse.id)
          }
          setDeleteResponse(null)
        }}
        destructive
      />
    </div>
  )
}
