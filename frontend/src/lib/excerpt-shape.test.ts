import { describe, it, expect } from 'vitest'
import {
  clipContainsRange,
  isCharExcerpt,
  isQuoteExcerpt,
  isTimeExcerpt,
  isWholeExcerpt,
  excerptRestorePayload,
} from './excerpt-shape'

const whole = { start_offset: null, end_offset: null, start_time: null, end_time: null }
const char = { start_offset: 4, end_offset: 12, start_time: null, end_time: null }
const time = { start_offset: null, end_offset: null, start_time: 10.5, end_time: 14 }

describe('excerpt shape predicates', () => {
  it('classifies each shape exclusively', () => {
    expect([isWholeExcerpt(whole), isCharExcerpt(whole), isTimeExcerpt(whole)]).toEqual([true, false, false])
    expect([isWholeExcerpt(char), isCharExcerpt(char), isTimeExcerpt(char)]).toEqual([false, true, false])
    expect([isWholeExcerpt(time), isCharExcerpt(time), isTimeExcerpt(time)]).toEqual([false, false, true])
  })

  // The whole point of the module: before it, `start_offset === null` meant
  // "whole quote", and a time excerpt satisfies that too. If isWholeExcerpt
  // ever returns true here, the workbench's unquote deletes a sub-clip quote.
  it('does NOT read a time-range excerpt as the whole-segment quote', () => {
    expect(isWholeExcerpt(time)).toBe(false)
  })

  it('treats a quote at timeline zero as a real time range (falsy-zero trap)', () => {
    const atZero = { start_offset: null, end_offset: null, start_time: 0, end_time: 0 }
    expect(isTimeExcerpt(atZero)).toBe(true)
    expect(isWholeExcerpt(atZero)).toBe(false)
    expect(isQuoteExcerpt(atZero)).toBe(true)
  })

  it('reads a payload with no time fields at all as the whole shape', () => {
    // A response shaped before the time columns existed must not fall through
    // every branch and read as "no shape".
    const legacy = { start_offset: null, end_offset: null } as Parameters<typeof isWholeExcerpt>[0]
    expect(isWholeExcerpt(legacy)).toBe(true)
    expect(isTimeExcerpt(legacy)).toBe(false)
  })

  describe('isQuoteExcerpt — the shape-AGNOSTIC display predicate', () => {
    it('counts whole and time shapes, mirroring segment_has_any_quote_filter', () => {
      expect(isQuoteExcerpt(whole)).toBe(true)
      expect(isQuoteExcerpt(time)).toBe(true)
    })

    it('deliberately excludes the char shape', () => {
      // A char-range excerpt is a sub-quote of a text segment and has never
      // driven "this segment is quoted" — the backend predicate agrees.
      expect(isQuoteExcerpt(char)).toBe(false)
    })
  })
})

describe('clipContainsRange', () => {
  const clip = { start_time: 10, end_time: 20 }

  it('accepts a range inside the clip and rejects one that escapes either end', () => {
    expect(clipContainsRange(clip, { start: 12, end: 18 })).toBe(true)
    expect(clipContainsRange(clip, { start: 9.9, end: 18 })).toBe(false)
    expect(clipContainsRange(clip, { start: 12, end: 20.1 })).toBe(false)
  })

  it('is CLOSED at both ends — the clip contains its own boundaries', () => {
    // Mirrors the backend's containment arm, which is what accepts or 400s the
    // create. Deliberately NOT the half-open rule findClipsAtTime uses for
    // "which clip is playing": a point quote at exactly end_time is CONTAINED
    // by the clip without being AT it.
    expect(clipContainsRange(clip, { start: 10, end: 20 })).toBe(true)
    expect(clipContainsRange(clip, { start: 20, end: 20 })).toBe(true)
    expect(clipContainsRange(clip, { start: 10, end: 10 })).toBe(true)
  })

  it('contains a point event clip only at its single instant', () => {
    const point = { start_time: 30, end_time: 30 }
    expect(clipContainsRange(point, { start: 30, end: 30 })).toBe(true)
    expect(clipContainsRange(point, { start: 30, end: 30.1 })).toBe(false)
  })
})

describe('excerptRestorePayload — undo re-creates the SHAPE, not just the target', () => {
  const ids = { segment_id: 11, dataset_value_id: null }

  it('restores a time range, the arm whose absence silently flattened sub-clip quotes', () => {
    expect(excerptRestorePayload({ ...time, ...ids })).toEqual({
      segment_id: 11, start_time: 10.5, end_time: 14,
    })
  })

  it('restores char offsets without consulting the char-only is_sub_segment flag', () => {
    expect(excerptRestorePayload({ ...char, ...ids })).toEqual({
      segment_id: 11, start_offset: 4, end_offset: 12,
    })
  })

  it('restores a whole quote as target-only', () => {
    expect(excerptRestorePayload({ ...whole, ...ids })).toEqual({ segment_id: 11 })
  })

  it('restores a comment excerpt by its dataset value', () => {
    expect(excerptRestorePayload({ ...whole, segment_id: null, dataset_value_id: 77 }))
      .toEqual({ dataset_value_id: 77 })
  })

  it('keeps a quote anchored at timeline zero as a time range', () => {
    // The falsy-zero trap again: `if (e.start_time)` would drop these fields
    // and flatten the quote to a whole-clip one.
    expect(excerptRestorePayload({
      start_offset: null, end_offset: null, start_time: 0, end_time: 0, ...ids,
    })).toEqual({ segment_id: 11, start_time: 0, end_time: 0 })
  })
})
