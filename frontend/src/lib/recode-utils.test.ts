/**
 * #600 — the client half of the reverse-reflection invariant.
 *
 * The grid must display exactly what the backend wrote to `value_numeric`. The
 * offset is computed SERVER-side over the mapping's non-null-set values, because
 * the null set needs the recognized-N/A rule and the column's missing
 * declaration — neither of which this client has. These pin that the wired
 * offset is used and never silently re-derived (the #578 drift class).
 */
import { describe, it, expect } from 'vitest'
import { mappingNumericValues, reverseOffset, reflectReverseValue } from './recode-utils'

// The #600 repro: a real 1..5 scale plus a recognized-N/A label carrying the
// SPSS-convention sentinel. Raw min+max = 100; over the real scale points, 6.
const POISON_MAP = { Never: 1, Always: 5, 'Prefer not to say': 99 }

describe('mappingNumericValues', () => {
  it('collects the numeric subset, skipping non-numeric values per value', () => {
    expect(mappingNumericValues({ a: 1, b: 'Low', c: 3 })).toEqual([1, 3])
  })

  it('is the RAW collection — it does not know the null set', () => {
    // Pins the backend contract: this mirrors services/recode.py's raw
    // collection. Reflection callers must NOT build an offset from it.
    expect(mappingNumericValues(POISON_MAP)).toEqual([1, 5, 99])
  })
})

describe('reverseOffset', () => {
  it('reflects about min + max', () => {
    expect(reverseOffset([1, 2, 3, 4, 5])).toBe(6)
  })

  it('stays in range for a 0-based scale (#28)', () => {
    // (max+1)-v would map 0..3 onto 1..4 and shift every mean.
    expect(reverseOffset([0, 1, 2, 3])).toBe(3)
  })

  it('returns 0 for an empty collection', () => {
    expect(reverseOffset([])).toBe(0)
  })
})

describe('reflectReverseValue', () => {
  it('uses the server offset when provided — the authority (#600)', () => {
    // 6 is what the backend computed over the REAL scale points; the local
    // mapping alone would say 100 and disagree with value_numeric.
    // Offset 6 over the real 1..5 points: "Never"(1) scores 5, "Always"(5) scores 1.
    expect(reflectReverseValue(1, POISON_MAP, 6)).toBe(5)
    expect(reflectReverseValue(5, POISON_MAP, 6)).toBe(1)
  })

  it('never re-derives the offset when the server sent one', () => {
    // The proof the wire wins: a server offset that DISAGREES with the local
    // mapping must still be honored. If this ever equals 100 - 1, the client
    // has started deriving again and the grid will drift from storage.
    expect(reflectReverseValue(1, POISON_MAP, 6)).toBe(5)
    expect(reflectReverseValue(1, POISON_MAP, 6)).not.toBe(reverseOffset([1, 5, 99]) - 1)
  })

  it('honors a server offset of 0 (a mapping of only null-set keys)', () => {
    // Guards the falsy-zero trap: `serverOffset || derive()` would silently
    // fall back here, which is how a 0 becomes a re-derivation.
    expect(reflectReverseValue(3, POISON_MAP, 0)).toBe(-3)
  })

  it('falls back to the raw mapping only when no offset is sent', () => {
    // Payloads that predate / omit the field. Knowingly the RAW min+max — and
    // wrong for a mapping containing a null-set key, which is why the backend
    // sends it on /data.
    expect(reflectReverseValue(1, { Never: 1, Always: 5 })).toBe(5)
    expect(reflectReverseValue(1, POISON_MAP)).toBe(99)
  })

  it('returns the code unchanged when the mapping has no numeric values', () => {
    expect(reflectReverseValue(2, { a: 'Low', b: 'High' })).toBe(2)
  })
})
