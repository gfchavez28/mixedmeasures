/**
 * Canvas comparison view — snapshot vs current or side-by-side canvases.
 *
 * URL params:
 *   ?canvas={id}&snapshot={id}  — snapshot comparison (left=snapshot, right=current)
 *   ?canvas={id}&canvas2={id}   — side-by-side (no diff highlighting)
 */
import { useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { EditorContent } from '@tiptap/react'
import type { AnyExtension } from '@tiptap/core'
import { ArrowLeft } from 'lucide-react'
import { canvasApi, type SnapshotRelationship } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useCanvasEditor } from '@/components/canvas/useCanvasEditor'
import { ExcerptEmbed, ChartEmbed, MemoEmbed, CalloutStat, ImageEmbed } from '@/components/canvas/extensions'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Shared extensions for read-only rendering ────────────────────────────────

const readOnlyExtensions: AnyExtension[] = [
  ExcerptEmbed,
  ChartEmbed,
  MemoEmbed,
  CalloutStat,
  ImageEmbed,
]

// ── Read-only theme renderer ─────────────────────────────────────────────────

function ReadOnlyTheme({ name, color, content, diffClass, materialDiff }: {
  name: string
  color: string | null
  content: Record<string, unknown> | null
  diffClass?: string
  materialDiff?: string
}) {
  const parsedContent = useMemo(() => {
    if (!content) return null
    if (typeof content === 'string') {
      try { return JSON.parse(content) } catch { return null }
    }
    return content
  }, [content])

  const { editor } = useCanvasEditor({
    content: parsedContent,
    editable: false,
    additionalExtensions: readOnlyExtensions,
  })

  return (
    <div className={cn('mb-6 pl-3 border-l-4', diffClass ?? 'border-transparent')}>
      <div className="flex items-center gap-2 mb-2">
        {color && <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />}
        <h3 className="text-sm font-semibold text-mm-text">{name}</h3>
      </div>
      {materialDiff && (
        <p className="text-[11px] text-mm-text-muted mb-2">{materialDiff}</p>
      )}
      {editor && (
        <div className="prose-sm max-w-none text-mm-text">
          <EditorContent editor={editor} />
        </div>
      )}
      {!parsedContent && (
        <p className="text-xs text-mm-text-faint italic">No content</p>
      )}
    </div>
  )
}

// ── Diff computation ─────────────────────────────────────────────────────────

interface SourceRef { type: string; id: number }

function parseRefs(raw: string | SourceRef[] | null): SourceRef[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw) } catch { return [] }
}

function refKey(r: SourceRef): string { return `${r.type}:${r.id}` }

function computeMaterialDiff(leftRefs: SourceRef[], rightRefs: SourceRef[]): string {
  const leftSet = new Set(leftRefs.map(refKey))
  const rightSet = new Set(rightRefs.map(refKey))
  const added = rightRefs.filter(r => !leftSet.has(refKey(r))).length
  const removed = leftRefs.filter(r => !rightSet.has(refKey(r))).length
  const parts: string[] = []
  if (added > 0) parts.push(`+${added} material${added !== 1 ? 's' : ''}`)
  if (removed > 0) parts.push(`-${removed} material${removed !== 1 ? 's' : ''}`)
  return parts.join(', ')
}

interface ThemeForCompare {
  name: string
  color: string | null
  content: Record<string, unknown> | null
  referenced_source_ids: string | SourceRef[] | null
}

interface MatchResult {
  matched: { left: ThemeForCompare; right: ThemeForCompare }[]
  leftOnly: ThemeForCompare[]
  rightOnly: ThemeForCompare[]
}

function matchThemes(leftThemes: ThemeForCompare[], rightThemes: ThemeForCompare[]): MatchResult {
  const matched: MatchResult['matched'] = []
  const rightUsed = new Set<number>()

  for (const lt of leftThemes) {
    const key = lt.name.trim().toLowerCase()
    const ri = rightThemes.findIndex((rt, i) => !rightUsed.has(i) && rt.name.trim().toLowerCase() === key)
    if (ri >= 0) {
      matched.push({ left: lt, right: rightThemes[ri] })
      rightUsed.add(ri)
    }
  }

  const leftOnly = leftThemes.filter(lt => !matched.some(m => m.left === lt))
  const rightOnly = rightThemes.filter((_, i) => !rightUsed.has(i))

  return { matched, leftOnly, rightOnly }
}

// ── Relationship diff ────────────────────────────────────────────────────────

