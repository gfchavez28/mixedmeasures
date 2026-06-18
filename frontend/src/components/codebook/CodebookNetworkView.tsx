import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
} from 'd3-force'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'
import type { CodebookCooccurrenceResponse } from '@/lib/api'
import type { CodebookSizing } from '@/hooks/useCodebookState'
import { useChartColors, useTheme } from '@/lib/theme-context'
import { fitViewportToBounds } from '@/lib/codebook-utils'
import type { Viewport, LayoutBounds } from '@/lib/codebook-utils'
import { COLOR_DEFAULT, COLOR_SELECT, COLOR_SPOTLIGHT } from '@/lib/codebook-constants'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'

// ── Types ────────────────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: number
  name: string
  color: string
  segmentCount: number
  sourceCount: number
  categoryPath: string[]
  radius: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number
}

type PNode = SimNode & { x: number; y: number }
type PLink = { source: PNode; target: PNode; weight: number }

interface CategoryZone {
  rootName: string
  color: string
  cx: number
  cy: number
  rx: number
  ry: number
  codeCount: number
}

interface Simulation {
  nodes: PNode[]
  links: PLink[]
  roots: string[]
  rootColorMap: Map<string, string>
  maxSeg: number
  maxSrc: number
}

interface Layout {
  nodes: PNode[]
  links: PLink[]
  roots: string[]
  rootColorMap: Map<string, string>
  zones: CategoryZone[]
  bounds: LayoutBounds
}

type TooltipState =
  | { kind: 'node'; node: PNode; x: number; y: number }
  | { kind: 'edge'; source: PNode; target: PNode; weight: number; x: number; y: number }

interface CodebookNetworkViewProps {
  data: CodebookCooccurrenceResponse
  sizing: CodebookSizing
  search: string
  selection: string | null
  onSelect: (sel: string | null) => void
  onSearchMatchCount?: (count: number) => void
  announce?: (msg: string) => void
  multiSelect: Set<string>
  onMultiSelectChange: (next: Set<string>) => void
  onContextMenu: (nodeId: string, clientX: number, clientY: number) => void
  lastSelectedRef: React.MutableRefObject<string | null>
  availableLevels?: { value: number; label: string }[]
  // Color editing from tooltip
  onCodeColorChange?: (codeId: number, color: string | null) => void
  onCategoryColorChange?: (categoryId: number, color: string) => void
  // Creation preview spotlight
  spotlightZoneName?: string | null
}

// ── Constants ────────────────────────────────────────────────────────────────

const VB_W = 800
const VB_H = 600
const VB_CX = VB_W / 2
const VB_CY = VB_H / 2
// ASPECT constant removed — SVG preserveAspectRatio="meet" handles fitting

const R_MIN = 6
const R_MAX = 20
const R_UNIFORM = 10

const EDGE_W_MIN = 1.2
const EDGE_W_MAX = 3

const ZOOM_FACTOR = 1.15
const ZOOM_MIN_W = 80   // extreme zoom-in
const ZOOM_MAX_W = 3200 // extreme zoom-out

const CAT_TARGET_RADIUS = 120
const CAT_FORCE_STRENGTH = 0.18
const CHARGE_STRENGTH = -200
const COLLIDE_PADDING = 10
const ZONE_PAD = 35
const ZONE_MIN_R = 30
const FIT_PAD = 50 // margin around node bounding box for auto-fit

// ── Component ────────────────────────────────────────────────────────────────

