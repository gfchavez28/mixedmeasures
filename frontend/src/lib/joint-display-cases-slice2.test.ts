/**
 * Joint display slice 2, round 2 (r5) — the case view's model (`joint-display-cases.ts`) and the
 * report's "cases that don't fit" note (r3-11): the request is the compute's own (D175), the
 * writers keep a reason REQUIRED (r3-9), a cell never reads "unknown" as "no" (r3-2), and the
 * note never names a rule-selected case (Kaiser 2009) — with a slice-1 display as the control.
 */
import { describe, expect, it } from 'vitest'
import type { JointDisplayCasesResponse, JointDisplayComputeResponse } from './api'
import { displayCoderScope, readDisplay } from './joint-display'
import {
  caseCodeText, caseCountRequest, caseListedText, caseRequest, caseValueText, hasMisfit, misfitReportFacts,
  misfitStatusText, withCase, withReason, withRule, withoutCase,
} from './joint-display-cases'
import { buildJointDisplayReport } from './joint-display-report'
import * as W from './joint-display-vocabulary'

const SLICE_1 = {
  group_by_column_id: 7, conversation_ids: [4], document_ids: null,
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [3], column_ids: [8] }],
}
const RULE = { conditions: [{ kind: 'group', group: 'High' }, { kind: 'variable', column_id: 8, op: 'lt', value: 24 }] }
const withMisfit = (misfit: unknown, attribution = 'participant') =>
  readDisplay({ ...SLICE_1, attribution: { label: attribution, column_id: null }, rows: [{ ...SLICE_1.rows[0], misfit }] })
const OPEN = displayCoderScope(false, 1)

function resp(over: Partial<JointDisplayCasesResponse> = {}): JointDisplayCasesResponse {
  return {
    groups: ['High', 'Low'], total: 22, listed: 22, matched: 3, unknown: 2, rule_unavailable_reason: null,
    rule_withheld_columns: [], rule_missing_groups: [], list_size: 3, added_outside: 0,
    codes: [{ code_id: 3, name: 'Positive response' }],
    variables: [{ column_id: 8, name: 'Training hours', dataset_id: 1, withheld: false, operators: ['lt', 'missing'] }],
    cases: [], named_cases: [], unavailable_reason: null, ...over,
  }
}

describe('the request (C3) is the compute’s own', () => {
  it('a slice-1 display: the implicit pair, its sources, the row’s bindings, the saved rule and lists', () => {
    const d = withMisfit({ rule: RULE, added: [{ participant_id: 11, reason: 'Moved' }], removed: [{ participant_id: 12, reason: 'Typo' }] })
    const req = caseRequest(d, 'r1', OPEN, { only: 'list', offset: 50, limit: 50 })!
    expect(req.strands!.map(s => [s.key, s.kind, s.conversation_ids])).toEqual([['codes', 'codes', [4]], ['variables', 'variables', null]])
    expect(req.bindings).toEqual({ codes: { code_ids: [3], column_ids: [] }, variables: { code_ids: [], column_ids: [8] } })
    expect(req.rule).toEqual(RULE)
    expect([req.added_participant_ids, req.removed_participant_ids, req.only, req.offset]).toEqual([[11], [12], 'list', 50])
    expect([req.coder_ids, req.layer_scope]).toEqual([null, 'human'])
  })

  it('blind: the viewer alone, as the compute (D175)', () => {
    const req = caseRequest(withMisfit(null), 'r1', displayCoderScope(true, 5), { only: 'all', offset: 0, limit: 50 })!
    expect(req.coder_ids).toEqual([5])
  })

  it('no grouping variable, or no such row: no request', () => {
    expect(caseRequest(readDisplay({ ...SLICE_1, group_by_column_id: null }), 'r1', OPEN, { only: 'all', offset: 0, limit: 50 })).toBeNull()
    expect(caseRequest(withMisfit(null), 'gone', OPEN, { only: 'all', offset: 0, limit: 50 })).toBeNull()
  })

  it('r5-7: the count alone is limit 0, and only for a row with a misfit', () => {
    expect(caseCountRequest(withMisfit({ rule: RULE, added: [], removed: [] }), 'r1', OPEN)!.limit).toBe(0)
    expect(caseCountRequest(withMisfit(null), 'r1', OPEN)).toBeNull()
    expect(caseCountRequest(withMisfit({ rule: { conditions: [] }, added: [], removed: [] }), 'r1', OPEN)).toBeNull()
  })
})

