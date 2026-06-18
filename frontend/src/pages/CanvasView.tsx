import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DndContext, useDroppable, type DragEndEvent } from '@dnd-kit/core'
import { canvasApi, excerptsApi, materialsApi, memosApi, type CanvasListItem, type CanvasDetail, type CanvasTheme, type CanvasSnapshot, type PendingItem } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useHistory } from '@/hooks/useHistory'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Copy, Trash2, Undo2, Redo2, PenLine, LayoutGrid, List, X, PanelRight, Grid3X3, FileText, BarChart3, GitCompare, HelpCircle, Paintbrush, Eye, EyeOff, Camera, RotateCcw, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format'
import { exportCanvasMarkdown, exportCanvasHtml, exportCanvasPdf, captureCanvasChartPngs, downloadFile } from '@/lib/canvas-export'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import InlineEditableText from '@/components/InlineEditableText'
import ThemeContextMenu from '@/components/canvas/ThemeContextMenu'
import { extractMaterialSummary, extractAllMaterialSummaries, computeNestingDepth } from '@/components/canvas/canvas-utils'
import type { InsertNodeHandle } from '@/components/canvas/ThemeEditor'
import WritingCanvas from '@/components/canvas/WritingCanvas'
import SpatialCanvas from '@/components/canvas/SpatialCanvas'
import MaterialsDrawer from '@/components/canvas/MaterialsDrawer'
import ConvergenceMatrix from '@/components/canvas/ConvergenceMatrix'

type CanvasViewMode = 'writing' | 'spatial'

// ── Integration quality helpers ──────────────────────────────────────────────

function computeIntegration(themes: CanvasTheme[]) {
  const result: Record<number, { hasQual: boolean; hasQuant: boolean; hasAnyTag: boolean; sources: string[] }> = {}
  for (const theme of themes) {
    const s = extractMaterialSummary(theme.content)
    result[theme.id] = {
      hasQual: s.excerptCount > 0 || s.memoCount > 0,
      hasQuant: s.chartCount > 0 || s.calloutCount > 0,
      hasAnyTag: s.hasAnyTag,
      sources: s.previews.slice(0, 5),
    }
  }
  return result
}

// ── Droppable wrapper for outline theme items ───────────────────────────────

function OutlineDropTarget({ themeId, children }: { themeId: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `outline-theme-${themeId}`,
    data: { themeId },
  })
  return (
    <div ref={setNodeRef} className={cn('rounded transition-colors', isOver && 'bg-teal-50 dark:bg-teal-900/20')}>
      {children}
    </div>
  )
}

// ── Outline sidebar ──────────────────────────────────────────────────────────

