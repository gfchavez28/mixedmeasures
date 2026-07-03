import { describe, it, expect } from 'vitest'
import {
  isSegmentCoded,
  isSegmentCodedVisible,
  computeCoverage,
  visibleCodeChipRows,
  distinctVisibleCodeIds,
  isCodeAppliedByActiveCoder,
} from './coding-progress'

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

// Track J · J1 item 3c — coder-aware coverage. A per-application detail carries the
// applying coder (null = legacy/unattributed). The visibility filter is a screen
// lens: your own + unattributed codes are never hidden.
const d = (user_id: number | null, is_universal = false) => ({ user_id, is_universal })

describe('isSegmentCodedVisible', () => {
  it('no filter: any non-universal code counts', () => {
    expect(isSegmentCodedVisible([d(2)])).toBe(true)
    expect(isSegmentCodedVisible([d(2, true)])).toBe(false)
    expect(isSegmentCodedVisible([])).toBe(false)
  })
  it('coded only by a hidden coder reads as uncoded-for-me', () => {
    expect(isSegmentCodedVisible([d(2)], new Set([2]))).toBe(false)
  })
  it('your own (unattributed/null) codes are never hidden', () => {
    expect(isSegmentCodedVisible([d(null)], new Set([2]))).toBe(true)
  })
  it('coded by both a hidden and a visible coder still counts', () => {
    expect(isSegmentCodedVisible([d(2), d(3)], new Set([2]))).toBe(true)
  })
  it('universal-only by a visible coder does not count', () => {
    expect(isSegmentCodedVisible([d(3, true)], new Set([2]))).toBe(false)
  })
})

describe('computeCoverage', () => {
  const items = [
    { codes: [d(2)] },              // coded by 2
    { codes: [d(3)] },              // coded by 3
    { codes: [d(2), d(3)] },        // coded by both
    { codes: [d(2, true)] },        // universal-only → uncoded
    { codes: [] },                  // uncoded
  ]
  const get = (i: { codes: ReturnType<typeof d>[] }) => i.codes

  it('codedAny is filter-independent', () => {
    expect(computeCoverage(items, get).codedAny).toBe(3)
    expect(computeCoverage(items, get, new Set([3])).codedAny).toBe(3)
  })
  it('codedVisible drops segments coded only by a hidden coder', () => {
    // hiding 3: item[1] (only 3) becomes uncoded; item[2] (2 and 3) stays.
    expect(computeCoverage(items, get, new Set([3])).codedVisible).toBe(2)
  })
  it('total counts all items', () => {
    expect(computeCoverage(items, get).total).toBe(5)
  })
})

// #441 — per-(code, coder) chip rendering. The bare arrays carry one entry per
// coder; rendering must produce one chip per (code, coder), NOT N collapsed onto
// one code_id key showing the last coder.
const cd = (code_id: number, user_id: number | null) => ({ code_id, user_id })

describe('visibleCodeChipRows', () => {
  it('one code applied by N coders → N rows with UNIQUE keys (the #441 collision)', () => {
    const rows = visibleCodeChipRows([cd(7, 1), cd(7, 2), cd(7, 3)])
    expect(rows.map(r => r.codeId)).toEqual([7, 7, 7])
    expect(rows.map(r => r.userId)).toEqual([1, 2, 3])
    expect(new Set(rows.map(r => r.key)).size).toBe(3) // no duplicate React keys
  })
  it('hidden coders are dropped; your own/unattributed stay', () => {
    const rows = visibleCodeChipRows([cd(7, 1), cd(7, 2), cd(8, null)], new Set([2]))
    expect(rows.map(r => [r.codeId, r.userId])).toEqual([[7, 1], [8, null]])
  })
  it('null appliers get distinct keys (array index disambiguates)', () => {
    const rows = visibleCodeChipRows([cd(7, null), cd(8, null)])
    expect(new Set(rows.map(r => r.key)).size).toBe(2)
  })
})

describe('distinctVisibleCodeIds', () => {
  it('collapses N coders of one code to a single id', () => {
    expect(distinctVisibleCodeIds([cd(7, 1), cd(7, 2), cd(8, 1)])).toEqual([7, 8])
  })
  it('applies the visibility lens when given', () => {
    expect(distinctVisibleCodeIds([cd(7, 2), cd(8, 1)], new Set([2]))).toEqual([8])
  })
})

describe('isCodeAppliedByActiveCoder', () => {
  const details = [cd(7, 1), cd(7, 2), cd(8, 2)]
  it('true only when the ACTIVE coder applied the code', () => {
    expect(isCodeAppliedByActiveCoder(details, [7, 7, 8], 7, 1)).toBe(true)
    expect(isCodeAppliedByActiveCoder(details, [7, 7, 8], 8, 1)).toBe(false) // only coder 2 has 8
    expect(isCodeAppliedByActiveCoder(details, [7, 7, 8], 8, 2)).toBe(true)
  })
  it('falls back to any-coder presence when details/active id are absent', () => {
    expect(isCodeAppliedByActiveCoder(undefined, [7, 8], 7, 1)).toBe(true)
    expect(isCodeAppliedByActiveCoder(details, [7, 7, 8], 8, null)).toBe(true) // null active → any-coder
  })
})
