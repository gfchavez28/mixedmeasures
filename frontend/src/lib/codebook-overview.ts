/**
 * #438 — data + layout for the read-only Codebook **Overview** (treemap) mode.
 *
 * Pure, testable. Consumes the SAME `CodebookTreeResponse` the Tree renders, so
 * the treemap's numbers are inherently consistent with the Tree (no separate
 * count path — see CLAUDE.md on the codebook count seam). Renders a squarified
 * treemap: categories nest their codes; tile area = the chosen measure.
 *
 * Honest-data rules (researchers must not be misled):
 *  - In `segments`/`sources` mode a 0-count code has no area and is DROPPED;
 *    `unusedCount` reports how many, so the UI can say "N codes not shown".
 *  - In `equal` mode every code is one equal tile (structural view) — unused
 *    codes ARE shown, because it's not a frequency view.
 *  - Tile area is per CODE (a segment with two codes counts under both), i.e.
 *    code-application weight, not distinct segments. Labelled honestly in the UI.
 */
import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'

export type OverviewMeasure = 'segments' | 'sources' | 'equal'

export interface Rect { x: number; y: number; w: number; h: number }

export interface OverviewNode {
  /** stable key: `root` | `cat-<id>` | `uncat` | `universal` | `code-<id>` */
  key: string
  kind: 'root' | 'category' | 'code'
  name: string
  /** computed area weight (>0 for rendered nodes) */
  value: number
  /** category accent (leaves inherit their category's color) */
  color: string
  /** present on leaves */
  code?: CodebookCodeNode
  children?: OverviewNode[]
  /** assigned by layoutTreemap */
  rect?: Rect
}

export interface OverviewModel {
  root: OverviewNode
  /** codes with 0 segments, hidden in segments/sources mode (0 in equal mode) */
  unusedCount: number
  /** rendered code-leaf count */
  codeCount: number
  /** sum of leaf values (e.g. total segment-applications) */
  totalValue: number
  measure: OverviewMeasure
}

/**
 * Deterministic categorical palette (categories carry no stored color). Mid-tone
 * hues so `getContrastColor` reliably picks readable text; distinct in light+dark.
 */
export const OVERVIEW_PALETTE = [
  '#2f7fb8', '#7a5bd8', '#cf8230', '#39a06d', '#bd4f86',
  '#4f93c4', '#a86a3c', '#6f9a3a', '#9a4f9e', '#3f9aa6',
] as const
/** Uncategorized + Universal get fixed neutral hues (set apart, like the Tree). */
export const UNCATEGORIZED_COLOR = '#5f6b78'
export const UNIVERSAL_COLOR = '#7a8088'

export function categoryColor(index: number): string {
  return OVERVIEW_PALETTE[((index % OVERVIEW_PALETTE.length) + OVERVIEW_PALETTE.length) % OVERVIEW_PALETTE.length]
}

function measureValue(code: CodebookCodeNode, measure: OverviewMeasure): number {
  if (measure === 'equal') return 1
  if (measure === 'sources') return code.source_count
  return code.segment_count
}

/** Build a category subtree node: its child categories + its own coded leaves. */
function buildCategory(cat: CodebookCategoryNode, color: string, measure: OverviewMeasure): OverviewNode | null {
  const children: OverviewNode[] = []
  for (const child of cat.children) {
    const node = buildCategory(child, color, measure)
    if (node) children.push(node)
  }
  for (const code of cat.codes) {
    const v = measureValue(code, measure)
    if (v > 0) children.push({ key: `code-${code.id}`, kind: 'code', name: code.name, value: v, color, code })
  }
  if (children.length === 0) return null
  const value = children.reduce((s, c) => s + c.value, 0)
  return { key: `cat-${cat.id}`, kind: 'category', name: cat.name, value, color, children }
}

function buildLeafGroup(
  key: string, name: string, color: string, codes: CodebookCodeNode[], measure: OverviewMeasure,
): OverviewNode | null {
  const children: OverviewNode[] = []
  for (const code of codes) {
    const v = measureValue(code, measure)
    if (v > 0) children.push({ key: `code-${code.id}`, kind: 'code', name: code.name, value: v, color, code })
  }
  if (children.length === 0) return null
  return { key, kind: 'category', name, color, value: children.reduce((s, c) => s + c.value, 0), children }
}

/** Count codes (incl. universal + uncategorized) with 0 segments — the "unused" set. */
function countUnused(treeData: CodebookTreeResponse): number {
  let n = 0
  const tally = (codes: CodebookCodeNode[]) => { for (const c of codes) if (c.segment_count === 0) n++ }
  const walk = (cats: CodebookCategoryNode[]) => { for (const c of cats) { tally(c.codes); walk(c.children) } }
  walk(treeData.tree)
  tally(treeData.uncategorized_codes)
  tally(treeData.universal_codes)
  return n
}

/**
 * Build the treemap hierarchy from the codebook tree response. Categories keep
 * `display_order`; Uncategorized then Universal trail at the end (set apart).
 */
export function buildOverviewModel(treeData: CodebookTreeResponse, measure: OverviewMeasure): OverviewModel {
  const children: OverviewNode[] = []
  const sortedCats = [...treeData.tree].sort((a, b) => a.display_order - b.display_order)
  sortedCats.forEach((cat, i) => {
    const node = buildCategory(cat, categoryColor(i), measure)
    if (node) children.push(node)
  })
  const uncat = buildLeafGroup('uncat', 'Uncategorized', UNCATEGORIZED_COLOR, treeData.uncategorized_codes, measure)
  if (uncat) children.push(uncat)
  const universal = buildLeafGroup('universal', 'Universal', UNIVERSAL_COLOR, treeData.universal_codes, measure)
  if (universal) children.push(universal)

  const value = children.reduce((s, c) => s + c.value, 0)
  const root: OverviewNode = { key: 'root', kind: 'root', name: 'Codebook', value, color: '#000', children }

  let codeCount = 0
  const countLeaves = (n: OverviewNode) => {
    if (n.kind === 'code') { codeCount++; return }
    n.children?.forEach(countLeaves)
  }
  countLeaves(root)

  return { root, unusedCount: countUnused(treeData), codeCount, totalValue: value, measure }
}

