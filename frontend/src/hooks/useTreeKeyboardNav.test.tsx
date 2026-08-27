/**
 * #701(a) — the shared tree keyboard layer and its derived position metadata.
 *
 * jsdom cannot tell you what a screen reader announces, but it CAN run the
 * grouping arithmetic and the focus moves, which is where the branching lives.
 * The announcement itself was verified by driving the real trees in Chrome.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { useTreeKeyboardNav, useTreeAriaPositions, firstChildIndex, parentIndex } from './useTreeKeyboardNav'

afterEach(cleanup)

/** A tree fixture given as (level, label, expanded?) triples. */
type Node = { level: number; label: string; expanded?: boolean }

function Tree({ nodes, onSetExpanded }: { nodes: Node[]; onSetExpanded?: (el: HTMLElement, v: boolean) => void }) {
  const treeRef = useRef<HTMLDivElement>(null)
  const onKeyDown = useTreeKeyboardNav({ treeRef, onSetExpanded })
  useTreeAriaPositions(treeRef)
  return (
    <div ref={treeRef} role="tree" aria-label="Fixture" onKeyDown={onKeyDown}>
      {nodes.map(n => (
        <div
          key={n.label}
          role="treeitem"
          tabIndex={-1}
          aria-level={n.level}
          aria-expanded={n.expanded == null ? undefined : n.expanded}
          data-label={n.label}
        >
          {n.label}
        </div>
      ))}
    </div>
  )
}

const item = (label: string) => screen.getByText(label)
const pos = (label: string) => [
  item(label).getAttribute('aria-posinset'),
  item(label).getAttribute('aria-setsize'),
].join('/')

describe('derived aria-setsize / aria-posinset', () => {
  it('numbers a flat tree as one set', () => {
    render(<Tree nodes={[
      { level: 1, label: 'a' }, { level: 1, label: 'b' }, { level: 1, label: 'c' },
    ]} />)
    expect(pos('a')).toBe('1/3')
    expect(pos('c')).toBe('3/3')
  })

  it('counts a child group separately from its parents', () => {
    // The reported defect shape: without this, a reader either gets no count at
    // all or a running total across the whole tree.
    render(<Tree nodes={[
      { level: 1, label: 'Conversations', expanded: true },
      { level: 2, label: 'conv A' },
      { level: 2, label: 'conv B' },
      { level: 1, label: 'Documents', expanded: true },
      { level: 2, label: 'doc A' },
    ]} />)
    expect(pos('Conversations')).toBe('1/2')   // two top-level sections
    expect(pos('Documents')).toBe('2/2')
    expect(pos('conv A')).toBe('1/2')
    expect(pos('doc A')).toBe('1/1')
  })

  /**
   * The load-bearing case. Two sibling groups at the SAME level must each start
   * a fresh set — a naive "group by level" would tell the reader "1 of 3" and
   * "2 of 3" and "3 of 3" across two unrelated parents.
   */
  it('starts a new set for each parent rather than pooling by level', () => {
    render(<Tree nodes={[
      { level: 1, label: 'P1', expanded: true },
      { level: 2, label: 'x1' }, { level: 2, label: 'x2' },
      { level: 1, label: 'P2', expanded: true },
      { level: 2, label: 'y1' },
    ]} />)
    expect(pos('x1')).toBe('1/2')
    expect(pos('x2')).toBe('2/2')
    expect(pos('y1')).toBe('1/1')   // NOT 3/3
  })

  it('handles a level that skips a step', () => {
    // A tree is free to jump 1 → 3; the grouping must not assume a stack that
    // moves one level at a time.
    render(<Tree nodes={[
      { level: 1, label: 'root', expanded: true },
      { level: 3, label: 'deep A' }, { level: 3, label: 'deep B' },
      { level: 1, label: 'root2' },
    ]} />)
    expect(pos('deep A')).toBe('1/2')
    expect(pos('root')).toBe('1/2')
    expect(pos('root2')).toBe('2/2')
  })

  it('renumbers when the visible set changes', () => {
    // Expanding a node, filtering, or a source list loading all change the set.
    // A stale size misinforms exactly like a stale level would.
    const { rerender } = render(<Tree nodes={[
      { level: 1, label: 'a' }, { level: 1, label: 'b' },
    ]} />)
    expect(pos('a')).toBe('1/2')
    rerender(<Tree nodes={[
      { level: 1, label: 'a' }, { level: 1, label: 'b' }, { level: 1, label: 'c' },
    ]} />)
    expect(pos('a')).toBe('1/3')
  })
})

