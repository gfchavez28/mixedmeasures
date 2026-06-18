import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { PenLine, Pencil, Palette, ArrowRight, Plus, Trash2, Eye, EyeOff, FolderInput, LayoutGrid, MoveHorizontal, CircleDot, Columns2, Circle, type LucideIcon } from 'lucide-react'
import { cn, getUnfocusedStyle } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import type { CanvasTheme, CanvasThemeRelationship } from '@/lib/api'
import { extractMaterialSummary, type MaterialSummary } from './canvas-utils'
import ThemeRelationshipPopover, { RelationshipBadge } from './ThemeRelationshipPopover'

// ── Props ────────────────────────────────────────────────────────────────────

interface SpatialCanvasProps {
  onUpdateTheme: (themeId: number, data: { name?: string; color?: string; viz_x?: number; viz_y?: number; parent_theme_id?: number | null }) => void
  onCreateTheme: (data: { name: string; viz_x?: number; viz_y?: number }) => void
  onDeleteTheme: (themeId: number) => void
  onSetView: (view: 'writing') => void
  onFocusTheme: (themeId: number | null) => void
  onCreateRelationship: (data: {
    source_theme_id: number
    target_theme_id: number
    relationship_type: string
    label?: string
    is_bidirectional?: boolean
    line_style?: string
    line_color?: string
  }) => void
  onUpdateRelationship: (relId: number, data: Record<string, unknown>) => void
  onDeleteRelationship: (relId: number) => void
  allThemes: CanvasTheme[]
}

// ── Edge detection (card boundary → arrow endpoints) ─────────────────────────

function getCardEdge(
  pos: { x: number; y: number },
  width: number,
  height: number,
  target: { x: number; y: number },
): { x: number; y: number } {
  const cx = pos.x + width / 2
  const cy = pos.y + height / 2
  const dx = target.x + width / 2 - cx
  const dy = target.y + height / 2 - cy

  if (dx === 0 && dy === 0) return { x: cx, y: cy }

  const angle = Math.atan2(dy, dx)
  const hw = width / 2
  const hh = height / 2
  const tanA = Math.abs(Math.tan(angle))

  let ex: number, ey: number
  if (tanA <= hh / hw) {
    ex = dx > 0 ? hw : -hw
    ey = ex * Math.tan(angle)
  } else {
    ey = dy > 0 ? hh : -hh
    ex = ey / Math.tan(angle)
  }

  return { x: cx + ex, y: cy + ey }
}

// ── Arrow marker IDs ─────────────────────────────────────────────────────────

function makeMarkerId(color: string, direction: 'end' | 'start'): string {
  return `arrow-${direction}-${color.replace(/[^a-zA-Z0-9]/g, '')}`
}

// ── Arrow label helpers ─────────────────────────────────────────────────────

const LABEL_MAX = 30

function truncateLabel(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text
}

function getArrowLabelText(rel: { relationship_type: string; label: string | null }): string {
  if (rel.relationship_type === 'custom') return rel.label || ''
  if (rel.label) return `${rel.relationship_type} \u00b7 ${rel.label}`
  return rel.relationship_type
}

// ── Floating menu (for SVG arrow + canvas background context menus) ──────────

function FloatingMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[8rem] rounded-md border bg-popover text-popover-foreground p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: x, top: y }}
    >
      {children}
    </div>,
    document.body,
  )
}

function FloatingMenuItem({ icon: Icon, label, danger, onClick }: { icon?: LucideIcon; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent transition-colors',
        danger && 'text-red-600 dark:text-red-400',
      )}
    >
      {Icon && <Icon className="w-4 h-4 mr-2" />}
      {label}
    </button>
  )
}

function FloatingMenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />
}

// ── Card dimensions ──────────────────────────────────────────────────────────

const CARD_WIDTH = 210
const CARD_BASE_HEIGHT = 72 // approximate min height

// ── Layout prototypes ───────────────────────────────────────────────────────

const LAYOUT_GAP_X = 60
const LAYOUT_GAP_Y = 50
const LAYOUT_MARGIN = 100

type LayoutFn = (count: number) => { x: number; y: number }[]

function layoutGrid(count: number): { x: number; y: number }[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  return Array.from({ length: count }, (_, i) => ({
    x: LAYOUT_MARGIN + (i % cols) * (CARD_WIDTH + LAYOUT_GAP_X),
    y: LAYOUT_MARGIN + Math.floor(i / cols) * (CARD_BASE_HEIGHT + LAYOUT_GAP_Y),
  }))
}

function layoutLinear(count: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: LAYOUT_MARGIN + i * (CARD_WIDTH + LAYOUT_GAP_X),
    y: 300,
  }))
}

function layoutHubSpoke(count: number): { x: number; y: number }[] {
  const cx = 500
  const cy = 400
  if (count <= 1) return [{ x: cx, y: cy }]
  const radius = Math.max(250, (count - 1) * 40)
  const result: { x: number; y: number }[] = [{ x: cx, y: cy }]
  for (let i = 1; i < count; i++) {
    const angle = ((i - 1) / (count - 1)) * Math.PI * 2 - Math.PI / 2
    result.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    })
  }
  return result
}

function layoutTwoColumn(count: number): { x: number; y: number }[] {
  const half = Math.ceil(count / 2)
  const colGap = CARD_WIDTH + LAYOUT_GAP_X * 4
  return Array.from({ length: count }, (_, i) => ({
    x: LAYOUT_MARGIN + (i < half ? 0 : colGap),
    y: LAYOUT_MARGIN + (i < half ? i : i - half) * (CARD_BASE_HEIGHT + LAYOUT_GAP_Y),
  }))
}

function layoutCircle(count: number): { x: number; y: number }[] {
  const cx = 500
  const cy = 400
  const radius = Math.max(200, count * 35)
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    }
  })
}

