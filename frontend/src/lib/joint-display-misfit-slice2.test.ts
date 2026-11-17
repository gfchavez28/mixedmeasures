/**
 * Joint display slice 2 — a row's "cases that don't fit" (D173; the review's r3): the
 * reader keeps it (C6), a rule reads as one sentence (r3-10), and the export's note says
 * what the rule selected or what the researcher picked, naming a case only as the display
 * names a quote (r3-7).
 */
import { describe, expect, it } from 'vitest'
import { readDisplay, unresolvedReferenceCount } from './joint-display'
import {
  conditionRequest,
  misfitNoteLine,
  readMisfit,
  ruleSentence,
  type RuleNames,
} from './joint-display-misfit'
import {
  CASE_OPERATOR_TEXT,
  misfitCountText,
  misfitRuleWithheldText,
  SERVER_VOCABULARY,
} from './joint-display-vocabulary'

const SLICE_1 = {
  group_by_column_id: 7, conversation_ids: null, document_ids: null,
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [3], column_ids: [8] }],
}

const MISFIT = {
  rule: { conditions: [
    { kind: 'group', group: 'High gain' },
    { kind: 'variable', column_id: 8, op: 'lt', value: 24 },
    { kind: 'code', strand_key: 'codes', code_id: 3, present: true },
    { kind: 'variable', column_id: 9, op: 'is', value: 'Rural' },
    { kind: 'variable', column_id: 8, op: 'missing', value: null },
  ] },
  added: [{ participant_id: 11, reason: 'Moved schools mid-year' }],
  removed: [{ participant_id: 12, reason: 'Hours were entered in days' }],
}

const NAMES: RuleNames = {
  groupBy: 'Gain group',
  column: id => ({ 8: 'Training hours', 9: 'Setting' } as Record<number, string>)[id] ?? null,
  code: id => (id === 3 ? 'Positive student response' : null),
  strand: key => (key === 'codes' ? 'Interviews' : null),
  codeStrandCount: 1,
}

describe('the reader (C6)', () => {
  it('reads a slice-1 display unchanged, with no misfit (control)', () => {
    const row = readDisplay(SLICE_1).rows[0]
    expect(row.misfit).toBeNull()
    // The combine: r1's model reads slice 1's row ids as the implicit pair's bindings (r1-2).
    expect(row.bindings.codes.code_ids).toEqual([3])
    expect(unresolvedReferenceCount(readDisplay(SLICE_1))).toBe(0)
  })

  it('keeps a stored misfit, every member', () => {
    const row = readDisplay({ ...SLICE_1, rows: [{ ...SLICE_1.rows[0], misfit: MISFIT }] }).rows[0]
    expect(row.misfit).toEqual(MISFIT)
  })

  it('keeps a condition it cannot read VERBATIM and sends it back as it came', () => {
    const later = { kind: 'code_rating', code_id: 3, op: 'gt', value: 3 }
    const m = readMisfit({ rule: { conditions: [later] } })!
    expect(m.rule!.conditions).toEqual([{ kind: 'unreadable', raw: later }])
    expect(conditionRequest(m.rule!.conditions[0])).toEqual(later)
  })

  it('keeps members this build does not know at every level, and never sends them (the combine, r1-9)', () => {
    const later = {
      rule: { conditions: [{ kind: 'group', group: 'High', weight: 2 }], joined: 'and' },
      added: [{ participant_id: 7, reason: 'r', added_at: '2027-01-01' }], removed: [], note: 'x',
    }
    const m = readDisplay({ rows: [{ key: 'r', misfit: later }] }).rows[0].misfit!
    const stored = JSON.parse(JSON.stringify(m))
    expect(stored.note).toBe('x')
    expect(stored.rule.joined).toBe('and')
    expect(stored.rule.conditions[0].weight).toBe(2)
    expect(stored.added[0].added_at).toBe('2027-01-01')
    expect(conditionRequest(m.rule!.conditions[0])).toEqual({ kind: 'group', group: 'High' })
  })

  it('counts a condition whose id an import could not resolve', () => {
    const misfit = { rule: { conditions: [{ kind: 'variable', column_id: null, op: 'lt', value: 1 }] } }
    expect(unresolvedReferenceCount(readDisplay({ ...SLICE_1, rows: [{ ...SLICE_1.rows[0], misfit }] }))).toBe(1)
  })
})

