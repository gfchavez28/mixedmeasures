import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

export interface LayoutBounds {
  minX: number; maxX: number; minY: number; maxY: number
}

export interface Viewport {
  x: number; y: number; width: number; height: number
}

export interface Diagnostics {
  unused: number
  uncategorized: number
  emptyCategories: number
  lowCoverage: number
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function walkCodes(
  tree: CodebookCategoryNode[],
  uncategorized: CodebookCodeNode[],
  universal: CodebookCodeNode[],
): { codes: CodebookCodeNode[]; categories: CodebookCategoryNode[] } {
  const codes: CodebookCodeNode[] = [...uncategorized, ...universal]
  const categories: CodebookCategoryNode[] = []
  function walk(nodes: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      categories.push(cat)
      codes.push(...cat.codes)
      walk(cat.children)
    }
  }
  walk(tree)
  return { codes, categories }
}

export function computeCodebookDiagnostics(treeData: CodebookTreeResponse): Diagnostics {
  const { codes, categories } = walkCodes(
    treeData.tree,
    treeData.uncategorized_codes,
    treeData.universal_codes,
  )
  return {
    unused: codes.filter(c => c.segment_count === 0).length,
    uncategorized: treeData.uncategorized_codes.length,
    emptyCategories: categories.filter(c => c.code_count === 0 && c.total_code_count === 0).length,
    lowCoverage: codes.filter(c => c.source_count === 1).length,
  }
}

// ── Fit viewport ─────────────────────────────────────────────────────────────

export function fitViewportToBounds(
  bounds: LayoutBounds,
  padding: number,
  legendPadSvg = 0,
): Viewport {
  const fitW = (bounds.maxX - bounds.minX) + padding * 2
  const fitH = (bounds.maxY - bounds.minY) + padding * 2 + legendPadSvg
  const fitCx = (bounds.minX + bounds.maxX) / 2
  const fitCy = (bounds.minY + bounds.maxY) / 2 + legendPadSvg / 2
  return { x: fitCx - fitW / 2, y: fitCy - fitH / 2, width: fitW, height: fitH }
}

// ── Hierarchy levels (bottom-up labeling) ────────────────────────────────────

export function buildHierarchyLevels(
  treeData: CodebookTreeResponse | undefined,
  customNames?: Record<string, string> | null,
): { value: number; label: string }[] {
  const levels: { value: number; label: string }[] = [{ value: -1, label: 'Codes' }]
  if (!treeData || treeData.tree.length === 0) return levels
  let maxDepth = 0
  function walk(cats: CodebookCategoryNode[], d: number) {
    for (const cat of cats) {
      if (d > maxDepth) maxDepth = d
      walk(cat.children, d + 1)
    }
  }
  walk(treeData.tree, 0)
  for (let d = maxDepth; d >= 0; d--) {
    const userLevel = maxDepth - d + 1
    const custom = customNames?.[String(d)]
    let label: string
    if (custom) label = custom
    else if (d === 0) label = 'Top Categories'
    else if (userLevel === 1) label = 'Subcategories'
    else label = `Level ${userLevel}`
    levels.push({ value: d, label })
  }
  return levels
}
