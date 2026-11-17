/**
 * #1341 — place a BLOCK embed at the selection without destroying another one, and leave a
 * text caret right after it.
 *
 * Every Canvas embed (`excerpt-embed`, `chart-embed`, `memo-embed`, `image-embed`,
 * `callout-stat`, `joint-display`) is a block ATOM. Inserting one used to leave it as a
 * `NodeSelection` (Tiptap's `insertContent` places the selection at the insertion's end, and
 * the nearest selectable thing there is the atom itself), so the NEXT insert — or a pasted
 * image, or a typed letter — REPLACED it: two Materials inserts in a row left only the
 * second. The same held for an embed the researcher had clicked (a click node-selects an
 * atom): inserting from the drawer replaced the one they were looking at.
 *
 * So:
 * - **A node selection is never replaced** — the new block goes after the selected node.
 *   (A TEXT range is still replaced, as in any editor: the researcher selected those words.)
 * - **The caret ends in a textblock immediately after the new block** — the one already
 *   there, or an empty paragraph made for it (Tiptap's own `setHorizontalRule` does the same).
 *
 * One function over a ProseMirror `Transaction`, so the chain-based door
 * (`ThemeEditor.insertWithPendingSlash`) and the plugin-based one (`image-embed.ts`'s paste)
 * place blocks identically.
 */
import { NodeSelection, Selection, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'

export function placeBlock(tr: Transaction, node: PMNode): Transaction {
  const sel = tr.selection
  const before = tr.steps.length
  if (sel instanceof NodeSelection) tr.replaceRangeWith(sel.to, sel.to, node)
  else tr.replaceSelectionWith(node)

  // Where the node landed: inside the range the insertion step wrote (a block dropped into
  // the middle of a paragraph splits it, so the step's end is NOT the node's end).
  let at = -1
  const map = tr.mapping.maps[tr.mapping.maps.length - 1]
  if (tr.steps.length > before) {
    map.forEach((_f, _t, newFrom, newTo) => {
      tr.doc.nodesBetween(newFrom, newTo, (n, pos) => {
        if (at < 0 && n === node) at = pos
        return at < 0
      })
    })
  }
  if (at < 0) return tr // nothing was inserted (the schema refused it); leave the selection

  const after = at + node.nodeSize
  const $after = tr.doc.resolve(after)
  if ($after.nodeAfter?.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
  } else {
    const paragraph = tr.doc.type.schema.nodes.paragraph
    if (paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
      tr.insert(after, paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, after + 1))
    } else {
      tr.setSelection(Selection.near($after, 1))
    }
  }
  return tr.scrollIntoView()
}
