/**
 * The joint display's five (2026-11-16d, D332–D339) — the pure halves:
 *
 * - #1646 (D337): the open construct's Quotes line counts each pin against its OWN strand, in its
 *   unit (`quotePoolText`); the old line counted a survey answer against interview passages.
 * - #1665 (D335, D336): a survey strand's new dataset starts the strand over
 *   (`changeStrandDataset`), and a variable of another dataset is said as such, never "no longer
 *   in this project" — `resultStrands` CARRIES the new field (11-16c: a field-by-field copy drops
 *   a new one silently) and the report's note says it apart.
 * - #1664 (D333): a saved rule naming an inactive code names it, and says why it is not run —
 *   in the sentence every reader builds (`ruleNamesFrom`) and in the report's note.
 */
import { describe, it, expect } from 'vitest'
import type { JointDisplayCasesResponse, JointDisplayComputeResponse } from '@/lib/api'
import {
  changeStrandDataset, constructsBindingStrandVariables, readDisplay, resultStrands, type JointDisplay,
} from '@/lib/joint-display'
import { buildJointDisplayReport } from '@/lib/joint-display-report'
import { misfitReportFacts, misfitStatusText, ruleNamesFrom } from '@/lib/joint-display-cases'
import { ruleSentence, type MisfitCondition } from '@/lib/joint-display-misfit'
import {
  MISFIT_RULE_UNAVAILABLE_TEXT, otherDatasetVariablesText, quotePoolText, SERVER_VOCABULARY,
} from '@/lib/joint-display-vocabulary'

describe('#1646 — the Quotes line counts each pin against its own strand, in its unit', () => {
  it('one pool item: N is that strand’s pins only — never every pin of the group', () => {
    expect(quotePoolText([{ name: 'Planning time', n: 5, unit: 'passages', pinned: 1 }]))
      .toBe('1 of 5 coded passages pinned')
    expect(quotePoolText([{ name: 'Planning time', n: 1, unit: 'answers', pinned: 0 }]))
      .toBe('0 of 1 coded answer pinned')
  })

  it('several items of one unit read as before; mixed units each carry their own', () => {
    expect(quotePoolText([
      { name: 'A (Interviews)', n: 3, unit: 'passages', pinned: 0 },
      { name: 'A (Focus groups)', n: 2, unit: 'passages', pinned: 1 },
    ])).toBe('chosen from A (Interviews) 3 · A (Focus groups) 2 coded passages')
    expect(quotePoolText([
      { name: 'A (Interviews)', n: 5, unit: 'passages', pinned: 0 },
      { name: 'A (Comments)', n: 1, unit: 'answers', pinned: 1 },
    ])).toBe('chosen from A (Interviews) 5 coded passages · A (Comments) 1 coded answer')
    expect(quotePoolText([])).toBe('')
  })
})

const display = (rows: unknown[]): JointDisplay => readDisplay({
  title: 'T', group_by_column_id: 11,
  strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' },
    { key: 'sv', kind: 'variables', label: 'Survey', dataset_id: 1 }],
  rows,
})

describe('#1665 (D335) — a survey strand’s new dataset starts the strand over', () => {
  it('counts the constructs that chose its variables, and clears each one’s — the mark stays', () => {
    const d = display([
      { key: 'r1', construct: 'A', bindings: { sv: { column_ids: [11, 12], marked_formed: true }, iv: { code_ids: [31] } } },
      { key: 'r2', construct: 'B', bindings: { iv: { code_ids: [31] } } },
      { key: 'r3', construct: 'C', bindings: { sv: { column_ids: [null] } } },   // D202: did not travel
    ])
    expect(constructsBindingStrandVariables(d, 'sv')).toBe(2)
    const next = changeStrandDataset(d, 'sv', 2)
    expect(next.strands.find(s => s.key === 'sv')!.dataset_id).toBe(2)
    expect(next.rows.map(r => r.bindings.sv?.column_ids ?? [])).toEqual([[], [], []])
    expect(next.rows[0].bindings.sv.marked_formed).toBe(true)
    expect(next.rows[0].bindings.iv.code_ids).toEqual([31])   // another strand is untouched
    expect(next.rows[1]).toBe(d.rows[1])                       // a row that chose none is the same row
  })
})

const ROW_BASE = {
  key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
  strands: { codes: 'not_measured', variables: 'not_measured' },
}

