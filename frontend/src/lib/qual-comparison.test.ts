/**
 * #1421 — the qualitative comparison's empty group, at the two pure readers.
 *
 * `comparisonBarRows` is where the bar chart's `?? 0` lived: the compiler cannot see
 * it, so this test is its only guard. Each case carries a REAL zero beside the empty
 * group — a group WITH segments that never used the code — which must stay 0.
 */
import { describe, it, expect } from 'vitest'
import { comparisonBarRows, undefinedComparisonGroups } from './qual-comparison'
import type { DemographicComparisonResponse } from '@/lib/api'

const data: DemographicComparisonResponse = {
  groups: ['Interviewed', 'Phone', 'Survey only'],
  group_totals: {
    Interviewed: { total_segments: 4, total_word_count: 4 },
    Phone: { total_segments: 2, total_word_count: 2 },
    'Survey only': { total_segments: 0, total_word_count: 0 },
  },
  codes: [{
    code_id: 1, code_name: 'Cost', category_name: null,
    by_group: {
      Interviewed: { count: 1, proportion: 0.25, undefined_reason: null },
      Phone: { count: 0, proportion: 0, undefined_reason: null },
      'Survey only': { count: 0, proportion: null, undefined_reason: 'no_segments' },
    },
    delta_proportion: null, test: null,
  }],
}

describe('comparisonBarRows (#1421)', () => {
  it('carries no share for the empty group and a real 0 for the group that never used the code', () => {
    const [row] = comparisonBarRows(data.codes, data.groups)
    expect(row['_prop_Survey only']).toBeNull()       // HEAD: 0
    expect(row._prop_Phone).toBe(0)                    // control: a measured zero
    expect(row._prop_Interviewed).toBe(0.25)
    expect(row['Survey only']).toBe(0)                 // the bar is the COUNT, a real 0
  })
})

describe('undefinedComparisonGroups (#1421)', () => {
  it('names exactly the groups the server sent no share for, with its reason', () => {
    expect(undefinedComparisonGroups(data)).toEqual([{ group: 'Survey only', reason: 'no_segments' }])
  })

  it('names none when every group has a share', () => {
    const full = { ...data, groups: ['Interviewed', 'Phone'] }
    expect(undefinedComparisonGroups(full)).toEqual([])
  })
})
