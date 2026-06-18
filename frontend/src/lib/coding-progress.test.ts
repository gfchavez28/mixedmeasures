import { describe, it, expect } from 'vitest'
import { isSegmentCoded } from './coding-progress'

// Guard for the #398/J-A regression: the document workbench used to count a
// segment as coded if it had ANY code (universal-only included), disagreeing with
// the backend coded_segment_count (4/14 vs 2/14). isSegmentCoded must exclude
// universal-only segments.
describe('isSegmentCoded', () => {
  it('uncoded: no codes', () => {
    expect(isSegmentCoded([])).toBe(false)
  })
  it('uncoded: only universal codes (the #398 bug case)', () => {
    expect(isSegmentCoded([{ is_universal: true }])).toBe(false)
    expect(isSegmentCoded([{ is_universal: true }, { is_universal: true }])).toBe(false)
  })
  it('coded: at least one non-universal code', () => {
    expect(isSegmentCoded([{ is_universal: false }])).toBe(true)
  })
  it('coded: mix of universal and non-universal counts once', () => {
    expect(isSegmentCoded([{ is_universal: true }, { is_universal: false }])).toBe(true)
  })
})
