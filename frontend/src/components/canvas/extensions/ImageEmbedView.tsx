import { useState, useRef, useEffect, useCallback } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Trash2 } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import MaterialsTagInline from '../MaterialsTagInline'

export default function ImageEmbedView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const { imageId, alt, width: storedWidth, materialTag, tagNote } = node.attrs
  const src = imageId ? `/api/projects/${projectId}/canvas-images/${imageId}` : ''
  const isEditable = editor?.isEditable ?? true

  const [editingAlt, setEditingAlt] = useState(false)
  const [altValue, setAltValue] = useState(String(alt ?? ''))
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  const [liveWidth, setLiveWidth] = useState<number>(Number(storedWidth) || 100)

  useEffect(() => {
    if (editingAlt) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [editingAlt])

  // Sync liveWidth when stored width changes externally
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync local width to the Tiptap node attr when it changes externally (undo/collab)
  useEffect(() => { setLiveWidth(Number(storedWidth) || 100) }, [storedWidth])

  const commitAlt = () => {
    updateAttributes({ alt: altValue })
    setEditingAlt(false)
  }

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!containerRef.current) return
    const startX = e.clientX
    const containerWidth = containerRef.current.parentElement?.clientWidth ?? containerRef.current.clientWidth
    const startPct = liveWidth

    const handleMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const deltaPct = (dx / containerWidth) * 100
      const newPct = Math.max(25, Math.min(100, startPct + deltaPct))
      setLiveWidth(Math.round(newPct))
    }

    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      setResizing(false)
      // Commit final width
      setLiveWidth(prev => {
        updateAttributes({ width: prev })
        return prev
      })
    }

    setResizing(true)
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [liveWidth, updateAttributes])

  const displayWidth = resizing ? liveWidth : (Number(storedWidth) || 100)

  return (
    <NodeViewWrapper
      className={`group/material relative my-3 ${selected ? 'ring-2 ring-mm-accent/30' : ''}`}
      data-type="image-embed"
      role="figure"
      aria-label={`Image${alt ? `: ${String(alt).slice(0, 60)}` : ''}${materialTag ? ` (${materialTag})` : ''}`}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="bg-white dark:bg-mm-surface shadow-sm rounded-md overflow-hidden border-l-4 border-l-sky-500 relative"
            style={{ width: `${displayWidth}%` }}
          >
            {/* Action zone */}
            {isEditable && (
              <div className="absolute top-2 right-2 flex items-center gap-1 z-10" onMouseDown={e => e.stopPropagation()}>
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
            )}

            {/* Image */}
            {src ? (
              <img
                src={src}
                alt={alt || ''}
                loading="lazy"
                className="w-full"
                draggable={false}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <div className="py-8 text-center text-sm text-mm-text-faint">
                Image unavailable
              </div>
            )}

            {/* Alt text */}
            {editingAlt ? (
              <div className="px-3 py-1.5" onMouseDown={e => e.stopPropagation()}>
                <input
                  ref={inputRef}
                  type="text"
                  value={altValue}
                  onChange={e => setAltValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitAlt()
                    if (e.key === 'Escape') { setAltValue(String(alt ?? '')); setEditingAlt(false) }
                  }}
                  onBlur={commitAlt}
                  placeholder="Alt text..."
                  className="w-full text-xs px-2 py-1 rounded border border-mm-border-subtle bg-transparent text-mm-text focus:outline-none focus:ring-1 focus:ring-mm-accent"
                  aria-label="Image alt text"
                />
              </div>
            ) : (
              alt && (
                <p className="text-xs text-mm-text-muted px-3 py-1.5 italic">{alt}</p>
              )
            )}

            {/* Resize handle (bottom-right) */}
            {isEditable && src && (
              <div
                onMouseDown={handleResizeStart}
                className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-sm bg-mm-border cursor-nwse-resize opacity-0 group-hover/material:opacity-60 transition-opacity"
                title="Drag to resize"
                aria-hidden="true"
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isEditable && (
            <ContextMenuItem onSelect={() => { setAltValue(String(alt ?? '')); setEditingAlt(true) }}>
              Edit alt text
            </ContextMenuItem>
          )}
          {isEditable && <ContextMenuSeparator />}
          {isEditable && (
            <ContextMenuItem onSelect={() => deleteNode()} className="text-red-600 dark:text-red-400">
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              Remove from theme
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </NodeViewWrapper>
  )
}
