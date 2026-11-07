/**
 * #1323 — the comparison's stated basis, read into words. Every assertion is the
 * WANTED behaviour: on `9dd1cd1b` the module does not exist and the table's note
 * said "Test: Chi-square test." whether or not a test ran.
 */
import { describe, it, expect } from 'vitest'
import type { DemographicComparisonResponse } from '@/lib/api'
import {
  COMPARISON_RESTRAINT_SENTENCE,
  cannotReachSignificance,
  comparisonMethodNote,
  comparisonScopeSentence,
  correctionName,
  deltaIntervalSpoken,
  deltaIntervalTitle,
  deltaIntervalVisual,
  describeOmittedTest,
  unitCount,
} from './comparison-basis'
import { comparisonSourceParams, comparisonSources } from './qual-comparison'

function payload(over: Partial<DemographicComparisonResponse['basis']> = {}, tests = true): DemographicComparisonResponse {
  return {
    groups: ['Board', 'Staff'],
    group_totals: {
      Board: { n: 3, participants: 3, total_segments: 60, total_word_count: 60 },
      Staff: { n: 3, participants: 3, total_segments: 60, total_word_count: 60 },
    },
    codes: [{
      code_id: 1, code_name: 'X', category_name: null,
      by_group: {
        Board: { count: 1, proportion: 1 / 3, undefined_reason: null, passages: 12 },
        Staff: { count: 3, proportion: 1, undefined_reason: null, passages: 3 },
      },
      delta_proportion: -0.6667,
      test: tests
        ? { method: 'fisher_exact', statistic: null, p_value: 0.4, p_adjusted: 0.8, significant: false,
            effect_size: null, effect_size_label: null, min_attainable_p: 0.1, can_reach_significance: false }
        : null,
      test_omitted_reason: null,
    }],
    basis: {
      unit: 'participant', correction: 'holm', family_size: 2, family_reachable: 0, tarone_family_size: 0,
      alpha: 0.05, tested_groups: ['Board', 'Staff'], test_omitted_reason: null, ...over,
    },
    scope: {
      conversations: 2, documents: 1, text_columns: 0, observations_left_out: 3,
      unassigned_passages: 4, participants_without_group: 0,
    },
  }
}

describe('unitCount', () => {
  it('names the unit with the number, singular and plural', () => {
    expect(unitCount('participant', 1)).toBe('1 participant')
    expect(unitCount('participant', 3)).toBe('3 participants')
    expect(unitCount('passage', 12)).toBe('12 passages')
  })
  it('names an unknown unit verbatim rather than relabelling it', () => {
    expect(unitCount('household', 2)).toBe('2 household')
  })
})

describe('correctionName', () => {
  it('names each correction for a heading, never the wire key', () => {
    expect(correctionName('discrete_holm')).toBe('discrete Holm')
    expect(correctionName('holm')).toBe('Holm')
    expect(correctionName('bh')).toBe('Benjamini–Hochberg')
  })
  it('names an unknown correction verbatim', () => {
    expect(correctionName('sidak')).toBe('sidak')
  })
})

describe('comparisonMethodNote', () => {
  it('states the unit, the test, the correction and its family', () => {
    const note = comparisonMethodNote(payload())!
    expect(note).toMatch(/Each participant counts once/)
    expect(note).toMatch(/Fisher’s exact test/)
    expect(note).toMatch(/adjusted across the 2 codes tested \(Holm\)/)
    expect(note).not.toMatch(/Chi-square/)
  })
  it('says what discrete Holm does, beside its name', () => {
    expect(comparisonMethodNote(payload({ correction: 'discrete_holm' })))
      .toMatch(/\(discrete Holm, which leaves out codes these group sizes cannot test\)/)
  })
  it('says the tests are exploratory and a missing star is not evidence of no difference (D13)', () => {
    expect(comparisonMethodNote(payload())).toContain(COMPARISON_RESTRAINT_SENTENCE)
    expect(COMPARISON_RESTRAINT_SENTENCE).toMatch(/exploratory/)
    expect(COMPARISON_RESTRAINT_SENTENCE).toMatch(/not evidence that the groups do not differ/)
  })
  it('says no such thing where no test ran', () => {
    const passages = comparisonMethodNote(payload({ unit: 'passage', test_omitted_reason: 'passage_unit', family_size: 0 }, false))!
    expect(passages).not.toContain(COMPARISON_RESTRAINT_SENTENCE)
    const tooFew = comparisonMethodNote(payload({ test_omitted_reason: 'insufficient_groups', family_size: 0 }, false))!
    expect(tooFew).not.toContain(COMPARISON_RESTRAINT_SENTENCE)
  })
  it('says when NO code can reach significance at these group sizes (the literature rider)', () => {
    expect(comparisonMethodNote(payload())).toMatch(/no code can reach p < \.05 after the adjustment/)
    expect(comparisonMethodNote(payload({ family_reachable: 2 }))).not.toMatch(/cannot reach|can reach/)
    expect(comparisonMethodNote(payload({ family_reachable: 1 }))).toMatch(/1 of the 2 codes cannot reach/)
  })
  it('says passages are described, not tested', () => {
    const note = comparisonMethodNote(payload({ unit: 'passage', test_omitted_reason: 'passage_unit', family_size: 0 }, false))!
    expect(note).toMatch(/Counts passages/)
    expect(note).toMatch(/no test is shown/)
    expect(note).not.toMatch(/Fisher/)
  })
  it('stays silent for a payload with no basis (never relabels it)', () => {
    const old = { ...payload(), basis: undefined }
    expect(comparisonMethodNote(old)).toBeNull()
  })
})

