import { useState, useRef, useEffect } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Trash2 } from 'lucide-react'
import MaterialsTagInline from '../MaterialsTagInline'

export default function CalloutStatView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const { value, label, materialTag, tagNote } = node.attrs
  const [editing, setEditing] = useState(!value && !label)
  const [editValue, setEditValue] = useState(String(value ?? ''))
  const [editLabel, setEditLabel] = useState(String(label ?? ''))
  const valueRef = useRef<HTMLInputElement>(null)

  // Auto-focus value input when entering edit mode
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => valueRef.current?.focus())
    }
  }, [editing])

  const handleCommit = () => {
    updateAttributes({ value: editValue, label: editLabel })
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCommit()
    }
    if (e.key === 'Escape') {
      setEditValue(String(value ?? ''))
      setEditLabel(String(label ?? ''))
      setEditing(false)
    }
  }

  const isEditable = editor?.isEditable ?? true

  return (
    <NodeViewWrapper
      className={`group/material relative my-3 bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-4 border-l-4 border-l-teal-500 text-center ${
        selected ? 'ring-2 ring-mm-accent/30' : ''
      }`}
      data-type="callout-stat"
      role="figure"
      aria-label={`Callout: ${value || ''} ${label || ''}${materialTag ? ` (${materialTag})` : ''}`}
    >
      <div className="absolute top-2 right-2 flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
        <button
          type="button"
          onClick={deleteNode}
          className="opacity-0 group-hover/material:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded text-mm-text-faint hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          aria-label="Remove from canvas"
          title="Remove from canvas"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <MaterialsTagInline
          tag={materialTag ?? null}
          tagNote={tagNote ?? null}
          onTagChange={tag => updateAttributes({ materialTag: tag })}
          onTagNoteChange={note => updateAttributes({ tagNote: note })}
          inline
        />
      </div>

      {editing && isEditable ? (
        // Edit mode — regular <input> elements, not contenteditable
        <div
          onMouseDown={e => e.stopPropagation()}
          className="space-y-1"
        >
          <input
            ref={valueRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleCommit}
            placeholder="Value (e.g. 85%)"
            className="w-full text-center text-2xl font-bold text-mm-text bg-transparent border-b border-mm-border-medium outline-none tabular-nums"
          />
          <input
            type="text"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleCommit}
            placeholder="Label (e.g. completion rate)"
            className="w-full text-center text-xs text-mm-text-muted bg-transparent border-b border-mm-border-medium outline-none"
          />
        </div>
      ) : (
        // Display mode
        <div
          onClick={() => { if (isEditable) { setEditValue(String(value ?? '')); setEditLabel(String(label ?? '')); setEditing(true) } }}
          className={isEditable ? 'cursor-pointer hover:bg-mm-bg/50 rounded transition-colors' : ''}
          role={isEditable ? 'button' : undefined}
          tabIndex={isEditable ? 0 : undefined}
          aria-label={isEditable ? 'Click to edit callout' : undefined}
        >
          <div className="text-2xl font-bold text-mm-text tabular-nums">
            {value || <span className="text-mm-text-faint">Value</span>}
          </div>
          {(label || isEditable) && (
            <div className="text-xs text-mm-text-muted mt-0.5">
              {label || <span className="text-mm-text-faint">Label</span>}
            </div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  )
}
