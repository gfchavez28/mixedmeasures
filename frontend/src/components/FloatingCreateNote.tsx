import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { computeFloatingPosition, type FloatingCoords } from '@/lib/floating-utils'

interface FloatingCreateNoteProps {
  position: FloatingCoords
  onSubmit: (content: string) => void
  onClose: () => void
  isPending?: boolean
}

export default function FloatingCreateNote({
  position,
  onSubmit,
  onClose,
  isPending = false,
}: FloatingCreateNoteProps) {
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Stable ref for onClose so effects don't re-attach listeners on every render
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Focus textarea on mount — delay enough for Radix ContextMenu to finish closing
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [])

  // Click outside to close — uses ref so listener is attached once
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onCloseRef.current()
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handle), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handle)
    }
  }, [])

  // Escape to close
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  }, [])

  const handleSubmit = () => {
    if (!content.trim() || isPending) return
    onSubmit(content.trim())
  }

  const style = useMemo(
    () => computeFloatingPosition(position, 300, 180),
    [position],
  )

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Create note"
      className="fixed z-50 w-[300px] bg-mm-surface border border-mm-border-medium rounded-lg shadow-xl animate-in fade-in-0 zoom-in-95 duration-150"
      style={{ top: style.top, left: style.left }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-mm-border-subtle">
        <span className="text-sm font-medium text-mm-text">Add Note</span>
        <button
          className="text-mm-text-muted hover:text-mm-text"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <textarea
          ref={textareaRef}
          value={content}
          aria-label="Note content"
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Note content..."
          className="w-full text-sm border rounded-md px-3 py-1.5 bg-mm-surface text-mm-text placeholder:text-mm-text-faint focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          rows={3}
        />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!content.trim() || isPending}
            onClick={handleSubmit}
          >
            {isPending ? 'Creating...' : 'Create'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
