/**
 * #35 — the reading half of a reliability coefficient's stated basis.
 *
 * The cross-language half (do the constants match `services/reliability_basis.py`,
 * are the exhaustiveness guards still there) is pinned from the PYTHON side by
 * `backend/tests/test_reliability_basis.py`, which reads the source file. This
 * file pins the READING behaviour: absent says nothing, unknown is named, known
 * is described.
 */
import { describe, it, expect } from 'vitest'
import {
  RELIABILITY_FACET_CODERS,
  RELIABILITY_FACET_ITEMS,
  alphaMetricLabel,
  describeAlphaMetric,
  describeReliabilityFacet,
  reliabilityFacetQualifier,
  describeUnitBasis, UNIT_BASIS_PARTICIPANT_PASSAGES, UNIT_BASIS_ALL_PASSAGES,
  describeFacilitatorExclusion, FACILITATOR_SPEAKERS_SHOWN, FACILITATOR_CODES_SHOWN,
  facilitatorRowNote,
  VERDICT_WITHHELD_TOO_FEW_UNITS, verdictWithheldWord, verdictShortfall,
  verdictWithheldNote, overallVerdictWithheldNote,
  isOneUnitRow,
} from './reliability-basis'

describe('reliability facet', () => {
  it('qualifies the two facets with different words', () => {
    const coders = reliabilityFacetQualifier(RELIABILITY_FACET_CODERS)
    const items = reliabilityFacetQualifier(RELIABILITY_FACET_ITEMS)
    expect(coders).toBe('over coders')
    expect(items).toBe('across items')
    expect(coders).not.toBe(items)
  })

  it('says NOTHING for an absent facet — an older payload must not be relabelled', () => {
    expect(reliabilityFacetQualifier(null)).toBeNull()
    expect(reliabilityFacetQualifier(undefined)).toBeNull()
    expect(reliabilityFacetQualifier('')).toBeNull()
    expect(describeReliabilityFacet(null)).toBeNull()
  })

  it('names an unknown facet verbatim rather than dropping it — a newer server is still a fact', () => {
    expect(reliabilityFacetQualifier('occasions')).toBe('over occasions')
    expect(describeReliabilityFacet('occasions')).toBe('Reliability facet: occasions.')
  })

  it('describes the items facet by what it is NOT, since that is the confusion it exists to prevent', () => {
    const sentence = describeReliabilityFacet(RELIABILITY_FACET_ITEMS)!
    expect(sentence).toMatch(/items/)
    expect(sentence).toMatch(/nothing about agreement between people/)
    expect(describeReliabilityFacet(RELIABILITY_FACET_CODERS)).toMatch(/different coders/)
  })
})

describe('alpha metric', () => {
  it('labels a metric with its own word', () => {
    expect(alphaMetricLabel('interval')).toBe('interval')
    expect(alphaMetricLabel('nominal')).toBe('nominal')
    expect(alphaMetricLabel(null)).toBeNull()
  })

  it('explains every known metric, and the interval one names the declared scale', () => {
    for (const metric of ['nominal', 'ordinal', 'interval', 'ratio']) {
      expect(describeAlphaMetric(metric)).toEqual(expect.any(String))
    }
    expect(describeAlphaMetric('interval')).toMatch(/3 and a 4 disagree less than a 3 and a 9/)
    expect(describeAlphaMetric('nominal')).toMatch(/match or they do not/)
  })

  it('says nothing for an absent metric and names an unknown one', () => {
    expect(describeAlphaMetric(undefined)).toBeNull()
    expect(describeAlphaMetric('circular')).toBe('Scored on the circular metric.')
  })
})

describe('unit basis (#1333 / #1334)', () => {
  it('says what a unit is for each known basis, and both count a group once', () => {
    const participant = describeUnitBasis(UNIT_BASIS_PARTICIPANT_PASSAGES)!
    const all = describeUnitBasis(UNIT_BASIS_ALL_PASSAGES)!
    expect(participant).toMatch(/turns are left out/)
    expect(all).toMatch(/turns included/)
    for (const sentence of [participant, all]) expect(sentence).toMatch(/a group of turns counts once/)
  })

  it('says nothing for an absent basis — an older payload is not relabelled — and names an unknown one', () => {
    expect(describeUnitBasis(undefined)).toBeNull()
    expect(describeUnitBasis(null)).toBeNull()
    expect(describeUnitBasis('every_word')).toBe('Units: every_word.')
  })
})

