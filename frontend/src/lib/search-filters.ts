/**
 * The universal-search filter taxonomy (#651).
 *
 * ⚠️ **The CLUSTERS are the source of truth; everything else derives from
 * them.** This direction is deliberate and load-bearing.
 *
 * Until 2026-08-02 `ALL_FILTERS` was the declared list and `SearchPopover`'s two
 * chip rows re-inlined their own literal subsets of it. They drifted:
 * `'observations'` was in the constant — so it was searched **by default** and
 * its results appeared — but in neither rendered row, so there was no checkbox
 * for it. A researcher could uncheck every Source box they could see and
 * observation hits kept coming back: *"1 result across 1 type"*, with no control
 * that could remove them.
 *
 * Deriving `ALL_FILTERS` from the clusters makes that class impossible: a
 * category added to a cluster is automatically searched, defaulted ON, **and
 * rendered**. Never re-inline a subset of these for display — that is the #450
 * hand-listed-set rule, and `search-filters.test.ts` fails closed if a category
 * ever exists in the type but in no cluster.
 */
import type { SearchEntityType } from '@/lib/api'

/** UI filter categories (what the user sees as checkboxes). */
export type FilterCategory =
  | 'conversations' | 'documents' | 'observations' | 'text' | 'canvases'
  | 'codes' | 'notes' | 'memos'

/**
 * Where material lives. Order mirrors the TopRail / Overview convention
 * (Conversations · Datasets · Documents · Observations), so the search chips
 * read in the same order as the rest of the app.
 */
export const SOURCE_FILTERS: FilterCategory[] = [
  'conversations', 'documents', 'observations', 'text', 'canvases',
]

/** What researchers add on top of that material. */
export const ANNOTATION_FILTERS: FilterCategory[] = ['codes', 'notes', 'memos']

export const ALL_FILTERS: FilterCategory[] = [...SOURCE_FILTERS, ...ANNOTATION_FILTERS]

/** Everything on, so a fresh search is a search of the whole project. */
export const DEFAULT_FILTERS: FilterCategory[] = [...ALL_FILTERS]

/**
 * Map UI filter selections → backend `SearchEntityType[]` for the API request.
 *
 * Every category is also a backend type, plus one implication: the three
 * segment-bearing sources additionally request `segments`, because a hit inside
 * a conversation turn, a document paragraph or an observation **clip label** all
 * come back as segment results rather than under their source's own type.
 */
export function filtersToBackendTypes(filters: FilterCategory[]): SearchEntityType[] {
  const types = new Set<SearchEntityType>()
  for (const f of filters) {
    types.add(f as SearchEntityType)
    if (f === 'conversations' || f === 'documents' || f === 'observations') {
      types.add('segments')
    }
  }
  return Array.from(types)
}
