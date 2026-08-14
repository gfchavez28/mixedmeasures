import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

/**
 * The ONE keyboard + structure layer for the app's DOM `role="tree"` widgets — #701(a).
 *
 * ## Why this exists
 *
 * Three trees (`SourceSelector`, `CodePicker`, `CodebookHidePanel`) each carried
 * a private, near-identical `handleKeyDown`: the same `querySelectorAll`, the
 * same `document.activeElement` lookup, the same ArrowUp/Down/Home/End/Space
 * switch. They had already drifted — only `CodePicker` implemented
 * ArrowRight/ArrowLeft, and **none** implemented Enter, so the one key a user is
 * most likely to press on a highlighted row did nothing in all three.
 *
 * That is the enumeration-debt shape the arch-debt synthesis names: N copies of
 * one job, remedied by a single chokepoint. A fourth tree written tomorrow
 * inherits the whole pattern instead of two thirds of it.
 *
 * ⚠️ **Deliberately NOT used by `CodebookTreeView`.** That tree is a spatial SVG
 * node graph, not a DOM list: its nodes are `<g>` elements positioned by a
 * measured layout, and it uses `aria-activedescendant` on a focusable container
 * rather than moving focus into SVG. Forcing it through this hook would impose
 * the wrong shape on it — a conclusion the #701 entry reached and this comment
 * exists to keep.
 *
 * ## What the hook owns
 *
 * **Navigation** (APG tree pattern): ArrowUp/Down between visible items,
 * Home/End to the ends, ArrowRight/ArrowLeft to expand/collapse or move by
 * level, Enter and Space to activate.
 *
 * **Position metadata**: `aria-level` is authored by each tree (only it knows
 * its own nesting), but `aria-setsize` / `aria-posinset` are DERIVED here from
 * the rendered DOM. See `useTreeAriaPositions`.
 */

/** Every visible treeitem inside the container, in document order. */
function treeItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
}

function levelOf(el: HTMLElement): number {
  return Number(el.getAttribute('aria-level') ?? '1')
}

export interface TreeKeyboardNavOptions {
  /** The element carrying `role="tree"`. */
  treeRef: RefObject<HTMLElement | null>
  /**
   * Expand or collapse the focused node. Omit for a tree with no collapsible
   * nodes — ArrowRight/ArrowLeft then only move by level, which is the correct
   * degenerate behaviour rather than a no-op.
   *
   * The item is passed rather than an id because each tree keys its expansion
   * state differently (a category id, a section name); the consumer reads
   * whatever `data-` attribute it already renders.
   */
  onSetExpanded?: (item: HTMLElement, expanded: boolean) => void
}

export function useTreeKeyboardNav({ treeRef, onSetExpanded }: TreeKeyboardNavOptions) {
  return useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const items = treeItems(treeRef.current)
    if (items.length === 0) return

    const focused = document.activeElement as HTMLElement | null
    if (!focused) return
    const idx = items.indexOf(focused)
    if (idx === -1) return

    const focus = (i: number) => items[Math.max(0, Math.min(i, items.length - 1))]?.focus()
    const expanded = focused.getAttribute('aria-expanded')

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focus(idx + 1); break
      case 'ArrowUp':   e.preventDefault(); focus(idx - 1); break
      case 'Home':      e.preventDefault(); focus(0); break
      case 'End':       e.preventDefault(); focus(items.length - 1); break

      case 'ArrowRight':
        e.preventDefault()
        // Collapsed → open it. Already open → step into the first child, which
        // in document order is simply the next item.
        if (expanded === 'false') onSetExpanded?.(focused, true)
        else if (expanded === 'true') focus(idx + 1)
        break

      case 'ArrowLeft': {
        e.preventDefault()
        if (expanded === 'true') { onSetExpanded?.(focused, false); break }
        // Otherwise move to the parent: the nearest PRECEDING item at a shallower
        // level. Derived from `aria-level` rather than DOM nesting on purpose —
        // these trees render each group as a SIBLING of its treeitem (owned via
        // `aria-owns`), so `closest('[role="treeitem"]')` would walk past the
        // parent entirely and land on whatever wraps the section.
        const level = levelOf(focused)
        for (let i = idx - 1; i >= 0; i--) {
          if (levelOf(items[i]) < level) { items[i].focus(); break }
        }
        break
      }

      // Enter was handled by NONE of the three trees. Space was handled by all
      // three, so activation existed — but a researcher pressing Enter on a
      // highlighted row got silence, which reads as a broken control rather
      // than as an unsupported key.
      case 'Enter':
      case ' ':
        e.preventDefault()
        focused.click()
        break
    }
  }, [treeRef, onSetExpanded])
}

