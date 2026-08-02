import { describe, it, expect } from 'vitest'
import {
  type FilterCategory,
  SOURCE_FILTERS,
  ANNOTATION_FILTERS,
  ALL_FILTERS,
  DEFAULT_FILTERS,
  filtersToBackendTypes,
} from './search-filters'

/**
 * #651 — `'observations'` lived in `ALL_FILTERS` but in neither rendered chip
 * row, so it was searched by default with no checkbox to exclude or isolate it.
 * Unchecking every visible Source box still returned observation hits.
 *
 * The completeness test below is the fail-closed guard for that class: it is
 * driven from an EXHAUSTIVE literal list of the `FilterCategory` union, so
 * adding a member to the type without putting it in a cluster fails the suite.
 */

// Exhaustive by construction: the `satisfies` makes TypeScript reject this
// literal if it ever omits a union member OR contains one that isn't a
// category, so the runtime check below cannot silently go stale.
const EVERY_CATEGORY = [
  'conversations', 'documents', 'observations', 'text', 'canvases',
  'codes', 'notes', 'memos',
] as const satisfies readonly FilterCategory[]

describe('filter taxonomy completeness (#651)', () => {
  it('renders every category in exactly one cluster', () => {
    for (const category of EVERY_CATEGORY) {
      const inSources = SOURCE_FILTERS.includes(category)
      const inAnnotations = ANNOTATION_FILTERS.includes(category)
      expect(
        inSources !== inAnnotations,
        `"${category}" must appear in exactly one rendered cluster — it is ` +
        `${inSources ? 'in Sources' : 'not in Sources'} and ` +
        `${inAnnotations ? 'in Annotations' : 'not in Annotations'}. ` +
        'A category in neither has no checkbox (#651).',
      ).toBe(true)
    }
  })

  it('observations has a checkbox — the #651 regression itself', () => {
    expect(SOURCE_FILTERS).toContain('observations')
  })

  it('ALL_FILTERS is exactly the two clusters, so nothing can be searched without being rendered', () => {
    expect([...ALL_FILTERS].sort()).toEqual([...EVERY_CATEGORY].sort())
    expect(ALL_FILTERS).toEqual([...SOURCE_FILTERS, ...ANNOTATION_FILTERS])
  })

  it('defaults to everything on', () => {
    expect([...DEFAULT_FILTERS].sort()).toEqual([...ALL_FILTERS].sort())
  })

  it('orders sources like the TopRail and Overview do', () => {
    // Conversations · Datasets(=text) · Documents · Observations is the app-wide
    // order; search keeps conversations/documents/observations adjacent so the
    // three segment-bearing sources read together.
    expect(SOURCE_FILTERS.indexOf('documents')).toBeLessThan(SOURCE_FILTERS.indexOf('observations'))
    expect(SOURCE_FILTERS.indexOf('conversations')).toBeLessThan(SOURCE_FILTERS.indexOf('documents'))
  })
})

describe('filtersToBackendTypes', () => {
  it('requests segments for each of the three segment-bearing sources', () => {
    // A clip LABEL comes back as a segment result, not under the observations
    // type — which is why unchecking observations must drop `segments` too when
    // it is the only segment-bearing source selected.
    expect(filtersToBackendTypes(['observations'])).toEqual(
      expect.arrayContaining(['observations', 'segments']),
    )
    expect(filtersToBackendTypes(['conversations'])).toEqual(
      expect.arrayContaining(['conversations', 'segments']),
    )
    expect(filtersToBackendTypes(['documents'])).toEqual(
      expect.arrayContaining(['documents', 'segments']),
    )
  })

  it('does NOT request segments for annotation-only selections', () => {
    expect(filtersToBackendTypes(['codes', 'notes', 'memos'])).not.toContain('segments')
  })

  it('drops observations from the request when unchecked — the control actually controls', () => {
    const withoutObs = filtersToBackendTypes(
      ALL_FILTERS.filter(f => f !== 'observations'),
    )
    expect(withoutObs).not.toContain('observations')
    // `segments` survives because conversations/documents still want it.
    expect(withoutObs).toContain('segments')
  })

  it('deduplicates the implied segments type across sources', () => {
    const types = filtersToBackendTypes(['conversations', 'documents', 'observations'])
    expect(types.filter(t => t === 'segments')).toHaveLength(1)
  })

  it('returns nothing for an empty selection, so the query stays disabled', () => {
    expect(filtersToBackendTypes([])).toEqual([])
  })
})
