import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Undo2, Redo2, MessageSquareText, RefreshCw, Plus, Table2 } from 'lucide-react'
import { columnDisplayLabel, truncatedColumnLabel } from '@/lib/dataset-column-label'
import AddVariableMenu from '@/components/AddVariableMenu'
import PickRuleToDeriveDialog from '@/components/PickRuleToDeriveDialog'
import DeriveVariableDialog from '@/components/DeriveVariableDialog'
import { useCreateVariable } from '@/hooks/useCreateVariable'
import { useDeriveVariable } from '@/hooks/useDeriveVariable'
import { variableViewPath } from '@/lib/dataset-routes'
import { countLabel, plural } from '@/lib/format'
import './dataset-view.css'
import { revealRecordCell, offsetForRecordNumber } from '@/lib/dataset-record-focus'
import { invalidateRowSetChanged } from '@/lib/dataset-cache'
import { useAddRecord } from '@/hooks/useAddRecord'
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
  DATASET_PAGE_SIZE,
} from '@/lib/api'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ColumnFormDialog } from '@/components/ColumnFormDialog'
import { DeleteVariableDialog } from '@/components/DeleteVariableDialog'
import { useDeleteVariable } from '@/hooks/useDeleteVariable'
import { modeDisabledProps, MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import { SortableColumnHeader, DataRow } from '@/components/DatasetGridComponents'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import {
  describeFreshness,
  describeRefresh,
  isManagedColumn,
} from '@/lib/magnitude-rollup-basis'
import { isManagedDataset, managedDatasetRefusal } from '@/lib/managed-dataset'
import { useHistory } from '@/hooks/useHistory'
import { focusedElementOwnsKey } from '@/lib/keyboard-scope'
import DatasetTabs from '@/components/DatasetTabs'

const EMPTY_DOMAIN_SCORES: import('@/lib/api').DomainScoreColumn[] = []

// ── Memoized grid body (avoids re-rendering rows when dialog state changes) ──

const DataGridBody = memo(function DataGridBody({
  rows, rowOffset, columns, resolvedActiveDefinitions, handleOpenText, pid,
  linkedParticipantMap, handleLink, selectedCell, handleCellSelect,
  editingCell, handleStartEdit, handleCellSave, handleCellCancel,
  handleTabNav, handleEnterNav, handleDeleteRow, deleteRowRefusal, linkRefusal, domainScoreCols,
}: {
  rows: import('@/lib/api').DatasetDataRow[]
  /**
   * The FETCHED page's offset — the record label's fallback is dataset-scoped,
   * never page-scoped (#834 review). `R${i + 1}` over a page restarts at "R1"
   * on every page, so two different records would carry the same label the
   * moment a dataset has no identifier column. Uses the fetched offset, not the
   * requested one, for the same reason the pager label does.
   */
  rowOffset: number
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
  deleteRowRefusal?: string | null
  linkRefusal?: string | null
  domainScoreCols: import('@/lib/api').DomainScoreColumn[]
}) {
  return (
    <tbody>
      {rows.map((row, i) => (
        <DataRow
          key={row.id}
          row={row}
          rowIndex={rowOffset + i}
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
          deleteRowRefusal={deleteRowRefusal}
          linkRefusal={linkRefusal}
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
  handleDeleteColumn, handleTypeChange,
  handleColumnNameEdit, handleColumnTextEdit,
  handleColumnResizeStart, handleColumnResize, handleColumnResizeEnd, handleColumnResetWidth,
  handleRecompute,
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
  handleDeleteColumn: (column: DatasetColumn) => void
  handleTypeChange: (columnId: number, newType: string) => void
  handleColumnNameEdit: (columnId: number, newName: string) => void
  handleColumnTextEdit: (columnId: number, newText: string) => void
  handleColumnResizeStart: (columnId: number) => void
  handleColumnResize: (columnId: number, delta: number) => void
  handleColumnResizeEnd: (columnId: number) => void
  handleColumnResetWidth: (columnId: number) => void
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
            onDeleteColumn={handleDeleteColumn}
            onTypeChange={handleTypeChange}
            onColumnNameEdit={handleColumnNameEdit}
            onColumnTextEdit={handleColumnTextEdit}
            onColumnResizeStart={handleColumnResizeStart}
            onColumnResize={handleColumnResize}
            onColumnResizeEnd={handleColumnResizeEnd}
            onColumnResetWidth={handleColumnResetWidth}
            domainPills={derived?.domainPills}
            onRemoveFromGroup={handleRemoveFromGroup}
            onToggleParticipantVisibility={handleToggleParticipantVisibility}
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
  // The Append item navigates from `onSelect` rather than wrapping a `<Link>`:
  // a menu item IS the interactive element, and nesting an anchor inside one
  // gives the row two roles and two tab targets.
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setBreadcrumbLabel } = useProjectLayout()

  /**
   * #800: the grid reads ONE PAGE. The endpoint used to return every row —
   * 90.1s / 226 MB / ~5.9 GB RSS on a 75,699-row dataset — so a researcher's
   * real dataset imported fine and then could not be opened at all.
   *
   * The offset is part of the query KEY, so each page caches separately and
   * the optimistic patches below (which map over `old.rows`) act on the page
   * actually on screen — which is the page the user just edited.
   */
  const [pageOffset, setPageOffset] = useState(0)
  /**
   * ⚠️ **`setQueryData` / `getQueryData` are EXACT-match; `invalidateQueries` /
   * `cancelQueries` are PREFIX-match.** Adding the offset to the query key means
   * the invalidations below keep working untouched (they match every page), but
   * every optimistic patch and its rollback would silently write to a key
   * nothing reads — the edit would appear to save and then snap back on the next
   * fetch. All of them take this key.
   */
  const dataPageKey = useMemo(
    () => ['dataset-data', pid, iid, pageOffset] as const,
    [pid, iid, pageOffset],
  )

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['dataset-data', pid, iid, pageOffset],
    queryFn: () => datasetsApi.getData(pid, iid, { offset: pageOffset }),
    placeholderData: (prev: DatasetDataResponse | undefined) => prev,
    enabled: !!pid && !!iid,
  })

  /**
   * #834 — deep link to one RECORD: `?row=<rowId>&column=<columnId>`.
   *
   * A universal-search text hit knows a row's primary key; this grid is
   * addressed by page offset. The bridge is `datasetsApi.rowPosition`, and it
   * is a SEPARATE request on purpose (see the endpoint's docstring): letting
   * `/data` resolve the row would make the offset a property of the response,
   * and this component's query key carries the offset (#800) with ten
   * optimistic-patch sites keyed on it.
   *
   * ⚠️ The params are consumed ONCE and then stripped from the URL. Left in
   * place they would re-fire the jump on every later render — so paging away
   * from a deep-linked record would snap straight back to it, and the browser
   * Back button would land on a URL that re-jumps rather than on the page the
   * user was reading.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const focusRowId = searchParams.get('row')
  const focusColumnId = searchParams.get('column')
  /**
   * ⚠️ A REF, not state, and deliberately so: the reveal below is a DOM effect
   * (scroll + a transient class) with no render output, so holding the pending
   * target in state would make the effect call `setState` for a value nothing
   * renders — the cascading-render shape `react-hooks` warns about. The
   * SELECTION it also sets is real state, so that is set at resolve time, in
   * the promise, where it belongs.
   */
  const pendingRevealRef = useRef<{ rowId: number; columnId: number | null } | null>(null)
  /** Which `?row=` has already been claimed — see the run-once guard below. */
  const handledFocusRef = useRef<string | null>(null)
  /** False only after unmount, so a resolve is never cancelled by a re-render. */
  const aliveRef = useRef(true)
  useEffect(() => {
    // ⚠️ Re-arm on MOUNT, not just clear on unmount. `useRef(true)` initialises
    // once for the component's whole life, so under StrictMode's development
    // double-invoke (mount → cleanup → mount) the cleanup left this false
    // permanently and every deep-link resolve was discarded on arrival. Found
    // by driving: the request fired, returned, and did nothing.
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const [jumpValue, setJumpValue] = useState('')



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

  // The three kinds of new variable — dialog state, both create mutations and
  // the invalidation set all live in `useCreateVariable` (#830f), shared with
  // the Variables view. The EDIT half of the computed form lives there too
  // (design note E — the popover thinning).
  // ⚠️ No `onCreated` on either hook: the new column appears in the grid already
  // on screen, so navigating would move the researcher away from what they made.
  const createVariable = useCreateVariable(pid, iid)
  const derive = useDeriveVariable(pid, iid)

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
    queryClient.setQueryData<DatasetDataResponse>(dataPageKey, old => {
      if (!old) return old
      return { ...old, columns: old.columns.map(c => c.id === columnId ? { ...c, column_name: newName || null } : c) }
    })
    executeHistory({
      type: 'column_name_edit',
      description: `Rename column to "${newName || '(empty)'}"`,
      redo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: newName || null } }) },
      undo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: oldName || null } }) },
    })
  }, [data, queryClient, executeHistory, updateHeaderMutation, dataPageKey])

  const handleColumnTextEdit = useCallback((columnId: number, newText: string) => {
    if (!data) return
    const col = data.columns.find(c => c.id === columnId)
    if (!col) return
    const oldText = col.column_text
    // Optimistic update
    queryClient.setQueryData<DatasetDataResponse>(dataPageKey, old => {
      if (!old) return old
      return { ...old, columns: old.columns.map(c => c.id === columnId ? { ...c, column_text: newText } : c) }
    })
    executeHistory({
      type: 'column_text_edit',
      description: `Update column text`,
      redo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: newText } }) },
      undo: async () => { await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: oldText } }) },
    })
  }, [data, queryClient, executeHistory, updateHeaderMutation, dataPageKey])

  // #575's "Swap name ↔ label" moved to the Variables view with the other
  // property forms (design note E — the popover thinning), and the swap
  // arithmetic moved with it, to `components/VariableActions.tsx`.

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

  // Keyboard shortcuts: Ctrl+Z/Y undo/redo, F2/Enter to edit, Escape clears selection
  //
  // 🔴 **F2 and Enter are #927's second half.** The app-wide convention is
  // "inline editing: F2 or double-click" — every other editable surface honours
  // it and this grid implemented NEITHER, so entering edit mode was a mouse
  // click and nothing else. That is what made the open-text branch's viewer a
  // dead end rather than an inconvenience: once the click was spoken for, no
  // key could get in.
  //
  // ⚠️ **This does NOT make the grid keyboard-navigable, and must not be read
  // as doing so.** `selectedCell` is only ever set by a click — the cells carry
  // no tab stop and there is no arrow navigation (unlike the crosswalk grid's
  // roving tabindex, #701b). So this is a mouse-select-then-keyboard-edit path,
  // which is a real improvement and not the whole gap; the gap is filed.
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
      if ((e.key === 'F2' || e.key === 'Enter') && !editingCell && selectedCell) {
        // ⚠️ Enter must stand down for whatever owns it. `focusedElementOwnsKey`
        // is the shared chokepoint (#784): a text field owns every key and a
        // button owns Space/Enter, so this cannot swallow the activation of a
        // focused toolbar control or steal a keystroke from the search box.
        // F2 is claimed unconditionally — nothing else on this page wants it.
        if (e.key === 'Enter' && focusedElementOwnsKey(e.key, document.activeElement)) return
        // Only a cell the researcher may write is editable; the status bar
        // beside this already says so for the other columns.
        //
        // ⚠️ Read off `data` rather than `manualColumnIds`, which is declared
        // 250 lines below this effect — naming it in the dep array would be a
        // temporal-dead-zone ReferenceError at render, not a lint nit.
        const column = data?.columns.find(c => c.id === selectedCell.columnId)
        if (column?.source !== 'manual') return
        e.preventDefault()
        setEditingCell(selectedCell)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canUndo, canRedo, historyUndo, historyRedo, editingCell, selectedCell, data])

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

  /**
   * The second half of the deep link: the requested page has now rendered, so
   * select the cell, scroll it into view and mark it briefly.
   *
   * Runs off `data` rather than off the resolve, because the rows have to EXIST
   * in the DOM before anything can be scrolled to — the same ordering trap
   * #825 records for "Jump to uncoded", where an activedescendant was moved to
   * a row react-virtuoso had never rendered.
   */
  useEffect(() => {
    if (focusRowId == null) return
    const key = `${focusRowId}:${focusColumnId ?? ''}`
    // 🔴 RUN-ONCE GUARD, and it is load-bearing — found by driving, not by any
    // test. Stripping the params below CHANGES `focusRowId`, which re-runs this
    // effect. The first draft cancelled the in-flight resolve from the effect's
    // own cleanup (`return () => { cancelled = true }`), so the effect cancelled
    // ITSELF ~30ms before its own response arrived and the jump was silently
    // dropped on every deep link. It looked correct on a 48-row dataset purely
    // because a single-page grid already had the row on screen.
    if (handledFocusRef.current === key) return
    handledFocusRef.current = key

    const rowId = Number(focusRowId)
    const columnId = focusColumnId == null ? null : Number(focusColumnId)
    // Strip once claimed, so a failed resolve cannot leave a param that retries
    // forever and the Back button lands on a page rather than on a re-jump.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('row')
      next.delete('column')
      return next
    }, { replace: true })
    if (!Number.isFinite(rowId)) return

    datasetsApi.rowPosition(pid, iid, rowId, DATASET_PAGE_SIZE)
      .then(pos => {
        // ⚠️ Guarded on UNMOUNT only (`aliveRef`), never on an effect re-run —
        // that distinction is the whole bug above.
        if (!aliveRef.current) return
        const col = Number.isFinite(columnId as number) ? columnId : null
        setPageOffset(pos.offset)
        if (col != null) setSelectedCell({ rowId, columnId: col })
        pendingRevealRef.current = { rowId, columnId: col }
      })
      .catch(() => {
        if (!aliveRef.current) return
        // A row that is not in THIS dataset 404s. Say so rather than leaving the
        // grid silently parked on page 1 as though nothing had been asked.
        toast.error('That record is no longer in this dataset.')
      })
  }, [focusRowId, focusColumnId, pid, iid, setSearchParams])

  useEffect(() => {
    const pending = pendingRevealRef.current
    if (!pending || !data || !tableRef.current) return
    const cleanup = revealRecordCell(tableRef.current, pending.rowId, pending.columnId)
    // Not found means the requested page has not rendered yet — keep the ref
    // armed so the next `data` change retries, rather than dropping the jump.
    if (!cleanup) return
    pendingRevealRef.current = null
    return cleanup
  }, [data])

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

  // The demographic-subtype edit moved to the Variables view (design note E).

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
    queryClient.setQueryData<DatasetDataResponse>(dataPageKey, old => {
      if (!old) return old
      return { ...old, columns: newOrder }
    })

    reorderMutation.mutate(orderedIds)
  }, [data, queryClient, reorderMutation, dataPageKey])

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
  /**
   * #800: DATASET-scoped, from the server — NOT derived from the loaded page.
   *
   * This map is what stops the picker offering a participant who is already
   * linked to another record (`DatasetGridComponents.tsx` greys them out and
   * names the record). Built from `data.rows` it only ever saw the current
   * page, so on a paginated dataset it would offer a participant linked on
   * page 7 — refused by `uq_dataset_rows_dataset_participant`, so a 409 rather
   * than corruption, but an offer the UI should never make. The payload is
   * bounded by the number of LINKED participants, not by row count.
   */
  const linkedParticipantMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const [pidStr, identifier] of Object.entries(data?.linked_participants ?? {})) {
      map.set(Number(pidStr), identifier)
    }
    return map
  }, [data])

  // Link mutation with optimistic update
  const linkMutation = useMutation({
    mutationFn: ({ rowId, participantId }: { rowId: number; participantId: number | null; participantName: string | null }) =>
      datasetsApi.linkParticipant(pid, iid, rowId, participantId),
    onMutate: async ({ rowId, participantId, participantName }) => {
      await queryClient.cancelQueries({ queryKey: ['dataset-data', pid, iid] })
      const previous = queryClient.getQueryData<DatasetDataResponse>(dataPageKey)
      queryClient.setQueryData<DatasetDataResponse>(dataPageKey, (old) => {
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
    // #556d: the per-mutation onError REPLACES the global default, so without a
    // toast here a failed link (e.g. the row was linked from another tab since
    // load → 409) rolled the cell back in silence — after the #532 flow had
    // already told the user "linked". Mirrors linkByColumnMutation's onError.
    onError: (err: unknown, vars, context) => {
      if (context?.previous) queryClient.setQueryData(dataPageKey, context.previous)
      toast.error(extractApiError(
        err,
        vars.participantId == null
          ? 'Failed to unlink participant'
          : 'Failed to link participant',
      ))
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
      const previous = queryClient.getQueryData<DatasetDataResponse>(dataPageKey)
      queryClient.setQueryData<DatasetDataResponse>(dataPageKey, (old) => {
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
      if (context?.previous) queryClient.setQueryData(dataPageKey, context.previous)
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
  // Deleting a variable: the confirm, the endpoint choice and the invalidation
  // set all live in `useDeleteVariable` (#812), shared with the Variables view.
  // The Data view passes no `onDeleted` — the column simply leaves the grid the
  // researcher is already looking at.
  const deleteVariable = useDeleteVariable(pid, iid)

  const refreshParticipantsMut = useMutation({
    mutationFn: () => datasetsApi.refreshParticipantsDataset(pid),
    onSuccess: (report) => {
      // Row 45's Decision 4 obliges the rollup to SAY what it excluded, and a
      // disclosure that reaches no surface discharges nothing — so the counts
      // ride the toast rather than being dropped on the floor.
      // ⚠️ PREFIX-match, so this covers every page offset in the key (#800).
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, iid] })
      queryClient.invalidateQueries({ queryKey: ['datasets', pid] })
      queryClient.invalidateQueries({ queryKey: ['project-columns', pid] })
      toast.success(describeRefresh(report))
    },
    onError: (err: Error) => toast.error(
      extractApiError(err, 'Could not refresh the participant table'),
    ),
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

  /**
   * Row 47 — add one empty record, through the shared hook.
   *
   * 🔴 **This surface's `onAdded` moves the PAGE and reveals the row**, because
   * a new record sorts LAST: on a 500-record dataset it lands on page 3 while
   * the grid is showing page 1, and "Record added" with nothing visible is the
   * state that reads as broken.
   *
   * ⚠️ It reuses the SEARCH DEEP LINK's reveal machinery rather than a second
   * scroll path — `setPageOffset` then `pendingRevealRef`, whose effect retries
   * until the requested page has actually rendered (#825: the row must EXIST in
   * the DOM before anything can scroll to it).
   *
   * ⚠️ No `rowPosition` round trip, unlike the deep link, which knows only a
   * primary key: the create already returned the position from the same
   * `row_position()` helper.
   */
  const { addRecord, isAdding } = useAddRecord(pid, iid, (created) => {
    setPageOffset(created.offset)
    pendingRevealRef.current = { rowId: created.row_id, columnId: null }
  })

  const deleteResponseMutation = useMutation({
    mutationFn: (rowId: number) => datasetsApi.deleteRow(pid, iid, rowId),
    onSuccess: () => {
      // Row 47 — the SHARED row-set helper. This invalidated `dataset-data`
      // alone, so after deleting a record the Datasets list kept its old
      // "Records" count and the Text Coding picker kept its old `N/M responded`
      // rate for the 60s staleTime (#830(d) made that a ROW count). Extracting
      // the helper for add-record is what surfaced it — #733's rule that a copy
      // propagates the original's defect verbatim, caught on the way in.
      invalidateRowSetChanged(queryClient, pid, iid)
      // #940 — the surface says "record"; a hand-authored table of departments
      // has no respondent and no answers.
      toast.success('Record deleted')
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to delete row')),
  })

  // Row 45 (i) — on a tool-maintained table the row set is DERIVED, so the
  // server 409s this. Refusing HERE, with the server's own words, is what stops
  // the confirm dialog promising a deletion the request then declines (#812's
  // defect). Not hidden: the sentence names the Participants page, which is
  // where the record actually goes away.
  const deleteRowRefusal = managedDatasetRefusal(data?.dataset, 'deleteRow')

  const handleDeleteRow = useCallback((rowId: number, recordLabel: string) => {
    if (deleteRowRefusal) {
      toast.info(deleteRowRefusal)
      return
    }
    setDeleteResponse({ id: rowId, label: recordLabel })
  }, [deleteRowRefusal])

  // Destructure data with safe defaults (hooks below must always run)
  const dataset = data?.dataset
  // useMemo'd so the empty-fallback array keeps a stable identity across renders
  // — the three useMemos below depend on `columns` and would otherwise recompute
  // every render while data is undefined.
  const columns = useMemo(() => data?.columns ?? [], [data])
  /**
   * #941 — was anything IMPORTED into this table?
   *
   * The question a new variable's default TYPE turns on. A survey dataset is
   * full of Likert items, so Ordinal is the right default there; a hand-authored
   * reference table (row 47: "sites, cohorts or departments") and the participant
   * table are nominal or open text, and neither ever holds an imported column.
   * Reading the column set rather than `dataset.source` keeps it true for a table
   * that was authored by hand and later appended to from a file.
   */
  const hasImportedColumns = useMemo(
    () => columns.some(c => c.source === 'imported'),
    [columns],
  )
  const rows = data?.rows ?? []
  // #800: `rows` is ONE PAGE. Anything user-facing that counts records reads
  // this instead — they were the same number until the endpoint was paginated.
  const totalRows = data?.total_rows ?? 0
  const pageSize = data?.limit ?? DATASET_PAGE_SIZE
  /**
   * #835(b): the label describes the page that is ON SCREEN, so it reads the
   * FETCHED offset — never `pageOffset`, the local state.
   *
   * `placeholderData` keeps the previous page's rows rendered while the next
   * one loads, so a label derived from local state flipped to the new range
   * ~0.2s (prod) / ~1.3s (dev) before those records existed on screen — and
   * this element is `role="status" aria-live="polite"`, so a screen reader was
   * TOLD the new range while the old rows were still displayed.
   */
  const shownOffset = data?.offset ?? pageOffset
  const pageStart = totalRows === 0 ? 0 : shownOffset + 1
  const pageEnd = Math.min(shownOffset + rows.length, totalRows)
  const hasPaging = totalRows > pageSize

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

  // Row 45 (i) — null on an ordinary dataset AND on a participant table that
  // has never been computed; the two are different states and the second shows
  // an empty table rather than a stale claim.
  const freshness = useMemo(
    () => (isManagedDataset(dataset) && dataset ? describeFreshness(dataset) : null),
    [dataset],
  )

  // Pre-compute open-text column IDs for toolbar "Code Text" link.
  // ⚠️ `columns` is the FULL column list even though `rows` is a page (#800),
  // so this is never a partial answer — the link cannot silently omit a text
  // variable that happened to fall outside the visible rows.
  const openTextColumnIds = useMemo(() =>
    columns.filter(c => c.column_type === 'open_text').map(c => c.id),
    [columns]
  )
  const hasOpenText = openTextColumnIds.length > 0

  // ── Stable callbacks that take column as argument ──────────────────────
  const handleSelectDefStable = useCallback((columnId: number, defId: number | null) => {
    setActiveDefinitions(prev => ({ ...prev, [columnId]: defId }))
  }, [])

  // One handler for both kinds — the endpoint choice lives in
  // `useDeleteVariable` (#812). `handleDeleteComputed` was an identical twin
  // that differed only by not closing the popover, which it never needed to.
  const handleDeleteColumn = useCallback((q: DatasetColumn) => {
    closeColumnEditor()
    deleteVariable.request(q)
  }, [closeColumnEditor, deleteVariable])

  // Row 45 (i) step 4 — TWO kinds of stale column, TWO verbs, one handler.
  //
  // 🔴 A score column is refreshed at the DATASET, never per column: the rollup
  // is ONE project-wide scan producing every participant's every score at once,
  // so routing it through `recomputeColumn` would re-run that whole scan per
  // rated code — and `recompute_column` 403s anything that is not
  // `source="computed"` anyway, so an unrouted item would simply fail. Same
  // shape as #812's delete: one control, two endpoints, ONE predicate deciding.
  const handleRecompute = useCallback((q: DatasetColumn) => {
    if (isManagedColumn(q)) refreshParticipantsMut.mutate()
    else recomputeMut.mutate(q.id)
  }, [recomputeMut, refreshParticipantsMut])

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
    /**
     * #800: "Failed to load dataset data" told the researcher nothing, and for
     * the case that produced it — a dataset too large for this endpoint — it
     * read as data loss when the data was intact and imported.
     *
     * 🔴 **CORRECTED 2026-08-23: this copy was stale the day after it shipped.**
     * It said "the spreadsheet view still loads every row at once", which #800
     * fixed in the same session that wrote it — the endpoint is paginated now
     * (MEASURED: 90.1s / 226 MB / ~5.9 GB before, 0.24s / 0.60 MB / 96 MB
     * after). So the sentence asserted a cause that no longer exists, which is
     * #797's defect — a diagnosis the code has not established — reintroduced
     * by the fix that obsoleted it.
     *
     * A timeout here is now an ORDINARY failure (a slow disk, a backend
     * restart), so say only what is known: the request did not finish, and the
     * data is not implicated. ⚠️ Do not re-add a size explanation without
     * re-measuring; the page size is bounded and no longer scales with the
     * dataset.
     */
    const aborted =
      error != null &&
      (((error as { name?: string }).name === 'TimeoutError') ||
       ((error as { name?: string }).name === 'AbortError'))
    return (
      <div className="p-8 text-center max-w-xl mx-auto">
        <p className="text-red-600 mb-3">
          {aborted ? 'This dataset took too long to load' : 'Failed to load dataset data'}
        </p>
        {aborted && (
          <p className="text-sm text-mm-text-muted mb-3">
            Nothing is wrong with your data — the import finished and the dataset is
            stored. The request timed out before this page could show it. Try again,
            or open the Variables view, which reads the dataset a variable at a time.
          </p>
        )}
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
        <DatasetTabs projectId={pid} datasetId={iid} variableCount={columns.length} />
        <div className="w-px h-4 bg-mm-border" aria-hidden="true" />
        <div className="flex items-center gap-2 text-sm text-mm-text-secondary mr-auto">
          {dataset.source && <span>Source: {dataset.source}</span>}
          {/* The variable count rides the Variables tab now — repeating it here
              was the same number twice in one band. `total_rows` is the DATASET
              (#800): `rows` is only the page. */}
          {/* #939 — `plural` exists (`lib/format.ts`) and BOTH sites here
              hand-rolled it: the caption below got it right, this one read
              "1 records". Row 47 made a one-record table the routine state, so
              it is the first thing a researcher sees after adding their first. */}
          <span><strong className="font-mono tabular-nums">{totalRows.toLocaleString()}</strong> {plural(totalRows, 'record', 'records')}</span>
          {/* 🔴 Row 45 (i) — THE HONEST HALF OF THE FRESHNESS PAIR. The table
              states WHEN it was computed, always, and never that it is up to
              date: MEASURED, eight input classes move a rating score and no
              enumeration of write sites covers them all, so a "current" badge
              would be a lie the first time a trigger was missed. `managed_stale`
              only ever ADDS a warning; its absence adds nothing.

              ⚠️ The refresh is a `<Button>` with a real name, not an icon — this
              is the verb that makes the snapshot move, and #559's rule is that a
              tooltip is not a name. */}
          {freshness && (
            <span className="flex items-center gap-1.5">
              <span className="w-px h-3 bg-mm-border" aria-hidden="true" />
              {/* ⚠️ The dot is DECORATIVE and the state is in the TEXT. Two
                  reasons, and the second is the one that decided it: a bare
                  `role="img"` badge trips the fail-closed scan in
                  `ChartFigure.test.tsx` (role="img" makes children
                  presentational), and colour-plus-a-dot is a WCAG 1.4.1
                  use-of-colour problem regardless — so the words carry it for
                  everyone rather than a shape carrying it for some. */}
              {freshness.stale && (
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"
                />
              )}
              <span className={freshness.stale ? 'text-amber-600 dark:text-amber-400' : undefined}>
                {freshness.label}
                {freshness.stale && ' · out of date'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => refreshParticipantsMut.mutate()}
                disabled={refreshParticipantsMut.isPending}
                aria-label="Refresh the participant scores from the current coding"
              >
                <RefreshCw
                  className={`w-3 h-3 ${refreshParticipantsMut.isPending ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {/* #830a's pattern, and it is REQUIRED here rather than tidy:
                    MEASURED at the 640x360 CSS viewport a 1280x720 window has
                    at 200% zoom, the full-width button put this row at 663px
                    against a 625px container whose ancestor is
                    `overflow-hidden` — i.e. CLIPPED, not scrollable (WCAG
                    1.4.4). Collapsing the word to `sr-only` brings it to 617px.
                    The button keeps its own `aria-label`, so nothing is lost to
                    a reader. */}
                <span className="sr-only lg:not-sr-only lg:ml-1">Refresh</span>
              </Button>
            </span>
          )}
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
        {/* ── Decision F: the two axes of a table, in one control ──────────
            This row was six buttons across FOUR unrelated axes with no
            separators: two created a variable, one added records, one went to
            a project-scoped page that is not about this dataset at all, one
            opened the Variables view, and one jumped to a different workspace.

            `Add ▾` groups by AXIS, which is jamovi's own shape and the thing
            two differently-tinted sibling buttons cannot say: creating a
            variable and appending records are two kinds of one act, and they
            are not the same kind as each other.

            ⚠️ The menu itself moved to `components/AddVariableMenu` on
            2026-08-31 (#830f) so the Variables view can render the SAME
            control — including the group headings' `aria-labelledby` wiring,
            which is the part a second copy loses. Its docstring carries the
            reasoning that used to live here. */}
        <AddVariableMenu
          onAddVariable={() => createVariable.open('manual')}
          onAddComputed={() => createVariable.open('computed')}
          onAddRecoded={() => createVariable.open('recoded')}
          onAppendRecords={() => navigate(`/projects/${pid}/datasets/${iid}/append`)}
          appendRefusal={managedDatasetRefusal(dataset, 'append')}
          onAddRecord={addRecord}
          addRecordRefusal={managedDatasetRefusal(dataset, 'addRow')}
        />

        {/* "Variable Groups" LEFT this toolbar: its route carries no
            `:datasetId` (it is project-scoped, and equivalence groups span
            datasets), so it never belonged to this dataset's action row. It is
            reachable from seven other places, TopRail's Datasets menu included
            — checked before removing, because a removal with no other entry
            point is a deletion.

            The old "Recode" button also lived here and went in slab 1: the tab
            strip at the head of this same band now goes to the Variables view.

            What is left is one control for this dataset's own two axes, and —
            after a separator, because it is a jump to a DIFFERENT workspace
            rather than an action on this table — Code Text. */}
        {/* 🔴 PRESENT-BUT-DISABLED, not absent (2026-08-24).
            This whole block used to render only when the dataset had an
            open-text variable — so on a survey of coded questions the capability
            simply was not there, and nothing said it existed or what would bring
            it back. That is the finding Stage 3 already made about the third
            variable kind: **a feature that is not enumerated where its siblings
            are is, for discovery purposes, absent.**

            It takes the persistent-MODE arm of `mode-disabled.ts` (#754): the
            state is one the researcher can CHANGE, and the remedy — set a
            variable's type to open text — is named in the disabled control's own
            accessible name, because the place to do it is the Variables view and
            nothing else on this screen would say so.

            ⚠️ The click guard is the load-bearing half: `aria-disabled` changes
            what a control ANNOUNCES and nothing about what it DOES.

            ⚠️ `Button asChild` and NOT `<Link><Button>`, which is what this was:
            an anchor wrapping a button is nested interactive content and two tab
            stops for one control. The enabled arm now renders ONE anchor styled
            as a button; the disabled arm renders a real `<button>`, because
            there is nowhere for it to link to. */}
        <div className="w-px h-4 bg-mm-border" aria-hidden="true" />
        {hasOpenText ? (
          <Button asChild variant="outline" size="sm" className="text-sm">
            <Link
              to={`/projects/${pid}/datasets/text-coding?columns=${openTextColumnIds.join(',')}`}
              aria-label="Code text"
            >
              <MessageSquareText className="w-4 h-4 mr-1" aria-hidden="true" />
              Code Text
            </Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className={`text-sm ${MODE_DISABLED_CLASS}`}
            title="No open-text variables in this dataset. Set a variable's type to open text in the Variables view to code its text."
            {...modeDisabledProps<HTMLButtonElement>({
              label: 'Code text',
              blockedReason:
                'unavailable because no variable in this dataset has the open text type; '
                + 'set one in the Variables view',
              onActivate: () => {},
            })}
          >
            <MessageSquareText className="w-4 h-4 mr-1" aria-hidden="true" />
            Code Text
          </Button>
        )}
      </div>

      {/* #930(a) — `min-h-0` GRANTS the collapse; an overflow on the SAME child
          is what makes it safe (#894's pairing rule, on the vertical axis).
          MEASURED at 640×360 before the fix: this region is 238px tall and its
          content 294px, `overflow-y: visible`, and the ancestor clips — so the
          empty-state panel ran to y=387 in a 360px viewport with the *Add record*
          button's last 7px behind the status bar and NOTHING scrolling.
          ⚠️ `overflow-hidden` is refuted for this (#894): it would delete the
          buttons from view and an overflow metric would call that fixed. */}
      <div className="flex-1 min-h-0 p-4 flex flex-col overflow-y-auto">
        {/* 🔴 Row 47 — THE GRID RENDERS WHETHER OR NOT THERE ARE ROWS.
            This was `rows.length === 0 ? "No rows for this dataset." : <grid>`,
            with the headers, the colgroup, the caption AND the pager all inside
            the else. So a table you had just created showed one grey sentence:
            you could add a variable and not SEE it, and there was nowhere to
            type. That made "author a dataset by hand" land on a dead end, which
            is why this is a prerequisite for the feature rather than polish.

            Two states now, and they answer different questions. With no
            variables AND no records there is nothing to render a grid OF, so
            the panel below names the two next steps — the empty state IS the
            feature for a brand-new table, exactly as `PickRuleToDeriveDialog`'s
            is. With at least one of the two, the grid renders and says what it
            is missing IN the table, where the answer will appear.

            ⚠️ The pager needs no guard: it already gates on
            `hasPaging = totalRows > pageSize`. */}
        {columns.length === 0 && totalRows === 0 ? (
          <div className="rounded-lg border border-mm-surface-border bg-mm-surface p-12 text-center">
            <Table2 className="w-8 h-8 mx-auto mb-4 text-mm-text-faint" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-mm-text mb-2">This table is empty</h2>
            <p className="text-sm text-mm-text-muted mb-6 max-w-md mx-auto">
              Add a variable for each thing you want to record, then add a record
              for each case. Both live in the <strong>Add</strong> menu above.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => createVariable.open('manual')}>
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                Add variable
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={addRecord}
                disabled={isAdding}
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                Add record
              </Button>
            </div>
          </div>
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
              {/* HTML requires `<caption>` to be the table's FIRST child — it
                  sat after `<colgroup>`, the only one of the app's caption
                  sites that did. Browsers recover, and a screen reader read it
                  fine, but the spec order is what other consumers rely on. */}
              {/* #909: pluralised — a hand-authored table is the first with one
                  column or one record, and the caption read "1 columns, 1 records". */}
              <caption className="sr-only">{dataset.name} — {countLabel(columns.length, 'column', 'columns')}{domainScoreCols.length > 0 ? `, ${countLabel(domainScoreCols.length, 'domain score', 'domain scores')}` : ''}, {countLabel(totalRows, 'record', 'records')}</caption>
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
              <thead>
                <tr className="bg-mm-bg border-b">
                  {/* #772 — `scope="col"` on all four header sites: these two,
                    * the per-column header in `DatasetGridComponents.tsx`, and
                    * the domain-score headers below. Four sites, two files —
                    * add one to a new header or it silently heads nothing. */}
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-semibold text-mm-text-secondary sticky left-0 top-0 z-30 bg-mm-bg"
                    title="Record ID"
                  >
                    Record
                  </th>
                  <th
                    scope="col"
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
                    handleDeleteColumn={handleDeleteColumn}
                    handleTypeChange={handleTypeChange}
                    handleColumnNameEdit={handleColumnNameEdit}
                    handleColumnTextEdit={handleColumnTextEdit}
                    handleColumnResizeStart={handleColumnResizeStart}
                    handleColumnResize={handleColumnResize}
                    handleColumnResizeEnd={handleColumnResizeEnd}
                    handleColumnResetWidth={handleColumnResetWidth}
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
                      scope="col"
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
              {/* An empty table still shows its headers — the researcher needs
                  to see the variables they have made. A second `<tbody>` is
                  valid HTML and keeps `DataGridBody` a pure row renderer. */}
              {rows.length === 0 && (
                <tbody>
                  <tr>
                    <td
                      colSpan={2 + columns.length + domainScoreCols.length}
                      className="px-3 py-10 text-center text-sm text-mm-text-muted"
                    >
                      No records yet — use <strong>Add ▾ → Add record</strong> to
                      create the first one.
                    </td>
                  </tr>
                </tbody>
              )}
              <DataGridBody
                rowOffset={shownOffset}
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
                deleteRowRefusal={deleteRowRefusal}
                linkRefusal={managedDatasetRefusal(dataset, 'linkParticipants')}
                domainScoreCols={domainScoreCols}
              />
            </table>
          </div>
          {/* #800: the pager. Shown only when there is more than one page, so a
              120-row dataset looks exactly as it did before this change. */}
          {hasPaging && (
            <nav
              className="flex items-center justify-between gap-3 mt-2 flex-shrink-0"
              aria-label="Record pages"
            >
              <p className="text-xs text-mm-text-muted" role="status" aria-live="polite">
                Records <strong className="font-mono tabular-nums">{pageStart.toLocaleString()}</strong>
                {'\u2013'}
                <strong className="font-mono tabular-nums">{pageEnd.toLocaleString()}</strong>
                {' of '}
                <strong className="font-mono tabular-nums">{totalRows.toLocaleString()}</strong>
              </p>
              <div className="flex items-center gap-2">
                {/* #835: reaching record 10,000 was 50 clicks of Next.
                  *
                  * A `<form>` so Enter submits natively \u2014 the control is
                  * useless if it needs a mouse to reach a button. The label is
                  * `sr-only` rather than `hidden`, because `hidden` removes it
                  * from the accessibility tree and leaves the input nameless
                  * (#717/#718); the placeholder is NOT a name.
                  *
                  * \u26a0\ufe0f No server round trip: a record NUMBER is an ordinal and
                  * its page is division (`offsetForRecordNumber`). Only the
                  * search deep link needs the resolver, because it knows a
                  * primary key instead. */}
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const target = offsetForRecordNumber(Number(jumpValue), pageSize, totalRows)
                    if (target == null) {
                      toast.error(`Enter a record number between 1 and ${totalRows.toLocaleString()}.`)
                      return
                    }
                    setPageOffset(target)
                    setJumpValue('')
                  }}
                >
                  <label htmlFor="dataset-jump-record" className="sr-only">
                    Go to record number
                  </label>
                  <input
                    id="dataset-jump-record"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={jumpValue}
                    onChange={(e) => setJumpValue(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="Go to #"
                    className="w-[88px] h-8 text-xs px-2 rounded-md border border-mm-border bg-mm-surface focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <Button type="submit" variant="outline" size="sm" disabled={jumpValue === '' || isFetching}>
                    Go
                  </Button>
                </form>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPageOffset(o => Math.max(0, o - pageSize))}
                  disabled={pageOffset === 0 || isFetching}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPageOffset(o => (o + pageSize < totalRows ? o + pageSize : o))}
                  disabled={pageEnd >= totalRows || isFetching}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
          {/* Drag overlay for column reorder */}
          <DragOverlay>
            {dragActiveColumn && (
              <div className="bg-mm-surface border rounded-lg shadow-lg px-3 py-2 text-xs font-medium text-mm-text flex items-center gap-2">
                <GripVertical className="w-3 h-3 text-mm-text-faint" />
                <span>{truncatedColumnLabel(dragActiveColumn, 25)}</span>
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
              <span className="font-medium text-mm-text-secondary">{truncatedColumnLabel(col, 30)}</span>
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
              <span className="font-medium text-mm-text-secondary">{truncatedColumnLabel(col, 30)}</span>
              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${TYPE_BADGE_CLASSES[col.column_type] || 'bg-mm-bg text-mm-text-muted'}`}>
                {col.column_type}
              </span>
              {/* ⚠️ These hints describe the SELECTED-not-editing state, and the
                  manual one used to describe edit mode instead: `Tab to next
                  cell · Enter to move down` are `EditableCell`'s own editor
                  keys, so with a cell merely selected neither did anything.
                  Since #927 `Enter`/`F2` open the editor from here, which is
                  what this now says; the editor's own hints are unchanged. */}
              {col.source === 'manual' && <span>Enter or F2 to edit · Esc to deselect</span>}
              {col.source !== 'manual' && <span>Esc to deselect</span>}
            </>
          ) : <span>? for shortcuts</span>
        })() : (
          /* #930(b) — the hint follows the state, as the empty panel's own copy
             already does. On a brand-new table there is no column header and no
             cell, so this named two things that are not on screen. */
          columns.length === 0 && totalRows === 0 ? (
            <span>Add a variable and a record to start · ? for shortcuts</span>
          ) : (
          <span>Click a column header or cell to edit · ? for shortcuts</span>
          )
        )}
      </div>

      {/* Expanded text dialog */}
      <Dialog open={!!expandedText} onOpenChange={() => setExpandedText(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{expandedText?.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-mm-text whitespace-pre-wrap">{expandedText?.text}</p>
        </DialogContent>
      </Dialog>

      {/* Decision B Stage 3 — the third kind of new variable. Two dialogs in
          sequence: pick the variable + rule, then the shared derive confirm.
          ⚠️ `onCreated` is deliberately NOT wired here: the new column appears
          in the grid the researcher is already looking at, whereas the Variables
          view navigates because it would otherwise leave them on the source. */}
      <PickRuleToDeriveDialog
        open={createVariable.isRecodedPickerOpen}
        columns={columns}
        variablesHref={variableViewPath(pid, iid)}
        onOpenChange={(o) => { if (!o) createVariable.close() }}
        onPick={(columnId, definition) => {
          createVariable.close()
          void derive.open({ columnId, definition })
        }}
      />
      <DeriveVariableDialog
        {...derive.dialogProps}
        sourceLabel={(() => {
          const src = columns.find(c => c.id === derive.sourceColumnId)
          return src ? columnDisplayLabel(src) : 'the source variable'
        })()}
      />

      {/* The Edit Column and Edit Computed Column dialogs moved to the
          Variables view with their entry points (design note E). The ADD
          dialogs stay on both views: creating a variable is a dataset-level
          act, and both tabs of the workspace offer it (#830f). */}
      {/* #941 — Ordinal is right for a survey and wrong for the reference tables
          row 47 built ("sites, cohorts or departments", says the dialog one step
          earlier). The signal is whether anything was IMPORTED here: a
          hand-authored table never has an imported column, and neither does the
          participant table. */}
      <ColumnFormDialog
        {...createVariable.manualDialogProps}
        title="Add Variable"
        defaultColumnType={hasImportedColumns ? 'ordinal' : 'nominal'}
      />
      <ColumnFormDialog
        {...createVariable.computedDialogProps}
        title="Add Computed Variable"
        mode="computed"
        projectId={pid}
        datasetId={iid}
        availableColumns={columns}
      />

      {/* Delete variable confirmation — the SAME dialog the Variables view
          renders, from the same hook (#812). */}
      <DeleteVariableDialog {...deleteVariable.dialogProps} />

      {/* Delete Response confirmation */}
      <ConfirmDialog
        open={deleteResponse !== null}
        onOpenChange={(open) => { if (!open) setDeleteResponse(null) }}
        title="Delete record?"
        description={`Delete record "${deleteResponse?.label}"? Every value in it is deleted with it. This cannot be undone.`}
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
