import { describe, it, expect } from 'vitest'
import {
  buildOverviewModel, layoutTreemap, squarify, gridLayout, categoryColor,
  type OverviewNode, type Rect,
} from './codebook-overview'
import type { CodebookTreeResponse, CodebookCodeNode, CodebookCategoryNode } from '@/lib/api'

function code(id: number, name: string, seg: number, src = seg, opts: Partial<CodebookCodeNode> = {}): CodebookCodeNode {
  return {
    id, numeric_id: id, name, description: null, color: null, is_active: true, is_universal: false,
    segment_count: seg, source_count: src, excerpt_count: 0, category_id: null, ...opts,
  }
}
function cat(id: number, name: string, order: number, codes: CodebookCodeNode[], children: CodebookCategoryNode[] = []): CodebookCategoryNode {
  return {
    id, name, color: null, display_order: order, parent_id: null, depth: 0, created_at: null,
    code_count: codes.length, total_code_count: codes.length, total_segments: 0, total_sources: 0, children, codes,
  }
}

// A small codebook: 2 categories (one with an unused code), 1 uncategorized, 2 universal (1 unused).
const TREE: CodebookTreeResponse = {
  tree: [
    cat(1, 'Implementation', 1, [code(10, 'Curriculum fidelity', 5), code(11, 'Pacing', 3), code(12, 'Unused code', 0)]),
    cat(2, 'Training', 2, [code(20, 'Peer collaboration', 5), code(21, 'Coaching', 1)]),
  ],
  uncategorized_codes: [code(30, 'new code test', 3, 1, { category_id: null })],
  universal_codes: [
    code(1, 'Unsubstantive', 1, 1, { is_universal: true }),
    code(2, 'Unclear', 0, 0, { is_universal: true }),
  ],
}

function leaves(n: OverviewNode, out: OverviewNode[] = []): OverviewNode[] {
  if (n.kind === 'code') out.push(n)
  n.children?.forEach(c => leaves(c, out))
  return out
}
function categories(n: OverviewNode, out: OverviewNode[] = []): OverviewNode[] {
  if (n.kind === 'category') out.push(n)
  n.children?.forEach(c => categories(c, out))
  return out
}
const within = (inner: Rect, outer: Rect, eps = 0.01) =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps &&
  inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps

describe('buildOverviewModel', () => {
  it('segments mode drops 0-count codes and counts them as unused', () => {
    const m = buildOverviewModel(TREE, 'segments')
    const names = leaves(m.root).map(l => l.name)
    expect(names).not.toContain('Unused code')   // 0 segments → dropped
    expect(names).not.toContain('Unclear')       // 0 segments universal → dropped
    expect(names).toContain('Curriculum fidelity')
    expect(m.unusedCount).toBe(2)                 // 'Unused code' + 'Unclear'
    expect(m.codeCount).toBe(6)                   // 5+3,5+1,3,1 coded leaves
    expect(m.totalValue).toBe(5 + 3 + 5 + 1 + 3 + 1) // = 18 segment-applications
  })

  it('equal mode shows every code (incl. unused) as value 1', () => {
    const m = buildOverviewModel(TREE, 'equal')
    expect(leaves(m.root).map(l => l.name)).toContain('Unused code')
    expect(leaves(m.root).every(l => l.value === 1)).toBe(true)
    expect(m.codeCount).toBe(8)                   // all codes incl. 2 unused
  })

  it('sources mode sizes by source_count', () => {
    const m = buildOverviewModel(TREE, 'sources')
    const ncode = leaves(m.root).find(l => l.name === 'new code test')!
    expect(ncode.value).toBe(1)                   // source_count = 1 (vs 3 segments)
  })

  it('routes uncategorized + universal into set-apart groups', () => {
    const m = buildOverviewModel(TREE, 'segments')
    const catKeys = categories(m.root).map(c => c.key)
    expect(catKeys).toContain('uncat')
    expect(catKeys).toContain('universal')
    expect(catKeys).toContain('cat-1')
  })

  it('assigns distinct deterministic category colors', () => {
    const m = buildOverviewModel(TREE, 'segments')
    const c1 = categories(m.root).find(c => c.key === 'cat-1')!
    const c2 = categories(m.root).find(c => c.key === 'cat-2')!
    expect(c1.color).toBe(categoryColor(0))
    expect(c2.color).toBe(categoryColor(1))
    expect(c1.color).not.toBe(c2.color)
  })

  it('omits empty categories entirely (all-zero category → no node)', () => {
    const allZero: CodebookTreeResponse = {
      tree: [cat(9, 'Empty', 1, [code(90, 'z1', 0), code(91, 'z2', 0)])],
      uncategorized_codes: [], universal_codes: [],
    }
    const m = buildOverviewModel(allZero, 'segments')
    expect(m.root.children).toHaveLength(0)
    expect(m.unusedCount).toBe(2)
  })
})

