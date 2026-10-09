import { describe, expect, it } from 'vitest'
import { mergedToast, type MergedTally } from '@/lib/code-merge-toast'

const base: MergedTally = {
  sourceCount: 1, targetName: 'Positive', skipped: 0, ratingsCarried: 0, ratingConflicts: 0,
  targetHasScale: true, setContradictions: 0, contradictionSet: null,
}

describe('the Codebook page’s merge toast', () => {
  it('is a success line when nothing needs the coder’s attention', () => {
    expect(mergedToast(base)).toEqual({ kind: 'success', message: 'Merged 1 code into "Positive"' })
  })

  it('keeps the existing details (#869 b), in order', () => {
    const t = mergedToast({ ...base, sourceCount: 2, skipped: 3, ratingConflicts: 1, ratingsCarried: 4, targetHasScale: false })
    expect(t.message).toBe(
      'Merged 2 codes into "Positive" (3 duplicates skipped · 1 rating difference flagged for '
      + 'reconciliation · 4 ratings kept but not shown until "Positive" has a rating scale)',
    )
  })

  it('is a WARNING that names the set when the merge left a coder holding two values (#1081 a)', () => {
    const t = mergedToast({ ...base, setContradictions: 2, contradictionSet: 'Stance' })
    expect(t.kind).toBe('warning')
    expect(t.message).toBe('Merged 1 code into "Positive"')
    expect(t.description).toBe(
      'In 2 passages this merge touched, one coder now holds two values of “Stance”. '
      + 'Its agreement figures leave them out until that coder chooses one value.',
    )
  })
})