function OutlineSidebar({
  themes,
  pendingItemCount,
  onClose,
  onScrollToTheme,
  focusedThemeId,
  onFocusTheme,
  onMoveTheme,
  onDeleteTheme,
}: {
  themes: CanvasTheme[]
  pendingItemCount: number
  onClose: () => void
  onScrollToTheme: (themeId: number) => void
  focusedThemeId: number | null
  onFocusTheme: (themeId: number | null) => void
  onMoveTheme: (themeId: number, direction: 'up' | 'down') => void
  onDeleteTheme: (themeId: number) => void
}) {
  const [showIntegration, setShowIntegration] = useState(true)
  const [focusMode, setFocusMode] = useState(false)
  const [prevFocused, setPrevFocused] = useState(focusedThemeId)
  const integration = useMemo(() => computeIntegration(themes.filter(t => t.section_type === 'theme')), [themes])
  const depthMap = useMemo(() => computeNestingDepth(themes), [themes])
  const themeSummaries = useMemo(() => {
    const map = new Map<number, ReturnType<typeof extractMaterialSummary>>()
    for (const t of themes) map.set(t.id, extractMaterialSummary(t.content))
    return map
  }, [themes])

  // Clear focus mode only when focusedThemeId transitions from set → null (e.g.
  // Escape key). Done during render (the "adjust state on prop change" pattern)
  // instead of an effect; the guard makes it terminate after one extra render.
  if (focusedThemeId !== prevFocused) {
    if (prevFocused != null && focusedThemeId == null) setFocusMode(false)
    setPrevFocused(focusedThemeId)
  }

  return (
    <div data-canvas-outline className="w-[220px] shrink-0 border-r border-mm-border bg-mm-surface overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-mm-border-subtle">
        <span className="text-xs font-semibold text-mm-text-secondary uppercase tracking-wide">Outline</span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  const next = !focusMode
                  setFocusMode(next)
                  if (next) {
                    const firstTheme = themes.find(t => t.section_type === 'theme')
                    if (firstTheme) onFocusTheme(firstTheme.id)
                  } else {
                    onFocusTheme(null)
                  }
                }}
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors',
                  focusMode
                    ? 'bg-[hsl(var(--mm-teal))] text-white'
                    : 'text-mm-text-muted hover:text-mm-text',
                )}
                aria-pressed={focusMode}
              >
                {focusMode ? 'Show all' : 'Focus'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{focusMode ? 'Show all sections' : 'Show one theme at a time'}</p>
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            onClick={onClose}
            className="p-0.5 rounded text-mm-text-muted hover:text-mm-text transition-colors"
            aria-label="Close outline"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <label className="flex items-center gap-1.5 px-3 pb-2 pt-2 text-[10px] text-mm-text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showIntegration}
          onChange={e => setShowIntegration(e.target.checked)}
          className="w-3 h-3 accent-teal-600"
        />
        Show integration
      </label>
      <nav className="py-2" aria-label="Canvas outline">
        {themes.map((theme, idx) => {
          const isThemeType = theme.section_type === 'theme'
          const info = isThemeType ? integration[theme.id] : null
          const summary = themeSummaries.get(theme.id)
          const materialCount = summary ? summary.excerptCount + summary.chartCount + summary.memoCount + summary.calloutCount : 0
          return (
            <OutlineDropTarget key={theme.id} themeId={theme.id}>
            <ContextMenu>
            <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => {
                onScrollToTheme(theme.id)
                if (focusMode && isThemeType) onFocusTheme(theme.id)
              }}
              className={cn(
                'w-full flex flex-col py-1.5 text-left text-sm hover:bg-mm-bg transition-colors',
                focusedThemeId === theme.id && 'bg-mm-bg',
              )}
              style={{ paddingLeft: 12 + (depthMap.get(theme.id) ?? 0) * 16, paddingRight: 12 }}
            >
              <div className="flex items-center gap-1 min-w-0">
                {isThemeType ? (
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: theme.color ?? '#6366f1' }} />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-mm-border" />
                )}
                <span className={cn('truncate', isThemeType ? 'text-mm-text' : 'text-mm-text-secondary italic')}>{theme.name}</span>
                {showIntegration && info && (
                  <TooltipProvider delayDuration={200} skipDelayDuration={400}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            'text-[9px] font-bold w-[15px] h-[13px] inline-flex items-center justify-center rounded-sm shrink-0',
                            info.hasQual
                              ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300'
                              : 'border border-dashed border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400',
                          )}
                        >
                          Q
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[200px]">
                        <p className="text-xs font-medium">{info.hasQual ? 'Qualitative materials' : 'No qualitative materials'}</p>
                        <p className="text-[11px] text-primary-foreground/70">Excerpts and memos embedded in this theme</p>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            'text-[9px] font-bold w-[15px] h-[13px] inline-flex items-center justify-center rounded-sm shrink-0',
                            info.hasQuant
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                              : 'border border-dashed border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400',
                          )}
                        >
                          N
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[200px]">
                        <p className="text-xs font-medium">{info.hasQuant ? 'Quantitative materials' : 'No quantitative materials'}</p>
                        <p className="text-[11px] text-primary-foreground/70">Charts and callout stats embedded in this theme</p>
                      </TooltipContent>
                    </Tooltip>
                    {!info.hasAnyTag && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-mm-text-faint shrink-0">
                            <HelpCircle className="w-3 h-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-[200px]">
                          <p className="text-xs font-medium">No tags</p>
                          <p className="text-[11px] text-primary-foreground/70">Tag items (confirms, contradicts, etc.) to track integration</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TooltipProvider>
                )}
                <span className="ml-auto text-xs text-mm-text-secondary tabular-nums shrink-0">{materialCount}</span>
              </div>
              {showIntegration && info && info.sources.length > 0 && (
                <div className="text-[9px] text-mm-text-muted leading-tight truncate pl-3">
                  {info.sources.slice(0, 3).join(', ')}
                  {info.sources.length > 3 && ` +${info.sources.length - 3} more`}
                </div>
              )}
            </button>
            </ContextMenuTrigger>
            <ThemeContextMenu
              theme={theme}
              isFirst={idx === 0}
              isLast={idx === themes.length - 1}
              isTheme={isThemeType}
              isFocused={focusedThemeId === theme.id}
              onMoveUp={() => onMoveTheme(theme.id, 'up')}
              onMoveDown={() => onMoveTheme(theme.id, 'down')}
              onConvert={() => {}} // not supported from outline
              onFocus={isThemeType ? () => onFocusTheme(theme.id) : undefined}
              onDelete={() => onDeleteTheme(theme.id)}
            />
            </ContextMenu>
            </OutlineDropTarget>
          )
        })}
        {pendingItemCount > 0 && (
          <button
            type="button"
            onClick={() => {
              document.getElementById('unsorted-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-mm-bg transition-colors"
          >
            <div className="w-2 h-2 rounded-full shrink-0 bg-mm-border" />
            <span className="truncate text-mm-text-secondary">Unsorted</span>
            <span className="ml-auto text-xs text-mm-text-secondary tabular-nums shrink-0">{pendingItemCount}</span>
          </button>
        )}
      </nav>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CanvasView() {
  const { projectId, setBreadcrumbLabel } = useProjectLayout()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const canvasIdParam = searchParams.get('canvas')
  const canvasId = canvasIdParam ? Number(canvasIdParam) : null

  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null)
  const [deleteThemeTarget, setDeleteThemeTarget] = useState<{ id: number; name: string; materialCount: number; childCount: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [newCanvasDialogOpen, setNewCanvasDialogOpen] = useState(false)
  const [newCanvasName, setNewCanvasName] = useState('')
  const [outlineOpen, setOutlineOpen] = useState(true)
  const history = useHistory()

  // Focus tracking for material insertion
  const focusedEditorRef = useRef<{ themeId: number | null; insertNode: InsertNodeHandle | null } | null>(null)
  const themeInsertNodeRefs = useRef(new Map<number, { current: InsertNodeHandle | null }>())

  // Materials drawer state
  const [drawerOpen, setDrawerOpen] = useState(() =>
    localStorage.getItem(`mm-canvas-drawer-${projectId}`) === 'true',
  )
  const [matrixOpen, setMatrixOpen] = useState(false)
  const [drawerSection, setDrawerSection] = useState<'excerpts' | 'charts' | 'memos' | null>(null)
  const [focusedThemeId, setFocusedThemeId] = useState<number | null>(null)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [insertingId, setInsertingId] = useState<number | null>(null)
  const [showColorBars, setShowColorBars] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<{ id: number; name: string } | null>(null)
  const [snapshotPopoverOpen, setSnapshotPopoverOpen] = useState(false)
  const [snapshotName, setSnapshotName] = useState('')
  const [restoreTarget, setRestoreTarget] = useState<CanvasSnapshot | null>(null)

  const toggleDrawer = useCallback((section?: 'excerpts' | 'charts' | 'memos') => {
    setDrawerOpen(prev => {
      const next = section ? true : !prev
      localStorage.setItem(`mm-canvas-drawer-${projectId}`, String(next))
      return next
    })
    if (section) setDrawerSection(section)
  }, [projectId])

  // View mode (writing/spatial) persisted in localStorage
  const [view, setView] = useState<CanvasViewMode>(() =>
    (localStorage.getItem(`mm-canvas-view-${projectId}`) as CanvasViewMode) || 'writing',
  )

  const handleSetView = useCallback((v: CanvasViewMode) => {
    setView(v)
    localStorage.setItem(`mm-canvas-view-${projectId}`, v)
  }, [projectId])

  // Persist last-analysis
  useEffect(() => {
    localStorage.setItem(`mm-last-analysis-${projectId}`, 'canvas')
  }, [projectId])

  // Canvas list (always fetch all including archived, filter client-side)
  const { data: allCanvases = [] } = useQuery({
    queryKey: ['canvases', projectId],
    queryFn: () => canvasApi.list(projectId, true),
    enabled: !isNaN(projectId),
    staleTime: 30_000,
  })
  const activeCanvases = useMemo(() => allCanvases.filter(c => !c.is_archived), [allCanvases])
  const archivedCanvases = useMemo(() => allCanvases.filter(c => c.is_archived), [allCanvases])
  const isCurrentArchived = canvasId != null && allCanvases.some(c => c.id === canvasId && c.is_archived)

  // Auto-select first active canvas if none selected
  useEffect(() => {
    if (!canvasId && activeCanvases.length > 0) {
      setSearchParams({ canvas: String(activeCanvases[0].id) }, { replace: true })
    }
  }, [activeCanvases, canvasId, setSearchParams])

  // Canvas detail
  const { data: canvas, isLoading: canvasLoading } = useQuery({
    queryKey: ['canvas', projectId, canvasId],
    queryFn: () => canvasApi.get(projectId, canvasId!),
    enabled: canvasId != null && !isNaN(projectId),
    staleTime: 10_000,
  })

  // Snapshots
  const { data: snapshots = [] } = useQuery({
    queryKey: ['snapshots', projectId, canvasId],
    queryFn: () => canvasApi.listSnapshots(projectId, canvasId!),
    enabled: canvasId != null && !isNaN(projectId),
    staleTime: 30_000,
  })

  // Set breadcrumb
  useEffect(() => {
    if (canvas?.name) setBreadcrumbLabel(canvas.name)
  }, [canvas?.name, setBreadcrumbLabel])

  // Derived data
  const themes = useMemo(
    () => canvas ? [...canvas.themes].sort((a, b) => a.doc_order - b.doc_order) : [],
    [canvas],
  )
  // Themes only (excludes prose sections) — for Spatial View, Convergence Matrix, integration
  const analyticalThemes = useMemo(
    () => themes.filter(t => t.section_type === 'theme'),
    [themes],
  )

  // "Already on canvas" source ID sets (derived from theme content)
  const onCanvasSourceIds = useMemo(() => {
    if (!canvas) return { onCanvasExcerptIds: new Set<number>(), onCanvasMaterialIds: new Set<number>(), onCanvasMemoIds: new Set<number>() }
    return extractAllMaterialSummaries(canvas.themes)
  }, [canvas])

  const invalidateCanvas = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['canvas', projectId, canvasId] })
    queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
  }, [queryClient, projectId, canvasId])

  // ── Mutations ──────────────────────────────────────────────────────────

  const createCanvasMut = useMutation({
    mutationFn: (name: string | undefined) => canvasApi.create(projectId, name),
    onSuccess: (data: CanvasDetail) => {
      queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
      setSearchParams({ canvas: String(data.id) })
      toast.success('Canvas created')
      if (data.themes.length === 0) {
        setShowTemplatePicker(true)
      }
    },
  })

  const updateCanvasMut = useMutation({
    mutationFn: (data: { name?: string; introduction?: Record<string, unknown> | null }) =>
      canvasApi.update(projectId, canvasId!, data),
    onSuccess: invalidateCanvas,
  })

  const archiveCanvasMut = useMutation({
    mutationFn: (id: number) => canvasApi.delete(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
      if (deleteTarget?.id === canvasId) {
        setSearchParams({}, { replace: true })
      }
      setDeleteTarget(null)
      toast.success('Canvas archived')
    },
  })

  const permanentDeleteCanvasMut = useMutation({
    mutationFn: (id: number) => canvasApi.delete(projectId, id, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
      if (permanentDeleteTarget?.id === canvasId) {
        setSearchParams({}, { replace: true })
      }
      setPermanentDeleteTarget(null)
      toast.success('Canvas permanently deleted')
    },
  })

  const restoreCanvasMut = useMutation({
    mutationFn: (id: number) => canvasApi.update(projectId, id, { is_archived: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
      invalidateCanvas()
      toast.success('Canvas restored')
    },
  })

  const createSnapshotMut = useMutation({
    mutationFn: (name: string) => canvasApi.createSnapshot(projectId, canvasId!, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snapshots', projectId, canvasId] })
      setSnapshotName('')
      toast.success('Snapshot saved')
    },
  })

  const restoreSnapshotMut = useMutation({
    mutationFn: (snapshotId: number) => canvasApi.restoreSnapshot(projectId, canvasId!, snapshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas', projectId, canvasId] })
      queryClient.invalidateQueries({ queryKey: ['snapshots', projectId, canvasId] })
      setRestoreTarget(null)
      toast.success('Snapshot restored')
    },
  })

  const deleteSnapshotMut = useMutation({
    mutationFn: (snapshotId: number) => canvasApi.deleteSnapshot(projectId, canvasId!, snapshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snapshots', projectId, canvasId] })
      toast.success('Snapshot deleted')
    },
  })

  const duplicateCanvasMut = useMutation({
    mutationFn: () => canvasApi.duplicate(projectId, canvasId!),
    onSuccess: (data: CanvasDetail) => {
      queryClient.invalidateQueries({ queryKey: ['canvases', projectId] })
      setSearchParams({ canvas: String(data.id) })
      toast.success('Canvas duplicated')
    },
  })

  const createThemeMut = useMutation({
    mutationFn: (data: { name: string; color?: string }) => canvasApi.createTheme(projectId, canvasId!, data),
    onSuccess: invalidateCanvas,
  })

  const updateThemeMut = useMutation({
    mutationFn: ({ themeId, data }: { themeId: number; data: { name?: string; color?: string; viz_x?: number; viz_y?: number; parent_theme_id?: number | null } }) =>
      canvasApi.updateTheme(projectId, canvasId!, themeId, data),
    onSuccess: invalidateCanvas,
  })

  const deleteThemeMut = useMutation({
    mutationFn: (themeId: number) => canvasApi.deleteTheme(projectId, canvasId!, themeId),
    onSuccess: (_data, deletedId) => {
      setDeleteThemeTarget(null)
      toast.success('Theme deleted')
      setFocusedThemeId(prev => prev === deletedId ? null : prev)
      invalidateCanvas()
    },
  })

  const reorderThemesMut = useMutation({
    mutationFn: (themeIds: number[]) => canvasApi.reorderThemes(projectId, canvasId!, themeIds),
    onSuccess: invalidateCanvas,
  })

  const updateRelMut = useMutation({
    mutationFn: ({ relId, data }: { relId: number; data: Record<string, unknown> }) =>
      canvasApi.updateRelationship(projectId, canvasId!, relId, data),
    onSuccess: invalidateCanvas,
  })

  const deleteRelMut = useMutation({
    mutationFn: (relId: number) => canvasApi.deleteRelationship(projectId, canvasId!, relId),
    onSuccess: invalidateCanvas,
  })

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleCanvasSelect = useCallback((value: string) => {
    if (value === '__new__') {
      setNewCanvasName('')
      setNewCanvasDialogOpen(true)
    } else if (value === '__toggle_archived__') {
      setShowArchived(prev => !prev)
    } else {
      setSearchParams({ canvas: value })
    }
  }, [setSearchParams])

  const handleCreateCanvasSubmit = useCallback(() => {
    const name = newCanvasName.trim()
    if (!name) return
    createCanvasMut.mutate(name)
    setNewCanvasDialogOpen(false)
    setNewCanvasName('')
  }, [newCanvasName, createCanvasMut])

  const handleRenameSave = useCallback((name: string) => {
    updateCanvasMut.mutate({ name })
  }, [updateCanvasMut])

  const handleExportMarkdown = useCallback(async () => {
    if (!canvas) return
    const toastId = toast.loading('Exporting as Markdown...')
    try {
      const md = await exportCanvasMarkdown(canvas, themes, projectId)
      downloadFile(md, `${canvas.name}.md`, 'text/markdown')
      toast.success('Exported as Markdown', { id: toastId })
    } catch {
      toast.error('Export failed', { id: toastId })
    }
  }, [canvas, themes, projectId])

  const handleExportHtml = useCallback(async () => {
    if (!canvas) return
    const toastId = toast.loading('Exporting as HTML...')
    try {
      const html = await exportCanvasHtml(canvas, themes, projectId)
      downloadFile(html, `${canvas.name}.html`, 'text/html')
      toast.success('Exported as HTML', { id: toastId })
    } catch {
      toast.error('Export failed', { id: toastId })
    }
  }, [canvas, themes, projectId])

  // Charts can only be captured from the live DOM, which exists in the Writing view
  // (all themes mount there). Warn once when a canvas has charts but none were
  // captured (e.g. exporting from the Spatial view) so exports silently dropping
  // chart images is explainable rather than mysterious.
  const warnIfChartsUncaptured = useCallback((pngs: Map<number, string>) => {
    if (pngs.size > 0) return
    const hasCharts = themes.some(t =>
      (typeof t.content === 'string' ? t.content : JSON.stringify(t.content ?? '')).includes('chart-embed'),
    )
    if (hasCharts) {
      toast.message('Switch to the Writing view to include chart images', {
        description: 'Charts are captured from the Writing view; this export uses data tables instead.',
        duration: 6000,
      })
    }
  }, [themes])

  const handleExportPdf = useCallback(async () => {
    if (!canvas) return
    const toastId = toast.loading('Preparing PDF…')
    try {
      const pngs = await captureCanvasChartPngs()
      warnIfChartsUncaptured(pngs)
      toast.dismiss(toastId)
      await exportCanvasPdf(canvas, themes, projectId, pngs)
    } catch {
      toast.error('PDF export failed', { id: toastId })
    }
  }, [canvas, themes, projectId, warnIfChartsUncaptured])

  const handleExportDocx = useCallback(async () => {
    if (!canvas || !canvasId) return
    const toastId = toast.loading('Exporting as Word…')
    try {
      const pngs = await captureCanvasChartPngs()
      warnIfChartsUncaptured(pngs)
      await canvasApi.exportDocx(projectId, canvasId, pngs, canvas.name)
      toast.success('Exported as Word', { id: toastId })
    } catch {
      toast.error('Word export failed', { id: toastId })
    }
  }, [canvas, canvasId, projectId, warnIfChartsUncaptured])

  const handleUpdateTheme = useCallback((themeId: number, data: { name?: string; section_type?: 'theme' | 'prose'; color?: string; viz_x?: number; viz_y?: number; parent_theme_id?: number | null }) => {
    updateThemeMut.mutate({ themeId, data })
  }, [updateThemeMut])

  const handleCreateTheme = useCallback((data: { name: string; section_type?: 'theme' | 'prose'; color?: string; after_theme_id?: number; viz_x?: number; viz_y?: number }) => {
    let createdThemeId: number | null = null
    history.execute({
      type: 'canvas_theme_create',
      description: `Create theme "${data.name}"`,
      redo: async () => {
        const theme = await canvasApi.createTheme(projectId, canvasId!, data)
        createdThemeId = theme.id
        invalidateCanvas()
      },
      undo: async () => {
        if (createdThemeId) {
          await canvasApi.deleteTheme(projectId, canvasId!, createdThemeId)
          invalidateCanvas()
        }
      },
    })
  }, [history, projectId, canvasId, invalidateCanvas])

  const executeThemeDelete = useCallback((themeId: number) => {
    const theme = canvas?.themes.find(t => t.id === themeId)
    if (!theme) { deleteThemeMut.mutate(themeId); return }

    const captured = { name: theme.name, color: theme.color ?? undefined }
    let currentThemeId = themeId

    history.execute({
      type: 'canvas_theme_delete',
      description: `Delete theme "${captured.name}"`,
      redo: async () => {
        await canvasApi.deleteTheme(projectId, canvasId!, currentThemeId)
        setFocusedThemeId(prev => prev === currentThemeId ? null : prev)
        invalidateCanvas()
      },
      undo: async () => {
        const restored = await canvasApi.createTheme(projectId, canvasId!, captured)
        currentThemeId = restored.id
        invalidateCanvas()
      },
    })
  }, [canvas?.themes, history, projectId, canvasId, deleteThemeMut, invalidateCanvas])

  const handleDeleteTheme = useCallback((themeId: number) => {
    const theme = canvas?.themes.find(t => t.id === themeId)
    if (!theme) return
    const summary = extractMaterialSummary(theme.content)
    const materialCount = summary.excerptCount + summary.chartCount + summary.memoCount + summary.calloutCount
    const childCount = canvas?.themes.filter(t => t.parent_theme_id === themeId).length ?? 0
    if (materialCount === 0 && childCount === 0) {
      executeThemeDelete(themeId)
    } else {
      setDeleteThemeTarget({ id: themeId, name: theme.name, materialCount, childCount })
    }
  }, [canvas?.themes, executeThemeDelete])

  const handleReorderThemes = useCallback((themeIds: number[]) => {
    reorderThemesMut.mutate(themeIds)
  }, [reorderThemesMut])

  const handleMoveTheme = useCallback((themeId: number, direction: 'up' | 'down') => {
    const idx = themes.findIndex(t => t.id === themeId)
    if (idx === -1) return
    const swap = direction === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= themes.length) return
    const ids = themes.map(t => t.id)
    ;[ids[idx], ids[swap]] = [ids[swap], ids[idx]]
    handleReorderThemes(ids)
  }, [themes, handleReorderThemes])

  // ── Material insertion handlers (insert Tiptap nodes via focusedEditorRef) ──

  const handleInsertExcerpt = useCallback(async (excerptId: number) => {
    const ref = focusedEditorRef.current
    if (!ref?.insertNode) { toast.info(themes.length > 0 ? 'Click into a theme editor first' : 'Create a theme first'); return }
    if (ref.themeId === null) { toast.info('Switch to a theme to embed materials'); return }
    setInsertingId(excerptId)
    try {
      const e = await excerptsApi.get(projectId, excerptId)
      ref.insertNode.insertExcerpt({
        excerptId: e.id,
        displayText: e.excerpt_text,
        sourceContext: e.conversation_name ?? '',
        conversationId: e.conversation_id,
      })
      invalidateCanvas()
    } catch { toast.error('Failed to load excerpt') }
    finally { setInsertingId(null) }
  }, [projectId, themes.length, invalidateCanvas])

  const handleInsertMaterial = useCallback(async (materialId: number) => {
    const ref = focusedEditorRef.current
    if (!ref?.insertNode) { toast.info(themes.length > 0 ? 'Click into a theme editor first' : 'Create a theme first'); return }
    if (ref.themeId === null) { toast.info('Switch to a theme to embed materials'); return }
    setInsertingId(materialId)
    try {
      // Use query cache first, fall back to fresh fetch
      let materials = queryClient.getQueryData<Array<{ id: number; config: Record<string, unknown>; auto_name: string; custom_name: string | null }>>(['materials-all', projectId])
      if (!materials) materials = await materialsApi.listAllMaterials(projectId)
      const m = materials?.find(x => x.id === materialId)
      if (!m) { toast.error('Material not found'); return }
      ref.insertNode.insertChart({
        materialId: m.id,
        config: JSON.stringify(m.config),
        title: m.custom_name ?? m.auto_name,
      })
      invalidateCanvas()
    } catch { toast.error('Failed to load chart data') }
    finally { setInsertingId(null) }
  }, [projectId, themes.length, queryClient, invalidateCanvas])

  const handleInsertMemo = useCallback(async (memoId: number) => {
    const ref = focusedEditorRef.current
    if (!ref?.insertNode) { toast.info(themes.length > 0 ? 'Click into a theme editor first' : 'Create a theme first'); return }
    if (ref.themeId === null) { toast.info('Switch to a theme to embed materials'); return }
    setInsertingId(memoId)
    try {
      const m = await memosApi.get(projectId, memoId)
      ref.insertNode.insertMemo({
        memoId: m.id,
        numericId: m.numeric_id,
        title: m.title ?? '',
        preview: (m.content ?? '').slice(0, 200),
      })
      invalidateCanvas()
    } catch { toast.error('Failed to load memo') }
    finally { setInsertingId(null) }
  }, [projectId, themes.length, invalidateCanvas])

  // ── Pending item handlers ─────────────────────────────────────────

  const handleRemovePendingItem = useCallback((itemId: number) => {
    if (!canvasId) return
    canvasApi.removePendingItem(projectId, canvasId, itemId).then(invalidateCanvas)
  }, [projectId, canvasId, invalidateCanvas])

  const handleInsertPendingItem = useCallback(async (item: PendingItem) => {
    const ref = focusedEditorRef.current
    if (!ref?.insertNode) { toast.info(themes.length > 0 ? 'Click into a theme editor first' : 'Create a theme first'); return }
    if (ref.themeId === null) { toast.info('Switch to a theme to embed materials'); return }
    try {
      if (item.item_type === 'excerpt') {
        const e = await excerptsApi.get(projectId, item.source_id)
        ref.insertNode.insertExcerpt({ excerptId: e.id, displayText: e.excerpt_text, sourceContext: e.conversation_name ?? '', conversationId: e.conversation_id })
      } else if (item.item_type === 'material') {
        const materials = await materialsApi.listAllMaterials(projectId)
        const m = materials?.find(x => x.id === item.source_id)
        if (m) ref.insertNode.insertChart({ materialId: m.id, config: JSON.stringify(m.config), title: m.custom_name ?? m.auto_name })
      } else if (item.item_type === 'memo') {
        const m = await memosApi.get(projectId, item.source_id)
        ref.insertNode.insertMemo({ memoId: m.id, numericId: m.numeric_id, title: m.title ?? '', preview: (m.content ?? '').slice(0, 200) })
      }
      if (canvasId) canvasApi.removePendingItem(projectId, canvasId, item.id).then(invalidateCanvas)
    } catch { toast.error('Failed to embed material') }
  }, [projectId, canvasId, themes.length, invalidateCanvas])

  // ── Relationship handlers (undoable) ──────────────────────────────

  const handleCreateRelationship = useCallback((data: {
    source_theme_id: number
    target_theme_id: number
    relationship_type: string
    label?: string
    is_bidirectional?: boolean
    line_style?: string
    line_color?: string
  }) => {
    let createdRelId: number | null = null
    history.execute({
      type: 'canvas_relationship_create',
      description: `Create "${data.relationship_type}" relationship`,
      redo: async () => {
        const rel = await canvasApi.createRelationship(projectId, canvasId!, data)
        createdRelId = rel.id
        invalidateCanvas()
      },
      undo: async () => {
        if (createdRelId) {
          await canvasApi.deleteRelationship(projectId, canvasId!, createdRelId)
          invalidateCanvas()
        }
      },
    })
  }, [history, projectId, canvasId, invalidateCanvas])

  const handleDeleteRelationship = useCallback((relId: number) => {
    // Find the relationship data for undo
    let capturedData: {
      source_theme_id: number
      target_theme_id: number
      relationship_type: string
      label?: string
      is_bidirectional?: boolean
      line_style?: string | null
      line_color?: string | null
    } | null = null

    if (canvas) {
      for (const theme of canvas.themes) {
        const rel = theme.relationships_out.find(r => r.id === relId)
        if (rel) {
          capturedData = {
            source_theme_id: rel.source_theme_id,
            target_theme_id: rel.target_theme_id,
            relationship_type: rel.relationship_type,
            label: rel.label ?? undefined,
            is_bidirectional: rel.is_bidirectional,
            line_style: rel.line_style,
            line_color: rel.line_color,
          }
          break
        }
      }
    }

    if (!capturedData) {
      deleteRelMut.mutate(relId)
      return
    }

    const captured = capturedData
    let currentRelId = relId

    history.execute({
      type: 'canvas_relationship_delete',
      description: `Delete "${captured.relationship_type}" relationship`,
      redo: async () => {
        await canvasApi.deleteRelationship(projectId, canvasId!, currentRelId)
        invalidateCanvas()
      },
      undo: async () => {
        const restored = await canvasApi.createRelationship(projectId, canvasId!, captured)
        currentRelId = restored.id
        invalidateCanvas()
      },
    })
  }, [canvas, history, projectId, canvasId, deleteRelMut, invalidateCanvas])

  // Scroll to theme for outline sidebar
  const scrollToTheme = useCallback((themeId: number) => {
    document.getElementById(`theme-${themeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // ── Drag-to-outline: assign unsorted block to theme ────────────────

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || !canvasId) return

    // Pending item drag → theme in outline
    const pendingItemId = active.data.current?.pendingItemId as number | undefined
    const itemType = active.data.current?.itemType as string | undefined
    const sourceId = active.data.current?.sourceId as number | undefined
    const themeId = over.data.current?.themeId as number | undefined

    if (pendingItemId && itemType && sourceId && themeId) {
      // Look up the target theme's insertNodeRef
      const targetRef = themeInsertNodeRefs.current.get(themeId)
      if (!targetRef?.current) {
        toast.info('Theme editor not ready')
        return
      }
      try {
        if (itemType === 'excerpt') {
          const e = await excerptsApi.get(projectId, sourceId)
          targetRef.current.insertExcerpt({ excerptId: e.id, displayText: e.excerpt_text, sourceContext: e.conversation_name ?? '', conversationId: e.conversation_id })
        } else if (itemType === 'material') {
          const materials = await materialsApi.listAllMaterials(projectId)
          const m = materials?.find(x => x.id === sourceId)
          if (m) targetRef.current.insertChart({ materialId: m.id, config: JSON.stringify(m.config), title: m.custom_name ?? m.auto_name })
        } else if (itemType === 'memo') {
          const m = await memosApi.get(projectId, sourceId)
          targetRef.current.insertMemo({ memoId: m.id, numericId: m.numeric_id, title: m.title ?? '', preview: (m.content ?? '').slice(0, 200) })
        }
        canvasApi.removePendingItem(projectId, canvasId, pendingItemId).then(invalidateCanvas)
        setAnnouncement('Material inserted into theme')
      } catch {
        toast.error('Failed to embed material')
      }
      return
    }

  }, [projectId, canvasId, invalidateCanvas])

  // ── Template application ──────────────────────────────────────────

  const applyTemplate = useCallback(async (template: 'blank' | 'from_analysis' | 'comparison' | 'research_questions') => {
    setShowTemplatePicker(false)
    if (!canvasId) return

    if (template === 'blank') {
      // Create default Introduction prose section
      await canvasApi.createTheme(projectId, canvasId, { name: 'Introduction', section_type: 'prose' })
      invalidateCanvas()
      return
    }

    if (template === 'comparison') {
      const theme1 = await canvasApi.createTheme(projectId, canvasId, { name: 'Theme A', color: '#10b981' })
      const theme2 = await canvasApi.createTheme(projectId, canvasId, { name: 'Theme B', color: '#ef4444' })
      await canvasApi.createRelationship(projectId, canvasId, {
        source_theme_id: theme1.id,
        target_theme_id: theme2.id,
        relationship_type: 'contradicts',
      })
      invalidateCanvas()
      return
    }

    if (template === 'research_questions') {
      await canvasApi.createTheme(projectId, canvasId, { name: 'RQ1', color: '#6366f1' })
      await canvasApi.createTheme(projectId, canvasId, { name: 'RQ2', color: '#8b5cf6' })
      await canvasApi.createTheme(projectId, canvasId, { name: 'RQ3', color: '#a855f7' })
      invalidateCanvas()
      return
    }

    if (template === 'from_analysis') {
      // Create themes grouped by analysis source tab
      try {
        const materials = await import('@/lib/api').then(m => m.materialsApi.listAllMaterials(projectId))
        const tabs = new Set(materials.map(x => x.source_tab))
        const tabColors: Record<string, string> = {
          quantitative: '#3b82f6',
          'qualitative-codes': '#10b981',
          'qualitative-quotes': '#f59e0b',
        }
        for (const tab of tabs) {
          const label = tab.replace(/^qualitative-/, 'Qual: ').replace(/^quantitative$/, 'Quantitative')
          await canvasApi.createTheme(projectId, canvasId, {
            name: label.charAt(0).toUpperCase() + label.slice(1),
            color: tabColors[tab] ?? '#6366f1',
          })
        }
        if (tabs.size === 0) {
          await canvasApi.createTheme(projectId, canvasId, { name: 'Analysis', color: '#6366f1' })
        }
        invalidateCanvas()
      } catch {
        toast.error('Could not load analysis data')
      }
    }
  }, [canvasId, projectId, invalidateCanvas])

  // ── Keyboard handler ────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!canvas) return
      const t = e.target as HTMLElement
      const inInput = t instanceof HTMLInputElement
        || t instanceof HTMLTextAreaElement
        || t.isContentEditable

      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y -- only outside contenteditable/inputs
      if (!inInput && (e.ctrlKey || e.metaKey)) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); if (history.canUndo) history.undo(); return }
        if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); if (history.canRedo) history.redo(); return }
      }

      // Ctrl+E — toggle materials drawer (works in all contexts)
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault()
        toggleDrawer()
        return
      }

      // Escape — exit focus mode
      if (!inInput && e.key === 'Escape' && focusedThemeId != null) {
        e.preventDefault()
        setFocusedThemeId(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canvas, history, toggleDrawer, focusedThemeId])

  // ── No canvases state ──────────────────────────────────────────────────

  if (activeCanvases.length === 0 && archivedCanvases.length === 0 && !canvasLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold text-mm-text mb-2">Create your first canvas</h2>
          <p className="text-sm text-mm-text-muted mb-4">
            Canvases let you compose qualitative and quantitative findings into an integrated analytical narrative.
          </p>
          <button
            onClick={() => { setNewCanvasName(''); setNewCanvasDialogOpen(true) }}
            disabled={createCanvasMut.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-purple))] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            New Canvas
          </button>
          {/* Create canvas dialog */}
          <Dialog open={newCanvasDialogOpen} onOpenChange={(open) => { if (!open) { setNewCanvasDialogOpen(false); setNewCanvasName('') } }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create Canvas</DialogTitle>
              </DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); handleCreateCanvasSubmit() }} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="canvas-name">Canvas name</Label>
                  <Input
                    id="canvas-name"
                    value={newCanvasName}
                    onChange={(e) => setNewCanvasName(e.target.value)}
                    placeholder="e.g., Thematic Analysis"
                    autoFocus
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" size="sm" onClick={() => { setNewCanvasDialogOpen(false); setNewCanvasName('') }}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!newCanvasName.trim() || createCanvasMut.isPending}>
                    {createCanvasMut.isPending ? 'Creating...' : 'Create'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Print-only title */}
      <h1 data-canvas-print-title className="hidden text-lg font-semibold px-3.5 py-2 print:block">
        {canvas?.name ?? 'Canvas'}
      </h1>

      {/* Toolbar */}
      <div data-canvas-toolbar className="shrink-0 flex items-center gap-2 px-3.5 py-2 border-b border-mm-border-subtle bg-mm-surface">
        {/* Canvas selector — `[&>span]:truncate` + `min-w-0` together ensure the
            SelectValue's text gets ellipsis instead of wrapping above/below the
            fixed-height (h-8) trigger when the canvas name is long. Native
            `title` on hover shows the full name without competing with the
            dropdown open gesture. */}
        <Select value={canvasId ? String(canvasId) : ''} onValueChange={handleCanvasSelect}>
          <SelectTrigger
            className="w-48 h-8 text-sm min-w-0 [&>span]:truncate [&>span]:min-w-0"
            aria-label="Select canvas"
            title={canvas?.name}
          >
            <SelectValue placeholder="Select canvas..." />
          </SelectTrigger>
          <SelectContent>
            {activeCanvases.map((c: CanvasListItem) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
            {archivedCanvases.length > 0 && (
              <>
                <SelectItem value="__toggle_archived__" className="text-mm-text-muted text-xs">
                  <span className="flex items-center gap-1">
                    {showArchived ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    {showArchived ? 'Hide archived' : `Archived (${archivedCanvases.length})`}
                  </span>
                </SelectItem>
                {showArchived && archivedCanvases.map((c: CanvasListItem) => (
                  <SelectItem key={c.id} value={String(c.id)} className="italic text-mm-text-faint">
                    {c.name}
                  </SelectItem>
                ))}
              </>
            )}
            <SelectItem value="__new__" className="text-mm-purple-text font-medium">
              <span className="flex items-center gap-1">
                <Plus className="w-3 h-3" />
                New canvas...
              </span>
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Canvas name */}
        {canvas && (
          <InlineEditableText
            value={canvas.name}
            placeholder="Canvas name"
            onSave={handleRenameSave}
            className="text-sm font-semibold text-mm-text"
            allowEmpty={false}
          />
        )}

        {/* View toggle */}
        <div className="ml-auto flex items-center gap-0.5 bg-mm-surface-secondary rounded p-0.5 border border-mm-border-subtle">
          <button
            onClick={() => handleSetView('writing')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors',
              view === 'writing'
                ? 'bg-white dark:bg-mm-surface shadow-sm text-mm-text'
                : 'text-mm-text-muted hover:text-mm-text',
            )}
            aria-pressed={view === 'writing'}
          >
            <PenLine className="w-3 h-3" />
            Writing
          </button>
          <button
            onClick={() => handleSetView('spatial')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors',
              view === 'spatial'
                ? 'bg-white dark:bg-mm-surface shadow-sm text-mm-text'
                : 'text-mm-text-muted hover:text-mm-text',
            )}
            aria-pressed={view === 'spatial'}
          >
            <LayoutGrid className="w-3 h-3" />
            Spatial
          </button>
        </div>

        {/* Actions */}
        {canvas && (
          <div className="flex items-center gap-1">
            <button
              disabled={!history.canUndo}
              onClick={() => history.undo()}
              className="p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              disabled={!history.canRedo}
              onClick={() => history.redo()}
              className="p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
              title="Redo (Ctrl+Y)"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            <div className="w-px h-4 bg-mm-border-subtle mx-0.5" />
            {/* Outline toggle */}
            {themes.length >= 3 && (
              <button
                onClick={() => setOutlineOpen(o => !o)}
                className={cn(
                  'p-1.5 rounded transition-colors',
                  outlineOpen
                    ? 'bg-[hsl(var(--mm-blue)/0.1)] text-[hsl(var(--mm-blue-text))]'
                    : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-bg',
                )}
                title="Toggle outline"
                aria-pressed={outlineOpen}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Convergence matrix toggle */}
            <button
              type="button"
              onClick={() => setMatrixOpen(prev => !prev)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors',
                matrixOpen
                  ? 'bg-[hsl(var(--mm-blue)/0.1)] text-[hsl(var(--mm-blue-text))]'
                  : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-surface-secondary',
              )}
              title="Convergence Matrix"
              aria-pressed={matrixOpen}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
              Matrix
            </button>
            {/* Color bar toggle */}
            <button
              type="button"
              onClick={() => setShowColorBars(prev => !prev)}
              className={cn(
                'p-1.5 rounded transition-colors',
                !showColorBars
                  ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                  : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-bg',
              )}
              title={showColorBars ? 'Hide color bars' : 'Show color bars'}
              aria-pressed={!showColorBars}
            >
              <Paintbrush className="w-3.5 h-3.5" />
            </button>
            {/* Materials drawer toggle */}
            <button
              type="button"
              onClick={() => toggleDrawer()}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors',
                drawerOpen
                  ? 'bg-[hsl(var(--mm-blue)/0.1)] text-[hsl(var(--mm-blue-text))]'
                  : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-surface-secondary',
              )}
              title="Toggle materials panel (Ctrl+E)"
              aria-pressed={drawerOpen}
            >
              <PanelRight className="w-3.5 h-3.5" />
              Materials
            </button>
            <button
              onClick={() => handleCreateTheme({ name: 'New theme' })}
              disabled={createThemeMut.isPending}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-[hsl(var(--mm-green)/0.08)] text-[hsl(var(--mm-green-text))] border border-[hsl(var(--mm-green)/0.2)] hover:bg-[hsl(var(--mm-green)/0.15)] transition-colors"
              title="Add theme"
            >
              <Plus className="w-3 h-3" />
              Theme
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
                  title="Export canvas"
                  aria-label="Export canvas"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportDocx}>
                  Word (.docx)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportMarkdown}>
                  Markdown (.md)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportHtml}>
                  HTML (.html)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPdf}>
                  Print / PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {activeCanvases.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
                    title="Compare with another canvas"
                    aria-label="Compare with another canvas"
                  >
                    <GitCompare className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {activeCanvases.filter(c => c.id !== canvasId).map(c => (
                    <DropdownMenuItem key={c.id} onClick={() => navigate(`/projects/${projectId}/analysis/canvas/compare?canvas=${canvasId}&canvas2=${c.id}`)}>
                      {c.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              onClick={() => duplicateCanvasMut.mutate()}
              disabled={duplicateCanvasMut.isPending}
              className="p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
              title="Duplicate canvas"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <Popover open={snapshotPopoverOpen} onOpenChange={setSnapshotPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  className="relative p-1.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
                  title="Snapshots"
                  aria-label="Canvas snapshots"
                >
                  <Camera className="w-3.5 h-3.5" />
                  {snapshots.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-[hsl(var(--mm-blue))] text-[9px] text-white flex items-center justify-center font-medium">
                      {snapshots.length}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-0">
                <div className="p-2 border-b border-mm-border-subtle">
                  <p className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider mb-2">Save snapshot</p>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={snapshotName}
                      onChange={e => setSnapshotName(e.target.value)}
                      placeholder="Snapshot name..."
                      className="flex-1 h-7 px-2 text-xs rounded border border-mm-border-subtle bg-transparent text-mm-text focus:outline-none focus:ring-1 focus:ring-mm-accent"
                      aria-label="Snapshot name"
                      onKeyDown={e => { if (e.key === 'Enter' && snapshotName.trim()) createSnapshotMut.mutate(snapshotName.trim()) }}
                    />
                    <button
                      onClick={() => snapshotName.trim() && createSnapshotMut.mutate(snapshotName.trim())}
                      disabled={!snapshotName.trim() || createSnapshotMut.isPending}
                      className="h-7 px-2.5 rounded text-xs font-medium text-white bg-[hsl(var(--mm-purple))] hover:opacity-90 disabled:opacity-40 transition-opacity"
                    >
                      Save
                    </button>
                  </div>
                </div>
                {snapshots.length > 0 ? (
                  <div className="max-h-64 overflow-y-auto divide-y divide-mm-border-subtle">
                    {snapshots.map(snap => (
                      <div key={snap.id} className="flex items-center gap-2 px-2 py-1.5 text-xs group/snap">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-mm-text truncate">{snap.name}</p>
                          <p className="text-mm-text-faint">
                            {snap.theme_count} theme{snap.theme_count !== 1 ? 's' : ''} &middot; {formatRelativeTime(snap.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/snap:opacity-100 transition-opacity">
                          <button
                            onClick={() => { setSnapshotPopoverOpen(false); navigate(`/projects/${projectId}/analysis/canvas/compare?canvas=${canvasId}&snapshot=${snap.id}`) }}
                            className="p-0.5 rounded hover:bg-mm-bg transition-colors text-mm-text-muted hover:text-mm-text"
                            title="Compare with current"
                            aria-label="Compare snapshot with current"
                          >
                            <GitCompare className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => setRestoreTarget(snap)}
                            className="p-0.5 rounded hover:bg-mm-bg transition-colors text-mm-text-muted hover:text-mm-text"
                            title="Restore"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => deleteSnapshotMut.mutate(snap.id)}
                            className="p-0.5 rounded hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-mm-text-muted hover:text-red-500"
                            title="Delete snapshot"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-xs text-mm-text-faint text-center">
                    No snapshots yet
                  </div>
                )}
              </PopoverContent>
            </Popover>
            <button
              onClick={() => isCurrentArchived
                ? setPermanentDeleteTarget({ id: canvas.id, name: canvas.name })
                : setDeleteTarget({ id: canvas.id, name: canvas.name })
              }
              className="p-1.5 rounded text-mm-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              title={isCurrentArchived ? 'Delete permanently' : 'Archive canvas'}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Canvas body */}
      <DndContext onDragEnd={handleDragEnd}>
      <div className="flex flex-1 overflow-hidden">
        {/* Outline sidebar */}
        {outlineOpen && canvas && themes.length >= 3 && (
          <OutlineSidebar
            themes={themes}
            pendingItemCount={canvas.pending_items?.length ?? 0}
            onClose={() => setOutlineOpen(false)}
            onScrollToTheme={scrollToTheme}
            focusedThemeId={focusedThemeId}
            onFocusTheme={setFocusedThemeId}
            onMoveTheme={handleMoveTheme}
            onDeleteTheme={handleDeleteTheme}
          />
        )}

        {/* Archived banner */}
        {isCurrentArchived && canvas && (
          <div className="shrink-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
            <span>This canvas is archived.</span>
            <button
              onClick={() => restoreCanvasMut.mutate(canvas.id)}
              disabled={restoreCanvasMut.isPending}
              className="px-2 py-0.5 rounded text-xs font-medium bg-white dark:bg-mm-surface border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/50 transition-colors"
            >
              Restore
            </button>
            <button
              onClick={() => setPermanentDeleteTarget({ id: canvas.id, name: canvas.name })}
              className="px-2 py-0.5 rounded text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            >
              Delete permanently
            </button>
          </div>
        )}

        {/* Main content */}
        {canvasLoading && (
          <div className="flex-1 flex items-center justify-center text-sm text-mm-text-muted">
            Loading canvas...
          </div>
        )}

        {view === 'writing' && canvas && !canvasLoading && (
          <WritingCanvas
            projectId={String(projectId)}
            canvas={canvas}
            onCreateTheme={handleCreateTheme}
            onUpdateTheme={handleUpdateTheme}
            onDeleteTheme={handleDeleteTheme}
            onReorderThemes={handleReorderThemes}
            onOpenDrawer={toggleDrawer}
            focusedThemeId={focusedThemeId}
            onFocusTheme={setFocusedThemeId}
            pendingItems={canvas.pending_items ?? []}
            onRemovePendingItem={handleRemovePendingItem}
            onInsertPendingItem={handleInsertPendingItem}
            focusedEditorRef={focusedEditorRef}
            themeInsertNodeRefs={themeInsertNodeRefs.current}
            showColorBars={showColorBars}
            onContentSaved={invalidateCanvas}
          />
        )}

        {view === 'spatial' && canvas && !canvasLoading && (
          <SpatialCanvas
            onUpdateTheme={handleUpdateTheme}
            onCreateTheme={handleCreateTheme}
            onDeleteTheme={handleDeleteTheme}
            onSetView={handleSetView}
            onFocusTheme={setFocusedThemeId}
            onCreateRelationship={handleCreateRelationship}
            onUpdateRelationship={(relId, data) => updateRelMut.mutate({ relId, data })}
            onDeleteRelationship={handleDeleteRelationship}
            allThemes={analyticalThemes}
          />
        )}

        {/* Materials drawer — flex panel */}
        {canvas && (
          <MaterialsDrawer
            projectId={projectId}
            onCanvasSourceIds={onCanvasSourceIds}
            open={drawerOpen}
            onClose={() => { setDrawerOpen(false); localStorage.setItem(`mm-canvas-drawer-${projectId}`, 'false') }}
            initialSection={drawerSection}
            onInsertExcerpt={handleInsertExcerpt}
            onInsertMaterial={handleInsertMaterial}
            onInsertMemo={handleInsertMemo}
            insertingId={insertingId}
          />
        )}
      </div>
      </DndContext>

      {/* Convergence matrix overlay */}
      {canvas && (
        <ConvergenceMatrix
          themes={analyticalThemes}
          open={matrixOpen}
          onClose={() => setMatrixOpen(false)}
          onCellClick={(sourceId, targetId, relId) => {
            if (relId) {
              // Filled cell: in writing view, scroll to source theme
              if (view === 'writing') {
                document.getElementById(`theme-${sourceId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            } else {
              // Empty cell: create default "influences" relationship
              handleCreateRelationship({
                source_theme_id: sourceId,
                target_theme_id: targetId,
                relationship_type: 'influences',
              })
            }
          }}
          onScrollToTheme={(themeId) => {
            document.getElementById(`theme-${themeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
          view={view}
        />
      )}

      {/* Archive canvas confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive canvas?</AlertDialogTitle>
            <AlertDialogDescription>
              This will archive "{deleteTarget?.name}". You can restore it later from the canvas list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && archiveCanvasMut.mutate(deleteTarget.id)}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Permanent delete confirmation */}
      <AlertDialog open={permanentDeleteTarget !== null} onOpenChange={(open) => { if (!open) setPermanentDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete canvas permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{permanentDeleteTarget?.name}" and all its themes. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => permanentDeleteTarget && permanentDeleteCanvasMut.mutate(permanentDeleteTarget.id)}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore snapshot confirmation */}
      <AlertDialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the current canvas state with "{restoreTarget?.name}". A backup of the current state will be saved automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreTarget && restoreSnapshotMut.mutate(restoreTarget.id)}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete theme confirmation */}
      <AlertDialog open={deleteThemeTarget !== null} onOpenChange={(open) => { if (!open) setDeleteThemeTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete section?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteThemeTarget?.name}"
              {(deleteThemeTarget?.materialCount ?? 0) > 0 && ` contains ${deleteThemeTarget!.materialCount} material${deleteThemeTarget!.materialCount !== 1 ? 's' : ''} that will be permanently deleted`}
              {(deleteThemeTarget?.materialCount ?? 0) > 0 && (deleteThemeTarget?.childCount ?? 0) > 0 && ', and'}
              {(deleteThemeTarget?.childCount ?? 0) > 0 && ` has ${deleteThemeTarget!.childCount} nested theme${deleteThemeTarget!.childCount !== 1 ? 's' : ''} that will be un-nested`}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteThemeTarget) { executeThemeDelete(deleteThemeTarget.id); setDeleteThemeTarget(null) } }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create canvas dialog */}
      <Dialog open={newCanvasDialogOpen} onOpenChange={(open) => { if (!open) { setNewCanvasDialogOpen(false); setNewCanvasName('') } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Canvas</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleCreateCanvasSubmit() }} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="canvas-name-main">Canvas name</Label>
              <Input
                id="canvas-name-main"
                value={newCanvasName}
                onChange={(e) => setNewCanvasName(e.target.value)}
                placeholder="e.g., Thematic Analysis"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => { setNewCanvasDialogOpen(false); setNewCanvasName('') }}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!newCanvasName.trim() || createCanvasMut.isPending}>
                {createCanvasMut.isPending ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Template picker dialog */}
      <Dialog open={showTemplatePicker} onOpenChange={setShowTemplatePicker}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Create New Canvas</DialogTitle>
            <DialogDescription>Choose a starting template or begin with a blank canvas</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-4">
            <button
              type="button"
              onClick={() => applyTemplate('blank')}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-mm-border hover:border-mm-border-medium hover:bg-mm-bg/50 transition-colors text-center"
            >
              <FileText className="w-6 h-6 text-mm-text-muted" />
              <span className="text-sm font-medium text-mm-text">Blank canvas</span>
              <span className="text-[11px] text-mm-text-muted leading-tight">Start from scratch with an empty writing surface</span>
            </button>
            <button
              type="button"
              onClick={() => applyTemplate('from_analysis')}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-mm-border hover:border-mm-border-medium hover:bg-mm-bg/50 transition-colors text-center"
            >
              <BarChart3 className="w-6 h-6 text-blue-500" />
              <span className="text-sm font-medium text-mm-text">From current analysis</span>
              <span className="text-[11px] text-mm-text-muted leading-tight">Create themes from your existing analysis sources</span>
            </button>
            <button
              type="button"
              onClick={() => applyTemplate('comparison')}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-mm-border hover:border-mm-border-medium hover:bg-mm-bg/50 transition-colors text-center"
            >
              <GitCompare className="w-6 h-6 text-amber-500" />
              <span className="text-sm font-medium text-mm-text">Comparison scaffold</span>
              <span className="text-[11px] text-mm-text-muted leading-tight">Two themes with a contradicts relationship</span>
            </button>
            <button
              type="button"
              onClick={() => applyTemplate('research_questions')}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-mm-border hover:border-mm-border-medium hover:bg-mm-bg/50 transition-colors text-center"
            >
              <HelpCircle className="w-6 h-6 text-purple-500" />
              <span className="text-sm font-medium text-mm-text">Research questions</span>
              <span className="text-[11px] text-mm-text-muted leading-tight">Three themes for RQ1, RQ2, and RQ3</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Accessibility announcements */}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>
  )
}