describe('writing the misfit (r3-9, r3-12)', () => {
  it('a reason is required, trimmed; a case is on one list; undo takes the reason too', () => {
    expect(withCase(null, 'added', 11, '   ')).toBeUndefined()
    const added = withCase(null, 'added', 11, '  Moved schools ')!
    expect(added).toEqual({ rule: null, added: [{ participant_id: 11, reason: 'Moved schools' }], removed: [] })
    const moved = withCase(added, 'removed', 11, 'Hours in days')!
    expect([moved.added, moved.removed]).toEqual([[], [{ participant_id: 11, reason: 'Hours in days' }]])
    expect(withoutCase(moved, 'removed', 11)).toBeNull()   // nothing left: stored as no misfit
    expect(withReason(added, 'added', 11, '')).toBeUndefined()
    expect(withReason(added, 'added', 11, 'New')!.added[0].reason).toBe('New')
  })

  it('a rule with no condition is no rule; a later release’s member survives an edit (R1)', () => {
    const later = { rule: null, added: [], removed: [], weight: 2 } as never
    expect(withRule(later, [])).toEqual({ rule: null, added: [], removed: [], weight: 2 })
    expect(withRule(null, [])).toBeNull()
    expect(withRule(null, [{ kind: 'group', group: 'High' }])!.rule).toEqual({ conditions: [{ kind: 'group', group: 'High' }] })
  })

  it('hasMisfit: a rule with a condition, or a case', () => {
    expect(hasMisfit(withMisfit({ rule: { conditions: [] }, added: [], removed: [] }).rows[0])).toBe(false)
    expect(hasMisfit(withMisfit({ rule: null, added: [{ participant_id: 1, reason: 'x' }], removed: [] }).rows[0])).toBe(true)
  })
})

describe('what a case’s cell says (r3-2: unknown is never "no")', () => {
  const facts = (over = {}) => ({ has_material: true, coded: true, values: [], codes: [{ code_id: 3, passages: 2, used: true }], ...over })
  it('used · not used · not coded yet · no material', () => {
    expect(caseCodeText(facts(), 3, 'codes')).toBe('used (2 passages)')
    expect(caseCodeText(facts({ codes: [{ code_id: 3, passages: 0, used: false }] }), 3, 'codes')).toBe(W.CASE_NOT_USED_TEXT)
    expect(caseCodeText(facts({ coded: false, codes: [{ code_id: 3, passages: 0, used: false }] }), 3, 'codes')).toBe(W.CASE_NOT_CODED_TEXT)
    expect(caseCodeText(facts({ has_material: false, codes: [{ code_id: 3, passages: 0, used: null }] }), 3, 'codes')).toBe(W.CASE_NO_MATERIAL_TEXT)
    expect(caseCodeText(facts({ has_material: false }), 3, 'text_codes')).toBe(W.CASE_NO_ANSWER_TEXT)
  })
  it('a value, a label, or why there is none', () => {
    const v = (x: object) => ({ has_material: null, coded: null, codes: [], values: [{ column_id: 8, value: null, label: null, reason: null, ...x }] })
    expect(caseValueText(v({ value: 12.345 }), 8)).toBe('12.35')
    expect(caseValueText(v({ value: 2, label: 'Rural' }), 8)).toBe('Rural')
    expect(caseValueText(v({ reason: 'missing' }), 8)).toBe('no answer')
    expect(caseValueText(v({ reason: W.SERVER_VOCABULARY.VARIABLE_RATING_WITHHELD }), 8)).toBe('left out while blind')
  })
  it('where a case stands, from the server’s fields', () => {
    const c = { participant_id: 1, label: 'T1', group: 'High', facts: {}, matches: null, listed_by: null, removed: false }
    expect(caseListedText(c, true)).toBe(W.CASE_LISTED_TEXT.unknown)
    expect(caseListedText(c, false)).toBe(W.CASE_LISTED_TEXT.no)
    expect(caseListedText({ ...c, removed: true, matches: true }, true)).toBe(W.CASE_LISTED_TEXT.removed)
  })
  it('the count, or why the rule was not run — the withheld variable first, by name (r3-3)', () => {
    expect(misfitStatusText(resp(), true)).toBe(W.misfitCountText(3, 22, 2))
    expect(misfitStatusText(resp({ rule_withheld_columns: ['Rating score'], rule_unavailable_reason: 'rating_withheld_blind', matched: null }), true))
      .toBe(W.misfitRuleWithheldText(['Rating score']))
    expect(misfitStatusText(resp({ rule_unavailable_reason: 'reference_missing', matched: null }), true))
      .toBe(W.MISFIT_RULE_UNAVAILABLE_TEXT.reference_missing)
    expect(misfitStatusText(resp(), false)).toBeNull()
  })
})

