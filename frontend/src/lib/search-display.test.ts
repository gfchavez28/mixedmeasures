import { describe, it, expect } from 'vitest'
import { displayCountAfterLocalFilter } from './search-display'

// #507 regression: the search popover recomputed a section count from the
// backend-CAPPED items list — "Segments (5)" for 10 matches, and the
// "Show all" affordance (gated on count > shown) vanished with the overflow.
describe('displayCountAfterLocalFilter (#507)', () => {
  it('keeps the backend total when the local filter removed nothing', () => {
    // backend: count=10, items capped at 5; both source checkboxes on
    expect(displayCountAfterLocalFilter(10, 5, 5)).toBe(10)
  })

  it('falls back to the kept length when the filter removed fetched items', () => {
    // one source type unchecked filtered 2 of the 5 fetched items
    expect(displayCountAfterLocalFilter(10, 5, 3)).toBe(3)
  })

  it('is the identity when nothing is capped or filtered', () => {
    expect(displayCountAfterLocalFilter(4, 4, 4)).toBe(4)
  })
})