/**
 * Stamp `aria-setsize` / `aria-posinset` onto every treeitem, derived from the
 * rendered DOM — #701(a).
 *
 * ## Why derived rather than authored
 *
 * A tree's set size is "how many siblings share my level, in my group". These
 * trees build their levels from hand-written JSX with conditional sections
 * (`conversations.length > 0 && …`), so authoring the numbers inline means
 * maintaining a counter across branches that appear and disappear — the exact
 * two-halves-of-one-fact shape that drifts. Deriving them from `aria-level` and
 * document order means the numbers cannot disagree with the tree the user is
 * actually looking at, and a section added later is counted without anyone
 * remembering this file exists.
 *
 * ⚠️ Runs after EVERY render, deliberately with no dependency array: expanding a
 * node, typing in the filter box, or loading sources all change the visible set,
 * and a stale set size misinforms exactly like a stale level would. These trees
 * hold tens of nodes, so the walk is cheap; a virtualised list would need the
 * `lib/listbox-aria.ts` treatment instead, because its DOM holds only a window.
 *
 * ⚠️ A new sibling group STARTS a new set. Positions reset when the level
 * decreases (leaving a group), which is what makes two sibling categories each
 * announce "1 of 3" for their own children rather than a running total.
 */
/**
 * Sibling positions for a tree, from its levels alone — #701(a).
 *
 * Given the levels of the items in document order, returns each item's
 * `aria-posinset` / `aria-setsize`. A SET is a maximal run of items at one level
 * under one parent: descending into a child group starts a fresh set, and
 * returning to a level under a DIFFERENT parent starts another. Levels may skip
 * (a tree is free to jump 1 → 3), so this tracks the open set per level rather
 * than assuming one step at a time.
 *
 * Pure and exported because it has TWO consumers that share nothing else: the
 * DOM trees (via `useTreeAriaPositions`) and `CodebookTreeView`, which is an SVG
 * node graph laid out by measurement. Two copies of "what counts as a sibling"
 * is precisely the drift this issue is about.
 */
export function siblingPositions(levels: number[]): { posinset: number; setsize: number }[] {
  const openByLevel = new Map<number, number[]>()   // level -> indices in that open set
  const sets: number[][] = []
  let prevLevel = 0

  levels.forEach((level, i) => {
    if (level < prevLevel) {
      // Left one or more groups: every deeper set is finished for good.
      for (const l of [...openByLevel.keys()]) if (l > level) openByLevel.delete(l)
    } else if (level > prevLevel) {
      // Entering a child group: this level's previous set belonged to a
      // different parent and must not be continued.
      openByLevel.delete(level)
    }
    let set = openByLevel.get(level)
    if (!set) { set = []; openByLevel.set(level, set); sets.push(set) }
    set.push(i)
    prevLevel = level
  })

  const out: { posinset: number; setsize: number }[] = new Array(levels.length)
  for (const set of sets) {
    set.forEach((itemIndex, i) => {
      out[itemIndex] = { posinset: i + 1, setsize: set.length }
    })
  }
  return out
}

export function useTreeAriaPositions(treeRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const items = treeItems(treeRef.current)
    if (items.length === 0) return
    const positions = siblingPositions(items.map(levelOf))
    items.forEach((item, i) => {
      item.setAttribute('aria-posinset', String(positions[i].posinset))
      item.setAttribute('aria-setsize', String(positions[i].setsize))
    })
  })
}
