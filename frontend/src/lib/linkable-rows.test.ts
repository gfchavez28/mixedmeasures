// #418 / #1053 — what a record's row says in the participant panel's picker, and
// what the picker says about the list. The SEARCH itself moved to the server
// (`backend/tests/test_linkable_rows_search.py` pins what matches and in what
// order); nothing here filters.
import { describe, expect, it } from 'vitest'

import type { LinkableRow } from './api/participants'
import {
  RECORD_PAGE_SIZE,
  linkableRowDetail,
  linkableRowMatch,
  recordPickerCount,
  showMoreCount,
} from './linkable-rows'

const row = (over: Partial<LinkableRow>): LinkableRow => ({
  row_id: 1,
  row_identifier: 'R0001',
  linked_participant_id: null,
  linked_participant_name: null,
  display_values: [],
  matched: null,
  ...over,
})

describe('linkableRowDetail', () => {
  it('joins the identifying values', () => {
    expect(linkableRowDetail(row({ display_values: ['T05', 'Maple Ridge'] }))).toBe('T05 · Maple Ridge')
    expect(linkableRowDetail(row({}))).toBe('')
  })
})

describe('linkableRowMatch', () => {
  it('names the column the search matched and shows its words', () => {
    const matched = { column_id: 4, column_label: 'Marital status', excerpt: '…never married…' }
    expect(linkableRowMatch(row({ matched }))).toBe('Marital status: …never married…')
  })

  it('says nothing when the label already shows the match', () => {
    expect(linkableRowMatch(row({}))).toBeNull()
  })
})

describe('recordPickerCount — the count line', () => {
  it('tells an empty dataset from a search that matched nothing (#963 Tier 2)', () => {
    expect(recordPickerCount(0, 0, '', 'Census')).toBe('This dataset has no records.')
    expect(recordPickerCount(0, 0, '  zz  ', 'Census')).toBe('No records in Census match “zz”.')
  })

  it('says how many there are when all are shown', () => {
    expect(recordPickerCount(3, 3, '', 'Census')).toBe('3 records.')
    expect(recordPickerCount(1, 1, '', 'Census')).toBe('1 record.')
    expect(recordPickerCount(2, 2, 'ana', 'Census')).toBe('2 records match.')
    expect(recordPickerCount(1, 1, 'ana', 'Census')).toBe('1 record matches.')
  })

  it('says a bounded page is bounded, and what reaches the rest (#844, #1045)', () => {
    expect(recordPickerCount(50, 75699, '', 'GSS'))
      .toBe(`Showing 50 of ${(75699).toLocaleString()} records. Search to find the others.`)
    expect(recordPickerCount(100, 12079, '23', 'GSS'))
      .toBe(`Showing 100 of ${(12079).toLocaleString()} records that match. Keep typing to narrow the list.`)
  })
})

describe('showMoreCount', () => {
  it('is one page, or what is left', () => {
    expect(showMoreCount(50, 1000)).toBe(RECORD_PAGE_SIZE)
    expect(showMoreCount(50, 60)).toBe(10)
    expect(showMoreCount(60, 60)).toBe(0)
  })
})
