/**
 * Reconcile a backend search-section total with a client-side item filter (#507).
 *
 * The backend caps each section's `items` (e.g. 5) but reports the honest
 * `count` of ALL matches (e.g. 10). Recomputing `count` from the filtered
 * items list silently replaces the true total with the cap — the header
 * under-reports and the "Show all N" affordance (gated on count > shown)
 * disappears, making the overflow unreachable.
 *
 * When the local filter kept every fetched item, the backend total is the
 * right display count. Only when the filter actually removed fetched items
 * do we fall back to the kept length — a client-side filter can't know how
 * many uncapped matches it would have kept.
 */
export function displayCountAfterLocalFilter(
  backendCount: number,
  fetchedCount: number,
  keptCount: number,
): number {
  return keptCount === fetchedCount ? backendCount : keptCount
}