function formatRelDiff(
  leftRels: SnapshotRelationship[],
  rightRels: { relationship_type: string; label: string | null; is_bidirectional: boolean; source_name: string; target_name: string }[],
  leftNames: Map<number, string>,
): { added: string[]; removed: string[] } {
  const relKey = (src: string, tgt: string, type: string) => `${src.toLowerCase()}|${tgt.toLowerCase()}|${type}`

  const leftSet = new Map<string, string>()
  for (const r of leftRels) {
    const src = leftNames.get(r.source_theme_id) ?? '?'
    const tgt = leftNames.get(r.target_theme_id) ?? '?'
    const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
    const label = r.relationship_type === 'custom' ? (r.label || '') : r.relationship_type
    leftSet.set(relKey(src, tgt, r.relationship_type), `${src} ${arrow} ${tgt}: ${label}`)
  }

  const rightSet = new Map<string, string>()
  for (const r of rightRels) {
    const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
    const label = r.relationship_type === 'custom' ? (r.label || '') : r.relationship_type
    rightSet.set(relKey(r.source_name, r.target_name, r.relationship_type), `${r.source_name} ${arrow} ${r.target_name}: ${label}`)
  }

  const added = [...rightSet.entries()].filter(([k]) => !leftSet.has(k)).map(([, v]) => v)
  const removed = [...leftSet.entries()].filter(([k]) => !rightSet.has(k)).map(([, v]) => v)
  return { added, removed }
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CanvasCompareView() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { projectId } = useProjectLayout()

  const canvasId = Number(searchParams.get('canvas')) || 0
  const snapshotId = Number(searchParams.get('snapshot')) || 0
  const canvas2Id = Number(searchParams.get('canvas2')) || 0
  const isSnapshotMode = snapshotId > 0
  const isSideBySide = canvas2Id > 0

  // Fetch current canvas (right panel, or left for side-by-side)
  const { data: canvas } = useQuery({
    queryKey: ['canvas', projectId, canvasId],
    queryFn: () => canvasApi.get(projectId, canvasId),
    enabled: canvasId > 0,
  })

  // Fetch snapshot detail (left panel in snapshot mode)
  const { data: snapshot } = useQuery({
    queryKey: ['snapshot-detail', projectId, canvasId, snapshotId],
    queryFn: () => canvasApi.getSnapshot(projectId, canvasId, snapshotId),
    enabled: isSnapshotMode && canvasId > 0,
  })

  // Fetch second canvas (right panel in side-by-side mode)
  const { data: canvas2 } = useQuery({
    queryKey: ['canvas', projectId, canvas2Id],
    queryFn: () => canvasApi.get(projectId, canvas2Id),
    enabled: isSideBySide && canvas2Id > 0,
  })

  // Build theme arrays for comparison
  const leftThemes: ThemeForCompare[] = useMemo(() => {
    if (isSnapshotMode && snapshot?.snapshot_data) {
      return snapshot.snapshot_data.themes
        .sort((a, b) => a.doc_order - b.doc_order)
        .map(t => ({
          name: t.name,
          color: t.color,
          content: t.content as unknown as Record<string, unknown> | null,
          referenced_source_ids: t.referenced_source_ids,
        }))
    }
    if (isSideBySide && canvas) {
      return [...canvas.themes].sort((a, b) => a.doc_order - b.doc_order).map(t => ({
        name: t.name,
        color: t.color,
        content: t.content,
        referenced_source_ids: t.referenced_source_ids,
      }))
    }
    return []
  }, [isSnapshotMode, isSideBySide, snapshot, canvas])

  const rightThemes: ThemeForCompare[] = useMemo(() => {
    const source = isSideBySide ? canvas2 : canvas
    if (!source) return []
    return [...source.themes].sort((a, b) => a.doc_order - b.doc_order).map(t => ({
      name: t.name,
      color: t.color,
      content: t.content,
      referenced_source_ids: t.referenced_source_ids,
    }))
  }, [isSideBySide, canvas, canvas2])

  // Diff computation (snapshot mode only)
  const diff = useMemo(() => {
    if (!isSnapshotMode) return null
    return matchThemes(leftThemes, rightThemes)
  }, [isSnapshotMode, leftThemes, rightThemes])

  // Relationship diff
  const relDiff = useMemo(() => {
    if (!isSnapshotMode || !snapshot?.snapshot_data || !canvas) return null
    const leftRels = snapshot.snapshot_data.relationships
    const leftNames = new Map(snapshot.snapshot_data.themes.map(t => [t.id, t.name]))
    const themeNames = new Map(canvas.themes.map(t => [t.id, t.name]))
    const rightRels: { relationship_type: string; label: string | null; is_bidirectional: boolean; source_name: string; target_name: string }[] = []
    for (const t of canvas.themes) {
      for (const r of (t.relationships_out ?? [])) {
        rightRels.push({
          relationship_type: r.relationship_type,
          label: r.label,
          is_bidirectional: r.is_bidirectional,
          source_name: themeNames.get(r.source_theme_id) ?? '?',
          target_name: themeNames.get(r.target_theme_id) ?? '?',
        })
      }
    }
    return formatRelDiff(leftRels, rightRels, leftNames)
  }, [isSnapshotMode, snapshot, canvas])

  // Labels
  const leftLabel = isSnapshotMode
    ? `Snapshot: ${snapshot?.name ?? '...'} (${snapshot ? formatRelativeTime(snapshot.created_at) : ''})`
    : canvas?.name ?? '...'
  const rightLabel = isSideBySide ? (canvas2?.name ?? '...') : 'Current state'

  const handleBack = () => {
    navigate(`/projects/${projectId}/analysis/canvas?canvas=${canvasId}`)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-mm-border-subtle bg-mm-surface">
        <button
          onClick={handleBack}
          className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
          aria-label="Back to canvas"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-2 text-sm">
          <span className="font-medium text-mm-text truncate max-w-[300px]">{leftLabel}</span>
          <span className="text-mm-text-faint">{'\u2194'}</span>
          <span className="font-medium text-mm-text truncate max-w-[300px]">{rightLabel}</span>
        </div>
      </div>

      {/* Dual panel */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left panel */}
        <div className="flex-1 overflow-auto border-b lg:border-b-0 lg:border-r border-mm-border-subtle">
          <div className="max-w-[600px] mx-auto px-6 py-6">
            {diff ? (
              <>
                {diff.matched.map((m, i) => (
                  <ReadOnlyTheme
                    key={`m-l-${i}`}
                    name={m.left.name}
                    color={m.left.color}
                    content={m.left.content}
                    materialDiff={computeMaterialDiff(
                      parseRefs(m.left.referenced_source_ids),
                      parseRefs(m.right.referenced_source_ids),
                    ) ? `Snapshot: ${computeMaterialDiff(parseRefs(m.left.referenced_source_ids), parseRefs(m.right.referenced_source_ids))}` : undefined}
                  />
                ))}
                {diff.leftOnly.map((t, i) => (
                  <ReadOnlyTheme key={`lo-${i}`} name={t.name} color={t.color} content={t.content} diffClass="border-l-indigo-500" />
                ))}
              </>
            ) : (
              leftThemes.map((t, i) => (
                <ReadOnlyTheme key={`l-${i}`} name={t.name} color={t.color} content={t.content} />
              ))
            )}
            {leftThemes.length === 0 && (
              <p className="text-sm text-mm-text-faint text-center py-8">No themes</p>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-[600px] mx-auto px-6 py-6">
            {diff ? (
              <>
                {diff.matched.map((m, i) => {
                  const md = computeMaterialDiff(
                    parseRefs(m.left.referenced_source_ids),
                    parseRefs(m.right.referenced_source_ids),
                  )
                  return (
                    <ReadOnlyTheme
                      key={`m-r-${i}`}
                      name={m.right.name}
                      color={m.right.color}
                      content={m.right.content}
                      materialDiff={md || undefined}
                    />
                  )
                })}
                {diff.rightOnly.map((t, i) => (
                  <ReadOnlyTheme key={`ro-${i}`} name={t.name} color={t.color} content={t.content} diffClass="border-l-rose-500" />
                ))}
              </>
            ) : (
              rightThemes.map((t, i) => (
                <ReadOnlyTheme key={`r-${i}`} name={t.name} color={t.color} content={t.content} />
              ))
            )}
            {rightThemes.length === 0 && (
              <p className="text-sm text-mm-text-faint text-center py-8">No themes</p>
            )}
          </div>
        </div>
      </div>

      {/* Relationship diff (snapshot mode only) */}
      {relDiff && (relDiff.added.length > 0 || relDiff.removed.length > 0) && (
        <div className="shrink-0 border-t border-mm-border-subtle px-6 py-3 bg-mm-surface max-h-40 overflow-auto">
          <p className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider mb-1">Relationship changes</p>
          <div className="flex gap-6 text-xs">
            {relDiff.added.length > 0 && (
              <div>
                <p className="text-rose-600 dark:text-rose-400 font-medium mb-0.5">Added ({relDiff.added.length})</p>
                {relDiff.added.map((r, i) => <p key={i} className="text-mm-text-muted">{r}</p>)}
              </div>
            )}
            {relDiff.removed.length > 0 && (
              <div>
                <p className="text-indigo-600 dark:text-indigo-400 font-medium mb-0.5">Removed ({relDiff.removed.length})</p>
                {relDiff.removed.map((r, i) => <p key={i} className="text-mm-text-muted">{r}</p>)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