describe('what the facilitator exclusion left out (#1333 / D18)', () => {
  const perCode = [
    { code_name: 'Empathy', facilitator_turns_coded: 2 },
    { code_name: 'Trust', facilitator_turns_coded: 0 },
    { code_name: 'Access', facilitator_turns_coded: null },
  ]

  it('names the turns, whose they were, and the codes a coder applied to one anyway', () => {
    expect(describeFacilitatorExclusion({ excluded: 6, speakers: ['Host', 'Interviewer'], perCode }))
      .toBe('6 facilitator turns (Host, Interviewer) are left out here; coded anyway: Empathy on 2.')
  })

  it('says when no coder coded one, and agrees in number for a single turn', () => {
    expect(describeFacilitatorExclusion({
      excluded: 1, speakers: ['Interviewer'], perCode: [{ code_name: 'Trust', facilitator_turns_coded: 0 }],
    })).toBe('1 facilitator turn (Interviewer) is left out here, and no coder coded one.')
  })

  it('bounds the list of speakers and says how many it left unsaid', () => {
    const speakers = ['A', 'B', 'C', 'D', 'E', 'F']
    const sentence = describeFacilitatorExclusion({ excluded: 9, speakers, perCode: [] })!
    expect(sentence).toContain(`(${speakers.slice(0, FACILITATOR_SPEAKERS_SHOWN).join(', ')} and 2 more)`)
    expect(sentence).not.toContain('E,')
  })

  it('says nothing when nothing was left out, or the payload predates the fields', () => {
    expect(describeFacilitatorExclusion({ excluded: 0, speakers: [], perCode })).toBeNull()
    expect(describeFacilitatorExclusion({ excluded: null, speakers: null, perCode })).toBeNull()
    expect(describeFacilitatorExclusion({ perCode })).toBeNull()
  })

  it('omits the parenthesis rather than printing an empty one when no names came', () => {
    expect(describeFacilitatorExclusion({ excluded: 2, speakers: null, perCode: [] }))
      .toBe('2 facilitator turns are left out here, and no coder coded one.')
  })

  it('names the codes with the MOST coded turns first, and bounds them (each row carries its own)', () => {
    // Alphabetical on the wire (the server sorts per_code by name), so a sentence
    // that kept wire order would name the smallest counts first.
    const many = [
      { code_name: 'Access', facilitator_turns_coded: 1 },
      { code_name: 'Burden', facilitator_turns_coded: 13 },
      { code_name: 'Care', facilitator_turns_coded: 4 },
      { code_name: 'Doubt', facilitator_turns_coded: 7 },
      { code_name: 'Ease', facilitator_turns_coded: 1 },
    ]
    expect(FACILITATOR_CODES_SHOWN).toBe(3)
    expect(describeFacilitatorExclusion({ excluded: 22, speakers: ['Interviewer'], perCode: many }))
      .toBe('22 facilitator turns (Interviewer) are left out here; coded anyway: '
        + 'Burden on 13, Doubt on 7, Care on 4 and 2 more codes.')
  })

  it('a row says its own share, in the singular when there is one, and nothing at zero', () => {
    expect(facilitatorRowNote(2)).toBe('2 facilitator turns carrying it are left out')
    expect(facilitatorRowNote(1)).toBe('1 facilitator turn carrying it is left out')
    expect(facilitatorRowNote(0)).toBeNull()
    expect(facilitatorRowNote(null)).toBeNull()
    expect(facilitatorRowNote(undefined)).toBeNull()
  })
})

describe('#1505 (D42) — one comparable unit', () => {
  it('is a row with no coefficient for too few units over EXACTLY one', () => {
    expect(isOneUnitRow({ undefined_reason: 'insufficient_n', n_units: 1 })).toBe(true)
    // Over NO unit the app-wide sentence is true of the row; the note is not.
    expect(isOneUnitRow({ undefined_reason: 'insufficient_n', n_units: 0 })).toBe(false)
    // Another reason over one unit is that reason's business.
    expect(isOneUnitRow({ undefined_reason: 'no_variance', n_units: 1 })).toBe(false)
    expect(isOneUnitRow({ undefined_reason: null, n_units: 1 })).toBe(false)
  })
})

describe('#1505 (D43) — a withheld verdict', () => {
  it('says "too few to judge" for the floor, nothing for a row that keeps its band', () => {
    expect(verdictWithheldWord(VERDICT_WITHHELD_TOO_FEW_UNITS)).toBe('too few to judge')
    expect(verdictWithheldWord(null)).toBeNull()
    expect(verdictWithheldWord(undefined)).toBeNull()
  })

  it('says only what is on screen for a reason this build does not know — never a guessed cause', () => {
    expect(verdictWithheldWord('a_newer_reason')).toBe('no verdict')
    expect(verdictWithheldNote('a_newer_reason', 18)).toBeNull()
    expect(overallVerdictWithheldNote('a_newer_reason', 18)).toBeNull()
    expect(verdictShortfall('a_newer_reason', 4, 18)).toBeNull()
  })

  it('takes the floor from the payload — a different floor says a different number', () => {
    // 🔴 The client never restates the server's constant: with a floor of 25
    // every sentence says 25, and a hard-coded 18 anywhere would show here.
    expect(verdictShortfall(VERDICT_WITHHELD_TOO_FEW_UNITS, 7, 25)).toBe('7 of the 25 units a verdict needs')
    expect(verdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, 25)).toContain('fewer than 25 units')
    expect(overallVerdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, 25)).toContain('fewer than 25 units')
    for (const s of [
      verdictShortfall(VERDICT_WITHHELD_TOO_FEW_UNITS, 7, 25),
      verdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, 25),
      overallVerdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, 25),
    ]) expect(s).not.toContain('18')
  })

  it('says nothing about a floor the payload does not state', () => {
    expect(verdictShortfall(VERDICT_WITHHELD_TOO_FEW_UNITS, 7, null)).toBeNull()
    expect(verdictShortfall(VERDICT_WITHHELD_TOO_FEW_UNITS, 7, undefined)).toBeNull()
    expect(verdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, null)).toBeNull()
    expect(overallVerdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, undefined)).toBeNull()
    // …and the count is the row's own, a real zero included.
    expect(verdictShortfall(VERDICT_WITHHELD_TOO_FEW_UNITS, 0, 18)).toBe('0 of the 18 units a verdict needs')
  })

  it('never calls the Model comparison reliability: the note speaks of agreement between coders', () => {
    // The same note is read under the Model comparison, whose copy denies that it
    // reports reliability (`lib/machine-agreement-copy.ts`).
    const note = verdictWithheldNote(VERDICT_WITHHELD_TOO_FEW_UNITS, 18)!
    expect(note).toMatch(/^Too few to judge:/)
    expect(note).toContain('judged by two or more coders')
    expect(note).toContain('good or poor agreement')
    expect(note).not.toMatch(/reliab/i)
  })
})
