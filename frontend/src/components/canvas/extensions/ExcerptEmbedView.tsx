import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Link, useNavigate } from 'react-router-dom'
import { Trash2, ExternalLink } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import MaterialsTagInline from '../MaterialsTagInline'

export default function ExcerptEmbedView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const { displayText, sourceContext, conversationId, materialTag, tagNote } = node.attrs

  return (
    <NodeViewWrapper
      className={`group/material relative my-3 ${selected ? 'ring-2 ring-mm-accent/30' : ''}`}
      data-type="excerpt-embed"
      role="figure"
      aria-label={`Excerpt: ${displayText ? String(displayText).slice(0, 60) : 'empty'}${materialTag ? ` (${materialTag})` : ''}`}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-3 border-l-4 border-l-emerald-500">
            {/* Action zone — trash + tag, no overlap */}
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

            <p className="text-[13.5px] leading-[1.75] text-mm-text italic pr-20">
              {displayText || 'Empty excerpt'}
            </p>

            {sourceContext && (
              conversationId ? (
                <Link
                  to={`/projects/${projectId}/conversations/${conversationId}`}
                  className="text-xs text-mm-accent hover:underline mt-1.5 block"
                >
                  {sourceContext}
                </Link>
              ) : (
                <p className="text-xs text-mm-text-muted mt-1.5">{sourceContext}</p>
              )
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {conversationId && (
            <>
              <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/conversations/${conversationId}`)}>
                <ExternalLink className="w-4 h-4 mr-2" />View Source
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => deleteNode()} className="text-red-600 dark:text-red-400">
            <Trash2 className="w-4 h-4 mr-2" />Remove from Theme
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </NodeViewWrapper>
  )
}
