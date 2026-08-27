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
import { getLabels, getSeedBasis } from './RecodeWorkbench'
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

describe('getSeedBasis — #823(h), how the codes got their order', () => {
  it('names the alphabet when the observed values are text', () => {
    // The filed case, GSS `fair`: the seed read *Depends = 1, Would take
    // advantage of you = 2, Would try to be fair = 3* — the negative pole above
    // the midpoint, on a 3-point attitude item, with nothing saying why.
    const fd = freqData([
      freq('Would try to be fair'), freq('Depends'), freq('Would take advantage of you'),
    ])
    expect(getSeedBasis([], undefined, fd)).toBe('observed_alphabetical')
    expect(getLabels([], undefined, fd)).toEqual([
      'Depends', 'Would take advantage of you', 'Would try to be fair',
    ])
  })

  it('does NOT warn when every observed value is a number', () => {
    // `compareValueLabels` orders these by VALUE, so 1..5 is the scale's own
    // order and a warning here would be noise on the common case.
    const fd = freqData([freq('3'), freq('5'), freq('1')])
    expect(getSeedBasis([], undefined, fd)).toBe('observed_numeric')
  })

  it('does NOT warn when somebody authored the order', () => {
    const def = { mapping: { Never: 1, Sometimes: 2, Always: 3 } } as unknown as RecodeDefinition
    expect(getSeedBasis([def], undefined, undefined)).toBe('authored_rule')

    const col = { scale_labels: ['Low', 'Mid', 'High'] } as unknown as DatasetColumn
    expect(getSeedBasis([], col, undefined)).toBe('declared_scale')
  })

  it('a single text value still counts as alphabetical', () => {
    // One value cannot be mis-ordered, but the BASIS is still the alphabet —
    // and the next import can add a second. The basis describes the ladder
    // rung, not how bad today's outcome happens to be.
    expect(getSeedBasis([], undefined, freqData([freq('Depends')]))).toBe('observed_alphabetical')
  })

  it('reports none when there is nothing to seed from', () => {
    expect(getSeedBasis([], undefined, undefined)).toBe('none')
    expect(getSeedBasis([], undefined, freqData([]))).toBe('none')
    // N/A values are filtered before the basis is decided, so a column whose
    // only values are missing seeds nothing rather than seeding the sentinels.
    expect(getSeedBasis([], undefined, freqData([freq('N/A', true)]))).toBe('none')
  })

  it('is the SAME ladder as getLabels, not a second one', () => {
    // Both read one implementation; if they ever disagree about which rung
    // fired, the warning would appear over an order it does not describe.
    const col = { scale_labels: ['Low', 'High'] } as unknown as DatasetColumn
    const fd = freqData([freq('Depends'), freq('Always')])
    expect(getSeedBasis([], col, fd)).toBe('declared_scale')
    expect(getLabels([], col, fd)).toEqual(['Low', 'High'])
  })
})
