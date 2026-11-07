/**
 * #1531 D99 (1.5.9, the developer's amendment) — a drag on the Quote Board keeps the places of
 * the quotes the dragger cannot see.
 *
 * The board's custom order is SHARED (`QuoteBoardConfig.custom_orders`, one per project), and a
 * drag used to save only the dragged section's VISIBLE ids, so a quote hidden at that moment lost
 * its saved slot and came back appended at the end (`applyCustomOrder`) — reshuffling a
 * colleague's arrangement. What hides a quote while dragging is allowed: the page's participant
 * filter, which narrows the read on the server and does not count as a board filter (search and
 * the board's exclusions turn dragging off). Blind mode does NOT hide one — it narrows a quote's
 * codes, never which quotes appear (read at the build, 2026-11-05c: `QuoteBoardView`'s
 * `isDragEnabled` and session A's every-quote-stays rule; the review had assumed it would) — but
 * the merge is what keeps it that way if it ever does.
 *
 * Rule: walk the saved order; a slot holding a visible quote takes the next quote of the new
 * visible order, a slot holding anything else keeps it. Visible quotes the saved order did not
 * hold (quoted since) follow, in the new order — where `applyCustomOrder` already shows them.
 * An empty saved order (the board seeds from source order) saves the visible order, as before.
 *
 * ⚠️ A saved id whose quote was DELETED is kept like a hidden one: the client cannot tell the
 * two apart (it never holds the unfiltered list), and `applyCustomOrder` skips an id it does not
 * find, so the cost is a stale number in the config, never a misplaced card.
 */
export function mergeVisibleOrder(saved: readonly number[], visible: readonly number[]): number[] {
  if (saved.length === 0) return [...visible]
  const visibleIds = new Set(visible)
  const out: number[] = []
  let next = 0
  for (const id of new Set(saved)) {
    if (visibleIds.has(id)) {
      out.push(visible[next++])
    } else {
      out.push(id)
    }
  }
  while (next < visible.length) out.push(visible[next++])
  return out
}
