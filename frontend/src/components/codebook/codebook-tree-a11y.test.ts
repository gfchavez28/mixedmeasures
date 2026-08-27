import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #701(a) — the Codebook tree's focus model.
 *
 * ⚠️ A SOURCE scan, deliberately. `CodebookTreeView` lays itself out from a
 * MEASURED container and draws its nodes as SVG; jsdom reports every element as
 * 0×0, so a mounted test renders no nodes and would assert nothing while looking
 * like coverage. The behaviour was verified in a real browser instead — after the
 * fix, Tab reaches the container, ArrowDown sets
 * `aria-activedescendant="codebook-node-code-2"`, that id resolves to a
 * `role="treeitem"` named "Unclear (universal): 1 segments, 1 sources", and focus
 * stays on the container. This scan pins the TECHNIQUE that produced it, the same
 * split as the #750 ordering guard.
 *
 * What it protects: the tree was keyboard-unreachable by construction. Roving
 * tabindex was half-built — `tabIndex={isFocused ? 0 : -1}` on every node, but
 * `focusedIdx` starts at -1 and only the keydown handler advances it, and that
 * handler sits on a container that could not take focus. Nothing focusable → no
 * keydown → nothing ever focusable. Removing any one of the three pieces below
 * restores that deadlock.
 */
const SRC = readFileSync(
  join(__dirname, 'CodebookTreeView.tsx'),
  'utf8',
)

describe('#701(a) — the Codebook tree can be entered from the keyboard', () => {
  it('the tree container is focusable', () => {
    expect(
      SRC,
      'without tabIndex on the container nothing in the tree can take focus, so ' +
      'handleKeyDown (which is bound here) never fires',
    ).toMatch(/role="tree"[\s\S]{0,1400}?tabIndex=\{0\}/)
  })

  it('it exposes an active descendant rather than moving focus into the SVG', () => {
    expect(SRC).toMatch(/aria-activedescendant=\{cursorNodeId \? nodeDomId\(cursorNodeId\)/)
  })

  it('entering the tree seeds a resting position', () => {
    // The bug was the ABSENCE of this: focusedIdx sat at -1 forever.
    // Asserted as the exact expression rather than a span between `onFocus={`
    // and the call: the file has three onFocus handlers and a span regex picks
    // whichever comes first, which is a tooltip handler.
    expect(
      SRC,
      'entering the tree must put the cursor on the first node when there is none',
    ).toContain('if (focusedIdx < 0 && nodeOrder.length > 0) setFocusedId(nodeOrder[0])')
  })

  it('every treeitem states its depth', () => {
    const emitted = SRC.match(/aria-level=\{n\.level\}/g) ?? []
    expect(emitted.length, 'one per render branch').toBe(5)
  })

  /**
   * The three level rules, pinned because they are NOT interchangeable and the
   * live fixture cannot tell them apart. Verified in a browser against dev.db:
   * 38 items, 0 without a level, 8 at level 1 (6 root categories + 2 universal
   * codes) and 30 at level 2 (their codes).
   *
   * ⚠️ **dev.db has no NESTED categories, so depth ≥ 1 was not exercised live.**
   * At depth 0, `depth + 1` and a hypothetical `depth` differ (1 vs 0) so the
   * 1-based-ness is proven — but whether the recursion increments correctly is
   * not. That is exactly the degenerate-fixture trap, so the formulas are held
   * here instead of trusted.
   */
  it('the level rules are the three distinct ones the node types need', () => {
    expect(SRC, 'a category: depth is 0-based, aria-level is 1-based').toContain('level: depth + 1')
    expect(SRC, "a category's codes sit one level deeper").toContain('level: depth + 2')
    expect(SRC, 'universal codes and the synthetic Uncategorized label are roots')
      .toMatch(/level: 1,\s+\/\/ #701\(a\): top band/)
    // ⚠️ CHANGED by #774: this used to assert `level: 2` — "child of the
    // synthetic 'Uncategorized' root". That marker has `depth: -1`, and the
    // category renderer returns `null` for it, so it is not a treeitem and no
    // key can reach it. The level was promising a parent that does not exist,
    // and ArrowLeft from an uncategorized code walked back to the LAST CATEGORY.
    expect(SRC, 'uncategorized codes are ROOTS — their visual grouping has no navigable node')
      .toMatch(/A ROOT, because the 'Uncategorized' marker below is not navigable[\s\S]{0,1200}?level: 1,/)
  })

  /**
   * #774 — the cursor indexes the NAVIGABLE order, never `layout.nodes`.
   *
   * `layout.nodes` is the SVG paint order: `layoutCategory` emits a category
   * AFTER the children whose extent decides its `y`, so the array is post-order
   * while the traversal rules it feeds (`firstChildIndex` / `parentIndex`) are
   * specified on a pre-order. Measured before the fix: ArrowLeft from `code-8`
   * landed on `cat-1` though `code-8` belongs to `cat-2` — wrong for every code
   * — and ArrowDown threw the cursor back up the screen once per category.
   * Reverting any of these three lines to `layout.nodes` restores all of it.
   */
  it('the keyboard order is derived, not the raw layout array', () => {
    expect(SRC, 'the order comes from the shared pre-order derivation')
      .toContain('navigableNodeIds(treeData, id => byId.has(id))')
    // ⚠️ A WINDOW, not a line: `nodeAria` spans several lines, and the
    // line-based form of this check passed on two of the three while being
    // structurally unable to read the third.
    for (const derived of ['const nodeOrder', 'const nodeLevels', 'const nodeAria']) {
      const at = SRC.indexOf(derived)
      expect(at, `${derived} must exist`).toBeGreaterThan(-1)
      const body = SRC.slice(at, SRC.indexOf('\n\n', at))
      expect(body, `${derived} must read navNodes, not layout.nodes`).toContain('navNodes')
      expect(body, `${derived} must not index the paint order`).not.toContain('layout.nodes')
    }
  })

  it('every treeitem carries the id the active descendant points at', () => {
    const treeitems = SRC.match(/role="treeitem"/g) ?? []
    const ids = SRC.match(/id=\{nodeDomId\(n\.id\)\}/g) ?? []
    // NON-EMPTY expectation (#730): a scan that found nothing would otherwise
    // pass. Two of the `role="treeitem"` hits are `closest()` calls in pointer
    // handlers, not render sites — hence the explicit count rather than equality.
    expect(treeitems.length).toBeGreaterThan(0)
    expect(
      ids.length,
      'each of the five mutually-exclusive render branches needs an id, or ' +
      'aria-activedescendant dangles for whichever branch is missing one',
    ).toBe(5)
  })
})
