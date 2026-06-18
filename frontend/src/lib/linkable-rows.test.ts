// #418 regression: the link picker must label rows with identifying values
// and search across every value in the row — previously both used
// demographic-typed values only ("S001"/"T05"/"Maple" found nothing).
import { describe, expect, it } from 'vitest'

import type { LinkableRow } from './api/participants'
import { filterLinkableRows, linkableRowDetail } from './linkable-rows'

const row = (over: Partial<LinkableRow>): LinkableRow => ({
  row_id: 1,
  row_identifier: 'R0001',
  linked_participant_name: null,
  demographic_values: [],
  display_values: [],
  search_text: '',
  ...over,
})

describe('linkableRowDetail', () => {
  it('joins display_values', () => {
    expect(linkableRowDetail(row({ display_values: ['T05', 'Maple Ridge'] }))).toBe(
      'T05 · Maple Ridge',
    )
  })

  it('falls back to demographic values for a stale cache shape', () => {
    const r = row({
      display_values: undefined as unknown as string[],
      demographic_values: [{ label: 'Gender', value: 'Female' }, { label: 'Age', value: null }],
    })
    expect(linkableRowDetail(r)).toBe('Female')
  })
})

describe('filterLinkableRows', () => {
  const rows = [
    row({ row_id: 1, search_text: 's001 maple ridge 63 72 t01' }),
    row({ row_id: 2, row_identifier: 'R0002', search_text: 's002 brookside 70 81 t05' }),
  ]

  it('matches any value in the row (student id, school, teacher id, score)', () => {
    expect(filterLinkableRows(rows, 'S001').map(r => r.row_id)).toEqual([1])
    expect(filterLinkableRows(rows, 'brookside').map(r => r.row_id)).toEqual([2])
    expect(filterLinkableRows(rows, 'T05').map(r => r.row_id)).toEqual([2])
    expect(filterLinkableRows(rows, '63').map(r => r.row_id)).toEqual([1])
  })

  it('still matches the row identifier', () => {
    expect(filterLinkableRows(rows, 'R0002').map(r => r.row_id)).toEqual([2])
  })

  it('empty query returns all rows', () => {
    expect(filterLinkableRows(rows, '  ')).toHaveLength(2)
  })

  it('no match returns empty', () => {
    expect(filterLinkableRows(rows, 'zzz')).toHaveLength(0)
  })
})
