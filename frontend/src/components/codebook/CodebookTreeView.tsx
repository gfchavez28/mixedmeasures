import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'
import type { CodebookSizing, CodebookFormat } from '@/hooks/useCodebookState'
import { useChartColors, useTheme } from '@/lib/theme-context'
import { getContrastColor } from '@/lib/utils'
import { fitViewportToBounds } from '@/lib/codebook-utils'
import type { Viewport, LayoutBounds } from '@/lib/codebook-utils'
import { COLOR_DEFAULT, COLOR_SELECT, COLOR_SPOTLIGHT, COLOR_UNIVERSAL, COLOR_UNIVERSAL_TEXT, SURFACE_LIGHT, SURFACE_DARK } from '@/lib/codebook-constants'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'

// ── Props ────────────────────────────────────────────────────────────────────

interface CodebookTreeViewProps {
  treeData: CodebookTreeResponse
  catFormat: CodebookFormat
  codeFormat: CodebookFormat
  sizing: CodebookSizing
  search: string
  selection: string | null
  onSelect: (sel: string | null) => void
  onSearchMatchCount?: (count: number) => void
  // Multi-select + targeting
  multiSelect: Set<string>
  targetingMode: boolean
  lastSelectedRef: React.MutableRefObject<string | null>
  onMultiSelectChange: (ids: Set<string>) => void
  onContextMenu: (nodeId: string, x: number, y: number) => void
  onTargetingComplete: (categoryId: number) => void
  onExitTargeting: () => void
  // Color editing from tooltip
  onCodeColorChange?: (codeId: number, color: string | null) => void
  onCategoryColorChange?: (categoryId: number, color: string) => void
  // Creation preview spotlight
  spotlightCategoryId?: number | null
  spotlightType?: 'code' | 'category' | null
  spotlightLabel?: string
  spotlightColor?: string
}

// ── Layout types ─────────────────────────────────────────────────────────────