const LAYOUTS: { key: string; label: string; fn: LayoutFn; icon: LucideIcon }[] = [
  { key: 'grid', label: 'Grid', fn: layoutGrid, icon: LayoutGrid },
  { key: 'linear', label: 'Linear chain', fn: layoutLinear, icon: MoveHorizontal },
  { key: 'hub', label: 'Hub & spoke', fn: layoutHubSpoke, icon: CircleDot },
  { key: 'two-col', label: 'Two columns', fn: layoutTwoColumn, icon: Columns2 },
  { key: 'circle', label: 'Circle', fn: layoutCircle, icon: Circle },
]

// ── Drop-on-card detection for nesting ──────────────────────────────────────

function findDropTarget(
  draggedId: number,
  centerX: number,
  centerY: number,
  themes: CanvasTheme[],
  getPos: (t: CanvasTheme) => { x: number; y: number } | undefined,
  getHeight?: (themeId: number) => number,
): number | null {
  // Can't nest a theme that already has children
  if (themes.some(c => c.parent_theme_id === draggedId)) return null
  for (const t of themes) {
    if (t.id === draggedId) continue
    if (t.section_type !== 'theme') continue
    if (t.parent_theme_id != null) continue  // can't nest into a child
    const pos = getPos(t)
    if (!pos) continue
    const cardHeight = getHeight?.(t.id) ?? CARD_BASE_HEIGHT
    if (
      centerX >= pos.x && centerX <= pos.x + CARD_WIDTH &&
      centerY >= pos.y && centerY <= pos.y + cardHeight
    ) {
      return t.id
    }
  }
  return null
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SpatialCanvas({
  onUpdateTheme,
  onCreateTheme,
  onDeleteTheme,
  onSetView,
  onFocusTheme,
  onCreateRelationship,
  onUpdateRelationship,
  onDeleteRelationship,
  allThemes,
}: SpatialCanvasProps) {

  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // ── State ──────────────────────────────────────────────────────────────

  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragState, setDragState] = useState<{
    themeId: number
    startX: number
    startY: number
    offset: { x: number; y: number }
  } | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
  const [connectionMode, setConnectionMode] = useState(false)
  const [connectionSource, setConnectionSource] = useState<number | null>(null)
  const [showContent, setShowContent] = useState(true)
  const [showNesting, setShowNesting] = useState(true)
  const [showFullLabels, setShowFullLabels] = useState(false)
  const [editingRelId, setEditingRelId] = useState<number | null>(null)
  const [newRelTarget, setNewRelTarget] = useState<number | null>(null)
  const [arrowMenu, setArrowMenu] = useState<{ relId: number; x: number; y: number } | null>(null)
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [spatialFocusId, setSpatialFocusId] = useState<number | null>(null)

  // Local positions for smooth dragging (no API round-trip during drag)
  const [localPositions, setLocalPositions] = useState<Record<number, { x: number; y: number }>>({})

  // ── Refs for event listener closures ───────────────────────────────────

  const dragStateRef = useRef(dragState)
  const isPanningRef = useRef(isPanning)
  const panStartRef = useRef(panStart)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const localPosRef = useRef(localPositions)
  const onUpdateThemeRef = useRef(onUpdateTheme)
  const allThemesRef = useRef(allThemes)

  useEffect(() => { dragStateRef.current = dragState }, [dragState])
  useEffect(() => { isPanningRef.current = isPanning }, [isPanning])
  useEffect(() => { panStartRef.current = panStart }, [panStart])
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { panRef.current = pan }, [pan])
  useEffect(() => { localPosRef.current = localPositions }, [localPositions])
  useEffect(() => { onUpdateThemeRef.current = onUpdateTheme }, [onUpdateTheme])
  useEffect(() => { allThemesRef.current = allThemes }, [allThemes])

  // ── Initialize local positions from theme data ─────────────────────────

  useEffect(() => {
    setLocalPositions(prev => {
      const next = { ...prev }
      let changed = false
      for (let i = 0; i < allThemes.length; i++) {
        const t = allThemes[i]
        if (next[t.id] == null) {
          if (t.viz_x != null && t.viz_y != null) {
            next[t.id] = { x: t.viz_x, y: t.viz_y }
          } else {
            next[t.id] = { x: 100 + (i % 3) * 260, y: 80 + Math.floor(i / 3) * 200 }
          }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [allThemes])

  // ── Position lookup ────────────────────────────────────────────────────

  const getPosition = useCallback(
    (theme: CanvasTheme, index: number): { x: number; y: number } => {
      if (localPositions[theme.id]) return localPositions[theme.id]
      if (theme.viz_x != null && theme.viz_y != null) return { x: theme.viz_x, y: theme.viz_y }
      return { x: 100 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 200 }
    },
    [localPositions],
  )

  // ── Theme content summaries (replaces block-based grouping) ─────────────

  const themeContentSummaries = useMemo(() => {
    const map = new Map<number, MaterialSummary>()
    for (const t of allThemes) map.set(t.id, extractMaterialSummary(t.content))
    return map
  }, [allThemes])

  // ── Top-level vs nested themes ──────────────────────────────────────

  const topLevelThemes = useMemo(() => allThemes.filter(t => t.parent_theme_id == null), [allThemes])
  const themeById = useMemo(() => new Map(allThemes.map(t => [t.id, t])), [allThemes])

  const childrenMap = useMemo(() => {
    const map = new Map<number, CanvasTheme[]>()
    for (const t of allThemes) {
      if (t.parent_theme_id != null) {
        const arr = map.get(t.parent_theme_id) ?? []
        arr.push(t)
        map.set(t.parent_theme_id, arr)
      }
    }
    return map
  }, [allThemes])

  // ── Auto-fit viewport on initial load ──────────────────────────────────
  const hasAutoFit = useRef(false)
  useEffect(() => {
    if (hasAutoFit.current || topLevelThemes.length === 0) return
    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      const positions = topLevelThemes.map((t, i) => {
        const lp = localPositions[t.id]
        if (lp) return lp
        if (t.viz_x != null && t.viz_y != null) return { x: t.viz_x, y: t.viz_y }
        return { x: 100 + (i % 3) * 260, y: 80 + Math.floor(i / 3) * 200 }
      })
      if (positions.length === 0) return
      const minX = Math.min(...positions.map(p => p.x))
      const minY = Math.min(...positions.map(p => p.y))
      const maxX = Math.max(...positions.map(p => p.x + CARD_WIDTH))
      const maxY = Math.max(...positions.map(p => p.y + CARD_BASE_HEIGHT))
      const contentW = maxX - minX + 80
      const contentH = maxY - minY + 80
      const { clientWidth, clientHeight } = container
      const fitZoom = Math.min(clientWidth / contentW, clientHeight / contentH, 1)
      const clampedZoom = Math.max(0.3, Math.min(fitZoom, 1))
      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2
      setPan({
        x: clientWidth / 2 - centerX * clampedZoom,
        y: clientHeight / 2 - centerY * clampedZoom,
      })
      if (clampedZoom < 0.95) setZoom(clampedZoom)
      hasAutoFit.current = true
    })
  }, [topLevelThemes, localPositions])

  const connectionCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const t of allThemes) {
      counts.set(t.id, (t.relationships_out?.length ?? 0) + (t.relationships_in?.length ?? 0))
    }
    return counts
  }, [allThemes])

  // ── Layout application ─────────────────────────────────────────────────

  const applyLayout = useCallback((layoutFn: LayoutFn) => {
    const themes = topLevelThemes
    if (themes.length === 0) return
    const positions = layoutFn(themes.length)
    // Instant visual feedback
    setLocalPositions(prev => {
      const next = { ...prev }
      themes.forEach((t, i) => { next[t.id] = positions[i] })
      return next
    })
    // Persist each position
    themes.forEach((t, i) => {
      onUpdateTheme(t.id, {
        viz_x: Math.round(positions[i].x),
        viz_y: Math.round(positions[i].y),
      })
    })
  }, [topLevelThemes, onUpdateTheme])

  // ── Build relationships from theme data ────────────────────────────────

  const relationships = useMemo(() => {
    const rels: Array<CanvasThemeRelationship & { sourceTheme: CanvasTheme; targetTheme: CanvasTheme }> = []
    for (const theme of allThemes) {
      for (const rel of (theme.relationships_out ?? [])) {
        const target = allThemes.find(t => t.id === rel.target_theme_id)
        if (target) rels.push({ ...rel, sourceTheme: theme, targetTheme: target })
      }
    }
    return rels
  }, [allThemes])

  // ── Reroute child connections through parent cards ──────────────────────

  const topLevelRelationships = useMemo(() => {
    const childToParent = new Map<number, number>()
    for (const t of allThemes) {
      if (t.parent_theme_id != null) childToParent.set(t.id, t.parent_theme_id)
    }
    return relationships.map(rel => {
      const effectiveSourceId = childToParent.get(rel.sourceTheme.id) ?? rel.sourceTheme.id
      const effectiveTargetId = childToParent.get(rel.targetTheme.id) ?? rel.targetTheme.id
      if (effectiveSourceId === effectiveTargetId) return null // intra-parent
      return {
        ...rel,
        effectiveSource: themeById.get(effectiveSourceId) ?? rel.sourceTheme,
        effectiveTarget: themeById.get(effectiveTargetId) ?? rel.targetTheme,
      }
    }).filter(Boolean) as Array<CanvasThemeRelationship & { sourceTheme: CanvasTheme; targetTheme: CanvasTheme; effectiveSource: CanvasTheme; effectiveTarget: CanvasTheme }>
  }, [relationships, allThemes, themeById])

  // ── Spatial focus mode ──────────────────────────────────────────────────

  const focusedSet = useMemo(() => {
    if (spatialFocusId == null) return null
    const set = new Set<number>([spatialFocusId])
    const theme = themeById.get(spatialFocusId)
    if (!theme) return set
    if (theme.parent_theme_id != null) set.add(theme.parent_theme_id)
    for (const rel of (theme.relationships_out ?? [])) {
      set.add(rel.target_theme_id)
      const target = themeById.get(rel.target_theme_id)
      if (target?.parent_theme_id != null) set.add(target.parent_theme_id)
    }
    for (const rel of (theme.relationships_in ?? [])) {
      set.add(rel.source_theme_id)
      const source = themeById.get(rel.source_theme_id)
      if (source?.parent_theme_id != null) set.add(source.parent_theme_id)
    }
    return set
  }, [spatialFocusId, themeById])

  // ── Unique arrow colors for marker defs ────────────────────────────────

  const uniqueColors = useMemo(() => {
    const colors = new Set<string>()
    for (const rel of topLevelRelationships) {
      colors.add(rel.line_color ?? '#8b949e')
    }
    return Array.from(colors)
  }, [topLevelRelationships])

  // ── Card dragging + panning via document-level events ──────────────────

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragStateRef.current
      if (ds) {
        const containerRect = containerRef.current?.getBoundingClientRect()
        if (!containerRect) return
        const x = (e.clientX - containerRect.left - ds.offset.x - panRef.current.x) / zoomRef.current
        const y = (e.clientY - containerRect.top - ds.offset.y - panRef.current.y) / zoomRef.current
        const newPos = { x: Math.max(0, x), y: Math.max(0, y) }
        setLocalPositions(prev => ({ ...prev, [ds.themeId]: newPos }))

        // Drop-target detection for nesting
        const centerX = newPos.x + CARD_WIDTH / 2
        const centerY = newPos.y + CARD_BASE_HEIGHT / 2
        const getPos = (t: CanvasTheme) => localPosRef.current[t.id] ?? (t.viz_x != null && t.viz_y != null ? { x: t.viz_x, y: t.viz_y } : undefined)
        const getH = (id: number) => cardRefs.current.get(id)?.offsetHeight ?? CARD_BASE_HEIGHT
        const target = findDropTarget(ds.themeId, centerX, centerY, allThemesRef.current, getPos, getH)
        setDropTarget(target)
      }

      if (isPanningRef.current) {
        const ps = panStartRef.current
        setPan(prev => ({
          x: prev.x + e.clientX - ps.x,
          y: prev.y + e.clientY - ps.y,
        }))
        setPanStart({ x: e.clientX, y: e.clientY })
      }
    }

    const handleMouseUp = () => {
      const ds = dragStateRef.current
      if (ds) {
        const pos = localPosRef.current[ds.themeId]
        if (pos) {
          // Check if we're dropping onto another card (nesting)
          const centerX = pos.x + CARD_WIDTH / 2
          const centerY = pos.y + CARD_BASE_HEIGHT / 2
          const getPos = (t: CanvasTheme) => localPosRef.current[t.id] ?? (t.viz_x != null && t.viz_y != null ? { x: t.viz_x, y: t.viz_y } : undefined)
          const getH = (id: number) => cardRefs.current.get(id)?.offsetHeight ?? CARD_BASE_HEIGHT
          const target = findDropTarget(ds.themeId, centerX, centerY, allThemesRef.current, getPos, getH)
          const draggedTheme = allThemesRef.current.find(t => t.id === ds.themeId)
          const currentParent = draggedTheme?.parent_theme_id ?? null

          if (target !== currentParent) {
            // Parent changed — send position + nesting update
            onUpdateThemeRef.current(ds.themeId, {
              viz_x: Math.round(pos.x),
              viz_y: Math.round(pos.y),
              parent_theme_id: target,
            })
          } else {
            onUpdateThemeRef.current(ds.themeId, {
              viz_x: Math.round(pos.x),
              viz_y: Math.round(pos.y),
            })
          }
        }
        setDragState(null)
        setDropTarget(null)
      }
      setIsPanning(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, []) // stable — all state accessed via refs

  // ── Escape key cancels connection mode ─────────────────────────────────

  useEffect(() => {
    if (!connectionMode) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConnectionMode(false)
        setConnectionSource(null)
        setNewRelTarget(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [connectionMode])

  // ── Escape key exits spatial focus mode ────────────────────────────────

  useEffect(() => {
    if (spatialFocusId == null) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSpatialFocusId(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [spatialFocusId])

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan when clicking on the container itself, not on cards
      if ((e.target as HTMLElement).closest('[data-spatial-card]')) return
      if ((e.target as HTMLElement).closest('[data-spatial-toolbar]')) return
      if ((e.target as HTMLElement).closest('[data-spatial-zoom]')) return
      setSpatialFocusId(null)
      setIsPanning(true)
      setPanStart({ x: e.clientX, y: e.clientY })
    },
    [],
  )

  const handleCardMouseDown = useCallback(
    (themeId: number) => (e: React.MouseEvent) => {
      if (connectionMode) return
      e.stopPropagation()
      const cardEl = cardRefs.current.get(themeId)
      if (!cardEl) return
      const rect = cardEl.getBoundingClientRect()
      setDragState({
        themeId,
        startX: e.clientX,
        startY: e.clientY,
        offset: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      })
    },
    [connectionMode],
  )

  const handleCardClick = useCallback(
    (themeId: number) => (e: React.MouseEvent) => {
      if (!connectionMode) return
      e.stopPropagation()

      if (connectionSource == null) {
        // First click: select source
        setConnectionSource(themeId)
      } else if (themeId !== connectionSource) {
        // Second click: select target, open popover
        setNewRelTarget(themeId)
      }
    },
    [connectionMode, connectionSource],
  )

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(prev => {
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      return Math.max(0.3, Math.min(2, prev + delta))
    })
  }, [])

  const toggleConnectionMode = useCallback(() => {
    setConnectionMode(prev => {
      if (prev) {
        // Turning off
        setConnectionSource(null)
        setNewRelTarget(null)
      }
      return !prev
    })
    setSpatialFocusId(null) // Clear focus when toggling connection mode
  }, [])

  const handleNewRelCreate = useCallback(
    (data: Parameters<SpatialCanvasProps['onCreateRelationship']>[0]) => {
      onCreateRelationship(data)
      setConnectionMode(false)
      setConnectionSource(null)
      setNewRelTarget(null)
    },
    [onCreateRelationship],
  )

  const handleRelPopoverClose = useCallback(() => {
    setEditingRelId(null)
    setNewRelTarget(null)
    setConnectionSource(null)
    setConnectionMode(false)
  }, [])

  // ── Editing relationship: find source theme for popover ────────────────

  const editingRelData = useMemo(() => {
    if (editingRelId == null) return null
    for (const rel of relationships) {
      if (rel.id === editingRelId) return rel
    }
    return null
  }, [editingRelId, relationships])

  // ── Connection mode: find source theme for new-rel popover ─────────────

  const connectionSourceTheme = useMemo(() => {
    if (connectionSource == null) return null
    return allThemes.find(t => t.id === connectionSource) ?? null
  }, [connectionSource, allThemes])

  // ── Render: empty state ────────────────────────────────────────────────

  if (allThemes.length === 0) {
    return (
      <div
        className="flex-1 relative overflow-hidden"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-mm-border-subtle) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div className="flex-1 flex items-center justify-center h-full text-sm text-mm-text-muted">
          <div className="text-center">
            <p>Create themes in the Writing View to see them here</p>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      data-spatial-view
      className={cn(
        'flex-1 relative overflow-hidden select-none',
        isPanning ? 'cursor-grabbing' : 'cursor-grab',
      )}
      style={{
        backgroundImage: 'radial-gradient(circle, var(--color-mm-border-subtle) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
      onMouseDown={handleContainerMouseDown}
      onWheel={handleWheel}
      onContextMenu={(e) => {
        // Only show background menu when clicking on empty space
        const target = e.target as HTMLElement
        if (target.closest('[data-spatial-card]') || target.closest('[data-spatial-toolbar]') || target.closest('[data-spatial-zoom]') || target.closest('svg')) return
        if (connectionMode) return
        e.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const canvasX = (e.clientX - rect.left - pan.x) / zoom
        const canvasY = (e.clientY - rect.top - pan.y) / zoom
        setBgMenu({ x: e.clientX, y: e.clientY, canvasX, canvasY })
      }}
    >
      {/* Transform wrapper for pan/zoom */}
      <div
        style={{
          position: 'absolute',
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {/* SVG overlay for relationship arrows */}
        <svg
          width={4000}
          height={4000}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          {/* Arrow marker defs */}
          <defs>
            {uniqueColors.map(color => (
              <marker
                key={`end-${color}`}
                id={makeMarkerId(color, 'end')}
                viewBox="0 0 10 8"
                refX="9"
                refY="4"
                markerWidth="8"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 4 L 0 8 Z" fill={color} />
              </marker>
            ))}
            {uniqueColors.map(color => (
              <marker
                key={`start-${color}`}
                id={makeMarkerId(color, 'start')}
                viewBox="0 0 10 8"
                refX="1"
                refY="4"
                markerWidth="8"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 10 0 L 0 4 L 10 8 Z" fill={color} />
              </marker>
            ))}
          </defs>

          {/* Relationship paths (top-level only; child connections rerouted through parents) */}
          {topLevelRelationships.map(rel => {
            const sourcePos = getPosition(
              rel.effectiveSource,
              topLevelThemes.indexOf(rel.effectiveSource),
            )
            const targetPos = getPosition(
              rel.effectiveTarget,
              topLevelThemes.indexOf(rel.effectiveTarget),
            )

            // Card edge detection — use actual card heights for expanded parent cards
            const sourceHeight = cardRefs.current.get(rel.effectiveSource.id)?.offsetHeight ?? CARD_BASE_HEIGHT
            const targetHeight = cardRefs.current.get(rel.effectiveTarget.id)?.offsetHeight ?? CARD_BASE_HEIGHT
            const from = getCardEdge(sourcePos, CARD_WIDTH, sourceHeight, targetPos)
            const to = getCardEdge(targetPos, CARD_WIDTH, targetHeight, sourcePos)

            // Path geometry
            const mx = (from.x + to.x) / 2
            const my = (from.y + to.y) / 2
            const dx = to.x - from.x
            const dy = to.y - from.y
            const len = Math.sqrt(dx * dx + dy * dy) || 1

            const lineColor = rel.line_color ?? '#8b949e'
            const rawStyle = rel.line_style ?? 'solid'
            const isNoArrow = rawStyle === 'no-arrow'
            const isStraight = rawStyle.includes('-straight')
            const baseStyle = rawStyle.replace('-straight', '')

            // Stroke dash (from base style, ignoring -straight suffix)
            let strokeDasharray: string | undefined
            if (baseStyle === 'dashed') strokeDasharray = '8 4'
            else if (baseStyle === 'dotted') strokeDasharray = '2 4'

            // Weight → stroke width (weight=1 default renders as medium)
            const w = rel.weight ?? 1
            const strokeW = w > 1 && w <= 33 ? 1.5 : w > 66 ? 4 : 2.5

            // Build path: curved (bezier) or straight (polyline with jog)
            let pathD: string
            let labelX: number
            let labelY: number

            if (isStraight) {
              const jogOffset = 3
              const jogX = mx + (-dy / len * jogOffset)
              const jogY = my + (dx / len * jogOffset)
              pathD = `M ${from.x},${from.y} L ${jogX},${jogY} L ${to.x},${to.y}`
              labelX = jogX
              labelY = jogY
            } else {
              const offset = len * 0.15
              const ctrlX = mx + (-dy / len * offset)
              const ctrlY = my + (dx / len * offset)
              pathD = `M ${from.x},${from.y} Q ${ctrlX},${ctrlY} ${to.x},${to.y}`
              labelX = (from.x + 2 * ctrlX + to.x) / 4
              labelY = (from.y + 2 * ctrlY + to.y) / 4
            }

            const isArrowVivid = !focusedSet || (
              spatialFocusId != null && (
                rel.sourceTheme.id === spatialFocusId ||
                rel.targetTheme.id === spatialFocusId
              )
            )
            const arrowOpacity = isArrowVivid ? undefined : 0.15

            return (
              <g key={rel.id}>
                {/* Invisible wider hit area for click */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={() => setEditingRelId(rel.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setArrowMenu({ relId: rel.id, x: e.clientX, y: e.clientY })
                  }}
                />
                {/* Visible path */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={lineColor}
                  strokeWidth={strokeW}
                  strokeDasharray={strokeDasharray}
                  markerEnd={isNoArrow ? undefined : `url(#${makeMarkerId(lineColor, 'end')})`}
                  markerStart={
                    rel.is_bidirectional && !isNoArrow
                      ? `url(#${makeMarkerId(lineColor, 'start')})`
                      : undefined
                  }
                  style={{ pointerEvents: 'none', transition: 'opacity 200ms' }}
                  opacity={arrowOpacity}
                />
                {/* Label pill */}
                {(() => {
                  const fullText = getArrowLabelText(rel)
                  if (!fullText) return null
                  const displayText = showFullLabels ? fullText : truncateLabel(fullText, LABEL_MAX)
                  const foW = 300
                  const foH = 24
                  return (
                    <foreignObject
                      x={labelX - foW / 2}
                      y={labelY - foH / 2}
                      width={foW}
                      height={foH}
                      style={{ pointerEvents: 'none', overflow: 'visible', transition: 'opacity 200ms' }}
                      opacity={arrowOpacity}
                    >
                      <div className="flex justify-center items-center h-full">
                        <span
                          className="inline-flex px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-white/90 dark:bg-mm-surface/90 select-none whitespace-nowrap"
                          style={{ color: lineColor }}
                          title={fullText}
                        >
                          {displayText}
                        </span>
                      </div>
                    </foreignObject>
                  )
                })()}
              </g>
            )
          })}
        </svg>

        {/* Theme cards (top-level only; nested children render inside parent cards) */}
        {topLevelThemes.map((theme, index) => {
          const pos = getPosition(theme, index)
          const summary = themeContentSummaries.get(theme.id)
          const ownMaterialCount = summary
            ? summary.excerptCount + summary.chartCount + summary.memoCount + summary.calloutCount
            : 0
          const children = childrenMap.get(theme.id) ?? []
          const childMaterialCount = children.reduce((sum, c) => {
            const cs = themeContentSummaries.get(c.id)
            return sum + (cs ? cs.excerptCount + cs.chartCount + cs.memoCount + cs.calloutCount : 0)
          }, 0)
          const totalMaterials = ownMaterialCount + (showNesting ? childMaterialCount : 0)
          const themeConns = connectionCounts.get(theme.id) ?? 0

          return (
            <ContextMenu key={theme.id}>
            <ContextMenuTrigger asChild>
            <div
              ref={el => {
                if (el) cardRefs.current.set(theme.id, el)
                else cardRefs.current.delete(theme.id)
              }}
              data-spatial-card
              role="button"
              tabIndex={0}
              aria-roledescription="draggable"
              aria-label={theme.name}
              className={cn(
                'absolute w-[210px] bg-white dark:bg-mm-surface border border-mm-border rounded-md shadow-md select-none transition-shadow focus:outline-none focus:ring-2 focus:ring-[hsl(var(--mm-teal))]',
                dragState?.themeId === theme.id && 'shadow-xl opacity-90 z-10',
                connectionMode && 'cursor-pointer',
                connectionSource === theme.id && 'ring-2 ring-[hsl(var(--mm-teal))]',
                !connectionMode && 'cursor-move',
              )}
              style={{
                left: pos.x, top: pos.y,
                ...(focusedSet && !focusedSet.has(theme.id) ? getUnfocusedStyle(false) : undefined),
              }}
              onMouseDown={handleCardMouseDown(theme.id)}
              onClick={handleCardClick(theme.id)}
              onKeyDown={(e) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault()
                  onDeleteTheme(theme.id)
                }
              }}
            >
              {/* Color stripe */}
              <div
                className="h-2 rounded-t-md"
                style={{ backgroundColor: theme.color ?? '#6366f1' }}
              />

              {/* Card body */}
              <div className="px-3 py-2">
                <div className="text-[13px] font-semibold text-mm-text mb-1 leading-tight">
                  {theme.name}
                </div>

                {/* Nested child themes (card expansion) */}
                {showNesting && children.length > 0 && (
                  <div className="mt-1 pt-1 border-t border-mm-border-subtle space-y-0.5">
                    {children.map(child => {
                      const childSummary = themeContentSummaries.get(child.id)
                      const childConns = connectionCounts.get(child.id) ?? 0
                      const childMatCount = childSummary ? childSummary.excerptCount + childSummary.chartCount + childSummary.memoCount + childSummary.calloutCount : 0
                      return (
                        <ContextMenu key={child.id}>
                          <ContextMenuTrigger asChild>
                            <div
                              className="px-1 py-0.5 rounded hover:bg-mm-bg/40 cursor-grab active:cursor-grabbing"
                              onMouseDown={(e) => {
                                if (connectionMode) return
                                e.stopPropagation()
                                const parentPos = getPosition(theme, index)
                                setLocalPositions(prev => ({ ...prev, [child.id]: { x: parentPos.x + 20, y: parentPos.y + 20 } }))
                                setDragState({
                                  themeId: child.id,
                                  startX: e.clientX,
                                  startY: e.clientY,
                                  offset: { x: CARD_WIDTH / 2, y: CARD_BASE_HEIGHT / 2 },
                                })
                              }}
                            >
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="text-[12px] font-semibold text-mm-text-secondary leading-tight truncate">{child.name}</span>
                                {childConns > 0 && (
                                  <RelationshipBadge count={childConns} onClick={() => { if (!connectionMode) setSpatialFocusId(prev => prev === child.id ? null : child.id) }} />
                                )}
                              </div>
                              {showContent && childSummary && childMatCount > 0 && (
                                <div className="space-y-0.5 mt-0.5">
                                  {childSummary.previews.slice(0, 2).map((preview, i) => (
                                    <div key={i} className="text-[10.5px] text-mm-text-faint truncate pl-1">{preview}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onSelect={() => { onSetView('writing'); onFocusTheme(child.id) }}>
                              <PenLine className="w-4 h-4 mr-2" />Edit in Writing View
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>
                                <Palette className="w-4 h-4 mr-2" />Change Color
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="p-2">
                                <ColorSwatchPicker value={child.color ?? '#6366f1'} onChange={color => onUpdateTheme(child.id, { color })} />
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => onUpdateTheme(child.id, { parent_theme_id: null })}>
                              Remove from Parent
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => onDeleteTheme(child.id)} className="text-red-600 dark:text-red-400">
                              <Trash2 className="w-4 h-4 mr-2" />Delete Theme
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                  </div>
                )}

                {/* Drag-to-nest placeholder */}
                {dropTarget === theme.id && dragState && (
                  <div className="mx-0 my-1 py-1 border border-dashed border-teal-400 rounded text-[11px] text-teal-600 dark:text-teal-400 text-center">
                    + {allThemes.find(t => t.id === dragState.themeId)?.name ?? 'theme'}
                  </div>
                )}

                {/* Material previews */}
                {showContent && summary && ownMaterialCount > 0 && (
                  <div className={cn('space-y-0.5', (showNesting && children.length > 0) ? 'mt-1 pt-1 border-t border-mm-border-subtle' : '')}>
                    {summary.previews.slice(0, 4).map((preview, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[11.5px] text-mm-text-muted truncate">
                        <span className="truncate">{preview}</span>
                      </div>
                    ))}
                    {summary.previews.length > 4 && (
                      <div className="text-[10px] text-mm-text-faint">+{summary.previews.length - 4} more</div>
                    )}
                  </div>
                )}

                {/* Footer: material count + relationship badge */}
                <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-mm-border-subtle text-[11px] text-mm-text-faint tabular-nums">
                  {totalMaterials} material{totalMaterials !== 1 ? 's' : ''}
                  {themeConns > 0 && (
                    <RelationshipBadge count={themeConns} onClick={() => { if (!connectionMode) setSpatialFocusId(prev => prev === theme.id ? null : theme.id) }} />
                  )}
                </div>
              </div>
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => { onSetView('writing'); onFocusTheme(theme.id) }}>
                <PenLine className="w-4 h-4 mr-2" />
                Edit in Writing View
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Palette className="w-4 h-4 mr-2" />
                  Change Color
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="p-2">
                  <ColorSwatchPicker value={theme.color ?? '#6366f1'} onChange={color => onUpdateTheme(theme.id, { color })} />
                </ContextMenuSubContent>
              </ContextMenuSub>
              {children.length === 0 && topLevelThemes.filter(t => t.id !== theme.id && t.section_type === 'theme').length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <FolderInput className="w-4 h-4 mr-2" />
                    Nest Into
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-64 overflow-y-auto w-48">
                    {topLevelThemes.filter(t => t.id !== theme.id && t.section_type === 'theme').map(t => (
                      <ContextMenuItem key={t.id} onSelect={() => onUpdateTheme(theme.id, { parent_theme_id: t.id })}>
                        <div className="w-2 h-2 rounded-full shrink-0 mr-2" style={{ backgroundColor: t.color ?? '#6366f1' }} />
                        <span className="truncate">{t.name}</span>
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              {!connectionMode && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => {
                    setConnectionMode(true)
                    setConnectionSource(theme.id)
                  }}>
                    <ArrowRight className="w-4 h-4 mr-2" />
                    Add Connection from Here
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onDeleteTheme(theme.id)} className="text-red-600 dark:text-red-400">
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Theme
              </ContextMenuItem>
            </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>

      {/* ── Ghost card for dragging nested child out of parent ──────────── */}
      {dragState && (() => {
        const draggedTheme = themeById.get(dragState.themeId)
        if (!draggedTheme || draggedTheme.parent_theme_id == null) return null
        const ghostPos = localPositions[dragState.themeId]
        if (!ghostPos) return null
        return (
          <div style={{ position: 'absolute', transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <div
              className="absolute w-[210px] bg-white dark:bg-mm-surface border border-mm-border rounded-md shadow-xl opacity-80 z-20 pointer-events-none"
              style={{ left: ghostPos.x, top: ghostPos.y }}
            >
              <div className="h-2 rounded-t-md" style={{ backgroundColor: draggedTheme.color ?? '#6366f1' }} />
              <div className="px-3 py-2 text-[13px] font-semibold text-mm-text">{draggedTheme.name}</div>
            </div>
          </div>
        )
      })()}

      {/* ── Spatial toolbar (top-left, floating) ────────────────────────── */}
      <div className="absolute top-3 left-3 flex gap-1 z-10" data-spatial-toolbar>
        <button
          type="button"
          className={cn(
            'h-[30px] px-2.5 border rounded text-[11.5px] font-medium shadow-sm transition-colors flex items-center gap-1',
            showContent
              ? 'border-[hsl(var(--mm-blue)/0.3)] bg-[hsl(var(--mm-blue)/0.08)] dark:bg-[hsl(var(--mm-blue)/0.15)] text-[hsl(var(--mm-blue-text))] dark:text-[hsl(var(--mm-blue)/0.8)]'
              : 'border-mm-border bg-white dark:bg-mm-surface text-mm-text-faint',
          )}
          onClick={() => setShowContent(prev => !prev)}
          aria-pressed={showContent}
          aria-label="Toggle material previews"
        >
          {showContent ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          Materials
        </button>
        <button
          type="button"
          className={cn(
            'h-[30px] px-2.5 border rounded text-[11.5px] font-medium shadow-sm transition-colors flex items-center gap-1',
            showNesting
              ? 'border-[hsl(var(--mm-blue)/0.3)] bg-[hsl(var(--mm-blue)/0.08)] dark:bg-[hsl(var(--mm-blue)/0.15)] text-[hsl(var(--mm-blue-text))] dark:text-[hsl(var(--mm-blue)/0.8)]'
              : 'border-mm-border bg-white dark:bg-mm-surface text-mm-text-faint',
          )}
          onClick={() => setShowNesting(prev => !prev)}
          aria-pressed={showNesting}
          aria-label="Toggle nested themes"
        >
          {showNesting ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          Nested Themes
        </button>
        <button
          type="button"
          className={cn(
            'h-[30px] px-2.5 border rounded text-[11.5px] font-medium shadow-sm transition-colors flex items-center gap-1',
            showFullLabels
              ? 'border-[hsl(var(--mm-blue)/0.3)] bg-[hsl(var(--mm-blue)/0.08)] dark:bg-[hsl(var(--mm-blue)/0.15)] text-[hsl(var(--mm-blue-text))] dark:text-[hsl(var(--mm-blue)/0.8)]'
              : 'border-mm-border bg-white dark:bg-mm-surface text-mm-text-faint',
          )}
          onClick={() => setShowFullLabels(prev => !prev)}
          aria-pressed={showFullLabels}
          aria-label="Toggle full relationship labels"
        >
          {showFullLabels ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          Labels
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-[30px] px-2.5 border rounded text-[11.5px] font-medium shadow-sm transition-colors flex items-center gap-1 border-mm-border bg-white dark:bg-mm-surface text-mm-text-secondary hover:bg-mm-bg"
              disabled={topLevelThemes.length === 0}
              aria-label="Choose layout arrangement"
            >
              <LayoutGrid className="w-3 h-3" />
              Layout
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {LAYOUTS.map(layout => (
              <DropdownMenuItem key={layout.key} onClick={() => applyLayout(layout.fn)}>
                <layout.icon className="w-3.5 h-3.5 mr-2 text-mm-text-muted" />
                {layout.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className={cn(
            'h-[30px] px-2.5 border rounded text-[11.5px] font-medium shadow-sm transition-colors',
            connectionMode
              ? 'bg-[hsl(var(--mm-teal))] text-white border-[hsl(var(--mm-teal))]'
              : 'border-mm-border bg-white dark:bg-mm-surface text-mm-text-secondary hover:bg-mm-bg',
          )}
          onClick={toggleConnectionMode}
          aria-pressed={connectionMode}
          aria-label={connectionMode ? (connectionSource != null ? 'Click target theme' : 'Click source theme') : 'Add connection between themes'}
        >
          {connectionMode
            ? connectionSource != null
              ? 'Click target...'
              : 'Click source...'
            : 'Add Connection'}
        </button>
      </div>

      {/* ── Connection mode instructions ───────────────────────────────── */}
      {connectionMode && (
        <div className="absolute top-12 left-3 z-10 bg-white dark:bg-mm-surface border border-mm-border rounded px-3 py-1.5 text-xs text-mm-text-muted shadow-sm">
          {connectionSource == null
            ? 'Click a source theme card to start'
            : 'Now click a target theme card to create the relationship'}
        </div>
      )}

      {/* ── Zoom controls (bottom-right, floating) ──────────────────────── */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-0.5 z-10" data-spatial-zoom>
        <button
          type="button"
          className="w-8 h-8 border border-mm-border bg-white dark:bg-mm-surface text-mm-text-secondary text-base flex items-center justify-center shadow-sm rounded-t hover:bg-mm-bg transition-colors"
          onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))}
          aria-label="Zoom in"
        >
          +
        </button>
        <div className="text-[10px] font-mono text-mm-text-muted text-center bg-white dark:bg-mm-surface border-x border-mm-border px-1 leading-6">
          {Math.round(zoom * 100)}%
        </div>
        <button
          type="button"
          className="w-8 h-8 border border-mm-border bg-white dark:bg-mm-surface text-mm-text-secondary text-base flex items-center justify-center shadow-sm rounded-b hover:bg-mm-bg transition-colors"
          onClick={() => setZoom(z => Math.max(0.3, +(z - 0.1).toFixed(2)))}
          aria-label="Zoom out"
        >
          {'\u2212'}
        </button>
      </div>

      {/* ── Arrow right-click menu (floating portal) ─────────────────── */}
      {arrowMenu && (
        <FloatingMenu x={arrowMenu.x} y={arrowMenu.y} onClose={() => setArrowMenu(null)}>
          <FloatingMenuItem icon={Pencil} label="Edit Relationship..." onClick={() => { setEditingRelId(arrowMenu.relId); setArrowMenu(null) }} />
          <FloatingMenuSeparator />
          <FloatingMenuItem icon={Trash2} label="Delete Connection" danger onClick={() => { onDeleteRelationship(arrowMenu.relId); setArrowMenu(null) }} />
        </FloatingMenu>
      )}

      {/* ── Background right-click menu (floating portal) ────────────── */}
      {bgMenu && (
        <FloatingMenu x={bgMenu.x} y={bgMenu.y} onClose={() => setBgMenu(null)}>
          <FloatingMenuItem icon={Plus} label="Add Theme Here" onClick={() => { onCreateTheme({ name: 'New theme', viz_x: bgMenu.canvasX, viz_y: bgMenu.canvasY }); setBgMenu(null) }} />
        </FloatingMenu>
      )}

      {/* ── Relationship popover: editing existing ──────────────────────── */}
      {editingRelData && (
        <RelationshipPopoverPortal
          sourceTheme={editingRelData.sourceTheme}
          allThemes={allThemes}
          onCreateRelationship={onCreateRelationship}
          onUpdateRelationship={onUpdateRelationship}
          onDeleteRelationship={(relId) => {
            onDeleteRelationship(relId)
            setEditingRelId(null)
          }}
          onClose={handleRelPopoverClose}
          position={getPopoverPosition(
            getPosition(editingRelData.sourceTheme, allThemes.indexOf(editingRelData.sourceTheme)),
            getPosition(editingRelData.targetTheme, allThemes.indexOf(editingRelData.targetTheme)),
            pan,
            zoom,
          )}
        />
      )}

      {/* ── Relationship popover: creating from connection mode ──────── */}
      {connectionSourceTheme && newRelTarget != null && (
        <RelationshipPopoverPortal
          sourceTheme={connectionSourceTheme}
          allThemes={allThemes}
          prefilledTargetId={newRelTarget}
          onCreateRelationship={handleNewRelCreate}
          onUpdateRelationship={onUpdateRelationship}
          onDeleteRelationship={onDeleteRelationship}
          onClose={handleRelPopoverClose}
          position={getPopoverPosition(
            getPosition(connectionSourceTheme, allThemes.indexOf(connectionSourceTheme)),
            getPosition(
              allThemes.find(t => t.id === newRelTarget) ?? connectionSourceTheme,
              allThemes.indexOf(allThemes.find(t => t.id === newRelTarget) ?? connectionSourceTheme),
            ),
            pan,
            zoom,
          )}
        />
      )}
    </div>
  )
}

// ── Popover position helper ──────────────────────────────────────────────────

function getPopoverPosition(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
  pan: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const midX = (sourcePos.x + targetPos.x) / 2 + CARD_WIDTH / 2
  const midY = (sourcePos.y + targetPos.y) / 2 + CARD_BASE_HEIGHT / 2
  return {
    x: midX * zoom + pan.x,
    y: midY * zoom + pan.y,
  }
}

// ── Positioned popover wrapper ───────────────────────────────────────────────
// Opens ThemeRelationshipPopover immediately via defaultOpen={true}.
// Radix Popover handles outside-click and Escape natively (portal-aware).
// onDismiss propagates Radix dismissal to clean up spatial canvas state.

function RelationshipPopoverPortal({
  sourceTheme,
  allThemes,
  prefilledTargetId,
  onCreateRelationship,
  onUpdateRelationship,
  onDeleteRelationship,
  onClose,
  position,
}: {
  sourceTheme: CanvasTheme
  allThemes: CanvasTheme[]
  prefilledTargetId?: number | null
  onCreateRelationship: SpatialCanvasProps['onCreateRelationship']
  onUpdateRelationship: SpatialCanvasProps['onUpdateRelationship']
  onDeleteRelationship: SpatialCanvasProps['onDeleteRelationship']
  onClose: () => void
  position: { x: number; y: number }
}) {
  return (
    <div
      className="absolute z-50"
      style={{ left: position.x, top: position.y }}
    >
      <ThemeRelationshipPopover
        theme={sourceTheme}
        allThemes={allThemes}
        prefilledTargetId={prefilledTargetId}
        defaultOpen
        onDismiss={onClose}
        onCreateRelationship={(...args) => {
          onCreateRelationship(...args)
          onClose()
        }}
        onUpdateRelationship={onUpdateRelationship}
        onDeleteRelationship={onDeleteRelationship}
      />
    </div>
  )
}