// ── Squarified treemap layout (Bruls, Huizing & van Wijk) ────────────────────

/** Aspect-ratio of the worst tile in a row of scaled areas laid along `length`. */
function worstRatio(areas: number[], length: number): number {
  if (areas.length === 0 || length <= 0) return Infinity
  const sum = areas.reduce((a, b) => a + b, 0)
  if (sum <= 0) return Infinity
  const max = Math.max(...areas), min = Math.min(...areas)
  const len2 = length * length, sum2 = sum * sum
  return Math.max((len2 * max) / sum2, sum2 / (len2 * min))
}

/**
 * Lay equal-value nodes into a uniform grid of identical, near-square cells
 * (row-major, preserving input order). Mutates each node's `rect`. Used when a
 * node's children all share one value — the `equal` measure, or any category
 * whose codes tie on the measure: a grid reads far more even than squarified
 * strips, which leave a few elongated leftover tiles. Cells are all the same
 * size (so "equal size" stays honest); any trailing slots (n not a multiple of
 * the column count) are simply left empty.
 */
export function gridLayout(nodes: OverviewNode[], rect: Rect): void {
  const n = nodes.length
  if (n === 0 || rect.w <= 0 || rect.h <= 0) return
  // Pick the column count whose cells sit closest to square — with a mild bias
  // toward fuller grids so a near-tie on aspect doesn't pick a wider layout that
  // leaves several empty trailing cells (e.g. 5 codes: prefer 3×2 (one gap) over
  // 4×2 (three gaps) when their cell aspects are nearly equal).
  let cols = 1, best = Infinity
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c)
    const cw = rect.w / c, ch = rect.h / rows
    const ar = Math.max(cw, ch) / Math.min(cw, ch)
    const score = ar + 0.12 * ((c * rows - n) / n)   // + emptiness penalty
    if (score < best - 1e-9) { best = score; cols = c }
  }
  const rows = Math.ceil(n / cols)
  const cw = rect.w / cols, ch = rect.h / rows
  nodes.forEach((node, i) => {
    const c = i % cols, r = Math.floor(i / cols)
    node.rect = { x: rect.x + c * cw, y: rect.y + r * ch, w: cw, h: ch }
  })
}

/**
 * Assign rects to `nodes` (in input order) filling `rect`, keeping tiles near
 * square. Areas are proportional to `node.value`. Mutates each node's `rect`.
 */
export function squarify(nodes: OverviewNode[], rect: Rect): void {
  const live = nodes.filter(n => n.value > 0)
  if (live.length === 0) return
  // Equal-valued siblings → a uniform grid (identical, near-square cells) reads
  // far more even than squarified strips. Covers `equal` mode and tied codes.
  const v0 = live[0].value
  if (live.length > 1 && live.every(n => Math.abs(n.value - v0) < 1e-9)) {
    gridLayout(live, rect)
    return
  }
  const area = rect.w * rect.h
  const totalV = live.reduce((s, n) => s + n.value, 0)
  const scale = totalV > 0 ? area / totalV : 0
  // worklist sorted desc by scaled area, paired with its node
  const work = live
    .map(n => ({ n, a: n.value * scale }))
    .sort((p, q) => q.a - p.a)

  let { x, y, w, h } = rect
  let i = 0
  while (i < work.length) {
    const length = Math.min(w, h)
    const row = [work[i]]
    let j = i + 1
    while (j < work.length) {
      const cur = row.map(r => r.a)
      if (worstRatio([...cur, work[j].a], length) <= worstRatio(cur, length)) { row.push(work[j]); j++ }
      else break
    }
    const rowArea = row.reduce((s, r) => s + r.a, 0)
    if (w >= h) {
      const stripW = rowArea / h
      let yy = y
      for (const r of row) {
        const cellH = (r.a / rowArea) * h
        r.n.rect = { x, y: yy, w: stripW, h: cellH }
        yy += cellH
      }
      x += stripW; w -= stripW
    } else {
      const stripH = rowArea / w
      let xx = x
      for (const r of row) {
        const cellW = (r.a / rowArea) * w
        r.n.rect = { x: xx, y, w: cellW, h: stripH }
        xx += cellW
      }
      y += stripH; h -= stripH
    }
    i = j
  }
}

export interface LayoutOpts {
  /** header strip reserved at the top of each category rect (px) */
  headerH?: number
  /** inner padding inside a category before its children are laid out (px) */
  pad?: number
}

/** Recursively lay out the whole hierarchy into `rect`. Mutates `node.rect`s. */
export function layoutTreemap(root: OverviewNode, rect: Rect, opts: LayoutOpts = {}): void {
  const headerH = opts.headerH ?? 16
  const pad = opts.pad ?? 2
  root.rect = rect
  const layoutChildren = (node: OverviewNode, isRoot: boolean) => {
    if (!node.children || node.children.length === 0 || !node.rect) return
    const r = node.rect
    // root has no header; categories reserve a header + padding
    const inner: Rect = isRoot
      ? r
      : { x: r.x + pad, y: r.y + headerH, w: Math.max(0, r.w - pad * 2), h: Math.max(0, r.h - headerH - pad) }
    squarify(node.children, inner)
    for (const child of node.children) if (child.kind === 'category') layoutChildren(child, false)
  }
  layoutChildren(root, true)
}
