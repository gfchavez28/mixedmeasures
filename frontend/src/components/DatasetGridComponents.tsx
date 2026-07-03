import { useState, useMemo, useCallback, memo } from 'react'
import { useListKeyboardNav } from '@/hooks/useListKeyboardNav'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Link2, X, Pencil, Trash2, Settings2, GripVertical, FunctionSquare, RefreshCw, Check } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import {
  participantsApi,
  type DatasetColumn,
  type DatasetDataRow,
  type RecodeDefinitionSummary,
  type Participant,
  type DomainScoreColumn,
} from '@/lib/api'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import EditableCell from '@/components/EditableCell'
import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import { ColumnEditorPopover, type EditorField } from '@/components/ColumnEditorPopover'
import { formatFocusRow } from '@/components/crosswalk/navigation'

// ── Resize handle ────────────────────────────────────────────────────────────

export function ResizeHandle({
  onResizeStart,
  onResize,
  onResizeEnd,
  onDoubleClick,
}: {
  onResizeStart: () => void
  onResize: (delta: number) => void
  onResizeEnd: () => void
  onDoubleClick: () => void
}) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    onResizeStart()

    const onMouseMove = (ev: MouseEvent) => {
      onResize(ev.clientX - startX)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeEnd()
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [onResizeStart, onResize, onResizeEnd])

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick() }}
      className="absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize hover:bg-mm-blue/40 transition-colors z-10"
      style={{ touchAction: 'none' }}
    />
  )
}

// ── Column header content (display-only) ────────────────────────────────────

