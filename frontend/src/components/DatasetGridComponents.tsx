import { useState, useMemo, useCallback, memo } from 'react'
import { useListKeyboardNav } from '@/hooks/useListKeyboardNav'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link2, X, Pencil, Trash2, Settings2, GripVertical, FunctionSquare, RefreshCw, Check, UserPlus, LoaderCircle, CornerDownRight } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { columnDisplayLabel } from '@/lib/dataset-column-label'
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
import { TYPE_BADGE_CLASSES, variableDeleteEndpoint } from '@/lib/dataset-constants'
import { ColumnEditorPopover, type EditorField } from '@/components/ColumnEditorPopover'
import { formatFocusRow } from '@/components/crosswalk/navigation'
import { variableViewPath } from '@/lib/dataset-routes'

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
          {/* An unset subtype is worth flagging, but a bare "?" announces as
              the character — a screen reader read "demographic ?" and nothing
              else. The words ARE the accessible name here, so `role="img"`
              would suppress them (#698); `sr-only` text beside the glyph is
              what names it without changing the visual. Setting it now lives
              in the Variables view (design note E). */}
          {column.column_type === 'demographic' && !column.demographic_subtype && (
            <>
              <span className="ml-0.5 text-amber-500" aria-hidden="true">?</span>
              <span className="sr-only"> — no subtype set</span>
            </>
          )}
        </span>
        {/* 🔴 A derived variable is `source="manual"` (Decision B — it must be,
            because a COMPUTED column is refused value labels, missing rules and
            recode definitions, #806). But "Manual column" then reads as
            "somebody typed this by hand", which is the OPPOSITE of what it is.
            Found by driving the real corpus, and it is #795's rule restated:
            ask of any status label whether the sentence it implies is true of
            THIS thing.

            ⚠️ The `sr-only` text is not decoration. `lucide-react` sets
            `aria-hidden` on its icons by default and a `title` on a `<span>` is
            not a reliable name, so before this the marker was announced as
            nothing at all — the same shape as the demographic-subtype marker
            just above, which is why it takes the same remedy. */}
        {isManual && (column.derived_via ? (
          <span title={`Derived using ${column.derived_via}`} className="flex items-center gap-0.5">
            <CornerDownRight className="w-3 h-3 text-mm-text-faint" />
            <span className="sr-only"> — derived using {column.derived_via}</span>
          </span>
        ) : (
          <span title="Manual column">
            <Pencil className="w-3 h-3 text-mm-text-faint" />
            <span className="sr-only"> — manual column</span>
          </span>
        ))}
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
  onDeleteColumn,
  onTypeChange,
  onColumnNameEdit,
  onColumnTextEdit,
  onColumnResizeStart,
  onColumnResize,
  onColumnResizeEnd,
  onColumnResetWidth,
  domainPills,
  onRemoveFromGroup,
  onToggleParticipantVisibility,
  onRecompute,
  onLinkByColumn,
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
  onDeleteColumn: (column: DatasetColumn) => void
  onTypeChange: (columnId: number, newType: string) => void
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
  /** A stale computed column is recomputed from here; the FORMULA is edited in
   * the Variables view (design note E — the popover thinning). */
  onRecompute?: (column: DatasetColumn) => void
  /** #414 (DEC-8): retro bulk-link by an identifier column. */
  onLinkByColumn?: (column: DatasetColumn) => void
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
  } = useSortable({
    id: column.id,
    // #776: dnd-kit's default `roleDescription` is the literal string
    // "sortable", which it means as *drag-reorderable*. On a TABLE COLUMN
    // HEADER that word already has a specific, different meaning — sort by
    // value — and this grid has no sort at all (no aria sort, no handler).
    // So every header announced a capability that does not exist, once per
    // column across a row, to the only users who hear it. Say what it is.
    attributes: { roleDescription: 'draggable column header' },
  })
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

  // ONE handler, because the endpoint choice moved into `useDeleteVariable`
  // (#812). The `onDeleteComputed` twin it replaces was vestigial: both props
  // resolved to the same `setDeleteColumnTarget`, so the branch decided nothing
  // and existed only to be got wrong on a fourth surface.
  const handleDelete = useCallback((q: DatasetColumn) => {
    onDeleteColumn(q)
  }, [onDeleteColumn])

  const handleResetWidth = useCallback(() => {
    onColumnResetWidth(column.id)
  }, [column.id, onColumnResetWidth])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <th
          ref={setNodeRef}
          // #772: `<th>` alone does not tell a screen reader which way it
          // heads. Without `scope`, cell navigation across a 120×11 grid
          // announces values with nothing to attach them to.
          scope="col"
          /**
           * Double-click opens this variable in the Variables view — jamovi's
           * gesture for the same surface (design note §11), and it was free:
           * `ResizeHandle` stops propagation on its own double-click, so the
           * width-reset keeps working (verified, not assumed).
           *
           * ⚠️ Single-click already opens the editor popover, so a double-click
           * necessarily toggles it open-then-shut first. Closing it explicitly
           * is what stops that landing us on the next page with a stale open
           * state. Form controls are excluded because the popover's own inline
           * editors would otherwise navigate away mid-edit — Radix PORTALS the
           * popover content, so this only guards the trigger's own children.
           *
           * ⚠️ This is a mouse-only affordance by nature. The keyboard path is
           * the popover's "Edit in the Variables view" link, which is why that
           * item stays even though this gesture exists.
           */
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('input, textarea, select')) return
            onPopoverOpenChange(column.id, false)
            navigate(variableViewPath(projectId, datasetId, column.id))
          }}
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
            onSelectDef={handleSelectDef}
            activeDef={activeDef}
            onNextColumn={onNextColumn}
            onPrevColumn={onPrevColumn}
            onDeleteColumn={handleDelete}
            onRecompute={onRecompute}
            onLinkByColumn={onLinkByColumn}
            projectId={projectId}
            datasetId={datasetId}
            columnIndex={columnIndex}
            columnCount={columnCount}
          >
            <div className="cursor-pointer">
              {/* Drag handle — visible on hover */}
              {/* #776/#559: the handle is a real (keyboard-draggable) control,
                  so it needs a name that says WHAT it moves — "Drag to reorder"
                  eleven times over says nothing about which column you are on.
                  `focus-visible:opacity-100` because it is reachable by Tab and
                  was revealed on hover only. */}
              <div
                {...attributes}
                {...listeners}
                onClick={(e) => e.stopPropagation()}
                className="absolute left-0 top-0 bottom-0 w-4 flex items-center justify-center opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100 cursor-grab active:cursor-grabbing z-10"
                aria-label={`Reorder column ${columnDisplayLabel(column)}`}
                title="Drag to reorder"
              >
                <GripVertical aria-hidden className="w-3 h-3 text-mm-text-faint" />
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
        {/* 🔴 "Column details…" and "Edit formula…" are GONE from here (design
            note E — the popover thinning), and the details item was also a
            LIVE DEFECT: it was offered for `manual || imported` while its save
            goes through the manual-only PATCH, which 403s on an imported
            column. The popover beside it carried the correct `isManual` gate
            since #575; this sibling was never swept. Both forms now have one
            home, reachable by "Edit in the Variables view" below, where the
            gate lives once. `Recompute` stays — see the popover's note. */}
        {column.source === 'computed' && column.stale && onRecompute && (
          <ContextMenuItem onClick={() => onRecompute(column)}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Recompute
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigate(variableViewPath(projectId, datasetId, column.id))}>
          <Settings2 className="w-4 h-4 mr-2" />
          Edit in the Variables view
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
        {/* 🔴 This item had NO source gate (#812). `delete_manual_column` 403s
            anything that is not `source="manual"`, so on an imported corpus —
            every column of a real survey — right-clicking a header opened a
            confirm promising to permanently delete the column and all its data,
            and the server then refused. The popover's two copies WERE gated, by
            living inside its manual/computed branches; this one was the third
            surface with the wrong gate, which is #807 exactly. */}
        {variableDeleteEndpoint(column) !== null && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => onDeleteColumn(column)}
              className="text-red-600"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete variable…
            </ContextMenuItem>
          </>
        )}
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
  suggestedIdentifier = null,
}: {
  row: DatasetDataRow
  projectId: number
  linkedParticipantMap: Map<number, string>
  onLink: (rowId: number, participantId: number | null, participantName: string | null) => void
  /** #532: this row's identifier-column value (falling back to row_identifier),
   *  trimmed — drives the "New participant from this row" affordance. */
  suggestedIdentifier?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()

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

  // #532: create a participant FROM this row (identifier = the row's
  // identifier-column value, falling back to row_identifier) and link it in one
  // gesture. The backend's 409-on-duplicate-identifier becomes "link to that
  // existing participant instead" — unless it is already linked to another row
  // in this dataset (one row per participant per dataset).
  const handleCreateFromRow = async () => {
    if (!suggestedIdentifier || creating) return
    setCreating(true)
    try {
      const created = await participantsApi.create(projectId, { identifier: suggestedIdentifier })
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      toast.success(`Created participant "${created.display_name || created.identifier}"`)
      handleSelect(created)
    } catch (err) {
      if ((err as { status?: number })?.status === 409) {
        const existing = participants.find(p => p.identifier === suggestedIdentifier)
        const linkedElsewhere = existing
          && linkedParticipantMap.has(existing.id)
          && existing.id !== row.participant_id
        if (existing && !linkedElsewhere) {
          toast.success(
            `"${suggestedIdentifier}" already existed — linked to that participant`,
          )
          handleSelect(existing)
        } else if (existing) {
          toast.error(
            `Participant "${suggestedIdentifier}" is already linked to record ${linkedParticipantMap.get(existing.id)}.`,
          )
        } else {
          // Popover list is stale (created elsewhere) — refresh so it appears.
          queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
          toast.error(
            `A participant with ID "${suggestedIdentifier}" already exists — pick it from the list.`,
          )
        }
      } else {
        toast.error('Could not create participant.')
      }
    } finally {
      setCreating(false)
    }
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
                className="absolute -right-1 top-1/2 -translate-y-1/2 hidden group-hover/cell:flex items-center justify-center w-4 h-4 rounded-full bg-muted hover:bg-red-100 text-mm-text-muted hover:text-red-700"
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
        <PopoverContent className="w-64 p-0" align="start" aria-label="Link a participant">
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

          {suggestedIdentifier && (
            <div className="p-1.5 border-t">
              <button
                onClick={() => void handleCreateFromRow()}
                disabled={creating}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-mm-green-text hover:bg-mm-surface-hover disabled:opacity-50"
              >
                {creating ? (
                  <LoaderCircle className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">
                  New participant &ldquo;{suggestedIdentifier}&rdquo;
                </span>
              </button>
            </div>
          )}
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
  // ⚠️ `rowIndex` is DATASET-scoped, not page-scoped — the caller adds the
  // page offset. Page-scoped it restarted at "R1" on every page, so on a
  // dataset with no identifier column two different records carried the same
  // label 200 rows apart. Latent rather than live (measured 2026-08-25: 0 of
  // 75,699 GSS rows and 0 of 48 Ferncrest rows lack an identifier), but record
  // identity is exactly what the #834 deep link makes load-bearing.
  const recordLabel = row.row_identifier || `R${rowIndex + 1}`

  // #532: the row's identity for create-from-row — the identifier column's
  // value when the dataset has one (trim-then-exact, the linking seam's rule),
  // else the row_identifier.
  const idCol = columns.find(c => c.column_type === 'identifier')
  const suggestedIdentifier =
    (idCol ? row.values[String(idCol.id)]?.value_text?.trim() : undefined)
    || row.row_identifier?.trim()
    || null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* `data-row-id` is the deep-link's only DOM contract (#834). A search
            hit scrolls to `tr[data-row-id="N"]` and then indexes into
            `tr.cells` using the position of the matching `<col data-col-id>` in
            the table's colgroup — which is why the marker lives HERE and not on
            each cell: `EditableCell` returns ten different `<td>` branches by
            type and edit state, so a per-cell attribute would be ten places to
            keep in step. Renaming this attribute breaks `useRecordFocus`. */}
        <tr className="group border-b" data-row-id={row.id}>
          {/* #772 — the record id is this row's HEADER, not a value.
            *
            * It was a `<td>`, so every body cell in a 120×11 grid had a column
            * to name it and nothing to say WHICH RECORD it belonged to: cell
            * navigation announced "Post_Score, 14" with no way to learn whose
            * 14 that was. `scope="row"` is what makes the identifier travel
            * with each cell.
            *
            * ⚠️ `text-left` is load-bearing, not tidying — a `<th>` centres by
            * UA default where a `<td>` does not, so dropping it silently
            * re-aligns the sticky identity column. `font-medium` already
            * overrides the bold. */}
          <th
            scope="row"
            className="px-3 py-2 text-left text-sm font-medium font-mono whitespace-nowrap sticky left-0 z-10 bg-mm-surface group-hover:bg-mm-surface-hover w-[96px] min-w-[96px]"
            title={recordLabel}
          >
            {recordLabel}
          </th>
          <ParticipantCell
            row={row}
            projectId={projectId}
            linkedParticipantMap={linkedParticipantMap}
            onLink={onLink}
            suggestedIdentifier={suggestedIdentifier}
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
