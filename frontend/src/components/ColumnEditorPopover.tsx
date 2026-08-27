import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router'
import { SELECTED_SEGMENT } from '@/lib/selection'
import { Trash2, RefreshCw, Users } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  type DatasetColumn,
  type RecodeDefinitionSummary,
} from '@/lib/api'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES, variableDeleteEndpoint } from '@/lib/dataset-constants'
import { columnDisplayLabel } from '@/lib/dataset-column-label'
import { variableViewPath } from '@/lib/dataset-routes'

// ── Types ────────────────────────────────────────────────────────────────────

export type EditorField = 'name' | 'label' | null

interface ColumnEditorPopoverProps {
  column: DatasetColumn
  open: boolean
  onOpenChange: (open: boolean) => void
  activeField: EditorField
  onActiveFieldChange: (field: EditorField) => void
  // Edit callbacks
  onColumnNameEdit: (columnId: number, newName: string) => void
  onColumnTextEdit: (columnId: number, newText: string) => void
  onTypeChange: (columnId: number, newType: string) => void
  onSelectDef: (defId: number | null) => void
  activeDef: RecodeDefinitionSummary | null
  // Navigation
  onNextColumn: (field: EditorField) => void
  onPrevColumn: (field: EditorField) => void
  // Action callbacks
  onDeleteColumn: (column: DatasetColumn) => void
  /** A stale computed column is recomputable from here BY DESIGN — the marker
   * that says it is stale is rendered in this very grid. The formula EDITOR
   * lives in the Variables view (design note E). */
  onRecompute?: (column: DatasetColumn) => void
  /** #414 (DEC-8): retro bulk-link — identifier columns only. Links unlinked
   * rows by this column's values; never overwrites manual links. */
  onLinkByColumn?: (column: DatasetColumn) => void
  // Context
  projectId: number
  datasetId: number
  columnIndex: number
  columnCount: number
  children: React.ReactNode
}

// ── Component ────────────────────────────────────────────────────────────────