const DATA = {
  unit: 'participants',
  group_by: { column_id: 7, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0 },
  rating: null,
  rows: [{ key: 'r1', codes: [], variables: [{ column_id: 8, name: 'Training hours', dataset_id: 1, unit: 'participants', cells: [] }],
    missing_code_ids: [], missing_column_ids: [], strands: {} }],
} as unknown as JointDisplayComputeResponse
const CTX = { coderName: () => null, withholding: false, self: 1, asOf: '15 Nov 2026' }
const note = (display: ReturnType<typeof readDisplay>, misfits: Map<string, unknown>) => buildJointDisplayReport({
  display, data: DATA, unavailable: null, facts: new Map(), attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false,
  misfits: misfits as never,
// The notice rule (2026-11-18, rewrite D): the cases that don't fit print in the Definitions.
}, CTX).definitions.join(' ')

describe('the report’s note (r3-11) — the four readers’ one function', () => {
  const MISFIT = { rule: RULE, added: [{ participant_id: 11, reason: 'Moved schools' }], removed: [] }
  // The answer carries a RULE-selected case (T05) in `cases` — the note must never name it.
  const answer = resp({ cases: [{ participant_id: 5, label: 'T05', group: 'High', facts: {}, matches: true, listed_by: 'rule', removed: false }],
    named_cases: [{ participant_id: 11, label: 'T11', group: 'Low' }] })

  it('prints the rule, its count and each added case with its reason — by identifier in participant mode', () => {
    const n = note(withMisfit(MISFIT), new Map([['r1', misfitReportFacts(answer, true)]]))
    expect(n).toContain('Cases that don’t fit — Planning. Rule: in the group “High” and Training hours is less than 24. 3 of 22 cases meet the rule; 2 cannot be checked')
    expect(n).toContain('Added by the researcher: T11: Moved schools.')
    expect(n).not.toContain('T05')
  })

  it('#1703 (d) (D374): a named case in none of the groups now carries Compact’s qualifier — from the read', () => {
    const outside = resp({ named_cases: [{ participant_id: 11, label: 'T11', group: null }] })
    const n = note(withMisfit(MISFIT), new Map([['r1', misfitReportFacts(outside, true)]]))
    expect(n).toContain('Added by the researcher: T11 (no longer in the display’s groups): Moved schools.')
    // CONTROL: in a group, no qualifier (the test above)
  })

  it('numbers the cases when the display does not attribute by identifier (r3-7)', () => {
    const n = note(withMisfit(MISFIT, 'none'), new Map([['r1', misfitReportFacts(answer, true)]]))
    expect(n).toContain('Added by the researcher: Case 1: Moved schools.')
    expect(n).not.toContain('T11')
  })

  it('an unread count says so and names no one it could not identify', () => {
    const n = note(withMisfit(MISFIT), new Map([['r1', 'unread']]))
    expect(n).toContain(`Rule: in the group “High” and Training hours is less than 24. ${W.MISFIT_COUNT_UNREAD_TEXT}`)
    expect(n).toContain('Added by the researcher: Case 1: Moved schools.')
    expect(n).not.toContain('no longer in the project')
    const noRule = note(withMisfit({ ...MISFIT, rule: null }), new Map([['r1', 'unread']]))
    expect(noRule).toContain(W.MISFIT_COUNT_UNREAD_TEXT)
  })

  it('control: a row with no misfit prints exactly what it printed without one', () => {
    expect(note(withMisfit(null), new Map())).toBe(note(readDisplay(SLICE_1), new Map()))
    expect(note(withMisfit(null), new Map())).not.toContain('Cases that don’t fit')
  })
})
