import { describe, it, expect } from 'vitest'
import { buildCategoryOptions } from './category-options'

describe('buildCategoryOptions (#462)', () => {
  it('orders roots by display_order, each followed by its children with depth', () => {
    const cats = [
      { id: 2, name: 'Beta', color: '#0f0', parent_id: null, display_order: 1 },
      { id: 1, name: 'Alpha', color: '#f00', parent_id: null, display_order: 0 },
      { id: 3, name: 'Alpha child', color: '#00f', parent_id: 1, display_order: 0 },
    ]
    const opts = buildCategoryOptions(cats)
    expect(opts.map(o => o.label)).toEqual(['Alpha', 'Alpha child', 'Beta'])
    expect(opts.map(o => o.depth)).toEqual([0, 1, 0])
    expect(opts[0]).toMatchObject({ value: 1, color: '#f00' })
  })

  it('returns an empty list for no categories', () => {
    expect(buildCategoryOptions([])).toEqual([])
  })

  it('treats missing color as null (still renders a dot)', () => {
    const opts = buildCategoryOptions([{ id: 5, name: 'No color', parent_id: null }])
    expect(opts[0].color).toBeNull()
  })
})