export function ColumnHeaderContent({
  column,
  activeDef,
  domainPills,
  projectId,
  onRemoveFromGroup,
}: {
  column: DatasetColumn
  activeDef: RecodeDefinitionSummary | null
  /** Phase 4.6: domain_id added so pill clicks can navigate to the crosswalk
   * with `?focusDomainId=N`. Right-click menu offers "View in crosswalk"
   * + "Remove from group" (destructive). */
  domainPills?: Array<{ domain_id: number; name: string; color: string | null }>
  /** Phase 4.6: required for crosswalk navigation. When omitted, pills
   * render non-interactively (legacy display-only mode). */
  projectId?: number
  /** Phase 4.6: handler for "Remove from group" — calls
   * crosswalkApi.moveMembers with target_mode='strip' for this column.
   * Lifted to the parent so DatasetView can wire the mutation + cache
   * invalidation in one place. */
  onRemoveFromGroup?: (columnId: number, domainId: number) => void
}) {
  const navigate = useNavigate()
  const hasName = !!column.column_name
  const textDisplay = column.column_text.length > 40
    ? column.column_text.slice(0, 40) + '\u2026'
    : column.column_text
  const badgeClass = TYPE_BADGE_CLASSES[column.column_type] || 'bg-mm-bg text-mm-text-muted'
  const isManual = column.source === 'manual'
  const isComputed = column.source === 'computed'
  const groupLabel = column.group_label || column.group_code

  return (
    <div className="flex flex-col items-center gap-0.5 w-full">
      {/* Row 0: Group label (if present) */}
      {groupLabel && (
        <span
          className="text-[9px] font-medium truncate max-w-full px-1 rounded"
          style={{
            backgroundColor: `hsl(${Math.abs([...groupLabel].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % 360}, 35%, 92%)`,
            color: `hsl(${Math.abs([...groupLabel].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % 360}, 30%, 40%)`,
          }}
          title={groupLabel}
        >
          {groupLabel}
        </span>
      )}
      {/* Row 1: Column short name — hidden when unset (#527: a full header row of
          italic "name" placeholders on every fresh import read as a rendering bug;
          the short name is added via the header editor, which keeps its own hint). */}
      {hasName && (
        <span
          className="text-xs truncate max-w-full rounded px-1 py-0.5 font-medium text-mm-text"
          title={column.column_name!}
        >
          {column.column_name}
        </span>
      )}
      {/* Row 2: Question text */}
      <span
        className="text-[11px] text-mm-text-secondary truncate max-w-full rounded px-0.5"
        title={column.column_text}
      >
        {textDisplay}
      </span>
      {/* Row 3: Type badge + icons */}
      <div className="flex items-center justify-center gap-1 px-1 py-0.5">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${badgeClass}`}
          title={column.column_type === 'demographic' && column.demographic_subtype
            ? `Demographic \u00b7 ${column.demographic_subtype.charAt(0).toUpperCase() + column.demographic_subtype.slice(1)}`
            : column.column_type}
        >
          {column.column_type === 'demographic' && column.demographic_subtype
            ? column.demographic_subtype.charAt(0).toUpperCase() + column.demographic_subtype.slice(1)
            : column.column_type}
          {column.column_type === 'demographic' && !column.demographic_subtype && (
            <span className="ml-0.5 text-amber-500">?</span>
          )}
        </span>
        {isManual && (
          <span title="Manual column"><Pencil className="w-3 h-3 text-mm-text-faint" /></span>
        )}
        {isComputed && (
          <span title={column.expression || 'Computed column'} className="flex items-center gap-0.5">
            <FunctionSquare className="w-3 h-3 text-violet-500" />
            {column.stale && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Stale — recompute" />
            )}
          </span>
        )}
        {column.equivalence_group_id && (
          projectId != null ? (
            // Phase 4.6: clickable Link2 — navigate to the crosswalk EG row.
            // Tagged-form URL `?focusRow=eg:N` (Phase 4.9 wires the parser;
            // until then this falls through to navigation that silently
            // no-ops, mirroring today's broken-since-Path-A behavior).
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                navigate(
                  `/projects/${projectId}/datasets/variable-groups?focusRow=${formatFocusRow('eg', column.equivalence_group_id!)}`,
                )
              }}
              title={`${column.equivalence_group_label || 'Linked'} — open in crosswalk`}
              aria-label={`Open ${column.equivalence_group_label || 'equivalence row'} in crosswalk`}
              className="inline-flex items-center text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded"
            >
              <Link2 className="w-3 h-3" />
            </button>
          ) : (
            <span title={column.equivalence_group_label || 'Linked'}>
              <Link2 className="w-3 h-3 text-indigo-400" />
            </span>
          )
        )}
        {activeDef && (
          <Settings2 className="w-3 h-3 text-mm-blue" />
        )}
      </div>
      {domainPills && domainPills.length > 0 && (
        <div className="flex flex-wrap justify-center gap-0.5 mt-0.5">
          {domainPills.map((d) => {
            const pillContent = (
              <span
                className="inline-block px-1 py-0 rounded text-[9px] font-medium text-white truncate max-w-[80px]"
                style={{ backgroundColor: d.color || '#6b7280' }}
                title={d.name}
              >
                {d.name}
              </span>
            )
            // Phase 4.6: clickable pill navigates to the crosswalk bracket.
            // Right-click → context menu with View / Remove. When projectId
            // isn't supplied (legacy display-only callers), render the
            // static pill exactly as before.
            if (projectId == null) {
              return <span key={`${d.domain_id}-static`}>{pillContent}</span>
            }
            return (
              <ContextMenu key={d.domain_id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(
                        `/projects/${projectId}/datasets/variable-groups?focusDomainId=${d.domain_id}`,
                      )
                    }}
                    aria-label={`Open variable group "${d.name}" in crosswalk — right-click for more options`}
                    className="inline-flex rounded focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
                  >
                    {pillContent}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() =>
                      navigate(
                        `/projects/${projectId}/datasets/variable-groups?focusDomainId=${d.domain_id}`,
                      )
                    }
                  >
                    View in crosswalk
                  </ContextMenuItem>
                  {onRemoveFromGroup && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => onRemoveFromGroup(column.id, d.domain_id)}
                        className="text-red-600 focus:text-red-600"
                      >
                        Remove from "{d.name}"
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sortable column header (wraps content with drag handle + popover + resize) ──

export const SortableColumnHeader = memo(function SortableColumnHeader({
  column,
  activeDef,
  onSelectDef,
  projectId,
  datasetId,
  onEditColumn,
  onDeleteColumn,
  onTypeChange,
  onSubtypeChange,
  onColumnNameEdit,
  onColumnTextEdit,
  onColumnResizeStart,
  onColumnResize,
  onColumnResizeEnd,
  onColumnResetWidth,
  domainPills,
  onRemoveFromGroup,
  onToggleParticipantVisibility,
  onEditComputed,
  onDeleteComputed,
  onRecompute,
  isPopoverOpen,
  onPopoverOpenChange,
  activeField,
  onActiveFieldChange,
  onNextColumn,
  onPrevColumn,
  columnIndex,
  columnCount,
}: {
  column: DatasetColumn
  activeDef: RecodeDefinitionSummary | null
  onSelectDef: (columnId: number, defId: number | null) => void
  projectId: number
  datasetId: number
  onEditColumn: (column: DatasetColumn) => void
  onDeleteColumn: (column: DatasetColumn) => void
  onTypeChange: (columnId: number, newType: string) => void
  onSubtypeChange: (columnId: number, subtype: string | null) => void
  onColumnNameEdit: (columnId: number, newName: string) => void
  onColumnTextEdit: (columnId: number, newText: string) => void
  onColumnResizeStart: (columnId: number) => void
  onColumnResize: (columnId: number, delta: number) => void
  onColumnResizeEnd: (columnId: number) => void
  onColumnResetWidth: (columnId: number) => void
  domainPills?: Array<{ domain_id: number; name: string; color: string | null }>
  /** Phase 4.6: lifted from DatasetView so the ContextMenu inside
   * ColumnHeaderContent can fire the strip mutation without DatasetView
   * having to know about the menu's internals. */
  onRemoveFromGroup?: (columnId: number, domainId: number) => void
  /** #353: toggle whether this column surfaces in linked-participant
   * profile panels. DatasetView owns the mutation + query invalidation;
   * this menu item just dispatches. */
  onToggleParticipantVisibility?: (column: DatasetColumn) => void
  onEditComputed?: (column: DatasetColumn) => void
  onDeleteComputed?: (column: DatasetColumn) => void
  onRecompute?: (column: DatasetColumn) => void
  isPopoverOpen: boolean
  onPopoverOpenChange: (columnId: number, open: boolean) => void
  activeField: EditorField
  onActiveFieldChange: (field: EditorField) => void
  onNextColumn: (field: EditorField) => void
  onPrevColumn: (field: EditorField) => void
  columnIndex: number
  columnCount: number
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: column.id })
  const navigate = useNavigate()

  const handleResizeStart = useCallback(() => {
    onColumnResizeStart(column.id)
  }, [column.id, onColumnResizeStart])

  const handleResize = useCallback((delta: number) => {
    onColumnResize(column.id, delta)
  }, [column.id, onColumnResize])

  const handleResizeEnd = useCallback(() => {
    onColumnResizeEnd(column.id)
  }, [column.id, onColumnResizeEnd])

  // Adapt stable parent callbacks to popover's per-column signatures
  const handleSelectDef = useCallback((defId: number | null) => {
    onSelectDef(column.id, defId)
  }, [column.id, onSelectDef])

  const handleOpenChange = useCallback((open: boolean) => {
    onPopoverOpenChange(column.id, open)
  }, [column.id, onPopoverOpenChange])

  const handleDelete = useCallback((q: DatasetColumn) => {
    if (q.source === 'computed' && onDeleteComputed) onDeleteComputed(q)
    else onDeleteColumn(q)
  }, [onDeleteColumn, onDeleteComputed])

  const handleResetWidth = useCallback(() => {
    onColumnResetWidth(column.id)
  }, [column.id, onColumnResetWidth])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <th
          ref={setNodeRef}
          className="px-3 py-2 text-center text-xs font-medium text-mm-text border-l sticky top-0 z-20 bg-mm-bg group/col"
          style={{ opacity: isDragging ? 0.4 : 1 }}
        >
          <ColumnEditorPopover
            column={column}
            open={isPopoverOpen && !isDragging}
            onOpenChange={handleOpenChange}
            activeField={activeField}
            onActiveFieldChange={onActiveFieldChange}
            onColumnNameEdit={onColumnNameEdit}
            onColumnTextEdit={onColumnTextEdit}
            onTypeChange={onTypeChange}
            onSubtypeChange={onSubtypeChange}
            onSelectDef={handleSelectDef}
            activeDef={activeDef}
            onNextColumn={onNextColumn}
            onPrevColumn={onPrevColumn}
            onOpenDetails={onEditColumn}
            onDeleteColumn={handleDelete}
            onEditComputed={onEditComputed}
            onRecompute={onRecompute}
            projectId={projectId}
            datasetId={datasetId}
            columnIndex={columnIndex}
            columnCount={columnCount}
          >
            <div className="cursor-pointer">
              {/* Drag handle — visible on hover */}
              <div
                {...attributes}
                {...listeners}
                onClick={(e) => e.stopPropagation()}
                className="absolute left-0 top-0 bottom-0 w-4 flex items-center justify-center opacity-0 group-hover/col:opacity-100 cursor-grab active:cursor-grabbing z-10"
                title="Drag to reorder"
              >
                <GripVertical className="w-3 h-3 text-mm-text-faint" />
              </div>
              <ColumnHeaderContent
                column={column}
                activeDef={activeDef}
                domainPills={domainPills}
                projectId={projectId}
                onRemoveFromGroup={onRemoveFromGroup}
              />
            </div>
          </ColumnEditorPopover>
          <ResizeHandle
            onResizeStart={handleResizeStart}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
            onDoubleClick={handleResetWidth}
          />
        </th>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {(column.source === 'manual' || column.source === 'imported') && (
          <ContextMenuItem onClick={() => onEditColumn(column)}>
            <Settings2 className="w-4 h-4 mr-2" />
            Column details...
          </ContextMenuItem>
        )}
        {column.source === 'computed' && onEditComputed && (
          <ContextMenuItem onClick={() => onEditComputed(column)}>
            <FunctionSquare className="w-4 h-4 mr-2" />
            Edit formula...
          </ContextMenuItem>
        )}
        {column.source === 'computed' && column.stale && onRecompute && (
          <ContextMenuItem onClick={() => onRecompute(column)}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Recompute
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigate(`/projects/${projectId}/datasets/${datasetId}/recode?column=${column.id}`)}>
          <Settings2 className="w-4 h-4 mr-2" />
          Edit in Recode Workbench
        </ContextMenuItem>
        {/* #353: toggle this column in linked-participant profile panels.
          * Default true; clicking flips. SKIP and OPEN_TEXT are excluded
          * from the participant panel regardless of this flag — no point
          * showing the toggle for them. */}
        {onToggleParticipantVisibility && column.column_type !== 'open_text' && column.column_type !== 'skip' && (
          <ContextMenuItem
            onClick={() => onToggleParticipantVisibility(column)}
            title="When this column's row is linked to a participant, the value shows in their profile panel."
          >
            {column.show_in_participant_profile === false ? (
              <>
                <Check className="w-4 h-4 mr-2 opacity-0" />
                Show in participant profile
              </>
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                Show in participant profile
              </>
            )}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            if (column.source === 'computed' && onDeleteComputed) onDeleteComputed(column)
            else onDeleteColumn(column)
          }}
          className="text-red-600"
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Delete column
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

// ── Participant cell with link popover ───────────────────────────────────────

export function ParticipantCell({
  row,
  projectId,
  linkedParticipantMap,
  onLink,
}: {
  row: DatasetDataRow
  projectId: number
  linkedParticipantMap: Map<number, string>
  onLink: (rowId: number, participantId: number | null, participantName: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { data: participantsData } = useQuery({
    queryKey: ['participants', projectId],
    queryFn: () => participantsApi.list(projectId),
    enabled: open,
  })

  const participants = useMemo(() => participantsData?.participants ?? [], [participantsData?.participants])

  const filtered = useMemo(() => {
    if (!search.trim()) return participants
    const term = search.trim().toLowerCase()
    return participants.filter(p => {
      const name = (p.display_name || p.identifier).toLowerCase()
      const role = (p.role || '').toLowerCase()
      return name.includes(term) || role.includes(term) || p.identifier.toLowerCase().includes(term)
    })
  }, [participants, search])

  const isLinked = row.participant_id != null

  const handleSelect = (participant: Participant) => {
    const name = participant.display_name || participant.identifier
    onLink(row.id, participant.id, name)
    setOpen(false)
    setSearch('')
  }

  const { focusedIndex, getItemProps, listProps } = useListKeyboardNav({
    itemCount: filtered.length,
    onSelect: (i) => {
      const p = filtered[i]
      if (p && !linkedParticipantMap.has(p.id) || p?.id === row.participant_id) handleSelect(p)
    },
    enabled: open,
  })

  const handleUnlink = (e: React.MouseEvent) => {
    e.stopPropagation()
    onLink(row.id, null, null)
  }

  return (
    <td className="px-3 py-2 text-sm whitespace-nowrap sticky left-[96px] z-10 bg-mm-surface group-hover:bg-mm-surface-hover border-r w-[160px] min-w-[160px]">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
        <PopoverTrigger asChild>
          {isLinked ? (
            <div className="relative group/cell cursor-pointer">
              <span className="text-sm font-medium text-mm-text hover:text-mm-blue-text">
                {row.participant_display_name}
              </span>
              <button
                onClick={handleUnlink}
                aria-label="Unlink participant"
                className="absolute -right-1 top-1/2 -translate-y-1/2 hidden group-hover/cell:flex items-center justify-center w-4 h-4 rounded-full bg-muted hover:bg-red-100 text-mm-text-muted hover:text-red-600"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button className="flex items-center gap-1 text-sm text-mm-text-faint hover:text-mm-blue-text">
              <Link2 className="w-3 h-3" />
              <span>Link...</span>
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <div className="p-2 border-b">
            <Input
              placeholder="Search participants..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={listProps.onKeyDown}
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          {isLinked && (
            <div className="px-3 py-2 border-b bg-mm-bg">
              <div className="flex items-center justify-between">
                <span className="text-xs text-mm-text-muted">
                  Current: <span className="font-medium text-mm-text">{row.participant_display_name}</span>
                </span>
                <button
                  onClick={(e) => { handleUnlink(e); setOpen(false) }}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove link
                </button>
              </div>
            </div>
          )}

          <div ref={listProps.ref} className="max-h-[240px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-mm-text-faint">No participants found</div>
            ) : (
              filtered.map((p, i) => {
                const name = p.display_name || p.identifier
                const alreadyLinkedTo = linkedParticipantMap.get(p.id)
                const isCurrentRow = p.id === row.participant_id
                const isDisabled = !!alreadyLinkedTo && !isCurrentRow
                const itemProps = getItemProps(i)

                return (
                  <button
                    key={p.id}
                    onClick={() => !isDisabled && handleSelect(p)}
                    disabled={isDisabled}
                    data-focused={itemProps['data-focused']}
                    onMouseEnter={itemProps.onMouseEnter}
                    className={`w-full text-left px-3 py-2 text-sm border-b last:border-b-0 ${
                      isCurrentRow
                        ? 'bg-mm-blue/12 text-mm-blue-text'
                        : isDisabled
                          ? 'opacity-50 cursor-not-allowed bg-mm-bg'
                          : focusedIndex === i
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-mm-surface-hover'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{name}</span>
                      {p.role && <span className="text-xs text-mm-text-faint">{p.role}</span>}
                    </div>
                    {p.linked_speakers.length > 0 && (
                      <div className="text-[11px] text-mm-text-faint">
                        {p.linked_speakers.length} conversation{p.linked_speakers.length !== 1 ? 's' : ''}
                      </div>
                    )}
                    {isDisabled && alreadyLinkedTo && (
                      <div className="text-[11px] text-amber-600">Already linked to {alreadyLinkedTo}</div>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </td>
  )
}

// ── Data row ─────────────────────────────────────────────────────────────────

export const DataRow = memo(function DataRow({
  row,
  rowIndex,
  columns,
  activeDefinitions,
  onOpenText,
  projectId,
  linkedParticipantMap,
  onLink,
  selectedCell,
  onCellSelect,
  editingCell,
  onStartEdit,
  onCellSave,
  onCellCancel,
  onTabNav,
  onEnterNav,
  onDeleteRow,
  domainScoreCols,
}: {
  row: DatasetDataRow
  rowIndex: number
  columns: DatasetColumn[]
  activeDefinitions: Record<number, number | null>
  onOpenText: (questionText: string, fullText: string) => void
  projectId: number
  linkedParticipantMap: Map<number, string>
  onLink: (rowId: number, participantId: number | null, participantName: string | null) => void
  selectedCell: { rowId: number; columnId: number } | null
  onCellSelect: (rowId: number, columnId: number) => void
  editingCell: { rowId: number; columnId: number } | null
  onStartEdit: (rowId: number, columnId: number) => void
  onCellSave: (answerId: number, value: string | null) => void
  onCellCancel: () => void
  onTabNav: (rowId: number, columnId: number, direction: 'next' | 'prev') => void
  onEnterNav: (rowId: number, columnId: number) => void
  onDeleteRow: (rowId: number, recordLabel: string) => void
  domainScoreCols?: DomainScoreColumn[]
}) {
  const recordLabel = row.row_identifier || `R${rowIndex + 1}`

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr className="group border-b">
          <td
            className="px-3 py-2 text-sm font-medium font-mono whitespace-nowrap sticky left-0 z-10 bg-mm-surface group-hover:bg-mm-surface-hover w-[96px] min-w-[96px]"
            title={recordLabel}
          >
            {recordLabel}
          </td>
          <ParticipantCell
            row={row}
            projectId={projectId}
            linkedParticipantMap={linkedParticipantMap}
            onLink={onLink}
          />
          {columns.map((q) => {
            const activeDefId = activeDefinitions[q.id]
            const activeDef = activeDefId != null
              ? (q.recode_definitions || []).find(d => d.id === activeDefId) || null
              : null
            const isEditing = editingCell?.rowId === row.id && editingCell?.columnId === q.id
            const isSelected = selectedCell?.rowId === row.id && selectedCell?.columnId === q.id
            return (
              <EditableCell
                key={q.id}
                answer={row.values[String(q.id)]}
                column={q}
                activeDef={activeDef}
                isSelected={isSelected}
                isEditing={isEditing}
                onSelect={() => onCellSelect(row.id, q.id)}
                onStartEdit={() => onStartEdit(row.id, q.id)}
                onSave={onCellSave}
                onCancel={onCellCancel}
                onTabNav={(dir) => onTabNav(row.id, q.id, dir)}
                onEnterNav={() => onEnterNav(row.id, q.id)}
                onOpenText={onOpenText}
              />
            )
          })}
          {domainScoreCols?.map(ds => {
            const score = ds.scores[String(row.id)]
            return (
              <td
                key={`ds-${ds.domain_id}`}
                className="px-2 py-2 text-sm text-center font-mono text-mm-text-secondary border-l"
                style={{ borderLeftColor: ds.domain_color || undefined, borderLeftWidth: ds.domain_color ? 3 : 1 }}
              >
                {score != null ? score.toFixed(2) : <span className="text-mm-text-faint italic">--</span>}
              </td>
            )
          })}
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => onDeleteRow(row.id, recordLabel)}
          className="text-red-600"
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Delete Record ({recordLabel})
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}, (prev, next) => {
  // Custom comparator: compare selectedCell/editingCell only for this row
  if (prev.row !== next.row) return false
  if (prev.rowIndex !== next.rowIndex) return false
  if (prev.columns !== next.columns) return false
  if (prev.activeDefinitions !== next.activeDefinitions) return false
  if (prev.onOpenText !== next.onOpenText) return false
  if (prev.projectId !== next.projectId) return false
  if (prev.linkedParticipantMap !== next.linkedParticipantMap) return false
  if (prev.onLink !== next.onLink) return false
  if (prev.onCellSelect !== next.onCellSelect) return false
  if (prev.onStartEdit !== next.onStartEdit) return false
  if (prev.onCellSave !== next.onCellSave) return false
  if (prev.onCellCancel !== next.onCellCancel) return false
  if (prev.onTabNav !== next.onTabNav) return false
  if (prev.onEnterNav !== next.onEnterNav) return false
  if (prev.onDeleteRow !== next.onDeleteRow) return false
  if (prev.domainScoreCols !== next.domainScoreCols) return false
  // Only re-render if selectedCell/editingCell relevance to THIS row changed
  const prevHasSelected = prev.selectedCell?.rowId === prev.row.id
  const nextHasSelected = next.selectedCell?.rowId === next.row.id
  if (prevHasSelected !== nextHasSelected) return false
  if (prevHasSelected && nextHasSelected && prev.selectedCell!.columnId !== next.selectedCell!.columnId) return false
  const prevHasEditing = prev.editingCell?.rowId === prev.row.id
  const nextHasEditing = next.editingCell?.rowId === next.row.id
  if (prevHasEditing !== nextHasEditing) return false
  if (prevHasEditing && nextHasEditing && prev.editingCell!.columnId !== next.editingCell!.columnId) return false
  return true
})
