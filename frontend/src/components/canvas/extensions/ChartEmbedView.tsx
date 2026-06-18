import { useMemo } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Link, useNavigate } from 'react-router-dom'
import { Trash2, ExternalLink, AlertTriangle } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import InlineChartRenderer from '../InlineChartRenderer'
import MaterialsTagInline from '../MaterialsTagInline'
import { materialsApi } from '@/lib/api'

export default function ChartEmbedView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const { materialId, config, title, materialTag, tagNote } = node.attrs

  const parsedContent = useMemo(() => {
    try {
      return typeof config === 'string' ? JSON.parse(config) : (config ?? {})
    } catch {
      return {}
    }
  }, [config])

  // #296: stale-on-load referential integrity. The all-materials query is
  // already cached by the canvas page (MaterialsDrawer + several CanvasView
  // sites use the same key), so this useQuery dedupes and reuses the cached
  // result rather than firing a per-embed network request.
  const { data: allMaterials } = useQuery({
    queryKey: ['materials-all', Number(projectId)],
    queryFn: () => materialsApi.listAllMaterials(Number(projectId)),
    enabled: !!projectId && !!materialId,
    staleTime: 60_000,
  })
  const missingRefs = useMemo(() => {
    if (!materialId || !allMaterials) return null
    const m = allMaterials.find(x => x.id === Number(materialId))
    return m?.has_missing_refs ? m.missing_refs : null
  }, [materialId, allMaterials])

  return (
    <NodeViewWrapper
      className={`group/material relative my-3 ${selected ? 'ring-2 ring-mm-accent/30' : ''}`}
      data-type="chart-embed"
      data-material-id={materialId}
      role="figure"
      aria-label={`Chart: ${title || 'Untitled'}${materialTag ? ` (${materialTag})` : ''}`}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-3 border-l-4 border-l-blue-500">
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

            {title && (
              <p className="text-sm font-medium text-mm-text mb-2 pr-20">{title}</p>
            )}

            {missingRefs && missingRefs.length > 0 && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-start gap-2 px-2.5 py-1.5 rounded text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-none mt-px" aria-hidden />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Sources missing.</span>{' '}
                  {missingRefs.length === 1
                    ? `1 referenced ${missingRefs[0].type} no longer exists.`
                    : `${missingRefs.length} referenced columns or domains no longer exist.`}{' '}
                  This chart may render incomplete data.
                </div>
              </div>
            )}

            {materialId ? (
              <InlineChartRenderer
                projectId={Number(projectId)}
                materialId={Number(materialId)}
                content={parsedContent}
              />
            ) : (
              <p className="text-sm text-mm-text-muted italic">Chart source not available</p>
            )}

            {materialId && (
              <Link
                to={`/projects/${projectId}/analysis/quantitative?material=${materialId}`}
                className="flex items-center gap-1 text-[11px] text-mm-accent hover:underline mt-1.5 py-1"
              >
                Open in Analysis <span className="text-[9px]">{'\u2192'}</span>
              </Link>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {materialId && (
            <>
              <ContextMenuItem onSelect={() => navigate(`/projects/${projectId}/analysis/quantitative?material=${materialId}`)}>
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
