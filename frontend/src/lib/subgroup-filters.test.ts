/**
 * #1534 D103/D107/D108 (1.5.9) — which subgroup filters count, decided once for the
 * Cross-analysis comparison and its CSV (`subgroup-filters.ts`).
 */
import { describe, it, expect } from 'vitest'
import type { SubgroupFilter } from '@/lib/api'
import {
  isFilterComplete,
  readyFilters,
  hasUnfinishedFilter,
  notComparedSentence,
} from './subgroup-filters'

const inFilter = (values: string[]): SubgroupFilter => ({ column_id: 7, operator: 'in', values })
const gte = (value?: string): SubgroupFilter => ({ column_id: 8, operator: 'gte', value })

describe('isFilterComplete', () => {
  it('a list operator needs a value chosen', () => {
    expect(isFilterComplete(inFilter(['North']))).toBe(true)
    expect(isFilterComplete(inFilter([]))).toBe(false)
    expect(isFilterComplete({ column_id: 7, operator: 'equals', values: ['North'] })).toBe(true)
    expect(isFilterComplete({ column_id: 7, operator: 'equals' })).toBe(false)
  })

  it('a number operator needs a number typed — and "0" IS one (the falsy-zero trap)', () => {
    expect(isFilterComplete(gte('40'))).toBe(true)
    expect(isFilterComplete(gte('0'))).toBe(true)
    expect(isFilterComplete(gte(''))).toBe(false)
    expect(isFilterComplete(gte('  '))).toBe(false)
    expect(isFilterComplete(gte(undefined))).toBe(false)
  })

  it('a mean operator needs nothing more; no column or an unknown operator is not finished', () => {
    expect(isFilterComplete({ column_id: 8, operator: 'above_mean' })).toBe(true)
    expect(isFilterComplete({ column_id: 8, operator: 'below_mean' })).toBe(true)
    expect(isFilterComplete({ column_id: 0, operator: 'above_mean' })).toBe(false)
    expect(isFilterComplete({ column_id: 8, operator: 'contains', values: ['x'] })).toBe(false)
  })
})

describe('readyFilters / hasUnfinishedFilter — the comparison and the file read the same list', () => {
  it('every filter finished → the list itself', () => {
    const list = [inFilter(['North']), gte('40')]
    expect(readyFilters(list)).toBe(list)
    expect(hasUnfinishedFilter(list)).toBe(false)
  })

  it('one unfinished → no list at all (never the finished subset)', () => {
    const list = [inFilter(['North']), gte('')]
    expect(readyFilters(list)).toBeNull()
    expect(hasUnfinishedFilter(list)).toBe(true)
  })

  it('no filters → no comparison, and nothing unfinished', () => {
    expect(readyFilters([])).toBeNull()
    expect(hasUnfinishedFilter([])).toBe(false)
  })
})

describe('notComparedSentence (D107)', () => {
  it('names one dataset, or several, and nothing when all are compared', () => {
    expect(notComparedSentence(['Wave 2'])).toBe(
      'Wave 2 is not in this comparison: none of the filters applies to its records.')
    expect(notComparedSentence(['Wave 2', 'Wave 3'])).toBe(
      'Wave 2; Wave 3 are not in this comparison: none of the filters applies to their records.')
    expect(notComparedSentence([])).toBeNull()
  })
})