describe('the rule as a sentence (r3-10)', () => {
  it('joins its clauses with "and", in the researcher\'s order', () => {
    expect(ruleSentence(readMisfit(MISFIT)!.rule!.conditions, NAMES)).toBe(
      'Gain group is “High gain” and Training hours is less than 24 and used “Positive '
      + 'student response” and Setting is “Rural” and Training hours has no answer')
  })

  it('names the strand only when there is more than one code strand, and a lost reference', () => {
    const conds = readMisfit({ rule: { conditions: [
      { kind: 'code', strand_key: 'codes', code_id: 3, present: false },
      { kind: 'variable', column_id: 99, op: 'gt', value: 1 },
    ] } })!.rule!.conditions
    expect(ruleSentence(conds, { ...NAMES, codeStrandCount: 2 })).toBe(
      'did not use “Positive student response” (Interviews) and a variable this row no '
      + 'longer binds is more than 1')
  })

  it('has words for every operator the server states', () => {
    const ops = Object.entries(SERVER_VOCABULARY).filter(([k]) => k.startsWith('CASE_OP_')).map(([, v]) => v)
    expect(ops.length).toBe(9)
    for (const op of ops) expect(CASE_OPERATOR_TEXT[op]).toBeTruthy()
  })
})

describe('what the count and the export say (r3-2, r3-7, r3-11)', () => {
  it('never folds the cases the rule cannot check into the count', () => {
    expect(misfitCountText(3, 22, 2)).toBe(
      '3 of 22 cases meet the rule; 2 cannot be checked (a value is missing, or there is no material in the sources).')
    expect(misfitCountText(1, 1, 0)).toBe('1 of 1 case meets the rule.')
  })

  it('names a withheld column, never drops it', () => {
    expect(misfitRuleWithheldText(['Mean rating'])).toContain('“Mean rating” comes from participant scores')
  })

  it('prints the rule and its count, then each added and removed case with its reason — never the rule\'s own cases', () => {
    const ids: Record<number, string> = { 11: 'T11', 12: 'T12' }
    expect(misfitNoteLine({
      construct: 'Planning', misfit: readMisfit(MISFIT)!, attribution: 'participant',
      sentence: 'Gain group is “High gain” and Training hours is less than 24',
      countText: misfitCountText(3, 22, 0), identifier: p => ids[p] ?? null,
    })).toBe('Cases that don’t fit — Planning. Rule: Gain group is “High gain” and Training '
      + 'hours is less than 24. 3 of 22 cases meet the rule. Added by the researcher: T11: Moved '
      + 'schools mid-year. Removed by the researcher: T12: Hours were entered in days.')
  })

  it('a hand-picked list is no rule and its additions, by identifier only when the display attributes by it', () => {
    const picked = readMisfit({ rule: null, added: [
      { participant_id: 11, reason: 'Moved schools mid-year' }, { participant_id: 12, reason: ' ' },
      { participant_id: 13, reason: 'Gone' }] })!
    const ids: Record<number, string> = { 11: 'T11', 12: 'T12' }
    const base = { construct: 'Planning', misfit: picked, identifier: (p: number) => ids[p] ?? null }
    expect(misfitNoteLine({ ...base, attribution: 'participant' })).toBe(
      'Cases that don’t fit — Planning. Added by the researcher: T11: Moved schools mid-year; '
      + 'T12: No reason recorded; a participant no longer in the project: Gone.')
    expect(misfitNoteLine({ ...base, attribution: 'none' })).toBe(
      'Cases that don’t fit — Planning. Added by the researcher: Case 1: Moved schools mid-year; '
      + 'Case 2: No reason recorded; a participant no longer in the project: Gone.')
  })

  it('a reason written as a sentence keeps one full stop, and its ? or ! (found by the build’s drive: "source..")', () => {
    const written = readMisfit({ rule: null, added: [
      { participant_id: 11, reason: 'No supervisor support in any source.' },
      { participant_id: 12, reason: 'Moved mid-year?' }] })!
    const base = { construct: 'Planning', misfit: written, identifier: (p: number) => `T${p}` }
    expect(misfitNoteLine({ ...base, attribution: 'participant' })).toBe(
      'Cases that don’t fit — Planning. Added by the researcher: T11: No supervisor support in any source; '
      + 'T12: Moved mid-year?')
    const one = readMisfit({ rule: null, added: [{ participant_id: 11, reason: 'In no source.' }] })!
    expect(misfitNoteLine({ ...base, misfit: one, attribution: 'participant' })).toBe(
      'Cases that don’t fit — Planning. Added by the researcher: T11: In no source.')
  })

  it('prints nothing for a row with no list', () => {
    expect(misfitNoteLine({ construct: 'x', misfit: { rule: null, added: [], removed: [] },
      attribution: 'participant', identifier: () => null })).toBeNull()
  })
})
