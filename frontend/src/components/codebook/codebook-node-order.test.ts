import { describe, it, expect } from 'vitest'
import { navigableNodeIds, type NavTreeData } from './codebook-node-order'
import { firstChildIndex, parentIndex, siblingPositions } from '@/hooks/useTreeKeyboardNav'

/**
 * #774 and the three defects it shares a root cause with.
 *
 * The order these produce is what the keyboard cursor, `aria-posinset`/
 * `aria-setsize` and shift-range selection all index. It used to be
 * `layout.nodes` — the SVG PAINT order, which is post-order because a category
 * is emitted after the children whose extent decides its `y`.
 *
 * ⚠️ The NESTED fixture below is the one that cannot be driven live: no project
 * in the developer's dev.db has a category with `parent_id` set, which is the
 * degenerate-fixture gap #758 and #701(a) both recorded. Everything here is
 * therefore the only coverage the nesting rules have.
 */

const cat = (id: number, codes: number[], children: NavTreeData['tree'] = []) =>
  ({ id, codes: codes.map(c => ({ id: c })), children })

/** Six root categories, five codes each — the shape of project 1. */
const FLAT: NavTreeData = {
  universal_codes: [{ id: 1 }, { id: 2 }],
  tree: [cat(1, [3, 4, 5, 6, 7]), cat(2, [8, 9, 10, 11, 12])],
  uncategorized_codes: [{ id: 32 }],
}

/** A category with BOTH a child category and its own direct codes. */
const NESTED: NavTreeData = {
  universal_codes: [{ id: 900 }],
  tree: [
    cat(1, [101, 102], [cat(2, [201, 202])]),
    cat(3, [301]),
  ],
  uncategorized_codes: [{ id: 999 }],
}

const all = () => true

describe('navigableNodeIds — reading order', () => {
  it('puts each category BEFORE its own codes, not after them', () => {
    // The defect: paint order gave code-3…code-7 then cat-1, so ArrowDown
    // walked five codes before reaching the category they belong to.
    expect(navigableNodeIds(FLAT, all)).toEqual([
      'code-1', 'code-2',
      'cat-1', 'code-3', 'code-4', 'code-5', 'code-6', 'code-7',
      'cat-2', 'code-8', 'code-9', 'code-10', 'code-11', 'code-12',
      'code-32',
    ])
  })

  it('orders a nested category as drawn: the category, its child categories, then its own codes', () => {
    expect(navigableNodeIds(NESTED, all)).toEqual([
      'code-900',
      'cat-1', 'cat-2', 'code-201', 'code-202', 'code-101', 'code-102',
      'cat-3', 'code-301',
      'code-999',
    ])
  })

  it('skips what the search filter removed, without disturbing the rest', () => {
    const gone = new Set(['cat-2', 'code-201', 'code-202', 'code-101'])
    expect(navigableNodeIds(NESTED, id => !gone.has(id))).toEqual([
      'code-900', 'cat-1', 'code-102', 'cat-3', 'code-301', 'code-999',
    ])
  })

  it('never emits the uncategorized-label marker, which is not a treeitem', () => {
    // It has depth -1 and the category renderer returns null for it, so counting
    // it inflated every root's announced set size by one.
    const ids = navigableNodeIds(NESTED, all)
    expect(ids).not.toContain('uncategorized-label')
    expect(ids.some(id => id.startsWith('cat-') || id.startsWith('code-'))).toBe(true)
  })
})

/**
 * The levels `CodebookTreeView` publishes: a category at `depth` is `depth + 1`,
 * its direct codes one deeper, and the two bands with no node of their own
 * (universal, uncategorized) are roots.
 */
const LEVELS: Record<string, number> = {
  'code-900': 1,
  'cat-1': 1, 'cat-2': 2, 'code-201': 3, 'code-202': 3, 'code-101': 2, 'code-102': 2,
  'cat-3': 1, 'code-301': 2,
  'code-999': 1,
}

/** Who each node's parent genuinely is — the fixture's own structure. */
const TRUE_PARENT: Record<string, string | null> = {
  'code-900': null,
  'cat-1': null, 'cat-2': 'cat-1', 'code-201': 'cat-2', 'code-202': 'cat-2',
  'code-101': 'cat-1', 'code-102': 'cat-1',
  'cat-3': null, 'code-301': 'cat-3',
  'code-999': null,
}

describe('the shared traversal rules are CORRECT on this order (they were not before)', () => {
  const order = navigableNodeIds(NESTED, all)
  const levels = order.map(id => LEVELS[id])

  it('ArrowLeft resolves EVERY node to its real parent — all of them, not a sample', () => {
    // A population assertion: the old order got this wrong for every code, and a
    // spot-check of one node would have passed on the old order too (a code
    // whose wrong parent happened to be the previous category).
    const resolved = Object.fromEntries(order.map((id, i) => {
      const p = parentIndex(levels, i)
      return [id, p === null ? null : order[p]]
    }))
    expect(resolved).toEqual(TRUE_PARENT)
  })

  it('ArrowRight from a category steps into its OWN first child', () => {
    const idx = (id: string) => order.indexOf(id)
    expect(firstChildIndex(levels, idx('cat-1'))).toBe(idx('cat-2'))
    expect(firstChildIndex(levels, idx('cat-2'))).toBe(idx('code-201'))
    expect(firstChildIndex(levels, idx('cat-3'))).toBe(idx('code-301'))
    // A leaf has nowhere to step in to.
    expect(firstChildIndex(levels, idx('code-102'))).toBeNull()
  })

  it('announces a set size that matches the navigable set', () => {
    const pos = siblingPositions(levels)
    const roots = order.filter(id => LEVELS[id] === 1)
    // code-900, cat-1, cat-3, code-999 — the label marker is NOT among them.
    expect(roots).toEqual(['code-900', 'cat-1', 'cat-3', 'code-999'])
    for (const id of roots) expect(pos[order.indexOf(id)].setsize).toBe(roots.length)
  })
})