describe('#1665 (D336) — a variable of another dataset is never "no longer in this project"', () => {
  it('resultStrands carries it per strand (the field-by-field copy), and the implicit fallback too', () => {
    const strands = resultStrands({ ...ROW_BASE, by_strand: {
      sv: { kind: 'variables', status: 'not_measured', codes: [], variables: [], observation_codes: [],
        missing_code_ids: [], missing_column_ids: [], other_dataset_column_ids: [44] } } })
    expect(strands.sv.other_dataset_column_ids).toEqual([44])
    expect(resultStrands({ ...ROW_BASE, other_dataset_column_ids: [45] }).variables.other_dataset_column_ids).toEqual([45])
  })

  it('the words: singular and plural', () => {
    expect(otherDatasetVariablesText(1)).toBe(
      '1 bound variable is from another dataset than its survey strand reads, so it is left out. Edit the row.')
    expect(otherDatasetVariablesText(2)).toBe(
      '2 bound variables are from another dataset than their survey strand reads, so they are left out. Edit the row.')
  })

  it('the report’s note says the two apart — one gone, one from another dataset — never "2 … no longer"', () => {
    const data: JointDisplayComputeResponse = {
      unit: 'participants',
      group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
      groups: [{ key: 'High', participants: 2, with_material: 2, without_coding: 0 },
        { key: 'Low', participants: 2, with_material: 2, without_coding: 0 }],
      unavailable_reason: null,
      scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
      rating: null,
      rows: [{ ...ROW_BASE, missing_column_ids: [77], other_dataset_column_ids: [44] }],
    }
    const d = readDisplay({ title: 'T', group_by_column_id: 11, rows: [{ key: 'r1', construct: 'A', column_ids: [77, 44] }] })
    const r = buildJointDisplayReport({
      display: d, data, unavailable: null, facts: new Map(), attributionWithheld: null, attributionUnusable: null,
      results: new Map(), resultsUnread: false, misfits: new Map(),
    }, { coderName: () => null, withholding: false, self: 1, asOf: '16 Nov 2026' })
    expect(r.note).toContain('1 bound item is no longer in this project and is left out.')
    expect(r.note).toContain(otherDatasetVariablesText(1))
    expect(r.note).not.toContain('2 bound items are no longer')
  })
})

describe('#1664 (D333) — a saved rule naming an inactive code names it and says why it is not run', () => {
  const RULE: MisfitCondition[] = [{ kind: 'code', strand_key: 'codes', code_id: 32, present: false }]
  const slice1 = readDisplay({ title: 'T', group_by_column_id: 11,
    rows: [{ key: 'r1', construct: 'Workload', code_ids: [32],
      misfit: { rule: { conditions: RULE }, added: [], removed: [] } }] })

  it('ruleNamesFrom names it from the inactive list — never "a code this row no longer binds"', () => {
    const names = ruleNamesFrom(slice1, 'Gain group', { codes: [], variables: [], inactive: [{ code_id: 32, name: 'Workload' }] })
    expect(ruleSentence(RULE, names)).toBe('did not use “Workload”')
    // The control: without the inactive list the old, false words come back.
    expect(ruleSentence(RULE, ruleNamesFrom(slice1, 'Gain group', { codes: [], variables: [] })))
      .toBe('did not use “a code this row no longer binds”')
  })

  it('the count line is the new reason’s words, wherever it is read (the case view, the open construct, the report)', () => {
    const resp = { rule_withheld_columns: [], rule_unavailable_reason: SERVER_VOCABULARY.MISFIT_RULE_CODE_INACTIVE,
      matched: null, total: 6, unknown: null, named_cases: [] } as unknown as JointDisplayCasesResponse
    expect(misfitStatusText(resp, true)).toBe(MISFIT_RULE_UNAVAILABLE_TEXT.code_inactive)
    expect(MISFIT_RULE_UNAVAILABLE_TEXT.code_inactive)
      .toBe('The rule names a code the codebook made inactive, so it selects no cases. Edit the rule.')

    const data: JointDisplayComputeResponse = {
      unit: 'participants',
      group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
      groups: [{ key: 'High', participants: 2, with_material: 2, without_coding: 0 },
        { key: 'Low', participants: 2, with_material: 2, without_coding: 0 }],
      unavailable_reason: null,
      scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
      rating: null,
      rows: [{ ...ROW_BASE, inactive_codes: [{ strand_key: 'codes', code_id: 32, name: 'Workload',
        merged_into_id: 31, merged_into_name: 'Barrier noted' }] }],
    }
    const r = buildJointDisplayReport({
      display: slice1, data, unavailable: null, facts: new Map(), attributionWithheld: null, attributionUnusable: null,
      results: new Map(), resultsUnread: false, misfits: new Map([['r1', misfitReportFacts(resp, true)]]),
    }, { coderName: () => null, withholding: false, self: 1, asOf: '16 Nov 2026' })
    expect(r.note).toContain('did not use “Workload”')
    expect(r.note).toContain('The rule names a code the codebook made inactive')
    expect(r.note).not.toContain('no longer binds')
  })
})
