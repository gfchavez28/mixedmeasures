import { describe, it, expect } from 'vitest'
import { describeQuoteNotesStayed } from './split-disclosure'

describe('describeQuoteNotesStayed (#712)', () => {
  it('says nothing when no note stayed behind', () => {
    // ⚠️ A real zero must be silent. The disclosure fires on every split, so a
    // message at 0 would nag on the overwhelmingly common case.
    expect(describeQuoteNotesStayed(0)).toBeNull()
    expect(describeQuoteNotesStayed(undefined)).toBeNull()
  })

  it('is singular for one and plural for many, including the pronoun', () => {
    expect(describeQuoteNotesStayed(1)).toBe(
      '1 quote note stayed with the original segment. Undo the split to bring it back.')
    expect(describeQuoteNotesStayed(3)).toBe(
      '3 quote notes stayed with the original segment. Undo the split to bring them back.')
  })

  it('names the recovery, not just the loss', () => {
    // The whole point: the note is NOT gone, and the researcher cannot see that
    // from the screen. A message that only reported the count would read as data
    // loss and invite them to retype the note.
    const msg = describeQuoteNotesStayed(2)!
    expect(msg).toMatch(/Undo the split/)
    expect(msg).not.toMatch(/lost|deleted|removed/i)
  })
})