export function ColumnEditorPopover({
  column,
  open,
  onOpenChange,
  activeField,
  onActiveFieldChange,
  onColumnNameEdit,
  onColumnTextEdit,
  onTypeChange,
  onSelectDef,
  activeDef,
  onNextColumn,
  onPrevColumn,
  onDeleteColumn,
  onRecompute,
  onLinkByColumn,
  projectId,
  datasetId,
  columnIndex,
  columnCount,
  children,
}: ColumnEditorPopoverProps) {
  // ── Internal edit state ──────────────────────────────────────────────
  const [editingField, setEditingField] = useState<'name' | 'label' | null>(null)
  const [editValue, setEditValue] = useState('')
  const pendingCommitRef = useRef<{ field: 'name' | 'label'; value: string } | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const labelInputRef = useRef<HTMLTextAreaElement>(null)
  const [announcement, setAnnouncement] = useState('')

  const defs = column.recode_definitions || []
  const isManual = column.source === 'manual'
  const isComputed = column.source === 'computed'
  const badgeClass = TYPE_BADGE_CLASSES[column.column_type] || 'bg-mm-bg text-mm-text-muted'

  // ── Commit logic ─────────────────────────────────────────────────────
  const commitEdit = useCallback(() => {
    if (!editingField) return
    const trimmed = editValue.trim()
    if (editingField === 'name') {
      const oldName = column.column_name || ''
      if (trimmed !== oldName) {
        onColumnNameEdit(column.id, trimmed)
      }
    } else {
      if (trimmed && trimmed !== column.column_text) {
        onColumnTextEdit(column.id, trimmed)
      }
    }
    pendingCommitRef.current = null
    setEditingField(null)
  }, [editingField, editValue, column, onColumnNameEdit, onColumnTextEdit])

  const cancelEdit = useCallback(() => {
    pendingCommitRef.current = null
    setEditingField(null)
  }, [])

  const startEdit = useCallback((field: 'name' | 'label') => {
    // Commit any pending edit first
    if (editingField && editingField !== field) {
      commitEdit()
    }
    setEditingField(field)
    setEditValue(field === 'name' ? (column.column_name || '') : column.column_text)
    pendingCommitRef.current = {
      field,
      value: field === 'name' ? (column.column_name || '') : column.column_text,
    }
  }, [editingField, commitEdit, column.column_name, column.column_text])

  // Track pending value for commit-on-dismiss
  useEffect(() => {
    if (editingField) {
      pendingCommitRef.current = { field: editingField, value: editValue }
    }
  }, [editingField, editValue])

  // ── Auto-activate field when activeField changes (from Tab navigation) ──
  useEffect(() => {
    if (open && activeField) {
      startEdit(activeField)
    }
  // Only trigger on open/activeField change, not on startEdit identity
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeField])

  // ── Focus management ─────────────────────────────────────────────────
  useEffect(() => {
    if (!editingField) return
    requestAnimationFrame(() => {
      if (editingField === 'name' && nameInputRef.current) {
        nameInputRef.current.focus()
        nameInputRef.current.select()
      } else if (editingField === 'label' && labelInputRef.current) {
        labelInputRef.current.focus()
        labelInputRef.current.select()
      }
    })
  }, [editingField])

  // #575's precedence, not a hand-rolled one. The chain here read
  // `column_name || column_code || column_text`, which puts the MACHINE code
  // ahead of the label — so on any dataset whose columns carry no short name (an
  // ordinary CSV/Excel import: the header row lands in `column_text`) this
  // announced "Editing column 3 of 41, C003" instead of the variable's own name.
  // An accessible name is the one place the fallback matters most.
  //
  // ⚠️ Resolved at RENDER, not inside the effect below, and the effect then
  // depends on the resulting STRING. Calling the helper inside the effect makes
  // `column` — the whole object — a dependency, and that object gets a fresh
  // identity on every `listColumns` refetch: the effect would re-run and
  // re-announce with nothing having changed, which is #770's mechanism (a live
  // region firing for a reason that is not the user's action). A primitive dep
  // can only change when the announced words actually change.
  const announceLabel = columnDisplayLabel(column, { maxLength: 40 })

  // ── Announce column on open ──────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setAnnouncement(`Editing column ${columnIndex + 1} of ${columnCount}, ${announceLabel}`)
    } else {
      setAnnouncement('')
    }
  }, [open, columnIndex, columnCount, announceLabel])

  // ── Reset on close ───────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setEditingField(null)
      setEditValue('')
      pendingCommitRef.current = null
    }
  }, [open])

  // ── Commit-on-dismiss ────────────────────────────────────────────────
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && pendingCommitRef.current) {
      const { field, value } = pendingCommitRef.current
      const trimmed = value.trim()
      if (field === 'name') {
        const oldName = column.column_name || ''
        if (trimmed !== oldName) {
          onColumnNameEdit(column.id, trimmed)
        }
      } else {
        if (trimmed && trimmed !== column.column_text) {
          onColumnTextEdit(column.id, trimmed)
        }
      }
      pendingCommitRef.current = null
    }
    onOpenChange(nextOpen)
  }, [column, onColumnNameEdit, onColumnTextEdit, onOpenChange])

  // ── Keyboard handler ─────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingField) {
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        commitEdit()
        if (e.shiftKey) {
          onPrevColumn(editingField)
        } else {
          onNextColumn(editingField)
        }
      } else if (e.key === 'Enter' && !(editingField === 'label' && e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        commitEdit()
        if (editingField === 'name') {
          startEdit('label')
          onActiveFieldChange('label')
        }
        // If editing label, Enter just commits (exits edit mode)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelEdit()
      }
    } else {
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        onNextColumn(null)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        onPrevColumn(null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleOpenChange(false)
      }
    }
  }, [editingField, commitEdit, cancelEdit, startEdit, onNextColumn, onPrevColumn, onActiveFieldChange, handleOpenChange])

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        align="start"
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(e) => e.preventDefault()}
        aria-roledescription="column editor"
        aria-label={`Column editor: ${announceLabel}`}
      >
        {/* SR announcement */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>

        {/* Column name (click-to-edit).
            ⚠️ These two captions are `<span>`, not `<label>`. Chrome reports
            "no label associated with a form field" for both, because the thing
            below is a BUTTON until you click it and only then an input — a
            `<label>` can associate with neither reliably, and one that
            associates with nothing is markup that promises a relationship it
            does not have. The accessible name comes from each input's own
            `aria-label`, which is what a reader actually announces. */}
        <div className="mb-1.5">
          <span className="block text-[10px] text-mm-text-muted uppercase tracking-wider">Short name</span>
          {editingField === 'name' ? (
            <input
              ref={nameInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              aria-label="Edit column name"
              className="w-full text-xs font-medium border border-mm-blue/50 rounded px-1.5 py-1 bg-mm-surface outline-none focus:ring-1 focus:ring-ring mt-0.5"
              maxLength={255}
              placeholder="Short display name"
            />
          ) : (
            <button
              type="button"
              onClick={() => { startEdit('name'); onActiveFieldChange('name') }}
              className="w-full text-left text-xs font-medium rounded px-1.5 py-1 mt-0.5 hover:bg-mm-surface-hover transition-colors cursor-text"
              title="Click to edit column name"
            >
              {column.column_name || <span className="italic text-mm-text-muted">Click to add short name</span>}
            </button>
          )}
        </div>

        {/* Column label (click-to-edit) */}
        <div className="mb-2">
          <span className="block text-[10px] text-mm-text-muted uppercase tracking-wider">Label</span>
          {editingField === 'label' ? (
            <textarea
              ref={labelInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              aria-label="Edit column label"
              className="w-full text-xs border border-mm-blue/50 rounded px-1.5 py-1 bg-mm-surface outline-none focus:ring-1 focus:ring-ring mt-0.5 resize-none"
              maxLength={500}
              rows={3}
              placeholder="Column label or description"
            />
          ) : (
            <button
              type="button"
              onClick={() => { startEdit('label'); onActiveFieldChange('label') }}
              className="w-full text-left text-xs text-mm-text-secondary rounded px-1.5 py-1 mt-0.5 hover:bg-mm-surface-hover transition-colors cursor-text"
              title="Click to edit column label"
            >
              {column.column_text}
            </button>
          )}
        </div>

        {/* Separator */}
        <div className="border-t my-2" />

        {/* Type dropdown */}
        <div className="mb-2">
          <select
            value={column.column_type}
            onChange={(e) => {
              const newType = e.target.value
              if (newType !== column.column_type) {
                onTypeChange(column.id, newType)
              }
            }}
            aria-label="Column type"
            className={`px-1.5 py-0.5 rounded text-[11px] font-medium border-none cursor-pointer ${badgeClass}`}
          >
            {COLUMN_TYPES.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {/* The demographic-subtype select moved to the Variables view
              (design note E — the popover thinning). It is a property of the
              variable, and this popover is the DATA view's quick editor. */}

          {column.scale_labels && (
            <p className="text-[11px] text-mm-text-faint mt-1">
              {column.scale_points}-point: {column.scale_labels.join(', ')}
            </p>
          )}
        </div>

        {/* Recode definitions */}
        {defs.length > 0 && (
          <div className="border-t pt-2 space-y-1">
            <button
              onClick={() => onSelectDef(null)}
              className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 ${
                !activeDef ? SELECTED_SEGMENT : 'hover:bg-mm-surface-hover text-mm-text-secondary'
              }`}
            >
              {!activeDef && <span className="text-mm-blue">*</span>}
              Show raw values
            </button>
            {defs.map(d => (
              <button
                key={d.id}
                onClick={() => onSelectDef(d.id)}
                className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 ${
                  activeDef?.id === d.id ? SELECTED_SEGMENT : 'hover:bg-mm-surface-hover text-mm-text-secondary'
                }`}
              >
                {activeDef?.id === d.id && <span className="text-mm-blue">*</span>}
                {d.name}
                {d.is_primary && <span className="text-amber-500 text-[11px]">primary</span>}
                <span className="text-[11px] text-mm-text-faint ml-auto">{d.recode_type}</span>
              </button>
            ))}
          </div>
        )}

        {/* Recode workbench link */}
        <div className="border-t pt-2 mt-2">
          <Link
            to={variableViewPath(projectId, datasetId, column.id)}
            className="text-xs text-mm-blue-text hover:underline"
          >
            Edit in the Variables view
          </Link>
        </div>

        {/* Manual/imported column actions */}
        {(isManual || column.source === 'imported') && (
          <>
            <div className="border-t my-2" />
            <div className="space-y-1">
              {column.column_type === 'identifier' && onLinkByColumn && (
                <button
                  onClick={() => onLinkByColumn(column)}
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-mm-surface-hover text-mm-text-secondary flex items-center gap-1.5"
                >
                  <Users className="w-3 h-3" />
                  Link rows to participants
                </button>
              )}
              {/* The "Value labels & missing…" modal that used to sit here is
                  GONE (design note E, slab 3), and so are "Swap name ↔ label"
                  and "Column details…" (the thinning). All three are property
                  FORMS — they change what the variable IS — and they now have
                  one home, the Variables view, reachable by the link above.
                  What stays here is what belongs to the DATA view: the quick
                  name/label/type edit you make while reading the grid, the
                  display lens, and the actions on this column's cells. */}
            </div>
          </>
        )}

        {/* Computed column actions */}
        {isComputed && (
          <>
            <div className="border-t my-2" />
            {column.expression && (
              <p className="text-[10px] text-mm-text-muted font-mono mb-2 break-all">{column.expression}</p>
            )}
            <div className="space-y-1">
              {/* "Edit formula…" moved to the Variables view with the other
                  property forms. `Recompute` deliberately did NOT: it is a VERB
                  acting on state this view RENDERS — the amber pulse marking a
                  stale computed column sits a few pixels away — so sending the
                  researcher to another screen to act on what is in front of
                  them would be worse than having it in both places. */}
              {column.stale && onRecompute && (
                <button
                  onClick={() => onRecompute(column)}
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-mm-surface-hover text-amber-600 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" />
                  Recompute
                </button>
              )}
            </div>
          </>
        )}

        {/* 🔴 ONE delete, gated by the ONE predicate (#812).
            There were two buttons here, and the gates they inherited from their
            surrounding branches disagreed: the first sat inside
            `isManual || imported`, so it offered to delete an IMPORTED column —
            which `delete_manual_column` 403s ("Only manual columns can be
            deleted") — while the second, inside `isComputed`, was correct. With
            the column-header context menu offering it ungated as well, that is
            three triggers and three different gates for one destructive verb:
            #807's shape, on the operation where getting it wrong is worst.
            The endpoint choice now lives in `useDeleteVariable`. */}
        {variableDeleteEndpoint(column) !== null && (
          <>
            <div className="border-t my-2" />
            <button
              onClick={() => onDeleteColumn(column)}
              className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 flex items-center gap-1.5"
            >
              <Trash2 className="w-3 h-3" />
              Delete variable…
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