describe('comparisonScopeSentence (#1297/#1298)', () => {
  it('names what was counted and what was left out, from the server', () => {
    const s = comparisonScopeSentence(payload())!
    expect(s).toMatch(/Counts 2 conversations, 1 document\./)
    expect(s).toMatch(/3 observations are left out/)
    expect(s).toMatch(/4 passages have no linked participant/)
  })
})

describe('the per-code marker', () => {
  it('fires only on an explicit false from the server', () => {
    expect(cannotReachSignificance({ can_reach_significance: false })).toBe(true)
    expect(cannotReachSignificance({ can_reach_significance: true })).toBe(false)
    expect(cannotReachSignificance({ can_reach_significance: null })).toBe(false)
    expect(cannotReachSignificance(null)).toBe(false)
  })
  it('explains an untested code', () => {
    expect(describeOmittedTest('universal_code')).toMatch(/universal code/)
    expect(describeOmittedTest('something_new')).toBe('No test: something_new.')
  })
})

describe('comparisonSources — what the comparison counts (#1297)', () => {
  const none = { conversations: [], textColumns: [], documents: [], observations: [] }
  it('nothing selected → every source of every kind', () => {
    expect(comparisonSources(none)).toEqual({})
  })
  it('a text-only selection sends EMPTY lists for the other kinds, never undefined', () => {
    expect(comparisonSources({ ...none, textColumns: [7] })).toEqual({
      conversation_ids: [], text_column_ids: [7], document_ids: [], observation_ids: [],
    })
  })
  it('keeps an empty kind as an empty CSV parameter', () => {
    expect(comparisonSourceParams(comparisonSources({ ...none, documents: new Set([3]) }))).toEqual({
      conversation_ids: '', text_column_ids: '', document_ids: '3', observation_ids: '',
    })
  })
})

describe('Δ and its interval (D3)', () => {
  const CI = { lower: -0.0934, upper: 0.5918, level: 0.95, method: 'newcombe_hybrid_score' }

  it('shows the interval in percentage points, for the eye — with the minus the Δ beside it uses', () => {
    // DRIVEN 2026-10-31b: a true minus here put `-33.3pp` over `[−79.2, …]` in one cell.
    expect(deltaIntervalVisual(CI)).toBe('[-9.3, 59.2]')
    expect(deltaIntervalVisual(null)).toBeNull()
  })

  it('rounds mirror values alike, as the Δ cell does', () => {
    // DRIVEN: `Math.round` printed ±0.7935 as −79.3 and 79.4.
    const [lo, hi] = deltaIntervalVisual({ ...CI, lower: -0.7935, upper: 0.7935 })!.slice(1, -1).split(', ')
    expect(lo).toBe(`-${hi}`)
  })

  it('reads a bound that rounds to zero as 0.0, never -0.0', () => {
    expect(deltaIntervalVisual({ ...CI, lower: -0.0004 })).toBe('[0.0, 59.2]')
  })

  it('says the interval in words, with its level and that it is UNADJUSTED', () => {
    expect(deltaIntervalSpoken(CI)).toBe(
      '95% confidence interval -9.3 to 59.2 percentage points (unadjusted)')
  })

  it('reads the level from the payload', () => {
    expect(deltaIntervalSpoken({ ...CI, level: 0.9 })).toMatch(/^90% confidence interval/)
  })

  it('titles the cell with the label and the caveat from ci-label.ts', () => {
    const title = deltaIntervalTitle(CI)!
    expect(title).toMatch(/^95% CI \(unadjusted\): -9\.3 to 59\.2 percentage points\. /)
    expect(title).toContain('not adjusted for the number of codes compared')
  })

  it('says in the method note that the interval is not adjusted — only when one is shown', () => {
    const p = payload()
    expect(comparisonMethodNote(p)).not.toContain('Newcombe')
    p.codes[0].delta_ci = CI
    expect(comparisonMethodNote(p)).toContain(
      'Δ is the difference between the two groups’ shares, with its 95% interval in brackets (Newcombe); the interval is not adjusted for the number of codes.')
  })
})
