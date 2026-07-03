import { describe, it, expect } from 'vitest'
import type { MergeCoderPreview, CoderMappingDecision } from './api'
import {
  defaultDecision, defaultDecisions, decisionToValue, parseDecisionValue, buildCoderMapping,
  resultingCoderCount,
} from './merge-coder-mapping'

function coder(over: Partial<MergeCoderPreview> = {}): MergeCoderPreview {
  return {
    original_id: 7,
    username: 'Alex',
    coder_type: 'human',
    archived: false,
    file_app_count: 10,
    local_match: null,
    ...over,
  }
}

describe('defaultDecision (R3 smart defaults)', () => {
  it('adds as new when there is no local match', () => {
    expect(defaultDecision(coder({ local_match: null }))).toEqual({ action: 'create' })
  })

  it('maps onto a confident non-archived name-match', () => {
    const c = coder({ local_match: { id: 3, username: 'Alex', archived: false, local_app_count: 4 } })
    expect(defaultDecision(c)).toEqual({ action: 'match', target_user_id: 3 })
  })

  it('un-archives by default when the match is archived (so they count toward IRR)', () => {
    const c = coder({ local_match: { id: 5, username: 'Alex', archived: true, local_app_count: 0 } })
    expect(defaultDecision(c)).toEqual({ action: 'match', target_user_id: 5, unarchive: true })
  })
})

describe('defaultDecisions', () => {
  it('keys decisions by original_id', () => {
    const a = coder({ original_id: 1, local_match: null })
    const b = coder({ original_id: 2, local_match: { id: 9, username: 'Bo', archived: false, local_app_count: 1 } })
    expect(defaultDecisions([a, b])).toEqual({
      1: { action: 'create' },
      2: { action: 'match', target_user_id: 9 },
    })
  })
})

describe('decisionToValue / parseDecisionValue round-trip', () => {
  it.each<CoderMappingDecision>([
    { action: 'create' },
    { action: 'match', target_user_id: 42 },
  ])('round-trips %o', (d) => {
    expect(parseDecisionValue(decisionToValue(d))).toEqual(
      d.action === 'create' ? { action: 'create' } : { action: 'match', target_user_id: 42 },
    )
  })
})

describe('buildCoderMapping (wire payload)', () => {
  it('emits a bare match (no unarchive key) when unarchive is not set', () => {
    const c = coder({ original_id: 1, local_match: { id: 3, username: 'Alex', archived: false, local_app_count: 2 } })
    const out = buildCoderMapping([c], { 1: { action: 'match', target_user_id: 3 } }, {})
    expect(out).toEqual({ '1': { action: 'match', target_user_id: 3 } })
  })

  it('carries unarchive only when set', () => {
    const c = coder({ original_id: 1 })
    const out = buildCoderMapping([c], { 1: { action: 'match', target_user_id: 5, unarchive: true } }, {})
    expect(out).toEqual({ '1': { action: 'match', target_user_id: 5, unarchive: true } })
  })

  it('omits new_username for a create when not renamed', () => {
    const c = coder({ original_id: 2, username: 'Briana' })
    const out = buildCoderMapping([c], { 2: { action: 'create' } }, {})
    expect(out).toEqual({ '2': { action: 'create' } })
  })

  it('sends new_username only when the rename differs from the file username', () => {
    const c = coder({ original_id: 2, username: 'Briana' })
    expect(buildCoderMapping([c], { 2: { action: 'create' } }, { 2: 'Briana' })).toEqual({
      '2': { action: 'create' },
    })
    expect(buildCoderMapping([c], { 2: { action: 'create' } }, { 2: 'Briana D.' })).toEqual({
      '2': { action: 'create', new_username: 'Briana D.' },
    })
    // whitespace-only / blank rename is ignored
    expect(buildCoderMapping([c], { 2: { action: 'create' } }, { 2: '   ' })).toEqual({
      '2': { action: 'create' },
    })
  })

  it('skips coders with no decision', () => {
    const c = coder({ original_id: 9 })
    expect(buildCoderMapping([c], {}, {})).toEqual({})
  })

  it('keys the payload by stringified original_id', () => {
    const c = coder({ original_id: 13, local_match: null })
    const out = buildCoderMapping([c], { 13: { action: 'create' } }, {})
    expect(Object.keys(out)).toEqual(['13'])
  })
})

describe('resultingCoderCount (#444 single-vs-multi-coder)', () => {
  const a = coder({ original_id: 1 })
  const b = coder({ original_id: 2 })

  it('counts two file coders mapped onto distinct existing coders as 2 (the false-positive case)', () => {
    const decisions: Record<number, CoderMappingDecision> = {
      1: { action: 'match', target_user_id: 3 },
      2: { action: 'match', target_user_id: 4 },
    }
    expect(resultingCoderCount([a, b], decisions)).toBe(2)
  })

  it('collapses two file coders mapped onto the same existing coder to 1', () => {
    const decisions: Record<number, CoderMappingDecision> = {
      1: { action: 'match', target_user_id: 3 },
      2: { action: 'match', target_user_id: 3 },
    }
    expect(resultingCoderCount([a, b], decisions)).toBe(1)
  })

  it('counts each create as a distinct new coder', () => {
    const decisions: Record<number, CoderMappingDecision> = {
      1: { action: 'create' },
      2: { action: 'create' },
    }
    expect(resultingCoderCount([a, b], decisions)).toBe(2)
  })

  it('mixes a create and a match as 2 distinct coders', () => {
    const decisions: Record<number, CoderMappingDecision> = {
      1: { action: 'create' },
      2: { action: 'match', target_user_id: 9 },
    }
    expect(resultingCoderCount([a, b], decisions)).toBe(2)
  })

  it('unions optional existing coder ids without double-counting a matched one', () => {
    const decisions: Record<number, CoderMappingDecision> = { 1: { action: 'match', target_user_id: 5 } }
    expect(resultingCoderCount([a], decisions, [5])).toBe(1)
    expect(resultingCoderCount([a], decisions, [9])).toBe(2)
  })

  it('ignores coders with no decision', () => {
    expect(resultingCoderCount([a, b], { 1: { action: 'match', target_user_id: 3 } })).toBe(1)
  })
})
