/**
 * The constants the shared source-list toolbar and its pages use (#1008).
 *
 * Kept out of `components/SourceListToolbar.tsx` so that file exports only its
 * component — React Fast Refresh cannot hot-reload a module that also exports
 * values, and the lint gate flags it.
 */
import type { SortDirection, SourceSortKey } from './source-list-sort'

/** A secondary tab-row control: neutral, never section-coloured (the accent is the CTA's). */
export const SOURCE_TAB_CLASS =
  'px-3 py-1.5 rounded-md text-sm font-medium text-mm-text-muted hover:text-mm-text transition-colors inline-flex items-center gap-1.5 border border-mm-surface-border hover:border-mm-text-muted'

/** One sort choice, direction included — `components/SourceListToolbar.tsx`'s note says why. */
export interface SortChoice {
  key: SourceSortKey
  dir: SortDirection
  label: string
}

/** The choices every source list offers; a page appends its progress pair. */
export const DATE_AND_NAME_SORTS: SortChoice[] = [
  { key: 'date', dir: 'desc', label: 'Newest first' },
  { key: 'date', dir: 'asc', label: 'Oldest first' },
  { key: 'name', dir: 'asc', label: 'Name A–Z' },
  { key: 'name', dir: 'desc', label: 'Name Z–A' },
]
