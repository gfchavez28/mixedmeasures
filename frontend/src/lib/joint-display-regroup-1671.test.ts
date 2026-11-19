/**
 * #1671 (D350–D352) — changing a display's grouping variable must not lose what was chosen under
 * the old groups. D352: a pin under a group the display does not have now is COUNTED and NAMED
 * under its row, in the one report function every reader and export reads (the audit's R1
 * probe: after a regroup the Markdown held no trace of the quote). D351: a rule naming a gone
 * group says so, by name. D350's model half: what the builder asks about.
 */
import { describe, it, expect } from 'vitest'
import type { JointDisplayComputeResponse, JointDisplayPinFact, JointDisplayCasesResponse } from '@/lib/api'
import { pinsOutsideGroups, readDisplay, regroupHolds, regroupNeedsAsking } from './joint-display'
import { buildJointDisplayReport, reportToMarkdown } from './joint-display-report'
import { misfitStatusText } from './joint-display-cases'
import { pinsOutsideGroupsText, regroupWarningText, SERVER_VOCABULARY } from './joint-display-vocabulary'

const groupsData = (keys: string[]): JointDisplayComputeResponse => ({
  unit: 'participants',
  group_by: { column_id: 11, name: 'Region', dataset_id: 1, dataset_name: 'Roster' },
  groups: keys.map(k => ({ key: k, participants: 3, with_material: 3, without_coding: 0 })),
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
  rating: null,
  rows: [{ key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
           strands: { codes: 'not_measured', variables: 'not_measured' } }],
} as unknown as JointDisplayComputeResponse)

const pin = (id: number, group: string) => ({ excerptId: id, displayText: `WORDS-${id}`, sourceContext: 'FG',
  conversationId: 1, observationId: null, group, role: 'typical', purpose: '' })
const display = readDisplay({
  title: 'T', group_by_column_id: 11,
  attribution: { label: 'participant', column_id: null },
  settings: { fit_vocabulary: 'fetters', implication: false, newcombe: false },
  rows: [{ key: 'r1', construct: 'Dosage', code_ids: [], column_ids: [], fit: null,
           pins: [pin(41, 'High gain'), pin(42, 'High gain'), pin(43, 'North')] }],
})
const facts = new Map<number, JointDisplayPinFact>([41, 42, 43].map(id => [id, { excerpt_id: id, participant_id: 4,
  participant_identifier: 'T-04', speaker_label: 'R', source_name: 'FG 1', column_value: null } as JointDisplayPinFact]))

function md(keys: string[]) {
  const r = buildJointDisplayReport({ display, data: groupsData(keys), unavailable: null, facts,
    attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false,
    misfits: new Map() } as never, { coderName: () => null, withholding: false, self: 1, asOf: 'x' })
  return reportToMarkdown(r)
}

describe('#1671 D352 — pins under groups the display does not have now', () => {
  it('after regrouping (North / South), the two High gain pins are counted and named under the row', () => {
    const out = md(['North', 'South'])
    expect(out).toContain(pinsOutsideGroupsText(2, ['High gain']))
    expect(out).toContain('WORDS-43')   // the pin under a present group is placed as before
  })
  it('CONTROL: every pin under a present group — no sentence', () => {
    expect(md(['High gain', 'North'])).not.toMatch(/does not have now/)
  })
  it('the count and the names, and the words', () => {
    expect(pinsOutsideGroups(display.rows[0], ['North'])).toEqual({ count: 2, groups: ['High gain'] })
    expect(pinsOutsideGroupsText(1, ['A'])).toBe('1 pinned quote is under a group this display does not have now: “A”.')
  })
})

describe('#1671 D351 — a rule naming a gone group says so, by name', () => {
  it('reads the server’s reason and groups, never "0 of N"', () => {
    const resp = { rule_unavailable_reason: SERVER_VOCABULARY.MISFIT_RULE_GROUP_MISSING,
      rule_missing_groups: ['High gain'], rule_withheld_columns: [], matched: null, total: 15, unknown: null,
    } as unknown as JointDisplayCasesResponse
    expect(misfitStatusText(resp, true)).toBe('A condition names the group “High gain”, which this display does not have now.')
  })
})

describe('#1671 D350 — what the builder asks about before a regroup', () => {
  it('counts pins, a group rule, picked cases and stamps; nothing held asks nothing', () => {
    const held = readDisplay({ group_by_column_id: 11, rows: [
      { key: 'a', construct: 'A', pins: [pin(1, 'X')], baseline: { hash: 'h', cells: {}, stamped_at: 'd' },
        misfit: { rule: { conditions: [{ kind: 'group', group: 'X' }] }, added: [{ participant_id: 1, reason: 'r' }], removed: [] } },
    ] })
    expect(regroupHolds(held)).toEqual({ pins: 1, groupRules: 1, pickedCases: 1, stamps: 1, groups: ['X'] })
    expect(regroupNeedsAsking(held)).toBe(true)
    expect(regroupNeedsAsking(readDisplay({ group_by_column_id: 11, rows: [{ key: 'a', construct: 'A' }] }))).toBe(false)
    expect(regroupNeedsAsking({ ...held, group_by_column_id: null })).toBe(false)   // first choice: nothing to keep
  })
  it('the warning names what it holds and the GROUPS it sits under, and says nothing is cleared (#1688 D370)', () => {
    expect(regroupWarningText({ pins: 3, groupRules: 0, pickedCases: 2, stamps: 1, groups: ['High', 'Low'] })).toBe(
      'This display holds 3 pinned quotes, 2 cases picked by hand and 1 set of numbers saved with a meta-inference, '
      + 'under the groups “High” and “Low”. Nothing is cleared: a grouping with those groups brings them back.')
    expect(regroupWarningText({ pins: 1, groupRules: 0, pickedCases: 0, stamps: 0, groups: ['High'] })).toBe(
      'This display holds 1 pinned quote, under the group “High”. Nothing is cleared: a grouping with that group brings it back.')
  })
  it('names three groups and counts the rest; with no group to name, names none', () => {
    expect(regroupWarningText({ pins: 5, groupRules: 0, pickedCases: 0, stamps: 0, groups: ['A', 'B', 'C', 'D', 'E'] }))
      .toContain('under the groups “A”, “B”, “C” and 2 more.')
    expect(regroupWarningText({ pins: 0, groupRules: 0, pickedCases: 2, stamps: 1, groups: [] })).toBe(
      'This display holds 2 cases picked by hand and 1 set of numbers saved with a meta-inference, chosen under its groups. Nothing is cleared.')
  })
  it('the groups come from pins and group conditions, each once, first seen first', () => {
    const d = readDisplay({ group_by_column_id: 11, rows: [
      { key: 'a', construct: 'A', pins: [pin(1, 'Low'), pin(2, 'High'), pin(3, 'Low')] },
      { key: 'b', construct: 'B', misfit: { rule: { conditions: [{ kind: 'group', group: 'Mid' }, { kind: 'group', group: 'High' }] }, added: [], removed: [] } },
    ] })
    expect(regroupHolds(d).groups).toEqual(['Low', 'High', 'Mid'])
    expect(regroupHolds(d).groupRules).toBe(1)   // a ROW with a group condition, as before
  })
})