describe('keyboard navigation', () => {
  const flat = [
    { level: 1, label: 'one' }, { level: 1, label: 'two' }, { level: 1, label: 'three' },
  ]

  it('moves with ArrowDown / ArrowUp and jumps with Home / End', () => {
    render(<Tree nodes={flat} />)
    item('one').focus()
    fireEvent.keyDown(item('one'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('two'))
    fireEvent.keyDown(item('two'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('one'))
    fireEvent.keyDown(item('one'), { key: 'End' })
    expect(document.activeElement).toBe(item('three'))
    fireEvent.keyDown(item('three'), { key: 'Home' })
    expect(document.activeElement).toBe(item('one'))
  })

  it('clamps at both ends rather than wrapping', () => {
    render(<Tree nodes={flat} />)
    item('one').focus()
    fireEvent.keyDown(item('one'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('one'))
  })

  /**
   * Enter was handled by NONE of the three trees — Space worked, so activation
   * existed and the gap was invisible to anyone who happened to press Space.
   */
  it('activates on Enter as well as Space', () => {
    const onClick = vi.fn()
    render(
      <div onClick={onClick}>
        <Tree nodes={flat} />
      </div>,
    )
    item('two').focus()
    fireEvent.keyDown(item('two'), { key: 'Enter' })
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(item('two'), { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('expands a collapsed node with ArrowRight and collapses with ArrowLeft', () => {
    const onSetExpanded = vi.fn()
    render(<Tree nodes={[{ level: 1, label: 'sect', expanded: false }]} onSetExpanded={onSetExpanded} />)
    item('sect').focus()
    fireEvent.keyDown(item('sect'), { key: 'ArrowRight' })
    expect(onSetExpanded).toHaveBeenCalledWith(item('sect'), true)

    cleanup()
    const onSetExpanded2 = vi.fn()
    render(<Tree nodes={[{ level: 1, label: 'sect', expanded: true }]} onSetExpanded={onSetExpanded2} />)
    item('sect').focus()
    fireEvent.keyDown(item('sect'), { key: 'ArrowLeft' })
    expect(onSetExpanded2).toHaveBeenCalledWith(item('sect'), false)
  })

  it('steps into an already-expanded node with ArrowRight', () => {
    render(<Tree nodes={[
      { level: 1, label: 'sect', expanded: true }, { level: 2, label: 'child' },
    ]} />)
    item('sect').focus()
    fireEvent.keyDown(item('sect'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(item('child'))
  })

  /**
   * The parent hop is derived from `aria-level`, NOT from DOM nesting: these
   * trees render each group as a SIBLING of its treeitem (owned via aria-owns),
   * so `closest('[role="treeitem"]')` would sail past the parent entirely.
   */
  it('moves to the parent with ArrowLeft on a leaf, across sibling groups', () => {
    render(<Tree nodes={[
      { level: 1, label: 'P1', expanded: true },
      { level: 2, label: 'x1' },
      { level: 1, label: 'P2', expanded: true },
      { level: 2, label: 'y1' },
    ]} />)
    item('y1').focus()
    fireEvent.keyDown(item('y1'), { key: 'ArrowLeft' })
    expect(document.activeElement, 'landed on the wrong parent').toBe(item('P2'))
  })

  it('ignores keys pressed when focus is outside the tree', () => {
    render(<><button>outside</button><Tree nodes={flat} /></>)
    screen.getByText('outside').focus()
    fireEvent.keyDown(item('one'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('outside'))
  })
})

/**
 * #773 — the horizontal half of the tree pattern, as pure arithmetic.
 *
 * `CodebookTreeView` only ever implemented open/close, and since every category
 * there renders EXPANDED that half was unobservable — an NVDA pass reported
 * "right didn't do anything", which read as an inert handler when in fact the
 * TRAVERSAL half was missing. These two functions are that half, shared by the
 * DOM trees and the SVG node graph so the two cannot disagree about what a
 * parent is (the `siblingPositions` argument, one function over).
 *
 * Levels below are `aria-level` values in document order, e.g.
 *   1  Category A
 *   2    Code a1
 *   2    Code a2
 *   1  Category B
 */
describe('#773 — horizontal traversal from levels alone', () => {
  const TREE = [1, 2, 2, 1, 2]   // A, a1, a2, B, b1

  describe('firstChildIndex', () => {
    it('steps into the first child — the next entry, when it is deeper', () => {
      expect(firstChildIndex(TREE, 0)).toBe(1)
      expect(firstChildIndex(TREE, 3)).toBe(4)
    })

    it('a leaf has nowhere to go, with no separate leaf test needed', () => {
      // a1's next entry (a2) is a SIBLING, not a child.
      expect(firstChildIndex(TREE, 1)).toBeNull()
    })

    it('an expanded node with NO children stays put — the DOM hook\'s old bug', () => {
      // The hook used a bare `focus(idx + 1)` whenever aria-expanded was true,
      // so an empty expanded category stepped sideways onto its next sibling.
      const EMPTY_THEN_SIBLING = [1, 1]
      expect(firstChildIndex(EMPTY_THEN_SIBLING, 0)).toBeNull()
    })

    it('the last entry has no next', () => {
      expect(firstChildIndex(TREE, TREE.length - 1)).toBeNull()
    })
  })

  describe('parentIndex', () => {
    it('finds the nearest PRECEDING shallower entry', () => {
      expect(parentIndex(TREE, 1)).toBe(0)
      expect(parentIndex(TREE, 2)).toBe(0)   // skips the sibling between
      expect(parentIndex(TREE, 4)).toBe(3)
    })

    it('a root stays put', () => {
      expect(parentIndex(TREE, 0)).toBeNull()
      expect(parentIndex(TREE, 3)).toBeNull()
    })

    it('handles a skipped level — a tree may jump 1 to 3', () => {
      // `siblingPositions` documents that levels need not step by one, so the
      // parent hop must not assume `level - 1` exists.
      expect(parentIndex([1, 3, 3], 1)).toBe(0)
    })

    it('never walks past a DEEPER intervening entry', () => {
      //  1 A / 2 a1 / 3 a1x / 2 a2  — a2's parent is A, not a1x.
      expect(parentIndex([1, 2, 3, 2], 3)).toBe(0)
    })
  })
})
