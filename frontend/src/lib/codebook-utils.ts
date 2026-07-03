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

/**
 * Legible default view (#428b). Fitting a very tall/narrow codebook entirely
 * into a short/wide canvas scales it illegibly small. When the content is
 * taller than the canvas aspect, open fit-to-WIDTH (same top-left anchor) at a
 * readable scale and let the user scroll down; otherwise return the
 * fit-everything viewport unchanged (the "Fit" control always returns to that).
 *
 * `topChromePx` nudges the top down so the first row clears a floating toolbar;
 * it's converted from screen px to SVG units via the fit-to-width scale.
 */
export function legibleDefaultViewport(
  fitVp: Viewport,
  container: { width: number; height: number } | null,
  topChromePx = 56,
): Viewport {
  if (!container || container.width <= 0 || container.height <= 0) return fitVp
  const widthScale = container.width / fitVp.width
  const heightScale = container.height / fitVp.height
  // Width-constrained already (wide/short content): fit-everything fills the
  // width, so there's nothing to gain — keep the overview.
  if (widthScale <= heightScale) return fitVp
  return {
    x: fitVp.x,
    y: fitVp.y - topChromePx / widthScale,
    width: fitVp.width,
    height: fitVp.width * (container.height / container.width),
  }
}

