/**
 * The Codebook tree's NAVIGABLE node order — extracted pure, #774.
 *
 * ## Why this is not inline in `CodebookTreeView`
 *
 * The same reason `siblingPositions` / `firstChildIndex` / `parentIndex` are
 * pure and exported: their consumer lays itself out from a MEASURED container
 * and draws SVG, so jsdom renders nothing and a mounted test asserts nothing
 * while looking like coverage. The rule that decides reading order is the part
 * that can be wrong, so it is the part that gets tested — including the NESTED
 * case, which no project in the developer's dev.db can currently produce.
 *
 * ## What it fixes
 *
 * `layout.nodes` is the SVG **paint** order, and three separate things indexed
 * it as though it were a reading order. `layoutCategory` places a category's
 * child categories, then its direct codes, and only THEN pushes the category
 * itself — the category's `y` is centred on the extent of the children it just
 * laid out. So the array is POST-order, while the traversal rules this tree
 * shares with the DOM trees (#773) are specified on a PRE-order. Measured on
 * project 1 before this existed:
 *
 *   - ArrowDown walked cat-1's five codes and only then reached cat-1, throwing
 *     the cursor ~340px back UP the screen once per category.
 *   - ArrowLeft ("go to my parent") from `code-8` landed on `cat-1`; `code-8`
 *     belongs to `cat-2`. Wrong for every code, not in an edge case.
 *   - ArrowRight from a category stepped into the NEXT category's codes.
 *
 * It is built from `treeData` rather than by re-sorting `layout.nodes` on
 * geometry because the code nodes carry a random y-jitter: a coordinate sort is
 * one unlucky fixture away from placing a code above its own category.
 */

/** The shape this needs from a category — structural, so tests need no API types. */
export interface NavCategoryNode {
  id: number
  children: NavCategoryNode[]
  codes: { id: number }[]
}

export interface NavTreeData {
  universal_codes: { id: number }[]
  tree: NavCategoryNode[]
  uncategorized_codes: { id: number }[]
}

/**
 * The ids of every navigable node, in the order they READ on screen.
 *
 * `exists` reports whether the layout actually produced that node: the search
 * filter makes `layoutCategory` return early for a category with no matching
 * descendants, so a miss is a skip, not a gap to fill. Nodes the layout emits
 * but does not render as a treeitem — the `uncategorized-label` marker, which
 * has `depth: -1` and which the category renderer returns `null` for — are
 * absent by construction: nothing here ever asks for one.
 */
export function navigableNodeIds(
  treeData: NavTreeData,
  exists: (id: string) => boolean,
): string[] {
  const out: string[] = []
  const take = (id: string) => { if (exists(id)) out.push(id) }

  // The universal band renders above everything else.
  for (const c of treeData.universal_codes) take(`code-${c.id}`)

  // Pre-order, matching what is drawn: the category, then its child categories
  // (which `layoutCategory` places first, pushing `currentY` down), then its own
  // direct codes below them.
  const walk = (cats: NavCategoryNode[]) => {
    for (const cat of cats) {
      take(`cat-${cat.id}`)
      walk(cat.children)
      for (const c of cat.codes) take(`code-${c.id}`)
    }
  }
  walk(treeData.tree)

  // Uncategorized codes trail the categories, under a label that is not itself
  // navigable — which is why they are levelled as ROOTS, not as its children.
  for (const c of treeData.uncategorized_codes) take(`code-${c.id}`)

  return out
}