interface LayoutNode {
  type: 'cat' | 'code' | 'universal-code'
  id: string           // 'cat-{id}' or 'code-{id}'
  x: number
  y: number
  w: number
  h: number
  cx: number           // center x
  cy: number           // center y
  color: string
  rootIndex: number
  // Code-specific
  code?: CodebookCodeNode
  scale?: number
  parentCX?: number    // right edge of parent category block
  parentCY?: number    // vertical center of parent category block
  // Category-specific
  cat?: CodebookCategoryNode
  depth?: number
  isExpanded?: boolean
  codeCount?: number
  totalCodes?: number
  totalSeg?: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const CODE_DOT_R = 6  // radius of compact-mode code dot

// ── Tooltip type ─────────────────────────────────────────────────────────────

type TreeTooltipState =
  | { kind: 'code'; node: LayoutNode; x: number; y: number }
  | { kind: 'cat'; node: LayoutNode; x: number; y: number }

// ── Helpers ──────────────────────────────────────────────────────────────────

function prand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function truncate(s: string, maxLen: number, scale = 1): string {
  const len = Math.floor(maxLen / scale)
  return s.length > len ? s.slice(0, len - 1) + '\u2026' : s
}

function collectAllCategoryIds(nodes: CodebookCategoryNode[]): Set<number> {
  const ids = new Set<number>()
  for (const cat of nodes) {
    ids.add(cat.id)
    for (const id of collectAllCategoryIds(cat.children)) ids.add(id)
  }
  return ids
}

/** Build set of category IDs that are ancestors of codes matching search */
function buildAncestorSet(
  tree: CodebookCategoryNode[],
  matchingCodeIds: Set<number>,
): Set<number> {
  const ancestors = new Set<number>()
  function walk(nodes: CodebookCategoryNode[], parentChain: number[]): boolean {
    let hasMatch = false
    for (const cat of nodes) {
      const chain = [...parentChain, cat.id]
      const codesMatch = cat.codes.some(c => matchingCodeIds.has(c.id))
      const childrenMatch = walk(cat.children, chain)
      if (codesMatch || childrenMatch) {
        for (const id of chain) ancestors.add(id)
        hasMatch = true
      }
    }
    return hasMatch
  }
  walk(tree, [])
  return ancestors
}

/** Map category id → inherited color (own color if set, else parent's, else gray) */
function buildRootColorMap(tree: CodebookCategoryNode[]): Map<number, string> {
  const map = new Map<number, string>()
  function walk(nodes: CodebookCategoryNode[], parentColor: string) {
    for (const cat of nodes) {
      const color = cat.color || parentColor
      map.set(cat.id, color)
      walk(cat.children, color)
    }
  }
  walk(tree, COLOR_DEFAULT)
  return map
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function CodebookTreeView({
  treeData,
  catFormat,
  codeFormat,
  sizing,
  search,
  selection,
  onSelect,
  onSearchMatchCount,
  multiSelect,
  targetingMode,
  lastSelectedRef,
  onMultiSelectChange,
  onContextMenu,
  onTargetingComplete,
  onExitTargeting,
  onCodeColorChange,
  onCategoryColorChange,
  spotlightCategoryId,
  spotlightType,
  spotlightLabel,
  spotlightColor,
}: CodebookTreeViewProps) {
  const chartColors = useChartColors()
  const { isDark } = useTheme()
  const surfaceColor = isDark ? SURFACE_DARK : SURFACE_LIGHT  // mm-surface resolved
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set())
  const [liveAnnouncement, setLiveAnnouncement] = useState('')
  const announce = useCallback((msg: string) => {
    setLiveAnnouncement(msg)
    setTimeout(() => setLiveAnnouncement(''), 1000)
  }, [])

  // Keyboard navigation
  const [focusedIdx, setFocusedIdx] = useState(-1)

  // Targeting mode hover
  const [hoverCatId, setHoverCatId] = useState<number | null>(null)

  // Targeting mode keyboard category cycling
  const [targetFocusIdx, setTargetFocusIdx] = useState(-1)

  // ── Container size measurement (used for both layout width and spatial zoom) ─

  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
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

  useEffect(() => {
    const el = wrapRef.current
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

  const containerWidth = containerSize?.width || 960  // 960 default until measured

  // ── Expand all on data change (preserves user collapse across zoom changes) ─

  useEffect(() => {
    if (search) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- expand all categories on data change
    setExpandedCategories(collectAllCategoryIds(treeData.tree))
  }, [treeData.tree, search])

  // ── Search matching ────────────────────────────────────────────────────

  const lowerSearch = search.toLowerCase().trim()

  const matchingCodeIds = useMemo(() => {
    if (!lowerSearch) return null
    const ids = new Set<number>()
    function scan(codes: CodebookCodeNode[]) {
      for (const c of codes) {
        if (c.name.toLowerCase().includes(lowerSearch)) ids.add(c.id)
      }
    }
    scan(treeData.universal_codes)
    scan(treeData.uncategorized_codes)
    function walk(nodes: CodebookCategoryNode[]) {
      for (const cat of nodes) {
        scan(cat.codes)
        walk(cat.children)
      }
    }
    walk(treeData.tree)
    return ids
  }, [treeData, lowerSearch])

  const ancestorCategoryIds = useMemo(() => {
    if (!matchingCodeIds) return null
    return buildAncestorSet(treeData.tree, matchingCodeIds)
  }, [treeData.tree, matchingCodeIds])

  // Report match count
  useEffect(() => {
    onSearchMatchCount?.(matchingCodeIds?.size ?? 0)
  }, [matchingCodeIds, onSearchMatchCount])

  // Force-expand ancestors during search
  useEffect(() => {
    if (ancestorCategoryIds && ancestorCategoryIds.size > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- expand ancestors to reveal search matches
      setExpandedCategories(ancestorCategoryIds)
    }
  }, [ancestorCategoryIds])

  // ── Size-by computation ────────────────────────────────────────────────

  const maxCounts = useMemo(() => {
    let maxSeg = 1
    let maxSrc = 1
    function scan(codes: CodebookCodeNode[]) {
      for (const c of codes) {
        if (c.segment_count > maxSeg) maxSeg = c.segment_count
        if (c.source_count > maxSrc) maxSrc = c.source_count
      }
    }
    scan(treeData.universal_codes)
    scan(treeData.uncategorized_codes)
    function walk(nodes: CodebookCategoryNode[]) {
      for (const cat of nodes) {
        scan(cat.codes)
        walk(cat.children)
      }
    }
    walk(treeData.tree)
    return { maxSeg, maxSrc }
  }, [treeData])

  const getScale = useCallback((code: CodebookCodeNode): number => {
    if (sizing === 'uniform') return 1
    const val = sizing === 'seg' ? code.segment_count : code.source_count
    const max = sizing === 'seg' ? maxCounts.maxSeg : maxCounts.maxSrc
    return 0.5 + 0.6 * (val / max)
  }, [sizing, maxCounts])

  // ── Selection state ────────────────────────────────────────────────────

  const selectedCodeId = useMemo(() => {
    if (!selection?.startsWith('code:')) return null
    return Number(selection.split(':')[1])
  }, [selection])

  const selectedCatId = useMemo(() => {
    if (!selection?.startsWith('cat:')) return null
    return Number(selection.split(':')[1])
  }, [selection])

  const hasAnySelection = multiSelect.size > 0 || selectedCodeId != null || selectedCatId != null

  // ── Root color map ─────────────────────────────────────────────────────

  const rootColorMap = useMemo(() => buildRootColorMap(treeData.tree), [treeData.tree])

  // ── Category breadcrumb paths (for tooltips) ──────────────────────────

  const categoryPathMap = useMemo(() => {
    const codeToPath = new Map<number, string[]>()
    const catToPath = new Map<number, string[]>()
    function walk(nodes: CodebookCategoryNode[], path: string[]) {
      for (const cat of nodes) {
        const currentPath = [...path, cat.name]
        catToPath.set(cat.id, path) // ancestors only, not self
        for (const code of cat.codes) {
          codeToPath.set(code.id, currentPath)
        }
        walk(cat.children, currentPath)
      }
    }
    walk(treeData.tree, [])
    return { codeToPath, catToPath }
  }, [treeData.tree])

  // ── Tooltip state ─────────────────────────────────────────────────────

  const [tooltip, setTooltip] = useState<TreeTooltipState | null>(null)
  const [tooltipPickerOpen, setTooltipPickerOpen] = useState(false)
  const tooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel any pending hide
  const cancelTooltipHide = useCallback(() => {
    if (tooltipHideTimer.current) {
      clearTimeout(tooltipHideTimer.current)
      tooltipHideTimer.current = null
    }
  }, [])

  // Delayed hide — gives user ~150ms to reach the tooltip
  const hideTooltip = useCallback(() => {
    if (tooltipPickerOpen) return
    cancelTooltipHide()
    tooltipHideTimer.current = setTimeout(() => {
      setTooltip(null)
      tooltipHideTimer.current = null
    }, 150)
  }, [tooltipPickerOpen, cancelTooltipHide])

  // Immediate hide (for zoom/pan where delay feels wrong)
  const hideTooltipNow = useCallback(() => {
    cancelTooltipHide()
    setTooltipPickerOpen(false)
    setTooltip(null)
  }, [cancelTooltipHide])

  // Clean up timer on unmount
  useEffect(() => () => cancelTooltipHide(), [cancelTooltipHide])

  const showTooltipForNode = useCallback((node: LayoutNode, e: React.MouseEvent) => {
    if (tooltipPickerOpen) return // Don't reposition while picker is open
    cancelTooltipHide()
    const cr = wrapRef.current?.getBoundingClientRect()
    if (!cr) return
    const maxTipW = 260
    let tx = e.clientX - cr.left + 12
    let ty = e.clientY - cr.top - 8
    if (tx + maxTipW > cr.width) tx = e.clientX - cr.left - maxTipW - 8
    if (ty < 10) ty = 10
    if (ty > cr.height - 10) ty = cr.height - 10
    const kind = node.type === 'cat' ? 'cat' as const : 'code' as const
    setTooltip({ kind, node, x: tx, y: ty })
  }, [tooltipPickerOpen, cancelTooltipHide])

  const showTooltipAtNodeFocus = useCallback((node: LayoutNode) => {
    if (tooltipPickerOpen) return // Don't reposition while picker is open
    cancelTooltipHide()
    const svg = svgRef.current
    const ctr = wrapRef.current
    if (!svg || !ctr) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const cr = ctr.getBoundingClientRect()
    const sp = new DOMPoint(node.cx, node.cy).matrixTransform(ctm)
    const maxTipW = 260
    let tx = sp.x - cr.left + (node.w / 2) + 8
    let ty = sp.y - cr.top
    if (tx + maxTipW > cr.width) tx = sp.x - cr.left - maxTipW - 8
    if (ty < 20) ty = 20
    if (ty > cr.height - 20) ty = cr.height - 20
    const kind = node.type === 'cat' ? 'cat' as const : 'code' as const
    setTooltip({ kind, node, x: tx, y: ty })
  }, [cancelTooltipHide, tooltipPickerOpen])

  // ── Toggle expand ──────────────────────────────────────────────────────

  const toggleExpand = useCallback((catId: number) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }, [])

  // ── Layout engine ──────────────────────────────────────────────────────

  const layout = useMemo(() => {
    const W = containerWidth
    const isCompactCode = codeFormat === 'compact'
    const isCompactCat = catFormat === 'compact'

    // Format-derived layout constants
    const dotSize = CODE_DOT_R * 2
    const nodeBaseH = isCompactCode ? dotSize : 44
    const nodeBaseW = isCompactCode ? dotSize : 140
    const catBaseW = isCompactCat ? 40 : 200
    const catBaseH = isCompactCat ? 16 : 50
    const gapV = isCompactCode ? 6 : 18
    const bandGap = isCompactCat ? 12 : 40
    const catGap = isCompactCat ? 10 : 32
    const jitterScale = isCompactCode ? 0.15 : 0.7

    const nodes: LayoutNode[] = []

    // ── Universal band ─────────────────────────────────────────────────
    const universalH = isCompactCode ? 32 : 48
    const filteredUniversal = matchingCodeIds
      ? treeData.universal_codes.filter(c => matchingCodeIds.has(c.id))
      : treeData.universal_codes

    if (filteredUniversal.length > 0) {
      filteredUniversal.forEach((code, i) => {
        const sc = getScale(code)
        const w = isCompactCode ? dotSize : 175
        const h = isCompactCode ? dotSize : 34
        const uniStride = isCompactCode ? dotSize + 12 : 210
        nodes.push({
          type: 'universal-code',
          id: `code-${code.id}`,
          x: 90 + i * uniStride,
          y: 12,
          w,
          h,
          cx: 90 + i * uniStride + w / 2,
          cy: 12 + h / 2,
          color: COLOR_UNIVERSAL,
          rootIndex: -1,
          code,
          scale: sc,
        })
      })
    }

    let currentY = (filteredUniversal.length > 0 ? universalH + 20 : 20)

    // ── Category layout (recursive) ────────────────────────────────────

    function layoutCategory(catNode: CodebookCategoryNode, depth: number, rootIndex: number, leftX: number) {
      const x = leftX
      const cw = catBaseW * (depth === 0 ? 1 : 0.85)
      const ch = catBaseH * (depth === 0 ? 1 : 0.85)
      const isExpanded = expandedCategories.has(catNode.id)
      const catColor = rootColorMap.get(catNode.id) || catNode.color || COLOR_DEFAULT

      // During search: hide categories that have no matching descendants
      if (matchingCodeIds && ancestorCategoryIds && !ancestorCategoryIds.has(catNode.id)) {
        const hasDirectMatch = catNode.codes.some(c => matchingCodeIds.has(c.id))
        if (!hasDirectMatch) return
      }

      const catStartY = currentY

      // Filter codes for search
      const visibleCodes = matchingCodeIds
        ? catNode.codes.filter(c => matchingCodeIds.has(c.id))
        : catNode.codes

      // Track indices of direct codes and child categories for parentCX/CY assignment
      const directCodeStartIdx = nodes.length
      let directCodeEndIdx = directCodeStartIdx
      const childCatIndices: number[] = []

      if (isExpanded) {
        // Reserve vertical space for this category's rectangle before children
        currentY += ch + gapV * 0.4

        // Layout child categories (push currentY down)
        for (const child of catNode.children) {
          const beforeLen = nodes.length
          layoutCategory(child, depth + 1, rootIndex, x + cw + catGap)
          // If a category node was added, record its index
          for (let i = beforeLen; i < nodes.length; i++) {
            if (nodes[i].type === 'cat' && nodes[i].cat?.id === child.id) {
              childCatIndices.push(i)
            }
          }
        }

        // Layout direct codes
        const codeXStart = x + cw + 40
        const codeXEnd = W - 30
        const codeXMid = (codeXStart + codeXEnd) / 2
        const codeXSpan = Math.max(codeXEnd - codeXStart, 80)

        for (const code of visibleCodes) {
          const sc = getScale(code)
          const h = nodeBaseH * sc
          const w = nodeBaseW * sc
          const jx = (prand(code.id * 7 + 3) - 0.5) * codeXSpan * jitterScale
          const jy = (prand(code.id * 13 + 7) - 0.5) * gapV * 0.5
          const cx = clamp(codeXMid + jx, codeXStart + w / 2, codeXEnd - w / 2)
          const cy = currentY + h / 2 + jy

          nodes.push({
            type: 'code',
            id: `code-${code.id}`,
            x: cx - w / 2,
            y: cy - h / 2,
            w,
            h,
            cx,
            cy,
            color: catColor,
            rootIndex,
            code,
            scale: sc,
            parentCX: 0,  // set after category node is placed
            parentCY: 0,
          })

          currentY += h + gapV * sc
        }
        directCodeEndIdx = nodes.length
      }

      if (!isExpanded || (visibleCodes.length === 0 && catNode.children.length === 0)) {
        currentY += ch
      }

      // Position parent: top-aligned in its reserved space when expanded, centered when collapsed
      const catCY = isExpanded ? catStartY + ch / 2 : (catStartY + currentY) / 2

      // Emit category node
      nodes.push({
        type: 'cat',
        id: `cat-${catNode.id}`,
        x,
        y: catCY - ch / 2,
        w: cw,
        h: ch,
        cx: x + cw / 2,
        cy: catCY,
        color: catColor,
        rootIndex,
        cat: catNode,
        depth,
        isExpanded,
        codeCount: visibleCodes.length,
        totalCodes: catNode.total_code_count,
        totalSeg: catNode.total_segments,
      })

      // Set parentCX/CY on direct code nodes and child category nodes (O(n) targeted update)
      const parentCX = x + cw  // right edge of this category block
      const parentCY = catCY

      for (let i = directCodeStartIdx; i < directCodeEndIdx; i++) {
        const node = nodes[i]
        if (node.type === 'code' && node.parentCX === 0) {
          node.parentCX = parentCX
          node.parentCY = parentCY
        }
      }
      for (const idx of childCatIndices) {
        const node = nodes[idx]
        if (!node.parentCX) {
          node.parentCX = parentCX
          node.parentCY = parentCY
        }
      }

      currentY += bandGap * (depth === 0 ? 1 : 0.6)
    }

    treeData.tree.forEach((root, i) => layoutCategory(root, 0, i, 30))

    // ── Uncategorized codes ────────────────────────────────────────────

    const filteredUncategorized = matchingCodeIds
      ? treeData.uncategorized_codes.filter(c => matchingCodeIds.has(c.id))
      : treeData.uncategorized_codes

    if (filteredUncategorized.length > 0) {
      currentY += bandGap

      // Uncategorized label Y
      const labelY = currentY
      currentY += 20

      const codeXStart = 90
      const codeXEnd = W - 30
      const codeXMid = (codeXStart + codeXEnd) / 2
      const codeXSpan = Math.max(codeXEnd - codeXStart, 80)

      for (const code of filteredUncategorized) {
        const sc = getScale(code)
        const h = nodeBaseH * sc
        const w = nodeBaseW * sc
        const jx = (prand(code.id * 7 + 3) - 0.5) * codeXSpan * jitterScale
        const jy = (prand(code.id * 13 + 7) - 0.5) * gapV * 0.5
        const cx = clamp(codeXMid + jx, codeXStart + w / 2, codeXEnd - w / 2)
        const cy = currentY + h / 2 + jy

        nodes.push({
          type: 'code',
          id: `code-${code.id}`,
          x: cx - w / 2,
          y: cy - h / 2,
          w,
          h,
          cx,
          cy,
          color: COLOR_DEFAULT,
          rootIndex: treeData.tree.length,
          code,
          scale: sc,
        })

        currentY += h + gapV * sc
      }

      // Synthetic label marker
      if (filteredUncategorized.length > 0) {
        nodes.push({
          type: 'cat' as const,
          id: 'uncategorized-label',
          x: 30,
          y: labelY,
          w: 100,
          h: 16,
          cx: 80,
          cy: labelY + 8,
          color: COLOR_DEFAULT,
          rootIndex: -2,
          depth: -1,
        })
      }
    }

    // Compute bounding box for viewport fitting
    const bounds: LayoutBounds = {
      minX: nodes.length > 0 ? Math.min(...nodes.map(n => n.x)) : 0,
      maxX: nodes.length > 0 ? Math.max(...nodes.map(n => n.x + n.w)) : W,
      minY: nodes.length > 0 ? Math.min(...nodes.map(n => n.y)) : 0,
      maxY: Math.max(currentY + 30, nodes.length > 0 ? Math.max(...nodes.map(n => n.y + n.h)) : 0),
    }

    return { nodes, totalH: currentY + 30, bounds }
  }, [treeData, catFormat, codeFormat, containerWidth, expandedCategories, matchingCodeIds, ancestorCategoryIds, getScale, rootColorMap])

  // ── Flat node order for keyboard navigation ────────────────────────────

  const nodeOrder = useMemo(() => {
    return layout.nodes
      .filter(n => n.id !== 'uncategorized-label')
      .map(n => n.id)
  }, [layout.nodes])

  // ── Category order for targeting mode navigation ──────────────────────

  const categoryOrder = useMemo(() => {
    return layout.nodes
      .filter(n => n.type === 'cat' && n.id !== 'uncategorized-label' && n.depth !== undefined && n.depth >= 0)
      .map(n => n.id)
  }, [layout.nodes])

  // ── Spotlight: auto-expand ancestors so spotlighted category is visible ─

  useEffect(() => {
    if (!spotlightCategoryId) return
    // Build ancestor chain for the spotlight category
    function findAncestors(cats: CodebookCategoryNode[], chain: number[]): number[] | null {
      for (const cat of cats) {
        if (cat.id === spotlightCategoryId) return chain
        const found = findAncestors(cat.children, [...chain, cat.id])
        if (found) return found
      }
      return null
    }
    const ancestors = findAncestors(treeData.tree, [])
    if (ancestors && ancestors.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- expand ancestors to reveal spotlighted category
      setExpandedCategories(prev => {
        const allPresent = ancestors.every(id => prev.has(id))
        if (allPresent) return prev
        const next = new Set(prev)
        for (const id of ancestors) next.add(id)
        return next
      })
    }
  }, [spotlightCategoryId, treeData.tree])

  // ── Spotlight data for creation preview ────────────────────────────────

  const spotlightInfo = useMemo(() => {
    if (!spotlightCategoryId) return null
    const catNode = layout.nodes.find(n => n.cat?.id === spotlightCategoryId)
    if (!catNode) return null

    const isCodeSpotlight = spotlightType === 'code'
    const catF = catFormat === 'compact'
    const codeF = codeFormat === 'compact'

    // Placeholder position
    let phCX: number, phCY: number, phW: number, phH: number
    let connX1: number, connY1: number

    if (isCodeSpotlight) {
      // Code placeholder: to the right of the category
      const gap = catF ? 30 : 50
      phW = codeF ? 12 : 120
      phH = codeF ? 12 : 32
      phCX = catNode.x + catNode.w + gap + phW / 2
      phCY = catNode.cy
      connX1 = catNode.x + catNode.w
      connY1 = catNode.cy
    } else {
      // Category placeholder: below the parent category
      phW = Math.min(catNode.w * 0.85, catF ? 36 : 160)
      phH = catF ? 14 : catNode.h * 0.8
      phCX = catNode.x + catNode.w + 30 + phW / 2
      phCY = catNode.y + catNode.h + 20 + phH / 2
      connX1 = catNode.x + catNode.w
      connY1 = catNode.cy
    }

    return { catNode, phCX, phCY, phW, phH, connX1, connY1, isCodeSpotlight }
  }, [spotlightCategoryId, spotlightType, layout, catFormat, codeFormat])

  // Reset targeting focus when entering/exiting targeting mode
  useEffect(() => {
    if (targetingMode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset focus index on targeting mode change
      setTargetFocusIdx(-1)
    }
  }, [targetingMode])

  // ── Spatial zoom/pan ───────────────────────────────────────────────────

  const ZOOM_FACTOR = 1.15
  const ZOOM_MIN_W = 60
  const ZOOM_MAX_W = 4000
  const FIT_PAD = 30

  // Fit viewport from layout bounds (no aspect enforcement — SVG meet handles fitting)
  const fitVp = useMemo<Viewport>(() => {
    return fitViewportToBounds(layout.bounds, FIT_PAD)
  }, [layout.bounds])

  const [viewport, setViewport] = useState<Viewport | null>(null)

  // Reset viewport when layout changes (data, zoom level, sizing, expand/collapse)
  const layoutIdRef = useRef<typeof layout | null>(null)
  useEffect(() => {
    if (layout && layout !== layoutIdRef.current) {
      layoutIdRef.current = layout
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync viewport when layout changes
      setViewport(fitVp)
    }
  }, [layout, fitVp])

  const vp = viewport || fitVp

  const spatialZoomLevel = useMemo(() => fitVp.width / vp.width, [fitVp.width, vp.width])
  const spatialZoomPercent = Math.round(spatialZoomLevel * 100)

  // Zoom around a point (scales both dimensions uniformly)
  const zoomAtPoint = useCallback((factor: number, screenX: number, screenY: number) => {
    const svg = svgRef.current
    if (!svg) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const inv = ctm.inverse()
    const pt = new DOMPoint(screenX, screenY).matrixTransform(inv)

    setViewport(prev => {
      const cur = prev || fitVp
      let newW = cur.width / factor
      newW = Math.max(ZOOM_MIN_W, Math.min(ZOOM_MAX_W, newW))
      const scale = newW / cur.width
      const newH = cur.height * scale
      const ratioX = (pt.x - cur.x) / cur.width
      const ratioY = (pt.y - cur.y) / cur.height
      // Constrain: keep viewport center within bounds ± 100px
      let newX = pt.x - ratioX * newW
      let newY = pt.y - ratioY * newH
      const bounds = layout.bounds
      const pad = 100
      const cx = newX + newW / 2
      const cy = newY + newH / 2
      const clampedCx = Math.max(bounds.minX - pad, Math.min(bounds.maxX + pad, cx))
      const clampedCy = Math.max(bounds.minY - pad, Math.min(bounds.maxY + pad, cy))
      newX += clampedCx - cx
      newY += clampedCy - cy
      return { x: newX, y: newY, width: newW, height: newH }
    })
  }, [fitVp, layout.bounds])

  // Wheel zoom
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

  // Pan via click-drag
  const panStart = useRef<{ sx: number; sy: number; vpStart: Viewport } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  const handlePanMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement
    // Don't pan when clicking on nodes
    if (target.closest('[role="treeitem"]')) return
    hideTooltipNow()
    panStart.current = { sx: e.clientX, sy: e.clientY, vpStart: { ...vp } }
    setIsPanning(true)
    e.preventDefault()
  }, [vp, hideTooltipNow])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ps = panStart.current
      if (!ps) return
      const svg = svgRef.current
      if (!svg) return
      // Use getScreenCTM for accurate SVG↔screen mapping (accounts for meet letterboxing)
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const scaleX = 1 / ctm.a
      const scaleY = 1 / ctm.d
      const bounds = layout.bounds
      const pad = 100
      let newX = ps.vpStart.x - (e.clientX - ps.sx) * scaleX
      let newY = ps.vpStart.y - (e.clientY - ps.sy) * scaleY
      const cx = newX + ps.vpStart.width / 2
      const cy = newY + ps.vpStart.height / 2
      const clampedCx = Math.max(bounds.minX - pad, Math.min(bounds.maxX + pad, cx))
      const clampedCy = Math.max(bounds.minY - pad, Math.min(bounds.maxY + pad, cy))
      newX += clampedCx - cx
      newY += clampedCy - cy
      setViewport({
        x: newX,
        y: newY,
        width: ps.vpStart.width,
        height: ps.vpStart.height,
      })
    }
    const handleMouseUp = () => {
      panStart.current = null
      setIsPanning(false)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [layout.bounds])

  // Toolbar-style zoom actions
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
    setViewport(fitVp)
  }, [fitVp])

  // Double-click background to fit
  const handleDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement
    if (target.closest('[role="treeitem"]')) return
    handleZoomFit()
  }, [handleZoomFit])

  // Announce spatial zoom changes
  const prevSpatialZoom = useRef(100)
  useEffect(() => {
    if (spatialZoomPercent !== prevSpatialZoom.current) {
      prevSpatialZoom.current = spatialZoomPercent
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ARIA announcement via announce() which wraps setState
      announce(`Tree zoom ${spatialZoomPercent}%`)
    }
  }, [spatialZoomPercent, announce])

  const svgCursor = isPanning ? 'grabbing' : 'grab'

  // ── Event handlers ─────────────────────────────────────────────────────

  const handleNodeClick = useCallback((nodeId: string, e: ReactMouseEvent) => {
    e.stopPropagation()

    // ─── Targeting mode ───────────────────────────────────────────────
    if (targetingMode) {
      if (nodeId.startsWith('cat-')) {
        const catId = Number(nodeId.slice(4))
        onTargetingComplete(catId)
      } else {
        // Click on non-category exits targeting mode
        onExitTargeting()
      }
      return
    }

    // ─── Ctrl/Meta+Click: toggle multi-select ─────────────────────────
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(multiSelect)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      lastSelectedRef.current = nodeId
      onMultiSelectChange(next)
      return
    }

    // ─── Shift+Click: range select ─────────────────────────────────────
    if (e.shiftKey && lastSelectedRef.current) {
      const startIdx = nodeOrder.indexOf(lastSelectedRef.current)
      const endIdx = nodeOrder.indexOf(nodeId)
      if (startIdx >= 0 && endIdx >= 0) {
        const lo = Math.min(startIdx, endIdx)
        const hi = Math.max(startIdx, endIdx)
        const next = new Set(multiSelect)
        for (let i = lo; i <= hi; i++) {
          next.add(nodeOrder[i])
        }
        onMultiSelectChange(next)
        return
      }
    }

    // ─── Plain click: single select (clear multi) ──────────────────────
    if (multiSelect.size > 0) {
      onMultiSelectChange(new Set())
    }
    lastSelectedRef.current = nodeId

    if (nodeId.startsWith('code-')) {
      const id = Number(nodeId.slice(5))
      const sel = `code:${id}`
      onSelect(selection === sel ? null : sel)
    } else if (nodeId.startsWith('cat-')) {
      const id = Number(nodeId.slice(4))
      const sel = `cat:${id}`
      onSelect(selection === sel ? null : sel)
    }
  }, [selection, onSelect, multiSelect, onMultiSelectChange, targetingMode, onTargetingComplete, onExitTargeting, lastSelectedRef, nodeOrder])

  const handleCatExpandClick = useCallback((catId: number, e: ReactMouseEvent) => {
    e.stopPropagation()
    toggleExpand(catId)
  }, [toggleExpand])

  const panMouseDownPos = useRef<{ x: number; y: number } | null>(null)

  const handleSvgMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    panMouseDownPos.current = { x: e.clientX, y: e.clientY }
    handlePanMouseDown(e)
  }, [handlePanMouseDown])

  const handleSvgClick = useCallback((e: React.MouseEvent) => {
    // Suppress click if it was a pan drag (moved more than 3px)
    if (panMouseDownPos.current) {
      const dx = Math.abs(e.clientX - panMouseDownPos.current.x)
      const dy = Math.abs(e.clientY - panMouseDownPos.current.y)
      panMouseDownPos.current = null
      if (dx > 3 || dy > 3) return
    }
    if (targetingMode) {
      onExitTargeting()
      return
    }
    if (multiSelect.size > 0) {
      onMultiSelectChange(new Set())
      return
    }
    onSelect(null)
  }, [onSelect, multiSelect, onMultiSelectChange, targetingMode, onExitTargeting])

  const handleNodeContextMenu = useCallback((nodeId: string, e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // If node not in multiSelect, clear multi and set only this node
    if (!multiSelect.has(nodeId)) {
      onMultiSelectChange(new Set([nodeId]))
    }
    onContextMenu(nodeId, e.clientX, e.clientY)
  }, [multiSelect, onMultiSelectChange, onContextMenu])

  // ── Keyboard navigation ────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Skip if typing in an input
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return

    // Keyboard zoom (spatial)
    if (e.key === '=' || e.key === '+') { e.preventDefault(); handleZoomIn(); return }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); handleZoomOut(); return }
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); handleZoomFit(); return }

    if (nodeOrder.length === 0) return

    // ─── Targeting mode keyboard ──────────────────────────────────────
    if (targetingMode) {
      switch (e.key) {
        case 'Escape': {
          e.preventDefault()
          onExitTargeting()
          return
        }
        case 'ArrowDown': {
          e.preventDefault()
          setTargetFocusIdx(prev => Math.min(prev + 1, categoryOrder.length - 1))
          return
        }
        case 'ArrowUp': {
          e.preventDefault()
          setTargetFocusIdx(prev => Math.max(prev - 1, 0))
          return
        }
        case 'Home': {
          e.preventDefault()
          setTargetFocusIdx(0)
          return
        }
        case 'End': {
          e.preventDefault()
          setTargetFocusIdx(categoryOrder.length - 1)
          return
        }
        case 'Enter': {
          e.preventDefault()
          if (targetFocusIdx >= 0 && targetFocusIdx < categoryOrder.length) {
            const catNodeId = categoryOrder[targetFocusIdx]
            const catId = Number(catNodeId.slice(4))
            onTargetingComplete(catId)
          }
          return
        }
      }
      return
    }

    // ─── Normal keyboard navigation ──────────────────────────────────
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = Math.min(focusedIdx + 1, nodeOrder.length - 1)
        setFocusedIdx(next)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = Math.max(focusedIdx - 1, 0)
        setFocusedIdx(next)
        break
      }
      case 'Home': {
        e.preventDefault()
        setFocusedIdx(0)
        break
      }
      case 'End': {
        e.preventDefault()
        setFocusedIdx(nodeOrder.length - 1)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const focused = nodeOrder[focusedIdx]
        if (focused?.startsWith('cat-')) {
          const catId = Number(focused.slice(4))
          setExpandedCategories(prev => new Set(prev).add(catId))
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const focused = nodeOrder[focusedIdx]
        if (focused?.startsWith('cat-')) {
          const catId = Number(focused.slice(4))
          setExpandedCategories(prev => {
            const next = new Set(prev)
            next.delete(catId)
            return next
          })
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const focused = nodeOrder[focusedIdx]
        if (focused) {
          if (focused.startsWith('code-')) {
            const id = Number(focused.slice(5))
            const sel = `code:${id}`
            onSelect(selection === sel ? null : sel)
          } else if (focused.startsWith('cat-')) {
            const id = Number(focused.slice(4))
            const sel = `cat:${id}`
            onSelect(selection === sel ? null : sel)
          }
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        // Cascading: multi-select → single-select
        if (multiSelect.size > 0) {
          onMultiSelectChange(new Set())
          return
        }
        onSelect(null)
        break
      }
    }
  }, [focusedIdx, nodeOrder, selection, onSelect, multiSelect, onMultiSelectChange, targetingMode, onExitTargeting, onTargetingComplete, categoryOrder, targetFocusIdx, handleZoomIn, handleZoomOut, handleZoomFit])

  // Show tooltip on keyboard focus change
  useEffect(() => {
    if (focusedIdx < 0 || focusedIdx >= nodeOrder.length) return
    const nodeId = nodeOrder[focusedIdx]
    const node = layout.nodes.find(n => n.id === nodeId)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync tooltip position to keyboard-focused node
    if (node) showTooltipAtNodeFocus(node)
  }, [focusedIdx, nodeOrder, layout.nodes, showTooltipAtNodeFocus])

  // Announce targeting mode changes
  const prevTargeting = useRef(targetingMode)
  /* eslint-disable react-hooks/set-state-in-effect -- ARIA announcement via announce() which wraps setState */
  useEffect(() => {
    if (prevTargeting.current !== targetingMode) {
      prevTargeting.current = targetingMode
      if (targetingMode) {
        announce('Targeting mode: click a category to move codes')
      } else {
        announce('Exited targeting mode')
      }
    }
  }, [targetingMode, announce])
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Rendering helpers ──────────────────────────────────────────────────

  const catNodes = layout.nodes.filter(n => n.type === 'cat' && n.id !== 'uncategorized-label')
  const codeNodes = layout.nodes.filter(n => n.type === 'code' || n.type === 'universal-code')
  const uncatLabel = layout.nodes.find(n => n.id === 'uncategorized-label')
  const universalNodes = layout.nodes.filter(n => n.type === 'universal-code')
  const universalBandWidth = universalNodes.length > 0
    ? Math.max(...universalNodes.map(n => n.x + n.w)) + 16 - 12  // right edge + padding - left offset
    : 0

  // Category nodes that have parent connections (child categories)
  const childCatNodes = catNodes.filter(n => n.parentCX && n.parentCY)

  // SVG text colors adapt to theme
  const textColor = chartColors.text
  const textMuted = chartColors.textMuted
  const refColor = chartColors.reference

  // ── Node dimming logic ─────────────────────────────────────────────────

  function getNodeDimmed(nodeId: string): boolean {
    if (targetingMode) return !nodeId.startsWith('cat-')
    if (multiSelect.size > 0) return !multiSelect.has(nodeId)
    if (selectedCodeId != null) return !nodeId.startsWith('code-') || Number(nodeId.slice(5)) !== selectedCodeId
    if (selectedCatId != null) return !nodeId.startsWith('cat-') || Number(nodeId.slice(4)) !== selectedCatId
    return false
  }

  function renderCatNode(n: LayoutNode) {
    if (!n.cat || n.depth === undefined || n.depth < 0) return null
    const cat = n.cat
    const depth = n.depth
    const color = n.color
    const isSingleSelected = selectedCatId === cat.id
    const isMultiSelected = multiSelect.has(n.id)
    const focusedId = focusedIdx >= 0 ? nodeOrder[focusedIdx] : null
    const isFocused = focusedId === n.id
    const dimmed = hasAnySelection && getNodeDimmed(n.id)
    const isCompact = catFormat === 'compact'
    const fontSize = isCompact ? (depth === 0 ? 11 : 10) : (depth === 0 ? 13 : 11)
    const showStats = catFormat === 'full'
    const labelTrunc = isCompact ? 18 : 25

    // Targeting mode: hover glow + keyboard focus glow
    const isTargetHover = targetingMode && hoverCatId === cat.id
    const isTargetFocused = targetingMode && targetFocusIdx >= 0 && categoryOrder[targetFocusIdx] === n.id
    const showTargetGlow = isTargetHover || isTargetFocused

    const rx = isCompact ? (depth === 0 ? 5 : 4) : (depth === 0 ? 10 : 7)

    return (
      <g
        key={n.id}
        role="treeitem"
        aria-label={`${cat.name}: ${n.totalCodes ?? 0} codes, ${n.totalSeg ?? 0} segments`}
        aria-expanded={n.isExpanded}
        aria-selected={isSingleSelected || isMultiSelected}
        tabIndex={isFocused ? 0 : -1}
        style={{
          cursor: targetingMode ? 'crosshair' : 'pointer',
          outline: 'none',
          opacity: dimmed && !targetingMode ? 0.2 : 1,
          transition: 'opacity .2s',
        }}
        onClick={(e) => handleNodeClick(n.id, e)}
        onContextMenu={(e) => handleNodeContextMenu(n.id, e)}
        onMouseEnter={(e) => {
          if (targetingMode) setHoverCatId(cat.id)
          showTooltipForNode(n, e)
        }}
        onMouseLeave={() => {
          if (targetingMode) setHoverCatId(null)
          hideTooltip()
        }}
        onFocus={() => showTooltipAtNodeFocus(n)}
        onBlur={hideTooltip}
      >
        {/* Targeting mode glow */}
        {showTargetGlow && (
          <rect
            x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8}
            rx={rx + 4}
            fill="none"
            stroke={COLOR_SELECT}
            strokeWidth={2}
            opacity={0.6}
          />
        )}
        {/* Selection / focus ring */}
        {(isSingleSelected || isMultiSelected || isFocused) && !showTargetGlow && (
          <rect
            x={n.x - 2} y={n.y - 2} width={n.w + 4} height={n.h + 4}
            rx={rx + 2}
            fill="none"
            stroke={isSingleSelected || isMultiSelected ? COLOR_SELECT : COLOR_DEFAULT}
            strokeWidth={1.5}
            strokeDasharray={isMultiSelected && !isSingleSelected ? '4 2' : undefined}
            opacity={0.5}
          />
        )}
        {/* Background — opaque so bezier curves don't bleed through */}
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h}
          rx={rx}
          fill={surfaceColor}
          stroke={`${color}60`}
          strokeWidth={depth === 0 ? 1.5 : 1}
        />
        {/* Color tint overlay */}
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h}
          rx={rx}
          fill={color}
          opacity={depth === 0 ? 0.1 : 0.07}
        />
        {/* Left accent bar */}
        <rect x={n.x} y={n.y} width={isCompact ? 3 : 4} height={n.h} rx={isCompact ? 1.5 : 2} fill={color} />
        {/* Expand/collapse indicator */}
        <text
          x={isCompact ? n.x + n.w - 10 : n.x + n.w - 14} y={n.cy}
          textAnchor="middle" dominantBaseline="central"
          fontSize={isCompact ? 8 : 10} fill={refColor}
          onClick={(e) => { handleCatExpandClick(cat.id, e) }}
          style={{ cursor: 'pointer' }}
        >
          {n.isExpanded ? '\u25BE' : '\u25B8'}
        </text>
        {/* Name (full only) */}
        {!isCompact && (
          <text
            x={n.x + 10} y={n.cy - (showStats ? 4 : 0)}
            dominantBaseline="central"
            fill={textColor}
            fontSize={fontSize}
            fontWeight={depth === 0 ? 700 : 600}
          >
            {truncate(cat.name, labelTrunc)}
          </text>
        )}
        {/* Stats (full format only) */}
        {showStats && !isCompact && (
          <text
            x={n.x + 10} y={n.cy + 12}
            fill={`${color}80`}
            fontSize={10}
          >
            {n.totalCodes ? `${n.totalCodes} codes` : ''}{n.totalCodes && n.totalSeg ? ' \u00b7 ' : ''}{n.totalSeg ? `${n.totalSeg} seg` : ''}
          </text>
        )}
      </g>
    )
  }

  function renderCodeNode(n: LayoutNode) {
    if (!n.code) return null
    const code = n.code
    const sc = n.scale || 1
    const isSingleSel = selectedCodeId === code.id
    const isMultiSel = multiSelect.has(n.id)
    const isSel = isSingleSel || isMultiSel
    const dimmed = hasAnySelection && getNodeDimmed(n.id)
    const focusedId = focusedIdx >= 0 ? nodeOrder[focusedIdx] : null
    const isFocused = focusedId === n.id
    const isUniversal = n.type === 'universal-code'

    const groupOpacity = dimmed ? (targetingMode ? (isUniversal ? 0.5 : 0.3) : 0.15) : 1

    const showCheckmark = isMultiSel

    const tooltipHandlers = {
      onMouseEnter: (e: React.MouseEvent) => showTooltipForNode(n, e),
      onMouseLeave: hideTooltip,
      onFocus: () => showTooltipAtNodeFocus(n),
      onBlur: hideTooltip,
    }

    // Universal codes
    if (isUniversal) {
      const uniChipColor = COLOR_UNIVERSAL

      // Compact: dot
      if (codeFormat === 'compact') {
        const dotR = CODE_DOT_R * sc
        return (
          <g
            key={n.id}
            role="treeitem"
            aria-label={`${code.name} (universal): ${code.segment_count} segments, ${code.source_count} sources`}
            aria-selected={isSel}
            tabIndex={isFocused ? 0 : -1}
            onClick={(e) => handleNodeClick(n.id, e)}
            onContextMenu={(e) => handleNodeContextMenu(n.id, e)}
            {...tooltipHandlers}
            style={{ cursor: targetingMode ? 'not-allowed' : 'pointer', outline: 'none', transition: 'opacity .2s' }}
            opacity={groupOpacity}
          >
            {(isSel || isFocused) && (
              <circle cx={n.cx} cy={n.cy} r={dotR + 3}
                fill="none" stroke={COLOR_SELECT} strokeWidth={1.5}
                strokeDasharray={isMultiSel && !isSingleSel ? '4 2' : undefined}
                opacity={0.5} />
            )}
            <circle cx={n.cx} cy={n.cy} r={dotR + 5} fill="transparent" style={{ cursor: 'pointer' }} />
            <circle cx={n.cx} cy={n.cy} r={dotR} fill={uniChipColor} stroke={`${uniChipColor}40`} strokeWidth={1} />
            {showCheckmark && (
              <>
                <circle cx={n.cx + dotR} cy={n.cy - dotR} r={4} fill={COLOR_SELECT} />
                <text x={n.cx + dotR} y={n.cy - dotR + 1} textAnchor="middle" dominantBaseline="central"
                  fill="white" fontSize={6} fontWeight={700}>{'\u2713'}</text>
              </>
            )}
          </g>
        )
      }

      // Full: chip
      const uniChipText = getContrastColor(uniChipColor)
      return (
        <g
          key={n.id}
          role="treeitem"
          aria-label={`${code.name} (universal): ${code.segment_count} segments, ${code.source_count} sources`}
          aria-selected={isSel}
          tabIndex={isFocused ? 0 : -1}
          onClick={(e) => handleNodeClick(n.id, e)}
          onContextMenu={(e) => handleNodeContextMenu(n.id, e)}
          {...tooltipHandlers}
          style={{ cursor: targetingMode ? 'not-allowed' : 'pointer', outline: 'none', transition: 'opacity .2s' }}
          opacity={groupOpacity}
        >
          {(isSel || isFocused) && (
            <rect x={n.x - 3} y={n.y - 3} width={n.w + 6} height={n.h + 6} rx={7}
              fill="none" stroke={COLOR_SELECT} strokeWidth={1.5}
              strokeDasharray={isMultiSel && !isSingleSel ? '4 2' : undefined}
              opacity={0.5} />
          )}
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={12}
            fill={uniChipColor} stroke={`${uniChipColor}40`} strokeWidth={1} />
          <text x={n.x + 10} y={n.cy - 5} dominantBaseline="central"
            fill={uniChipText} fontSize={11} fontWeight={500}>
            {code.name}
          </text>
          <text x={n.x + 10} y={n.cy + 9}
            fill={uniChipText} opacity={0.7} fontSize={9}>
            {code.segment_count} seg {'\u00b7'} {code.source_count} src
          </text>
          {showCheckmark && (
            <>
              <circle cx={n.x + n.w - 6} cy={n.y + 6} r={5} fill={COLOR_SELECT} />
              <text x={n.x + n.w - 6} y={n.y + 7} textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize={7} fontWeight={700}>{'\u2713'}</text>
            </>
          )}
        </g>
      )
    }

    // Compact: dot mode for categorized/uncategorized codes
    if (codeFormat === 'compact') {
      const dotR = CODE_DOT_R * sc
      const chipColor = code.color || n.color
      return (
        <g
          key={n.id}
          role="treeitem"
          aria-label={`${code.name}: ${code.segment_count} segments, ${code.source_count} sources`}
          aria-selected={isSel}
          tabIndex={isFocused ? 0 : -1}
          onClick={(e) => handleNodeClick(n.id, e)}
          onContextMenu={(e) => handleNodeContextMenu(n.id, e)}
          {...tooltipHandlers}
          style={{ cursor: targetingMode ? 'not-allowed' : 'pointer', outline: 'none', transition: 'opacity .2s' }}
          opacity={groupOpacity}
        >
          {(isSel || isFocused) && (
            <circle cx={n.cx} cy={n.cy} r={dotR + 3}
              fill="none" stroke={COLOR_SELECT} strokeWidth={1.5}
              strokeDasharray={isMultiSel && !isSingleSel ? '4 2' : undefined}
              opacity={0.5} />
          )}
          {/* Invisible hit area for easier clicking */}
          <circle cx={n.cx} cy={n.cy} r={dotR + 5} fill="transparent" style={{ cursor: 'pointer' }} />
          {/* Visible dot */}
          <circle cx={n.cx} cy={n.cy} r={dotR} fill={chipColor} stroke={`${chipColor}40`} strokeWidth={1} />
          {/* Multi-select checkmark */}
          {showCheckmark && (
            <>
              <circle cx={n.cx + dotR} cy={n.cy - dotR} r={4} fill={COLOR_SELECT} />
              <text x={n.cx + dotR} y={n.cy - dotR + 1} textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize={6} fontWeight={700}>{'\u2713'}</text>
            </>
          )}
        </g>
      )
    }

    // Full: chip-style
    const fs = clamp(11 * sc, 9, 12)
    const chipColor = code.color || n.color
    const chipTextColor = getContrastColor(chipColor)

    return (
      <g
        key={n.id}
        role="treeitem"
        aria-label={`${code.name}: ${code.segment_count} segments, ${code.source_count} sources`}
        aria-selected={isSel}
        tabIndex={isFocused ? 0 : -1}
        onClick={(e) => handleNodeClick(n.id, e)}
        onContextMenu={(e) => handleNodeContextMenu(n.id, e)}
        {...tooltipHandlers}
        style={{ cursor: targetingMode ? 'not-allowed' : 'pointer', outline: 'none', transition: 'opacity .2s' }}
        opacity={groupOpacity}
      >
        {(isSel || isFocused) && (
          <rect
            x={n.cx - n.w / 2 - 3} y={n.cy - n.h / 2 - 3}
            width={n.w + 6} height={n.h + 6} rx={8}
            fill="none" stroke={COLOR_SELECT} strokeWidth={1.5}
            strokeDasharray={isMultiSel && !isSingleSel ? '4 2' : undefined}
            opacity={0.5}
          />
        )}
        <rect
          x={n.cx - n.w / 2} y={n.cy - n.h / 2} width={n.w} height={n.h}
          rx={12}
          fill={chipColor}
          stroke={`${chipColor}40`}
          strokeWidth={1}
        />
        <text
          x={n.cx - n.w / 2 + 10} y={n.cy - 5}
          dominantBaseline="central"
          fill={chipTextColor} fontSize={fs} fontWeight={500}
        >
          {truncate(code.name, 20, sc)}
        </text>
        <text
          x={n.cx - n.w / 2 + 10} y={n.cy + 9}
          fill={chipTextColor} opacity={0.7} fontSize={clamp(8 * sc, 7, 9)}
        >
          {code.segment_count} seg{code.source_count > 0 ? ` \u00b7 ${code.source_count} src` : ''}
        </text>
        {/* Multi-select checkmark badge */}
        {showCheckmark && (
          <>
            <circle cx={n.cx + n.w / 2 - 6} cy={n.cy - n.h / 2 + 6} r={5} fill={COLOR_SELECT} />
            <text x={n.cx + n.w / 2 - 6} y={n.cy - n.h / 2 + 7}
              textAnchor="middle" dominantBaseline="central"
              fill="white" fontSize={7} fontWeight={700}>{'\u2713'}</text>
          </>
        )}
      </g>
    )
  }

  // ── Branch line dimming ─────────────────────────────────────────────────

  function getBranchOpacity(codeNodeId: string, isSel: boolean): { dimmed: boolean; opacity: number } {
    if (targetingMode) return { dimmed: true, opacity: 0.15 }
    if (multiSelect.size > 0) {
      const inMulti = multiSelect.has(codeNodeId)
      return { dimmed: !inMulti, opacity: inMulti ? 0.6 : 0.08 }
    }
    if (selectedCodeId != null) {
      return { dimmed: !isSel, opacity: isSel ? 0.9 : 0.08 }
    }
    return { dimmed: false, opacity: 0.5 }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden"
      role="tree"
      aria-label="Codebook tree"
      aria-multiselectable={multiSelect.size > 0 ? true : undefined}
      onKeyDown={handleKeyDown}
    >
      <svg
        ref={svgRef}
        viewBox={`${vp.x} ${vp.y} ${vp.width} ${vp.height}`}
        className="w-full h-full select-none"
        preserveAspectRatio="xMidYMid meet"
        fontFamily='"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
        onClick={handleSvgClick}
        onMouseDown={handleSvgMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: svgCursor }}
      >
        {/* Universal band background */}
        {(matchingCodeIds ? treeData.universal_codes.some(c => matchingCodeIds.has(c.id)) : treeData.universal_codes.length > 0) && (
          <>
            <rect
              x={12} y={6}
              width={Math.min(containerWidth - 24, Math.max(universalBandWidth, 120))}
              height={codeFormat === 'compact' ? 32 : 48}
              rx={6}
              fill="rgba(16,185,129,0.03)"
              stroke="rgba(16,185,129,0.12)"
              strokeWidth={1}
            />
            <text
              x={22} y={22}
              fill={COLOR_UNIVERSAL_TEXT}
              fontSize={9}
              fontWeight={600}
              letterSpacing="0.06em"
            >
              UNIVERSAL
            </text>
          </>
        )}

        {/* Uncategorized label */}
        {uncatLabel && (
          <text
            x={uncatLabel.x} y={uncatLabel.cy}
            fill={textMuted}
            fontSize={11}
            fontWeight={600}
            letterSpacing="0.04em"
          >
            UNCATEGORIZED
          </text>
        )}

        {/* Branch lines: category → child category */}
        {childCatNodes.map(n => {
          if (!n.cat) return null
          const x1 = n.parentCX!
          const y1 = n.parentCY!
          const x2 = n.x
          const y2 = n.cy
          const mx = x1 + (x2 - x1) * 0.4
          return (
            <path
              key={`cb-${n.cat.id}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={`${n.color}45`}
              strokeWidth={catFormat === 'compact' ? 1.2 : 2.0}
              style={{ transition: 'opacity .2s' }}
              opacity={targetingMode ? 0.3 : 1}
            />
          )
        })}

        {/* Branch lines: category → code */}
        {codeNodes.map(n => {
          if (!n.code || n.type === 'universal-code' || !n.parentCX || !n.parentCY) return null
          const isSel = n.code.id === selectedCodeId || multiSelect.has(n.id)
          const x1 = n.parentCX
          const y1 = n.parentCY
          const color = n.color
          const branch = getBranchOpacity(n.id, isSel)

          // For compact dots, connect to circle edge facing parent; for full chips, left edge
          let x2: number, y2: number
          if (codeFormat === 'compact') {
            const sc = n.scale || 1
            const r = CODE_DOT_R * sc
            const dx = x1 - n.cx
            const dy = y1 - n.cy
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist > 0) {
              x2 = n.cx + (dx / dist) * r
              y2 = n.cy + (dy / dist) * r
            } else {
              x2 = n.cx - r
              y2 = n.cy
            }
          } else {
            x2 = n.cx - n.w / 2
            y2 = n.cy
          }
          const mx = x1 + (x2 - x1) * 0.4

          return (
            <path
              key={`cl-${n.code.id}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={isSel ? color : `${color}50`}
              strokeWidth={isSel ? 2 : codeFormat === 'compact' ? 1.2 : 2.0}
              opacity={branch.opacity}
              style={{ transition: 'opacity .2s' }}
            />
          )
        })}

        {/* Category nodes */}
        {catNodes.map(renderCatNode)}

        {/* Code nodes */}
        {codeNodes.map(renderCodeNode)}

        {/* Creation spotlight overlay */}
        {spotlightInfo && (
          <g style={{ pointerEvents: 'none' }}>
            {/* Glow ring around target category */}
            <rect
              x={spotlightInfo.catNode.x - 6}
              y={spotlightInfo.catNode.y - 6}
              width={spotlightInfo.catNode.w + 12}
              height={spotlightInfo.catNode.h + 12}
              rx={12}
              fill="none"
              stroke={COLOR_SPOTLIGHT}
              strokeWidth={2}
              strokeDasharray="6 3"
            >
              <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2s" repeatCount="indefinite" />
            </rect>

            {/* Dashed connector from category to placeholder */}
            {(() => {
              const x1 = spotlightInfo.connX1
              const y1 = spotlightInfo.connY1
              const x2 = spotlightInfo.phCX - spotlightInfo.phW / 2
              const y2 = spotlightInfo.phCY
              const mx = x1 + (x2 - x1) * 0.4
              return (
                <path
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={COLOR_SPOTLIGHT}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  opacity={0.5}
                />
              )
            })()}

            {/* Placeholder node */}
            {spotlightInfo.isCodeSpotlight ? (
              codeFormat === 'compact' ? (
                <circle
                  cx={spotlightInfo.phCX}
                  cy={spotlightInfo.phCY}
                  r={CODE_DOT_R}
                  fill="none"
                  stroke={COLOR_SPOTLIGHT}
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  opacity={0.6}
                />
              ) : (
                <g>
                  <rect
                    x={spotlightInfo.phCX - spotlightInfo.phW / 2}
                    y={spotlightInfo.phCY - spotlightInfo.phH / 2}
                    width={spotlightInfo.phW}
                    height={spotlightInfo.phH}
                    rx={6}
                    fill={`${COLOR_SPOTLIGHT}15`}
                    stroke={COLOR_SPOTLIGHT}
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                    opacity={0.6}
                  />
                  <text
                    x={spotlightInfo.phCX}
                    y={spotlightInfo.phCY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={11}
                    fill={COLOR_SPOTLIGHT}
                    opacity={0.8}
                  >
                    {truncate(spotlightLabel?.trim() || 'New code', 14)}
                  </text>
                </g>
              )
            ) : (
              <g>
                {/* Category-style placeholder with color accent */}
                <rect
                  x={spotlightInfo.phCX - spotlightInfo.phW / 2}
                  y={spotlightInfo.phCY - spotlightInfo.phH / 2}
                  width={spotlightInfo.phW}
                  height={spotlightInfo.phH}
                  rx={catFormat === 'compact' ? 4 : 8}
                  fill={`${spotlightColor || COLOR_SPOTLIGHT}15`}
                  stroke={spotlightColor || COLOR_SPOTLIGHT}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  opacity={0.6}
                />
                {/* Left accent bar */}
                <rect
                  x={spotlightInfo.phCX - spotlightInfo.phW / 2}
                  y={spotlightInfo.phCY - spotlightInfo.phH / 2}
                  width={catFormat === 'compact' ? 3 : 4}
                  height={spotlightInfo.phH}
                  rx={1.5}
                  fill={spotlightColor || COLOR_SPOTLIGHT}
                  opacity={0.6}
                />
                {catFormat === 'full' && (
                  <text
                    x={spotlightInfo.phCX}
                    y={spotlightInfo.phCY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={11}
                    fill={spotlightColor || COLOR_SPOTLIGHT}
                    opacity={0.8}
                  >
                    {truncate(spotlightLabel?.trim() || 'New category', 14)}
                  </text>
                )}
              </g>
            )}
          </g>
        )}
      </svg>

      {/* Tooltip overlay */}
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
          {tooltip.kind === 'code' && tooltip.node.code && (() => {
            const code = tooltip.node.code!
            const chipColor = code.color || tooltip.node.color
            return (
              <>
                <div className="flex items-center gap-1.5">
                  <button
                    className="w-4 h-4 rounded-full shrink-0 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow"
                    style={{ backgroundColor: chipColor }}
                    aria-label={`Change color for ${code.name}`}
                    title="Change color"
                    onClick={() => setTooltipPickerOpen(prev => !prev)}
                  />
                  <div className="font-medium text-sm">{code.name}</div>
                </div>
                {tooltipPickerOpen && onCodeColorChange && (
                  <div className="mt-2 space-y-2 border-t border-mm-border-subtle pt-2">
                    <p className="text-[10px] text-mm-text-faint uppercase tracking-wide">Code Color</p>
                    <ColorSwatchPicker
                      value={code.color || ''}
                      onChange={(c) => {
                        onCodeColorChange(code.id, c)
                        setTooltipPickerOpen(false)
                        setTooltip(null)
                      }}
                    />
                    {code.color && (
                      <button
                        className="text-xs text-mm-text-muted hover:text-mm-text"
                        onClick={() => {
                          onCodeColorChange(code.id, null)
                          setTooltipPickerOpen(false)
                          setTooltip(null)
                        }}
                      >
                        {code.category_id != null ? 'Clear (inherit from category)' : 'Clear custom color'}
                      </button>
                    )}
                  </div>
                )}
                {!tooltipPickerOpen && (
                  <>
                    <div className="text-xs text-mm-text-muted mt-1">
                      {code.segment_count} segments · {code.source_count} sources
                    </div>
                    {(() => {
                      const path = categoryPathMap.codeToPath.get(code.id)
                      return path && path.length > 0 ? (
                        <div className="text-xs text-mm-text-faint mt-0.5">
                          {path.join(' \u203A ')}
                        </div>
                      ) : null
                    })()}
                  </>
                )}
              </>
            )
          })()}
          {tooltip.kind === 'cat' && tooltip.node.cat && (() => {
            const cat = tooltip.node.cat!
            const catColor = cat.color || tooltip.node.color
            return (
              <>
                <div className="flex items-center gap-1.5">
                  <button
                    className="w-4 h-4 rounded shrink-0 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow"
                    style={{ backgroundColor: catColor }}
                    aria-label={`Change color for category ${cat.name}`}
                    title="Change color"
                    onClick={() => setTooltipPickerOpen(prev => !prev)}
                  />
                  <div className="font-medium text-sm">{cat.name}</div>
                </div>
                {tooltipPickerOpen && onCategoryColorChange && (
                  <div className="mt-2 space-y-2 border-t border-mm-border-subtle pt-2">
                    <p className="text-[10px] text-mm-text-faint uppercase tracking-wide">Category Color</p>
                    <ColorSwatchPicker
                      value={cat.color || ''}
                      onChange={(c) => {
                        onCategoryColorChange(cat.id, c)
                        setTooltipPickerOpen(false)
                        setTooltip(null)
                      }}
                    />
                  </div>
                )}
                {!tooltipPickerOpen && (
                  <>
                    <div className="text-xs text-mm-text-muted mt-1">
                      {tooltip.node.totalCodes ?? 0} codes · {tooltip.node.totalSeg ?? 0} segments
                    </div>
                    {cat.children.length > 0 && (
                      <div className="text-xs text-mm-text-faint mt-0.5">
                        {cat.children.length} subcategor{cat.children.length === 1 ? 'y' : 'ies'}
                      </div>
                    )}
                    {(() => {
                      const path = categoryPathMap.catToPath.get(cat.id)
                      return path && path.length > 0 ? (
                        <div className="text-xs text-mm-text-faint mt-0.5">
                          {path.join(' \u203A ')}
                        </div>
                      ) : null
                    })()}
                  </>
                )}
              </>
            )
          })()}
        </div>
      )}

      {/* Zoom toolbar overlay */}
      <div
        data-exclude-export=""
        className="absolute top-3 left-3 flex items-center gap-1 bg-mm-bg/95 border border-mm-border-medium rounded-lg p-1 shadow-md z-10"
        role="toolbar"
        aria-label="Tree zoom controls"
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
        <span className="text-[10px] text-mm-text-faint tabular-nums px-1">{spatialZoomPercent}%</span>
      </div>

      {/* Hint text */}
      <div
        data-exclude-export=""
        className="absolute top-3 right-3 text-[10px] text-mm-text-muted z-10"
      >
        {multiSelect.size > 0
          ? 'M to move \u00b7 G to merge \u00b7 Esc to clear'
          : 'Scroll to zoom \u00b7 Drag to pan \u00b7 +/\u2212/0'}
      </div>

      {/* Empty after search */}
      {matchingCodeIds && matchingCodeIds.size === 0 && (
        <p className="text-xs text-mm-text-faint text-center py-8 absolute inset-0 flex items-center justify-center">No codes match &ldquo;{search}&rdquo;</p>
      )}

      {/* SR announcements */}
      <div aria-live="polite" className="sr-only">{liveAnnouncement}</div>
    </div>
  )
}
