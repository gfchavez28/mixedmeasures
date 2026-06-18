import { useState } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Link, useNavigate } from 'react-router-dom'
import { Trash2, ExternalLink } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import MaterialsTagInline from '../MaterialsTagInline'

export default function MemoEmbedView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const { numericId, title, preview, materialTag, tagNote } = node.attrs
  const [expanded, setExpanded] = useState(false)

  const previewText = String(preview || '')
  const truncated = previewText.length > 200 ? previewText.slice(0, 200) + '...' : previewText

  return (
    <NodeViewWrapper
      className={`group/material relative my-3 ${selected ? 'ring-2 ring-mm-accent/30' : ''}`}
      data-type="memo-embed"
      role="figure"
      aria-label={`Memo: ${title || 'Untitled'}${materialTag ? ` (${materialTag})` : ''}`}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-3 border-l-4 border-l-purple-500">
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

            <div className="flex items-center gap-2 mb-1 pr-20">
              {numericId != null && (
                <span className="text-[10px] font-mono font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 rounded px-1.5 py-0.5">
                  M-{numericId}
                </span>
              )}
              {title && <span className="text-sm font-semibold text-mm-text truncate">{title}</span>}
            </div>

            {previewText && (
              <p className="text-xs text-mm-text-muted leading-relaxed">
                {expanded ? previewText : truncated}
              </p>
            )}

            {previewText.length > 200 && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="text-[11px] text-mm-text-muted hover:text-mm-text mt-1"
                onMouseDown={e => e.stopPropagation()}
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}

            <Link
              to={`/projects/${projectId}/memos-notes`}
              className="flex items-center gap-1 text-[11px] text-mm-accent hover:underline mt-1.5 py-1"
            >
              Open in Memos <span className="text-[9px]">{'\u2192'}</span>
            </Link>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/memos-notes`)}>
            <ExternalLink className="w-4 h-4 mr-2" />View Source
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => deleteNode()} className="text-red-600 dark:text-red-400">
            <Trash2 className="w-4 h-4 mr-2" />Remove from Theme
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </NodeViewWrapper>
  )
}
