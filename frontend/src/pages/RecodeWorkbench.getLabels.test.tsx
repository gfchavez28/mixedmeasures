/**
 * getLabels — the draft-mapping label source for the Recode Workbench.
 *
 * #579: priority-3 (observed frequency values) must be ordered by VALUE, not by
 * response frequency. `get_value_frequencies` returns count-descending order, so
 * consuming it as a scale order assigned codes 1..N by popularity (the modal
 * answer got code 1). Priorities 1 (existing-def keys) and 2 (scale_labels) carry
 * an authored/scale order and must NOT be re-sorted.
 */
import { describe, it, expect } from 'vitest'
import { getLabels } from './RecodeWorkbench'
import type { DatasetColumn, RecodeDefinition, ValueFrequency } from '@/lib/api'

const freq = (value_text: string, is_na = false): ValueFrequency =>
  ({ value_text, count: 1, is_na }) as unknown as ValueFrequency

const freqData = (vals: ValueFrequency[]) =>
  ({ column_id: 1, frequencies: vals, total: vals.length })

describe('getLabels — #579 priority-3 numeric-aware ordering', () => {
  it('orders bare-numeric frequency values by VALUE, not by count', () => {
    // Arrives count-descending (modal "3" first); must come out 2,3,4,5.
    const fd = freqData([freq('3'), freq('5'), freq('4'), freq('2')])
    expect(getLabels([], undefined, fd)).toEqual(['2', '3', '4', '5'])
  })

  it('sorts multi-digit numeric labels numerically, not lexicographically', () => {
    const fd = freqData([freq('2'), freq('12'), freq('1'), freq('15'), freq('9')])
    expect(getLabels([], undefined, fd)).toEqual(['1', '2', '9', '12', '15'])
  })

  it('drops N/A values before ordering', () => {
    const fd = freqData([freq('3'), freq('N/A', true), freq('1')])
    expect(getLabels([], undefined, fd)).toEqual(['1', '3'])
  })

  it('priority 2 (scale_labels) is returned in scale order, NOT alphabetized', () => {
    const col = { scale_labels: ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent'] } as unknown as DatasetColumn
    // Even though a frequency list is present, scale_labels wins and is untouched.
    const fd = freqData([freq('Good'), freq('Poor')])
    expect(getLabels([], col, fd)).toEqual(['Poor', 'Fair', 'Good', 'Very Good', 'Excellent'])
  })

  it('priority 1 (existing-def keys) is returned in the def order, NOT alphabetized', () => {
    const existing = [
      { mapping: { Never: 1, Sometimes: 2, Always: 3 } },
    ] as unknown as RecodeDefinition[]
    expect(getLabels(existing, undefined, undefined)).toEqual(['Never', 'Sometimes', 'Always'])
  })
})
