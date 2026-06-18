// #418: label + search helpers for the participant↔dataset-row link picker.
// The backend's linkable-rows payload carries `display_values` (up to 3
// identifying text-ish values) and `search_text` (every value_text, lowered);
// these helpers are the single place the picker derives what to show and what
// a query matches — previously both used demographic-typed values only, which
// made rows anonymous and unfindable on datasets without demographic columns.
import type { LinkableRow } from './api/participants'

/** Secondary label text shown after the row identifier. */
export function linkableRowDetail(row: LinkableRow): string {
  if (row.display_values?.length) return row.display_values.join(' · ')
  // Fallback for any stale cache shape: the old demographic-values join.
  return (row.demographic_values ?? [])
    .filter(d => d.value)
    .map(d => d.value)
    .join(' · ')
}

/** Query match across the row identifier and every value in the row. */
export function filterLinkableRows(rows: LinkableRow[], query: string): LinkableRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(r =>
    (r.row_identifier?.toLowerCase().includes(q)) ||
    (r.search_text?.includes(q)) ||
    // Stale-cache fallback, mirrors linkableRowDetail
    (r.demographic_values ?? []).some(d => d.value?.toLowerCase().includes(q)),
  )
}