export default function CodebookNetworkView({
  data,
  sizing,
  search,
  selection,
  onSelect,
  onSearchMatchCount,
  announce,
  multiSelect,
  onMultiSelectChange,
  onContextMenu,
  lastSelectedRef,
  availableLevels,
  onCodeColorChange,
  onCategoryColorChange,
  spotlightZoneName,
}: CodebookNetworkViewProps) {
  const chartColors = useChartColors()
  const { isDark } = useTheme()
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [tooltipPickerOpen, setTooltipPickerOpen] = useState(false)
  const tooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTooltipHide = useCallback(() => {
    if (tooltipHideTimer.current) {
      clearTimeout(tooltipHideTimer.current)
      tooltipHideTimer.current = null
    }
  }, [])

  const hideTooltip = useCallback(() => {
    if (tooltipPickerOpen) return
    cancelTooltipHide()
    tooltipHideTimer.current = setTimeout(() => {
      setTooltip(null)
      tooltipHideTimer.current = null
    }, 150)
  }, [tooltipPickerOpen, cancelTooltipHide])

  const hideTooltipNow = useCallback(() => {
    cancelTooltipHide()
    setTooltipPickerOpen(false)
    setTooltip(null)
  }, [cancelTooltipHide])

  useEffect(() => () => cancelTooltipHide(), [cancelTooltipHide])

  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null)
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null)
  const [hasInteracted, setHasInteracted] = useState(false)
  const [focusedIdx, setFocusedIdx] = useState(0)
  const keyNavActive = useRef(false)

  const selPrefix = data.hierarchy_level === -1 ? 'code' : 'cat'

  // ── Static d3-force simulation (depends only on data, NOT sizing) ──────

  const simulation = useMemo<Simulation | null>(() => {
    if (data.nodes.length === 0) return null

    // Max counts for radius scaling (captured here for the layout pass)
    let maxSeg = 1, maxSrc = 1
    for (const n of data.nodes) {
      if (n.segment_count > maxSeg) maxSeg = n.segment_count
      if (n.source_count > maxSrc) maxSrc = n.source_count
    }

    const simNodes: SimNode[] = data.nodes.map(n => ({
      id: n.id,
      name: n.name,
      color: n.color || COLOR_DEFAULT,
      segmentCount: n.segment_count,
      sourceCount: n.source_count,
      categoryPath: n.category_path,
      radius: R_UNIFORM, // uniform for simulation; sizing applied in layout pass
    }))

    // Category-angle seeding
    const roots = [...new Set(simNodes.map(n => n.categoryPath[0] || ''))]
    const catCount = Math.max(roots.length, 1)
    const catTarget = new Map<string, { x: number; y: number }>()
    roots.forEach((cat, i) => {
      const a = (2 * Math.PI * i) / catCount
      catTarget.set(cat, { x: VB_CX + Math.cos(a) * CAT_TARGET_RADIUS, y: VB_CY + Math.sin(a) * CAT_TARGET_RADIUS })
    })

    // Seed initial positions (deterministic jitter via Knuth hash)
    for (const node of simNodes) {
      const root = node.categoryPath[0] || ''
      const idx = roots.indexOf(root)
      const a = (2 * Math.PI * idx) / catCount
      const h1 = ((node.id * 2654435761) >>> 0) / 0x100000000
      const h2 = ((node.id * 1597334677) >>> 0) / 0x100000000
      node.x = VB_CX + Math.cos(a) * 120 + (h1 - 0.5) * 80
      node.y = VB_CY + Math.sin(a) * 120 + (h2 - 0.5) * 80
    }

    // Build links
    const simLinks: SimLink[] = data.edges.map(e => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    }))

    // Simulate
    const sim = forceSimulation<SimNode>(simNodes)
      .force('link', forceLink<SimNode, SimLink>(simLinks).id(d => d.id).strength(0.3).distance(80))
      .force('charge', forceManyBody().strength(CHARGE_STRENGTH))
      .force('center', forceCenter(VB_CX, VB_CY))
      .force('collide', forceCollide<SimNode>(d => d.radius + COLLIDE_PADDING))
      .force('catX', forceX<SimNode>(d => catTarget.get(d.categoryPath[0] || '')?.x ?? VB_CX).strength(CAT_FORCE_STRENGTH))
      .force('catY', forceY<SimNode>(d => catTarget.get(d.categoryPath[0] || '')?.y ?? VB_CY).strength(CAT_FORCE_STRENGTH))

    sim.tick(300)
    sim.stop()

    const posNodes = simNodes as PNode[]

    // Build root color map
    const rootColorMap = new Map<string, string>()
    for (const node of posNodes) {
      const root = node.categoryPath[0] || ''
      if (!rootColorMap.has(root)) rootColorMap.set(root, node.color)
    }

    return { nodes: posNodes, links: simLinks as unknown as PLink[], roots, rootColorMap, maxSeg, maxSrc }
  }, [data])

  // ── Layout pass: apply sizing + compute zones/bounds (no simulation re-run) ─

  const layout = useMemo<Layout | null>(() => {
    if (!simulation) return null

    // Apply radius scaling based on current sizing mode
    const posNodes = simulation.nodes.map(n => {
      let radius = R_UNIFORM
      if (sizing === 'seg') radius = R_MIN + (R_MAX - R_MIN) * (n.segmentCount / simulation.maxSeg)
      else if (sizing === 'src') radius = R_MIN + (R_MAX - R_MIN) * (n.sourceCount / simulation.maxSrc)
      return { ...n, radius }
    })

    // Compute category zone ellipses
    const zones: CategoryZone[] = []
    for (const rootName of simulation.roots) {
      if (!rootName) continue // skip universal/uncategorized (empty string root)
      const catNodes = posNodes.filter(n => (n.categoryPath[0] || '') === rootName)
      if (catNodes.length === 0) continue

      const cx = catNodes.reduce((s, n) => s + n.x, 0) / catNodes.length
      const cy = catNodes.reduce((s, n) => s + n.y, 0) / catNodes.length
      let maxDx = 0, maxDy = 0
      for (const n of catNodes) {
        const dx = Math.abs(n.x - cx) + n.radius
        const dy = Math.abs(n.y - cy) + n.radius
        if (dx > maxDx) maxDx = dx
        if (dy > maxDy) maxDy = dy
      }
      zones.push({
        rootName,
        color: simulation.rootColorMap.get(rootName) || COLOR_DEFAULT,
        cx,
        cy,
        rx: Math.max(maxDx + ZONE_PAD, ZONE_MIN_R),
        ry: Math.max(maxDy + ZONE_PAD, ZONE_MIN_R),
        codeCount: catNodes.length,
      })
    }
    // Sort by area descending so larger zones render behind
    zones.sort((a, b) => (b.rx * b.ry) - (a.rx * a.ry))

    // Compute bounding box from nodes + zones
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of posNodes) {
      const left = n.x - n.radius
      const right = n.x + n.radius
      const top = n.y - n.radius - 25 // label space below
      const bottom = n.y + n.radius + 25
      if (left < minX) minX = left
      if (right > maxX) maxX = right
      if (top < minY) minY = top
      if (bottom > maxY) maxY = bottom
    }
    for (const z of zones) {
      if (z.cx - z.rx < minX) minX = z.cx - z.rx
      if (z.cx + z.rx > maxX) maxX = z.cx + z.rx
      if (z.cy - z.ry - 16 < minY) minY = z.cy - z.ry - 16 // zone label space
      if (z.cy + z.ry > maxY) maxY = z.cy + z.ry
    }

    return { nodes: posNodes, links: simulation.links, roots: simulation.roots, rootColorMap: simulation.rootColorMap, zones, bounds: { minX, maxX, minY, maxY } }
  }, [simulation, sizing])

  // ── Container size measurement ──────────────────────────────────────────

  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null)

  // Sync initial measurement (before first paint)
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      setContainerSize({ width: rect.width, height: rect.height })
    } else {
      // Element may not be laid out yet — retry after browser layout pass
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          setContainerSize({ width: r.width, height: r.height })
        }
      })
    }
  }, [])

  // ResizeObserver for subsequent changes (debounced)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    const ro = new ResizeObserver((entries) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { width, height } = entries[0].contentRect
        if (width > 0 && height > 0) {
          setContainerSize(prev => {
            if (prev && Math.abs(prev.width - width) < 5 && Math.abs(prev.height - height) < 5) return prev
            return { width, height }
          })
        }
      }, 100)
    })
    ro.observe(el)
    return () => { clearTimeout(timer); ro.disconnect() }
  }, [])

  // ── Legend measurement ─────────────────────────────────────────────────

  const legendRef = useRef<HTMLDivElement>(null)
  const [legendHeight, setLegendHeight] = useState(0)

  useEffect(() => {
    const h = legendRef.current?.offsetHeight ?? 0
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measure legend DOM height
    if (h !== legendHeight) setLegendHeight(h)
  }, [legendHeight])

  // ── Fit viewport (derived from layout bounds + legend, no aspect enforcement) ─

  const fitViewport = useMemo<Viewport>(() => {
    if (!layout) return { x: 0, y: 0, width: VB_W, height: VB_H }
    // Legend offset: convert pixel height to SVG-space proportional padding
    const rawH = layout.bounds.maxY - layout.bounds.minY + FIT_PAD * 2
    const legendPad = containerSize && containerSize.height > 0
      ? legendHeight / containerSize.height * rawH
      : 0
    return fitViewportToBounds(layout.bounds, FIT_PAD, legendPad)
  }, [layout, containerSize, legendHeight])

  // ── Viewport (zoom/pan) ─────────────────────────────────────────────────

  const [viewport, setViewport] = useState<Viewport | null>(null)

  // Reset viewport to fit when the underlying graph changes (new data / hierarchy level).
  // Sizing-only changes update layout but NOT simulation, so viewport is preserved.
  const simIdRef = useRef<Simulation | null>(null)
  useEffect(() => {
    if (simulation && simulation !== simIdRef.current) {
      simIdRef.current = simulation
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync viewport when simulation changes
      setViewport(fitViewport)
    }
  }, [simulation, fitViewport])

  // Re-fit when legend first measures (0 → actual height)
  const prevLegendH = useRef(0)
  /* eslint-disable react-hooks/set-state-in-effect -- re-fit viewport on first legend measurement */
  useEffect(() => {
    if (legendHeight !== prevLegendH.current && prevLegendH.current === 0 && legendHeight > 0) {
      prevLegendH.current = legendHeight
      setViewport(fitViewport)
    } else {
      prevLegendH.current = legendHeight
    }
  }, [legendHeight, fitViewport])
  /* eslint-enable react-hooks/set-state-in-effect */

  const vp = viewport || fitViewport

  const zoomLevel = useMemo(() => {
    return fitViewport.width / vp.width
  }, [fitViewport.width, vp.width])

  const zoomPercent = Math.round(zoomLevel * 100)

  // Zoom around a point (scales both dimensions uniformly)
  const zoomAtPoint = useCallback((factor: number, screenX: number, screenY: number) => {
    const svg = svgRef.current
    if (!svg) return

    // Convert screen point to SVG coordinates
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const inv = ctm.inverse()
    const pt = new DOMPoint(screenX, screenY).matrixTransform(inv)

    setViewport(prev => {
      const cur = prev || fitViewport
      let newW = cur.width / factor
      // Clamp
      newW = Math.max(ZOOM_MIN_W, Math.min(ZOOM_MAX_W, newW))
      const scale = newW / cur.width
      const newH = cur.height * scale
      // Keep the point under the cursor stationary
      const ratioX = (pt.x - cur.x) / cur.width
      const ratioY = (pt.y - cur.y) / cur.height
      return {
        x: pt.x - ratioX * newW,
        y: pt.y - ratioY * newH,
        width: newW,
        height: newH,
      }
    })
  }, [fitViewport])

  // Wheel zoom — must use useEffect with passive:false to allow preventDefault
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      hideTooltipNow()
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
      zoomAtPoint(factor, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoomAtPoint, hideTooltipNow])

  // Pan via click-drag on background (screen-space delta approach)
  const panScreenStart = useRef<{ sx: number; sy: number; vpStart: Viewport } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  const handlePanMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement
    if (target.closest('[data-node-id]')) return
    hideTooltipNow()
    panScreenStart.current = { sx: e.clientX, sy: e.clientY, vpStart: { ...vp } }
    setIsPanning(true)
    e.preventDefault()
  }, [vp, hideTooltipNow])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ps = panScreenStart.current
      if (!ps) return
      const svg = svgRef.current
      if (!svg) return
      // Use getScreenCTM for accurate SVG↔screen mapping (accounts for meet letterboxing)
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const scaleX = 1 / ctm.a
      const scaleY = 1 / ctm.d
      setViewport({
        x: ps.vpStart.x - (e.clientX - ps.sx) * scaleX,
        y: ps.vpStart.y - (e.clientY - ps.sy) * scaleY,
        width: ps.vpStart.width,
        height: ps.vpStart.height,
      })
    }
    const handleMouseUp = () => {
      panScreenStart.current = null
      setIsPanning(false)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Toolbar zoom actions (exposed via callback props or internal)
  const handleZoomIn = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    zoomAtPoint(1.3, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [zoomAtPoint])

  const handleZoomOut = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    zoomAtPoint(1 / 1.3, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [zoomAtPoint])

  const handleZoomFit = useCallback(() => {
    setViewport(fitViewport)
  }, [fitViewport])

  // Double-click background to fit
  const handleDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement
    if (target.closest('[data-node-id]')) return
    handleZoomFit()
  }, [handleZoomFit])

  // Announce zoom changes
  const prevZoomPercent = useRef(100)
  useEffect(() => {
    if (zoomPercent !== prevZoomPercent.current) {
      prevZoomPercent.current = zoomPercent
      announce?.(`Network zoom ${zoomPercent}%`)
    }
  }, [zoomPercent, announce])

  // ── Derived data ──────────────────────────────────────────────────────────

  const sortedNodeIds = useMemo(() => {
    if (!layout) return []
    return [...layout.nodes].sort((a, b) => a.name.localeCompare(b.name)).map(n => n.id)
  }, [layout])

  const adjacency = useMemo(() => {
    if (!layout) return new Map<number, { name: string; weight: number }[]>()
    const adj = new Map<number, { name: string; weight: number }[]>()
    for (const link of layout.links) {
      if (!adj.has(link.source.id)) adj.set(link.source.id, [])
      if (!adj.has(link.target.id)) adj.set(link.target.id, [])
      adj.get(link.source.id)!.push({ name: link.target.name, weight: link.weight })
      adj.get(link.target.id)!.push({ name: link.source.name, weight: link.weight })
    }
    for (const [, list] of adj) list.sort((a, b) => b.weight - a.weight)
    return adj
  }, [layout])

  const maxW = useMemo(() => data.max_weight || 1, [data.max_weight])

  // ── Export label (must be above early return to preserve hook order) ─────

  const levelLabel = useMemo(() => {
    if (data.hierarchy_level === -1) return 'codes'
    const match = availableLevels?.find(l => l.value === data.hierarchy_level)
    if (match) return match.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return `L${data.hierarchy_level}`
  }, [data.hierarchy_level, availableLevels])

  // ── Search ────────────────────────────────────────────────────────────────

  const lowerSearch = useMemo(() => search.toLowerCase().trim(), [search])

  const matchingIds = useMemo<Set<number> | null>(() => {
    if (!lowerSearch || !layout) return null
    return new Set(layout.nodes.filter(n => n.name.toLowerCase().includes(lowerSearch)).map(n => n.id))
  }, [layout, lowerSearch])

  useEffect(() => {
    onSearchMatchCount?.(matchingIds?.size ?? 0)
  }, [matchingIds, onSearchMatchCount])

  // ── Selection ─────────────────────────────────────────────────────────────

  const selectedId = useMemo<number | null>(() => {
    if (!selection) return null
    const [pfx, idStr] = selection.split(':')
    if (pfx !== selPrefix) return null
    const n = Number(idStr)
    return isNaN(n) ? null : n
  }, [selection, selPrefix])

  const connectedIds = useMemo(() => {
    if (selectedId == null || !layout) return new Set<number>()
    const s = new Set<number>()
    for (const l of layout.links) {
      if (l.source.id === selectedId) s.add(l.target.id)
      if (l.target.id === selectedId) s.add(l.source.id)
    }
    return s
  }, [selectedId, layout])

  // ── Tooltip helpers ───────────────────────────────────────────────────────

  const showTooltipAtNode = useCallback((node: PNode) => {
    if (tooltipPickerOpen) return
    cancelTooltipHide()
    const svg = svgRef.current, ctr = containerRef.current
    if (!svg || !ctr) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const cr = ctr.getBoundingClientRect()
    const sp = new DOMPoint(node.x, node.y).matrixTransform(ctm)
    // Clamp tooltip to container bounds
    const maxTooltipW = 260
    let tx = sp.x - cr.left + node.radius + 8
    let ty = sp.y - cr.top
    if (tx + maxTooltipW > cr.width) tx = sp.x - cr.left - maxTooltipW - 8
    if (ty < 20) ty = 20
    if (ty > cr.height - 20) ty = cr.height - 20
    setTooltip({ kind: 'node', node, x: tx, y: ty })
  }, [tooltipPickerOpen, cancelTooltipHide])

  // ── Keyboard focus ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!keyNavActive.current || sortedNodeIds.length === 0) return
    const nid = sortedNodeIds[focusedIdx]
    const el = svgRef.current?.querySelector(`[data-node-id="${nid}"]`) as SVGElement | null
    el?.focus()
  }, [focusedIdx, sortedNodeIds])

  // ── Opacity helpers ───────────────────────────────────────────────────────

  const getNodeOpacity = useCallback((id: number, catRoot?: string) => {
    if (matchingIds && !matchingIds.has(id)) return 0.15
    if (multiSelect.size > 0 && !multiSelect.has(`${selPrefix}-${id}`)) return 0.15
    if (hoveredCategory && catRoot !== hoveredCategory) return 0.2
    if (selectedId != null && selectedId !== id && !connectedIds.has(id)) return 0.15
    return 1
  }, [matchingIds, selectedId, connectedIds, multiSelect, selPrefix, hoveredCategory])

  const getEdgeOpacity = useCallback((link: PLink) => {
    const edgeKey = `${link.source.id}-${link.target.id}`
    if (hoveredEdgeKey === edgeKey) return 1
    if (matchingIds && !matchingIds.has(link.source.id) && !matchingIds.has(link.target.id)) return 0.05
    if (multiSelect.size > 0 && !multiSelect.has(`${selPrefix}-${link.source.id}`) && !multiSelect.has(`${selPrefix}-${link.target.id}`)) return 0.08
    if (hoveredCategory) {
      const srcRoot = link.source.categoryPath[0] || ''
      const tgtRoot = link.target.categoryPath[0] || ''
      if (srcRoot !== hoveredCategory && tgtRoot !== hoveredCategory) return 0.08
    }
    if (selectedId != null) {
      return (link.source.id === selectedId || link.target.id === selectedId) ? 1 : 0.08
    }
    return 0.15 + 0.5 * (link.weight / maxW)
  }, [matchingIds, selectedId, maxW, multiSelect, selPrefix, hoveredEdgeKey, hoveredCategory])

  // ── Edge path builder ─────────────────────────────────────────────────────

  const buildEdgePath = useCallback((link: PLink) => {
    const dx = link.target.x - link.source.x
    const dy = link.target.y - link.source.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 0.1) {
      // Degenerate: straight line
      return `M ${link.source.x},${link.source.y} L ${link.target.x},${link.target.y}`
    }
    const offset = Math.min(dist * 0.08, 15)
    const mx = (link.source.x + link.target.x) / 2 - (dy / dist) * offset
    const my = (link.source.y + link.target.y) / 2 + (dx / dist) * offset
    return `M ${link.source.x},${link.source.y} Q ${mx},${my} ${link.target.x},${link.target.y}`
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNodeClick = useCallback((id: number, e: React.MouseEvent) => {
    setHasInteracted(true)
    const key = `${selPrefix}-${id}`

    if (e.ctrlKey || e.metaKey) {
      // Toggle in multi-select
      const next = new Set(multiSelect)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      onMultiSelectChange(next)
      lastSelectedRef.current = key
      return
    }

    // Plain click: clear multi-select, toggle single select
    if (multiSelect.size > 0) onMultiSelectChange(new Set())
    const sel = `${selPrefix}:${id}`
    onSelect(selection === sel ? null : sel)
    lastSelectedRef.current = key
  }, [multiSelect, onMultiSelectChange, selPrefix, selection, onSelect, lastSelectedRef])

  const handleNodeContextMenu = useCallback((id: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const key = `${selPrefix}-${id}`
    if (!multiSelect.has(key)) {
      onMultiSelectChange(new Set([key]))
    }
    onContextMenu(key, e.clientX, e.clientY)
  }, [multiSelect, onMultiSelectChange, onContextMenu, selPrefix])

  const handleSvgKeyDown = useCallback((e: ReactKeyboardEvent<SVGSVGElement>) => {
    // Keyboard zoom
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      handleZoomIn()
      return
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      handleZoomOut()
      return
    }
    if (e.key === '0') {
      e.preventDefault()
      handleZoomFit()
      return
    }

    // Ctrl+Space or Ctrl+Enter: toggle focused node in multi-select
    if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault()
      const nid = sortedNodeIds[focusedIdx]
      if (nid != null) {
        const key = `${selPrefix}-${nid}`
        const next = new Set(multiSelect)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        onMultiSelectChange(next)
        lastSelectedRef.current = key
      }
      return
    }

    if (sortedNodeIds.length === 0) return
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        keyNavActive.current = true
        setFocusedIdx(i => Math.min(i + 1, sortedNodeIds.length - 1))
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        keyNavActive.current = true
        setFocusedIdx(i => Math.max(i - 1, 0))
        break
      case 'Home':
        keyNavActive.current = true
        setFocusedIdx(0)
        break
      case 'End':
        keyNavActive.current = true
        setFocusedIdx(sortedNodeIds.length - 1)
        break
      case 'Enter':
      case ' ': {
        const sel = `${selPrefix}:${sortedNodeIds[focusedIdx]}`
        onSelect(selection === sel ? null : sel)
        break
      }
      case 'Escape':
        if (multiSelect.size > 0) {
          onMultiSelectChange(new Set())
        } else if (selectedId != null) {
          onSelect(null)
        } else {
          hideTooltip()
        }
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }, [sortedNodeIds, focusedIdx, selPrefix, selection, onSelect, hideTooltip, selectedId, handleZoomIn, handleZoomOut, handleZoomFit, multiSelect, onMultiSelectChange, lastSelectedRef])

  // ── Zoom-responsive label visibility ──────────────────────────────────────

  const showLabels = zoomLevel >= 0.6
  const showCounts = zoomLevel > 1.0
  const showZoneLabels = zoomLevel >= 0.4

  // ── Cursor ────────────────────────────────────────────────────────────────

  const svgCursor = isPanning ? 'grabbing' : 'grab'

  // ── Render ────────────────────────────────────────────────────────────────

  if (!layout || data.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-16">
        <span className="text-3xl mb-3" role="presentation">&#128279;</span>
        <p className="text-sm text-mm-text-secondary max-w-sm">
          No code co-occurrences found. Codes need to co-occur in the same segment or response to appear here.
        </p>
      </div>
    )
  }

  return (
    <ChartExportWrapper supportsSvg fillHeight filename={`codebook-network-${levelLabel}`}>
      <div ref={containerRef} className="relative w-full h-full" style={{ minHeight: 400 }}>
        <svg
          ref={svgRef}
          viewBox={`${vp.x} ${vp.y} ${vp.width} ${vp.height}`}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
          role="application"
          aria-label={`Code co-occurrence network: ${data.nodes.length} nodes, ${data.edges.length} edges. Zoom ${zoomPercent}%`}
          aria-roledescription="interactive network graph"
          tabIndex={0}
          onKeyDown={handleSvgKeyDown}
          onMouseDown={handlePanMouseDown}
          onDoubleClick={handleDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            cursor: svgCursor,
            fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          }}
          onFocus={(e) => {
            if (e.target === e.currentTarget && sortedNodeIds.length > 0) {
              keyNavActive.current = true
              const nid = sortedNodeIds[focusedIdx]
              const el = svgRef.current?.querySelector(`[data-node-id="${nid}"]`) as SVGElement | null
              el?.focus()
            }
          }}
        >
          {/* Background rect — shows app bg + provides export background */}
          <rect
            x={vp.x} y={vp.y} width={vp.width} height={vp.height}
            fill="hsl(var(--mm-surface))"
          />

          {/* Category zone ellipses (lowest z-order) */}
          {layout.zones.map(zone => {
            const isSpotlit = spotlightZoneName === zone.rootName
            return (
            <g key={zone.rootName}>
              <ellipse
                cx={zone.cx}
                cy={zone.cy}
                rx={zone.rx}
                ry={zone.ry}
                fill={zone.color}
                fillOpacity={isSpotlit ? (isDark ? 0.18 : 0.14) : (isDark ? 0.08 : 0.06)}
                stroke={zone.color}
                strokeOpacity={isSpotlit ? 0.6 : 0.15}
                strokeWidth={isSpotlit ? 2.5 : 1}
                strokeDasharray={isSpotlit ? undefined : '6 4'}
              />
              {/* Spotlight outer glow ring */}
              {isSpotlit && (
                <ellipse
                  cx={zone.cx}
                  cy={zone.cy}
                  rx={zone.rx + 8}
                  ry={zone.ry + 8}
                  fill="none"
                  stroke={COLOR_SPOTLIGHT}
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  style={{ pointerEvents: 'none' }}
                >
                  <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite" />
                </ellipse>
              )}
              {/* Zone label at top edge */}
              {showZoneLabels && (
                <text
                  x={zone.cx}
                  y={zone.cy - zone.ry + 14}
                  textAnchor="middle"
                  fill={zone.color}
                  fontSize={11}
                  fontWeight={600}

                  opacity={0.6}
                  style={{ pointerEvents: 'none' }}
                >
                  {zone.rootName.length > 18 ? zone.rootName.slice(0, 16) + '\u2026' : zone.rootName}
                </text>
              )}
            </g>
            )
          })}

          {/* Edges (curved) */}
          {layout.links.map(link => {
            const edgeKey = `${link.source.id}-${link.target.id}`
            const op = getEdgeOpacity(link)
            const w = EDGE_W_MIN + (EDGE_W_MAX - EDGE_W_MIN) * (link.weight / maxW)
            const accent = selectedId != null && (link.source.id === selectedId || link.target.id === selectedId)
            const isHovered = hoveredEdgeKey === edgeKey
            const d = buildEdgePath(link)
            return (
              <g key={edgeKey}>
                {/* Visible edge */}
                <path
                  d={d}
                  fill="none"
                  stroke={accent || isHovered ? chartColors.accent : chartColors.reference}
                  strokeWidth={isHovered ? w + 1 : w}
                  opacity={op}
                  style={{ transition: 'opacity 0.15s, stroke-width 0.1s' }}
                />
                {/* Hit area (wider transparent path for hover) */}
                {op > 0.1 && (
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(12, w + 8)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => {
                      cancelTooltipHide()
                      setHoveredEdgeKey(edgeKey)
                      const cr = containerRef.current?.getBoundingClientRect()
                      if (!cr) return
                      const maxTipW = 220
                      let tx = e.clientX - cr.left + 12
                      let ty = e.clientY - cr.top - 8
                      if (tx + maxTipW > cr.width) tx = e.clientX - cr.left - maxTipW - 8
                      if (ty < 10) ty = 10
                      if (ty > cr.height - 10) ty = cr.height - 10
                      setTooltip({ kind: 'edge', source: link.source, target: link.target, weight: link.weight, x: tx, y: ty })
                    }}
                    onMouseLeave={() => {
                      setHoveredEdgeKey(null)
                      hideTooltip()
                    }}
                  />
                )}
              </g>
            )
          })}

          {/* Nodes */}
          {layout.nodes.map(node => {
            const isSel = selectedId === node.id
            const isMultiSel = multiSelect.has(`${selPrefix}-${node.id}`)
            const op = getNodeOpacity(node.id, node.categoryPath[0] || '')
            const isFocusTarget = sortedNodeIds[focusedIdx] === node.id
            // Show labels for selected/hovered/focused nodes regardless of zoom
            const forceLabel = isSel || isFocusTarget || isMultiSel
            const nodeShowLabels = showLabels || forceLabel
            const nodeShowCounts = showCounts || forceLabel
            return (
              <g key={node.id}>
                {/* Single-select ring (solid accent) */}
                {isSel && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + 4}
                    fill="none"
                    stroke={chartColors.accent}
                    strokeWidth={2.5}
                    opacity={0.7}
                  />
                )}
                {/* Multi-select ring (dashed blue) */}
                {isMultiSel && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + 4}
                    fill="none"
                    stroke={COLOR_SELECT}
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    opacity={0.8}
                  />
                )}
                <circle
                  data-node-id={node.id}
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={node.color}
                  stroke={chartColors.axis}
                  strokeWidth={1}
                  opacity={op}
                  className="outline-none"
                  style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                  tabIndex={isFocusTarget ? 0 : -1}
                  role="img"
                  aria-label={`${node.name}: ${node.segmentCount} segments, ${node.sourceCount} sources`}
                  aria-selected={isMultiSel || undefined}
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(node.id, e) }}
                  onContextMenu={(e) => handleNodeContextMenu(node.id, e)}
                  onMouseEnter={e => {
                    if (tooltipPickerOpen) return
                    cancelTooltipHide()
                    const cr = containerRef.current?.getBoundingClientRect()
                    if (!cr) return
                    const maxTipW = 260
                    let tx = e.clientX - cr.left + 12
                    let ty = e.clientY - cr.top - 8
                    if (tx + maxTipW > cr.width) tx = e.clientX - cr.left - maxTipW - 8
                    if (ty < 10) ty = 10
                    if (ty > cr.height - 10) ty = cr.height - 10
                    setTooltip({ kind: 'node', node, x: tx, y: ty })
                  }}
                  onMouseLeave={hideTooltip}
                  onFocus={() => showTooltipAtNode(node)}
                  onBlur={hideTooltip}
                />
                {/* Node label */}
                {nodeShowLabels && (
                  <text
                    x={node.x}
                    y={node.y + node.radius + 12}
                    textAnchor="middle"
                    fill={chartColors.text}
                    fontSize={10}
                    fontWeight={isSel ? 600 : 400}
  
                    opacity={op}
                    style={{ pointerEvents: 'none', transition: 'opacity 0.15s' }}
                  >
                    {node.name.length > 14 ? node.name.slice(0, 12) + '\u2026' : node.name}
                  </text>
                )}
                {/* Segment count */}
                {nodeShowCounts && (
                  <text
                    x={node.x}
                    y={node.y + node.radius + 22}
                    textAnchor="middle"
                    fill={chartColors.reference}
                    fontSize={9}
  
                    opacity={op}
                    style={{ pointerEvents: 'none', transition: 'opacity 0.15s' }}
                  >
                    {node.segmentCount}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {/* Zoom toolbar */}
        <div
          data-exclude-export=""
          className="absolute top-3 left-3 flex items-center gap-1 bg-mm-bg/95 border border-mm-border-medium rounded-lg p-1 shadow-md z-10"
          role="toolbar"
          aria-label="Zoom controls"
        >
          <button
            onClick={handleZoomIn}
            className="w-6 h-6 rounded flex items-center justify-center text-sm font-medium text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface-hover transition-colors"
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            className="w-6 h-6 rounded flex items-center justify-center text-sm font-medium text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface-hover transition-colors"
            aria-label="Zoom out"
            title="Zoom out (-)"
          >
            &minus;
          </button>
          <button
            onClick={handleZoomFit}
            className="px-1.5 h-6 rounded flex items-center justify-center text-[10px] font-medium text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface-hover transition-colors"
            aria-label="Fit to content"
            title="Fit to content (0)"
          >
            Fit
          </button>
          <span className="text-[10px] text-mm-text-faint tabular-nums px-1">{zoomPercent}%</span>
        </div>

        {/* Hint text */}
        <div
          data-exclude-export=""
          className="absolute top-3 right-3 text-[10px] text-mm-text-muted z-10 transition-opacity duration-150"
          style={{ opacity: (!hasInteracted && multiSelect.size === 0) || multiSelect.size > 0 ? 1 : 0.7 }}
        >
          {!hasInteracted && multiSelect.size === 0
            ? 'Click node to highlight \u00b7 Scroll to zoom \u00b7 +/\u2212/0'
            : multiSelect.size > 0
              ? 'M to move \u00b7 G to merge \u00b7 Esc to clear'
              : 'Scroll to zoom \u00b7 Drag to pan \u00b7 +/\u2212/0'}
        </div>

        {/* Legend */}
        <div
          ref={legendRef}
          data-exclude-export=""
          className="absolute bottom-4 left-4 bg-mm-surface/95 border border-mm-border-subtle rounded-lg p-3 text-[10px] space-y-1.5 z-10 max-h-48 overflow-y-auto"
        >
          <div className="font-medium text-mm-text-secondary mb-1">Legend</div>
          {layout.roots.filter(Boolean).map(cat => {
            const color = layout.rootColorMap.get(cat) || chartColors.text
            const zone = layout.zones.find(z => z.rootName === cat)
            const isHovered = hoveredCategory === cat
            return (
              <div
                key={cat}
                role="button"
                tabIndex={0}
                aria-label={`Highlight ${cat}${zone ? ` (${zone.codeCount} codes)` : ''}`}
                className={`flex items-center gap-2 px-1 -mx-1 rounded cursor-pointer transition-colors ${isHovered ? 'bg-mm-surface-hover' : ''}`}
                onMouseEnter={() => setHoveredCategory(cat)}
                onMouseLeave={() => setHoveredCategory(null)}
                onFocus={() => setHoveredCategory(cat)}
                onBlur={() => setHoveredCategory(null)}
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-mm-text-muted">{cat}</span>
                {zone && <span className="text-mm-text-faint ml-auto tabular-nums">({zone.codeCount})</span>}
              </div>
            )
          })}
          <div className="pt-1 border-t border-mm-border-subtle text-mm-text-faint">
            Line = co-occurrence{sizing !== 'uniform' && <> · Size = {sizing === 'seg' ? 'segments' : 'sources'}</>}
          </div>
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            data-exclude-export=""
            className="absolute z-50 pointer-events-auto px-3 py-2 rounded-lg shadow-lg border border-mm-border-subtle bg-mm-surface text-mm-text max-w-[260px]"
            style={{ left: tooltip.x, top: tooltip.y, transform: 'translateY(-50%)' }}
            onMouseEnter={cancelTooltipHide}
            onMouseLeave={() => {
              if (!tooltipPickerOpen) {
                setTooltip(null)
                cancelTooltipHide()
              }
            }}
          >
            {tooltip.kind === 'node' ? (() => {
              const node = tooltip.node
              const canChangeColor = selPrefix === 'code' ? !!onCodeColorChange : !!onCategoryColorChange
              return (
                <>
                  <div className="flex items-center gap-1.5">
                    {canChangeColor ? (
                      <button
                        className={`w-4 h-4 ${selPrefix === 'code' ? 'rounded-full' : 'rounded'} shrink-0 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow`}
                        style={{ backgroundColor: node.color }}
                        aria-label={`Change color for ${node.name}`}
                        title="Change color"
                        onClick={() => setTooltipPickerOpen(prev => !prev)}
                      />
                    ) : (
                      <span
                        className={`w-4 h-4 ${selPrefix === 'code' ? 'rounded-full' : 'rounded'} shrink-0`}
                        style={{ backgroundColor: node.color }}
                      />
                    )}
                    <div className="font-medium text-sm">{node.name}</div>
                  </div>
                  {tooltipPickerOpen && canChangeColor && (
                    <div className="mt-2 space-y-2 border-t border-mm-border-subtle pt-2">
                      <p className="text-[10px] text-mm-text-faint uppercase tracking-wide">
                        {selPrefix === 'code' ? 'Code' : 'Category'} Color
                      </p>
                      <ColorSwatchPicker
                        value={node.color || ''}
                        onChange={(c) => {
                          if (selPrefix === 'code') onCodeColorChange?.(node.id, c)
                          else onCategoryColorChange?.(node.id, c)
                          setTooltipPickerOpen(false)
                          setTooltip(null)
                        }}
                      />
                      {selPrefix === 'code' && (
                        <button
                          className="text-xs text-mm-text-muted hover:text-mm-text"
                          onClick={() => {
                            onCodeColorChange?.(node.id, null)
                            setTooltipPickerOpen(false)
                            setTooltip(null)
                          }}
                        >
                          Clear custom color
                        </button>
                      )}
                    </div>
                  )}
                  {!tooltipPickerOpen && (
                    <>
                      <div className="text-xs text-mm-text-muted mt-1">
                        {node.segmentCount} segments · {node.sourceCount} sources
                      </div>
                      {node.categoryPath.length > 0 && (
                        <div className="text-xs text-mm-text-faint mt-0.5">
                          {node.categoryPath.join(' \u203A ')}
                        </div>
                      )}
                      {(adjacency.get(node.id)?.length ?? 0) > 0 && (
                        <div className="mt-1.5 pt-1.5 border-t border-mm-border-subtle">
                          <div className="text-[10px] text-mm-text-faint uppercase tracking-wide mb-0.5">
                            Top co-occurring
                          </div>
                          {adjacency.get(node.id)!.slice(0, 5).map((c, ci) => (
                            <div key={ci} className="text-xs text-mm-text-secondary flex justify-between gap-3">
                              <span className="truncate">{c.name}</span>
                              <span className="text-mm-text-faint tabular-nums shrink-0">{c.weight}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )
            })() : (
              <>
                <div className="font-medium text-sm">
                  {tooltip.source.name} {'\u2194'} {tooltip.target.name}
                </div>
                <div className="text-xs text-mm-text-muted mt-1">
                  {tooltip.weight} co-occurrence{tooltip.weight !== 1 ? 's' : ''}
                </div>
                {(tooltip.source.categoryPath[0] || '') !== (tooltip.target.categoryPath[0] || '') && (
                  <div className="text-xs text-mm-text-faint mt-0.5 space-y-0.5">
                    {tooltip.source.categoryPath.length > 0 && <div>{tooltip.source.categoryPath.join(' \u203A ')}</div>}
                    {tooltip.target.categoryPath.length > 0 && <div>{tooltip.target.categoryPath.join(' \u203A ')}</div>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </ChartExportWrapper>
  )
}
