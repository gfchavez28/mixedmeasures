import { describe, it, expect } from 'vitest'
import type { MergeCoderPreview, CoderMappingDecision } from './api'
import {
  defaultDecision, defaultDecisions, decisionToValue, parseDecisionValue, buildCoderMapping,
  resultingCoderCount, newCoderCounts, nameInUseNote,
} from './merge-coder-mapping'

function coder(over: Partial<MergeCoderPreview> = {}): MergeCoderPreview {
  return {
    original_id: 7,
    username: 'Alex',
    coder_type: 'human',
    archived: false,
    file_app_count: 10,
    local_match: null,
    name_in_use: null,
    match_options: [],
    machine_provenance: null,
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

// #1034 — a MODEL coder is never one of the people consensus and agreement need.
describe('#1034 — the consensus note counts PEOPLE', () => {
  const person = coder({ original_id: 1, username: 'Ana' })
  const model = coder({ original_id: 2, username: 'GPT-4o', coder_type: 'ai' })

  it('a person and a model are ONE person, not two coders', () => {
    const decisions: Record<number, CoderMappingDecision> = {
      1: { action: 'match', target_user_id: 5 }, 2: { action: 'create' },
    }
    expect(resultingCoderCount([person, model], decisions)).toBe(1)
    // POSITIVE CONTROL: two people ARE two.
    const two = coder({ original_id: 3, username: 'Ben' })
    expect(resultingCoderCount([person, two], { 1: { action: 'create' }, 3: { action: 'create' } })).toBe(2)
  })

  it('new coders are split by kind', () => {
    expect(newCoderCounts([person, model], { 1: { action: 'create' }, 2: { action: 'create' } }))
      .toEqual({ people: 1, models: 1 })
    expect(newCoderCounts([person, model], { 1: { action: 'match', target_user_id: 5 }, 2: { action: 'create' } }))
      .toEqual({ people: 0, models: 1 })
  })
})

describe('#1034 — a taken name is explained, never a surprise', () => {
  it('no note when the name is free or matched', () => {
    expect(nameInUseNote(coder())).toBeNull()
  })
  it('a person holding a model\'s name', () => {
    const c = coder({
      coder_type: 'ai', username: 'Model-1',
      name_in_use: { username: 'Model-1', coder_type: 'human', reason: 'kind', new_username: 'Model-1 (2)' },
    })
    expect(nameInUseNote(c)).toBe(
      'A person called “Model-1” is already here, and a person and a model cannot stand in '
      + 'for each other — so this machine coder joins as “Model-1 (2)”.',
    )
  })
  it('a model holding a person\'s name', () => {
    const c = coder({
      username: 'Alex',
      name_in_use: { username: 'Alex', coder_type: 'ai', reason: 'kind', new_username: 'Alex (2)' },
    })
    expect(nameInUseNote(c)).toMatch(/^A machine coder called “Alex” .* so this person joins as “Alex \(2\)”\.$/)
  })
  it('another configuration of the model', () => {
    const c = coder({
      coder_type: 'ai', username: 'GPT-4o',
      name_in_use: { username: 'GPT-4o', coder_type: 'ai', reason: 'configuration', new_username: 'GPT-4o (2)' },
    })
    expect(nameInUseNote(c)).toContain('two configurations of one model are two coders')
    expect(nameInUseNote(c)).toContain('joins as “GPT-4o (2)”')
  })
})
