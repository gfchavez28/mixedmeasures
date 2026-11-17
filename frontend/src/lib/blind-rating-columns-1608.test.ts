/** #1608 — the line a blind coder reads where the participant table's rating columns were left out. */
import { describe, it, expect } from 'vitest'
import { withheldRatingColumnsNotice } from '@/lib/blind-rating-columns'

describe('withheldRatingColumnsNotice (#1608)', () => {
  it('says nothing when nothing was withheld (a real 0, and an absent field)', () => {
    expect(withheldRatingColumnsNotice(0)).toBeNull()
  })
  it('counts what it hid and says why, singular and plural', () => {
    expect(withheldRatingColumnsNotice(1)).toBe(
      "1 rating column is hidden while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
    expect(withheldRatingColumnsNotice(2)).toMatch(/^2 rating columns are hidden while blind\. /)
  })
})