describe('squarify', () => {
  const RECT: Rect = { x: 0, y: 0, w: 400, h: 300 }
  const mk = (vals: number[]): OverviewNode[] =>
    vals.map((v, i) => ({ key: `n${i}`, kind: 'code', name: `n${i}`, value: v, color: '#000' }))

  it('conserves total area and contains every tile', () => {
    const nodes = mk([5, 3, 2, 1, 8, 4])
    squarify(nodes, RECT)
    let sum = 0
    for (const n of nodes) {
      expect(n.rect).toBeDefined()
      expect(within(n.rect!, RECT)).toBe(true)
      expect(Number.isFinite(n.rect!.w) && Number.isFinite(n.rect!.h)).toBe(true)
      expect(n.rect!.w).toBeGreaterThanOrEqual(0)
      expect(n.rect!.h).toBeGreaterThanOrEqual(0)
      sum += n.rect!.w * n.rect!.h
    }
    expect(sum).toBeCloseTo(RECT.w * RECT.h, 2)
  })

  it('makes tile area proportional to value', () => {
    const nodes = mk([10, 5])
    squarify(nodes, RECT)
    const a0 = nodes[0].rect!.w * nodes[0].rect!.h
    const a1 = nodes[1].rect!.w * nodes[1].rect!.h
    expect(a0 / a1).toBeCloseTo(2, 5)
  })

  it('handles a single node by filling the rect', () => {
    const nodes = mk([7])
    squarify(nodes, RECT)
    const r = nodes[0].rect!
    expect(r.x).toBeCloseTo(RECT.x, 6); expect(r.y).toBeCloseTo(RECT.y, 6)
    expect(r.w).toBeCloseTo(RECT.w, 6); expect(r.h).toBeCloseTo(RECT.h, 6)
  })

  it('ignores zero-value nodes', () => {
    const nodes = mk([5, 0, 5])
    squarify(nodes, RECT)
    expect(nodes[1].rect).toBeUndefined()
    expect(nodes[0].rect).toBeDefined()
  })

  it('lays equal-valued siblings as a uniform grid (identical cells, not strips)', () => {
    const nodes = mk([1, 1, 1, 1, 1, 1])  // equal mode within a category
    squarify(nodes, RECT)
    const w0 = nodes[0].rect!.w, h0 = nodes[0].rect!.h
    for (const n of nodes) {
      expect(n.rect!.w).toBeCloseTo(w0, 6)   // every cell the same size
      expect(n.rect!.h).toBeCloseTo(h0, 6)
      expect(within(n.rect!, RECT)).toBe(true)
    }
    // 6 cells in a 400×300 rect → 3×2 grid is the squarest → aspect well under 2
    const ar = Math.max(w0, h0) / Math.min(w0, h0)
    expect(ar).toBeLessThan(1.6)
  })
})

describe('gridLayout', () => {
  const RECT: Rect = { x: 10, y: 20, w: 300, h: 200 }
  const mk = (n: number): OverviewNode[] =>
    Array.from({ length: n }, (_, i) => ({ key: `g${i}`, kind: 'code' as const, name: `g${i}`, value: 1, color: '#000' }))

  it('produces identical, contained, near-square cells and preserves input order', () => {
    const nodes = mk(7)
    gridLayout(nodes, RECT)
    const w0 = nodes[0].rect!.w, h0 = nodes[0].rect!.h
    for (const n of nodes) {
      expect(n.rect!.w).toBeCloseTo(w0, 6)
      expect(n.rect!.h).toBeCloseTo(h0, 6)
      expect(within(n.rect!, RECT)).toBe(true)
    }
    // row-major order: node 1 sits to the right of (or below, never above) node 0
    expect(nodes[1].rect!.y).toBeGreaterThanOrEqual(nodes[0].rect!.y - 1e-6)
  })

  it('fills the rect when n is a multiple of the column count (no trailing gap)', () => {
    const nodes = mk(6)
    gridLayout(nodes, RECT)
    const sum = nodes.reduce((s, n) => s + n.rect!.w * n.rect!.h, 0)
    expect(sum).toBeCloseTo(RECT.w * RECT.h, 2)
  })

  it('single node fills the whole rect', () => {
    const nodes = mk(1)
    gridLayout(nodes, RECT)
    expect(nodes[0].rect!.w).toBeCloseTo(RECT.w, 6)
    expect(nodes[0].rect!.h).toBeCloseTo(RECT.h, 6)
  })
})

describe('layoutTreemap', () => {
  const RECT: Rect = { x: 0, y: 0, w: 600, h: 400 }

  it('contains every category and code within its parent', () => {
    const m = buildOverviewModel(TREE, 'segments')
    layoutTreemap(m.root, RECT, { headerH: 16, pad: 2 })
    for (const c of categories(m.root)) {
      expect(c.rect).toBeDefined()
      expect(within(c.rect!, RECT)).toBe(true)
      for (const child of c.children ?? []) {
        expect(child.rect).toBeDefined()
        expect(within(child.rect!, c.rect!, 0.5)).toBe(true)  // inside parent (with header inset)
      }
    }
    for (const l of leaves(m.root)) expect(l.rect).toBeDefined()
  })

  it('reserves a header strip below each category top edge', () => {
    const m = buildOverviewModel(TREE, 'segments')
    layoutTreemap(m.root, RECT, { headerH: 16, pad: 2 })
    const c1 = categories(m.root).find(c => c.key === 'cat-1')!
    for (const child of c1.children ?? []) {
      expect(child.rect!.y).toBeGreaterThanOrEqual(c1.rect!.y + 16 - 0.5)
    }
  })
})
