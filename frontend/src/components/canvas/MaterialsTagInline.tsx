/**
 * Inline material-tag editor for Tiptap material NodeViews.
 *
 * Renders within the NodeViewWrapper (positioned absolutely, not via portal)
 * to avoid ProseMirror focus issues. The tag label is ALWAYS in the DOM
 * (opacity-controlled) so it appears in print output.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

// ── Tag color map ──────────────────────────────────────────────────────────

const TAG_COLORS: Record<string, string> = {
  confirms:     'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  contradicts:  'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  expands:      'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  complements:  'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
}

function getTagClasses(tag: string): string {
  return TAG_COLORS[tag] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
}

const TAG_DOT_COLORS: Record<string, string> = {
  confirms:    'bg-emerald-500',
  contradicts: 'bg-red-500',
  expands:     'bg-amber-500',
  complements: 'bg-blue-500',
}

const PRESET_TAGS = ['confirms', 'contradicts', 'expands', 'complements'] as const

interface MaterialsTagInlineProps {
  tag: string | null
  tagNote: string | null
  onTagChange: (tag: string | null) => void
  onTagNoteChange: (note: string | null) => void
  /** When true, skip absolute positioning (parent wraps in its own positioned container) */
  inline?: boolean
}

export default function MaterialsTagInline({
  tag,
  tagNote,
  onTagChange,
  onTagNoteChange,
  inline,
}: MaterialsTagInlineProps) {
  const [open, setOpen] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on click outside (check both container and portal popover)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus custom input when popover opens
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setCustomValue('')
    }
  }, [open])

  const handleSelect = useCallback(
    (value: string) => {
      onTagChange(value)
      setOpen(false)
    },
    [onTagChange],
  )

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customValue.trim()
    if (trimmed) {
      onTagChange(trimmed)
      setOpen(false)
    }
  }, [customValue, onTagChange])

  // Determine tag label classes
  const tagClasses = tag
    ? getTagClasses(tag)
    : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-dashed border-gray-300 dark:border-gray-600'

  return (
    <div
      ref={containerRef}
      className={inline ? 'z-10' : 'absolute top-2 right-2 z-10'}
      // Prevent ProseMirror from handling clicks inside the tag UI
      onMouseDown={e => e.stopPropagation()}
    >
      {/* Tag label — always in DOM for print CSS */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`material-tag-label text-[10px] font-medium px-1.5 py-0.5 rounded truncate max-w-[80px] transition-opacity ${tagClasses} ${
          tag
            ? 'opacity-100'
            : 'opacity-0 group-hover/material:opacity-100 focus:opacity-100 print:opacity-100'
        }`}
        title={tag ?? 'Add tag'}
        aria-label={tag ? `Tag: ${tag}. Click to change` : 'Add tag'}
      >
        {tag ?? 'Tag'}
      </button>

      {/* Popover — rendered as portal to escape stacking contexts */}
      {open && (() => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return null
        const popoverHeight = 220
        const flipAbove = rect.bottom + popoverHeight > window.innerHeight
        const top = flipAbove ? rect.top - popoverHeight - 4 : rect.bottom + 4
        const left = Math.max(8, rect.right - 160)
        return createPortal(
        <div
          ref={popoverRef}
          className="fixed bg-white dark:bg-mm-surface border border-mm-border shadow-lg rounded-md overflow-hidden"
          style={{ zIndex: 100, minWidth: 160, top, left }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div role="listbox" aria-label="Tag options">
            {PRESET_TAGS.map(preset => (
              <button
                key={preset}
                type="button"
                role="option"
                aria-selected={tag === preset}
                onClick={() => handleSelect(preset)}
                className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-xs text-mm-text hover:bg-mm-bg transition-colors"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${TAG_DOT_COLORS[preset]}`} />
                <span className="capitalize">{preset}</span>
              </button>
            ))}

            {tag && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => { onTagChange(null); setOpen(false) }}
                className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-xs text-mm-text-muted hover:bg-mm-bg transition-colors"
              >
                <span className="w-2 h-2 rounded-full shrink-0 bg-gray-300 dark:bg-gray-600" />
                <span>Clear tag</span>
              </button>
            )}
          </div>

          <hr className="border-mm-border my-1" />

          {/* Custom tag input */}
          <div className="px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={customValue}
              onChange={e => setCustomValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCustomSubmit()
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder="Custom tag..."
              className="w-full text-xs rounded border border-mm-border bg-mm-bg px-2 py-1 text-mm-text placeholder:text-mm-text-faint outline-none focus:ring-1 focus:ring-mm-accent"
            />
            <p className="text-[9px] text-mm-text-faint mt-0.5 select-none">Press Enter to add</p>
          </div>

          {/* Tag note */}
          <div className="px-2 py-1.5 border-t border-mm-border">
            <input
              type="text"
              value={tagNote ?? ''}
              onChange={e => onTagNoteChange(e.target.value || null)}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
              placeholder="Note (optional)..."
              className="w-full text-xs rounded border border-mm-border bg-mm-bg px-2 py-1 text-mm-text placeholder:text-mm-text-faint outline-none focus:ring-1 focus:ring-mm-accent"
            />
          </div>
        </div>,
        document.body,
        )
      })()}
    </div>
  )
}
