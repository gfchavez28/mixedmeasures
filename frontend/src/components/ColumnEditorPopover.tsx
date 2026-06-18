import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, FunctionSquare, RefreshCw, Settings2 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  type DatasetColumn,
  type RecodeDefinitionSummary,
} from '@/lib/api'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'

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
  onSubtypeChange: (columnId: number, subtype: string | null) => void
  onSelectDef: (defId: number | null) => void
  activeDef: RecodeDefinitionSummary | null
  // Navigation
  onNextColumn: (field: EditorField) => void
  onPrevColumn: (field: EditorField) => void
  // Action callbacks
  onOpenDetails: (column: DatasetColumn) => void
  onDeleteColumn: (column: DatasetColumn) => void
  onEditComputed?: (column: DatasetColumn) => void
  onRecompute?: (column: DatasetColumn) => void
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
  onSubtypeChange,
  onSelectDef,
  activeDef,
  onNextColumn,
  onPrevColumn,
  onOpenDetails,
  onDeleteColumn,
  onEditComputed,
  onRecompute,
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

  // ── Announce column on open ──────────────────────────────────────────
  useEffect(() => {
    if (open) {
      const label = column.column_name || column.column_code || column.column_text.slice(0, 40)
      setAnnouncement(`Editing column ${columnIndex + 1} of ${columnCount}, ${label}`)
    } else {
      setAnnouncement('')
    }
  }, [open, columnIndex, columnCount, column.column_name, column.column_code, column.column_text])

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
        aria-label={`Column editor: ${column.column_name || column.column_code || column.column_text.slice(0, 40)}`}
      >
        {/* SR announcement */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>

        {/* Column name (click-to-edit) */}
        <div className="mb-1.5">
          <label className="text-[10px] text-mm-text-muted uppercase tracking-wider">Name</label>
          {editingField === 'name' ? (
            <input
              ref={nameInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              aria-label="Edit column name"
              className="w-full text-xs font-medium border border-blue-300 dark:border-blue-700 rounded px-1.5 py-1 bg-mm-surface outline-none focus:ring-1 focus:ring-ring mt-0.5"
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
              {column.column_name || <span className="italic text-mm-text-muted">Click to add name</span>}
            </button>
          )}
        </div>

        {/* Column label (click-to-edit) */}
        <div className="mb-2">
          <label className="text-[10px] text-mm-text-muted uppercase tracking-wider">Label</label>
          {editingField === 'label' ? (
            <textarea
              ref={labelInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              aria-label="Edit column label"
              className="w-full text-xs border border-blue-300 dark:border-blue-700 rounded px-1.5 py-1 bg-mm-surface outline-none focus:ring-1 focus:ring-ring mt-0.5 resize-none"
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

          {column.column_type === 'demographic' && (
            <select
              value={column.demographic_subtype || ''}
              onChange={(e) => onSubtypeChange(column.id, e.target.value || null)}
              aria-label="Demographic subtype"
              className="mt-1 w-full text-xs border border-mm-border-subtle rounded px-1.5 py-0.5 bg-mm-surface text-mm-text-secondary"
            >
              <option value="">No subtype</option>
              <option value="role">Role</option>
              <option value="gender">Gender</option>
              <option value="race">Race</option>
              <option value="age">Age</option>
              <option value="other">Other</option>
            </select>
          )}

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
                !activeDef ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200' : 'hover:bg-mm-surface-hover text-mm-text-secondary'
              }`}
            >
              {!activeDef && <span className="text-blue-500 dark:text-blue-400">*</span>}
              Show raw values
            </button>
            {defs.map(d => (
              <button
                key={d.id}
                onClick={() => onSelectDef(d.id)}
                className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 ${
                  activeDef?.id === d.id ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200' : 'hover:bg-mm-surface-hover text-mm-text-secondary'
                }`}
              >
                {activeDef?.id === d.id && <span className="text-blue-500 dark:text-blue-400">*</span>}
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
            to={`/projects/${projectId}/datasets/${datasetId}/recode?column=${column.id}`}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Edit in Recode Workbench
          </Link>
        </div>

        {/* Manual/imported column actions */}
        {(isManual || column.source === 'imported') && (
          <>
            <div className="border-t my-2" />
            <div className="space-y-1">
              <button
                onClick={() => onOpenDetails(column)}
                className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-mm-surface-hover text-mm-text-secondary flex items-center gap-1.5"
              >
                <Settings2 className="w-3 h-3" />
                Column details...
              </button>
              <button
                onClick={() => onDeleteColumn(column)}
                className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 flex items-center gap-1.5"
              >
                <Trash2 className="w-3 h-3" />
                Delete column
              </button>
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
              {onEditComputed && (
                <button
                  onClick={() => onEditComputed(column)}
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-mm-surface-hover text-mm-text-secondary flex items-center gap-1.5"
                >
                  <FunctionSquare className="w-3 h-3" />
                  Edit formula...
                </button>
              )}
              {column.stale && onRecompute && (
                <button
                  onClick={() => onRecompute(column)}
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-mm-surface-hover text-amber-600 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" />
                  Recompute
                </button>
              )}
              <button
                onClick={() => onDeleteColumn(column)}
                className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 flex items-center gap-1.5"
              >
                <Trash2 className="w-3 h-3" />
                Delete column
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
