import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'
import { Link, useNavigate } from 'react-router'
import { Trash2, ExternalLink, AlertTriangle } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import InlineChartRenderer from '../InlineChartRenderer'
import MaterialsTagInline from '../MaterialsTagInline'
import { materialsApi, metricsApi } from '@/lib/api'
import {
  materialAnalysisPath,
  describeMissingRefs,
  describeStaleInputs,
  isQualitativeMaterialConfig,
} from '@/lib/material-kind'
import { extractComputeParams, staleComputedInputs } from '../inline-chart-params'
import { figureDrift, type FigureFingerprint } from '../figure-baseline'
import { variableViewPath } from '@/lib/dataset-routes'

export default function ChartEmbedView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const {
    materialId, config, title, materialTag, tagNote,
    figureHash, figureHeadline, figureStampedAt,
  } = node.attrs

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

  // #652: routed from the CONFIG, not `source_tab` — the config is on the node,
  // so it is synchronous and survives the material row being deleted. See
  // lib/material-kind.ts for why that matters.
  const analysisPath = useMemo(
    () => materialAnalysisPath(projectId, materialId, parsedContent),
    [projectId, materialId, parsedContent],
  )

  /**
   * #795 — the variables feeding this chart that need recomputing.
   *
   * 🔴 **This replaces a prop that was never once passed.** `InlineChartRenderer`
   * declared `isStale?: boolean` and rendered a "Data stale" indicator from it;
   * `git log -S"isStale"` on this file is EMPTY. The prop was optional, so
   * nothing type-errored and nothing linted — the #624/#626/#627/#630
   * half-landed-wire class. It is gone now, and the signal lives HERE, beside
   * `missingRefs`, which is the one integrity warning on this surface that has
   * always fired: same placement, same treatment, and — because it sits OUTSIDE
   * `InlineChartRenderer`'s `data-chart-capture-root` — the same absence from
   * the exported PNG, which is right for an in-app fix-it prompt.
   *
   * ⚠️ Deliberately NOT a prop again. The old shape died because it depended on
   * a caller remembering; a signal derived where it is rendered cannot be
   * forgotten by a second consumer.
   *
   * ⚠️ Quantitative embeds only. A qualitative chart reads codes and sources,
   * not dataset columns, so there is nothing here that can go stale.
   */
  const isQual = useMemo(() => isQualitativeMaterialConfig(parsedContent), [parsedContent])
  const computeParams = useMemo(() => extractComputeParams(parsedContent), [parsedContent])
  const wantsColumns =
    !isQual && (computeParams.columnIds.length > 0 || computeParams.domainIds.length > 0)

  // Same key + staleTime as the analysis picker, so on a project where that has
  // been open this is a cache read, and N embeds on one canvas share one fetch.
  const { data: analysisColumns } = useQuery({
    queryKey: ['analysis-columns', Number(projectId)],
    queryFn: () => metricsApi.analysisColumns(Number(projectId)),
    enabled: !!projectId && wantsColumns,
    staleTime: 60_000,
  })

  const staleInputs = useMemo(() => {
    if (!analysisColumns) return []
    const all = analysisColumns.datasets.flatMap(d => d.columns)
    return staleComputedInputs(computeParams, all)
  }, [analysisColumns, computeParams])

  /**
   * #808 — the figure baseline.
   *
   * `InlineChartRenderer` reports what it DREW; this compares it to the
   * fingerprint stored on the node. Three states and only one of them speaks:
   * no baseline says nothing (we cannot know what this embed showed last week),
   * a matching baseline says nothing (a tick on every embed would be the noise
   * this must not become), and a differing one names the figure.
   *
   * ⚠️ **The seed is a WRITE, so it happens once and only when there is nothing
   * to lose.** An embed with no baseline adopts the current figures the first
   * time they resolve — which is honest for a pre-existing embed (the marker
   * only ever claims "changed since <date>") and is what "stamp at insert"
   * means for a node whose data arrives after it mounts. It flows through
   * `updateAttributes` like any edit, so the existing save path carries it.
   *
   * ⚠️ **`useState` + a ref, not a bare setter.** The callback fires on every
   * data change, and an unconditional `setState` here re-renders in a loop —
   * the same guard the co-occurrence N callback needs, for the same reason.
   */
  const [figure, setFigure] = useState<FigureFingerprint | null>(null)
  const handleFigure = useCallback((next: FigureFingerprint | null) => {
    setFigure(prev => (prev?.hash === next?.hash ? prev : next))
  }, [])

  const seededRef = useRef(false)
  useEffect(() => {
    if (!figure || figureHash || seededRef.current) return
    seededRef.current = true
    updateAttributes({
      figureHash: figure.hash,
      figureHeadline: figure.headline,
      figureStampedAt: new Date().toISOString().slice(0, 10),
    })
  }, [figure, figureHash, updateAttributes])

  const drift = useMemo(
    () => figureDrift({ hash: figureHash, headline: figureHeadline, stampedAt: figureStampedAt }, figure),
    [figureHash, figureHeadline, figureStampedAt, figure],
  )

  const acceptFigures = useCallback(() => {
    if (!figure) return
    updateAttributes({
      figureHash: figure.hash,
      figureHeadline: figure.headline,
      figureStampedAt: new Date().toISOString().slice(0, 10),
    })
  }, [figure, updateAttributes])

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
          <div className="bg-white dark:bg-mm-surface shadow-sm rounded-md px-4 py-3 border-l-4 border-l-mm-blue">
            <div className="absolute top-2 right-2 flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
              <button
                type="button"
                onClick={deleteNode}
                className="opacity-0 group-hover/material:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded text-mm-text-faint hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
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
                  {describeMissingRefs(missingRefs)}{' '}
                  This chart may render incomplete data.
                </div>
              </div>
            )}

            {/* The wording names the CAUSE, not "Data stale" — this chart's
                figures are re-fetched on every render, so "stale" would be
                false about the one thing a reader would take it to mean. It
                names the variable because "something needs recomputing" sends
                a researcher hunting through forty of them, and links to where
                the fix is (the Variables view carries Recompute per variable). */}
            {staleInputs.length > 0 && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-start gap-2 px-2.5 py-1.5 rounded text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-none mt-px" aria-hidden />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Needs recomputing.</span>{' '}
                  {describeStaleInputs(staleInputs)}{' '}
                  This chart is drawing the earlier values.{' '}
                  {staleInputs.length === 1 && (
                    <Link
                      to={variableViewPath(projectId, staleInputs[0].dataset_id, staleInputs[0].id)}
                      className="underline hover:no-underline"
                    >
                      Open the variable
                    </Link>
                  )}
                </div>
              </div>
            )}

            {/* #808 — the figures moved since the author last accepted them.
                Sits with the other two integrity signals and OUTSIDE
                `data-chart-capture-root`, so it never lands in an exported
                image: it is a prompt for the author, not a note to the reader.
                The before/after is the point — "something changed" sends a
                researcher to re-derive what, which is the work the marker is
                supposed to save. */}
            {drift && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-start gap-2 px-2.5 py-1.5 rounded text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-none mt-px" aria-hidden />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">The figures have changed</span>
                  {drift.stampedAt ? ` since ${drift.stampedAt}.` : '.'}
                  {drift.was && drift.now && ` ${drift.was} is now ${drift.now}.`}{' '}
                  Check the text around this chart still says what the data says.{' '}
                  <button
                    type="button"
                    onClick={acceptFigures}
                    className="underline hover:no-underline font-medium"
                  >
                    Mark as reviewed
                  </button>
                </div>
              </div>
            )}

            {materialId ? (
              <InlineChartRenderer
                projectId={Number(projectId)}
                materialId={Number(materialId)}
                content={parsedContent}
                embedTitle={title ?? null}
                onFigure={handleFigure}
              />
            ) : (
              <p className="text-sm text-mm-text-muted italic">Chart source not available</p>
            )}

            {materialId && (
              <Link
                to={analysisPath}
                className="flex items-center gap-1 text-[11px] text-mm-accent hover:underline mt-1.5 py-1"
                aria-label={`Open ${title || 'this chart'} in Analysis`}
              >
                Open in Analysis <span className="text-[9px]" aria-hidden>{'\u2192'}</span>
              </Link>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {materialId && (
            <>
              <ContextMenuItem onSelect={() => navigate(analysisPath)}>
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
