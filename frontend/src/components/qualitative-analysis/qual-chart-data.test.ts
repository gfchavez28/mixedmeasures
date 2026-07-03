import { describe, it, expect } from 'vitest'
import { resolveRenderedBarEntry } from './qual-chart-data'

// #504 regression: recharts compacts zero-dimension rects out of its rendered
// list, so label/click callbacks receive RENDERED indexes. The corpus repro:
// 6 codes with counts [0, 3, 5, 6, 1, 2] — the zero-count first entry shifted
// every painted label one row (Access showed Unclear's 3, etc.).
const entries = [
  { label: 'Unsubstantive', value: 0, count: 0, _codeId: 6 },
  { label: 'Unclear', value: 3, count: 3, _codeId: 1 },
  { label: 'Access barriers', value: 5, count: 5, _codeId: 2 },
  { label: 'Staff support', value: 6, count: 6, _codeId: 3 },
  { label: 'Cost concerns', value: 1, count: 1, _codeId: 4 },
  { label: 'Wait times', value: 2, count: 2, _codeId: 5 },
]

describe('resolveRenderedBarEntry (#504)', () => {
  it('maps rendered indexes past a leading zero-count entry to their own data rows', () => {
    // recharts renders 5 rects (values 3,5,6,1,2) with indexes 0..4
    const renderedValues = [3, 5, 6, 1, 2]
    const resolved = renderedValues.map((v, i) => resolveRenderedBarEntry(entries, i, v))
    expect(resolved.map(e => e?.count)).toEqual([3, 5, 6, 1, 2])
    expect(resolved.map(e => e?.label)).toEqual([
      'Unclear', 'Access barriers', 'Staff support', 'Cost concerns', 'Wait times',
    ])
  })

  it('handles an interior zero-count entry', () => {
    const withInteriorZero = [
      { label: 'A', value: 4, count: 4 },
      { label: 'B', value: 0, count: 0 },
      { label: 'C', value: 7, count: 7 },
    ]
    expect(resolveRenderedBarEntry(withInteriorZero, 0, 4)?.label).toBe('A')
    expect(resolveRenderedBarEntry(withInteriorZero, 1, 7)?.label).toBe('C')
  })

  it('falls back to data-order indexing if recharts stops compacting zero rects', () => {
    // A future recharts passing data indexes: index 2 with value 7 should
    // still resolve to C (rendered[2] is undefined; entries[2] matches).
    const withLeadingZero = [
      { label: 'Z', value: 0, count: 0 },
      { label: 'A', value: 4, count: 4 },
      { label: 'C', value: 7, count: 7 },
    ]
    expect(resolveRenderedBarEntry(withLeadingZero, 2, 7)?.label).toBe('C')
    // ...and a data-index pointing at the zero entry draws no label
    expect(resolveRenderedBarEntry(withLeadingZero, 0, 0)).toBeNull()
  })

  it('returns null when neither mapping agrees with the callback value', () => {
    expect(resolveRenderedBarEntry(entries, 0, 999)).toBeNull()
    expect(resolveRenderedBarEntry(entries, 42, 3)).toBeNull()
  })

  it('is identity-stable when no zero-count entries exist', () => {
    const noZeros = entries.slice(1)
    noZeros.forEach((e, i) => {
      expect(resolveRenderedBarEntry(noZeros, i, e.value)).toBe(e)
    })
  })
})
