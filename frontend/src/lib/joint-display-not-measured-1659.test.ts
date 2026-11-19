/**
 * #1659 — a strand NOT MEASURED on a row says WHY, in the server's reason
 * (`by_strand[key].not_measured_reason`, #823c: the client never guesses). The Compact view
 * printed "Not measured: no code bound" for every case, above the line naming the bound code a
 * merge had moved away; the shared note said "nothing from this strand is bound to the
 * construct". Here: the words for each reason, the population (every server reason has words),
 * the report table's cells (the Report view and every export), and an absent reason claiming no
 * cause. The Compact view and the open construct: `JointDisplayView.not-measured-1659.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import type { JointDisplayComputeResponse, JointDisplayRowResult, JointDisplayRowStrand } from '@/lib/api'
import { readDisplay } from '@/lib/joint-display'
import { buildJointDisplayReport, observationBesideText, type ReportConstructRow } from '@/lib/joint-display-report'
import { rowStrands } from '@/lib/joint-display-strands'
import {
  NOT_MEASURED_REASON_TEXT, SERVER_VOCABULARY as V, STRAND_NOT_MEASURED_TEXT, notMeasuredClause, notMeasuredText,
} from '@/lib/joint-display-vocabulary'

const CTX = { coderName: () => 'Me', withholding: false, self: 1, asOf: '16 Nov 2026' }

function strandOf(kind: string, status: string, reason: string | null | undefined, codes: unknown[] = []): JointDisplayRowStrand {
  const s: JointDisplayRowStrand = {
    kind, status, codes: codes as never, variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [],
  }
  return reason === undefined ? s : { ...s, not_measured_reason: reason }
}

const LIVE = {
  code_id: 31, name: 'Morale', unit: 'participants', rated: false, formed_groups: null,
  cells: [
    { group: 'High', count: 3, n: 11, share: 3 / 11, share_undefined_reason: null, passages: 4, rating: null },
    { group: 'Low', count: 1, n: 10, share: 0.1, share_undefined_reason: null, passages: 1, rating: null },
  ],
  difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
}

function data(byStrand: Record<string, JointDisplayRowStrand>): JointDisplayComputeResponse {
  const row: JointDisplayRowResult = {
    key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' }, by_strand: byStrand,
  }
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Team', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: null, rows: [row],
  }
}

const DISPLAY = {
  title: 'Morale', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-txt', kind: 'text_codes', label: 'Survey comments', text_column_ids: [44] },
    { key: 's-svy', kind: 'variables', label: 'Baseline survey', dataset_id: 2 },
    { key: 's-obs', kind: 'observation_codes', label: 'Site visits', observation_ids: null },
  ],
  rows: [{ key: 'r1', construct: 'Morale', bindings: {
    's-int': { code_ids: [31] }, 's-txt': { code_ids: [31] }, 's-svy': { column_ids: [] }, 's-obs': { code_ids: [31] } } }],
}

function report(byStrand: Record<string, JointDisplayRowStrand>) {
  const r = buildJointDisplayReport({
    display: readDisplay(DISPLAY), data: data(byStrand), unavailable: null, facts: new Map(),
    attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false, misfits: new Map(),
  }, CTX)
  return { r, row: r.rows[0] as ReportConstructRow }
}

describe('#1659 — the words for each reason', () => {
  it('each reason its own clause; "no code bound" only for nothing bound', () => {
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_NOTHING_BOUND, 'codes')).toBe('Not measured: no code bound')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_NOTHING_BOUND, 'variables')).toBe('Not measured: no variable bound')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_BOUND_GONE, 'codes')).toBe('Not measured: what it binds is no longer in this project')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_BOUND_INACTIVE, 'codes')).toBe('Not measured: what it binds is inactive in the codebook')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_NO_QUESTIONS, 'text_codes')).toBe('Not measured: none of its survey questions is in this project')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_BOUND_OTHER_DATASET, 'variables'))
      .toBe('Not measured: what it binds is in another dataset than this strand reads')
    expect(notMeasuredText(V.STRAND_NOT_MEASURED_BOUND_UNAVAILABLE, 'codes')).toBe('Not measured: nothing it binds can be shown here')
    for (const reason of Object.keys(NOT_MEASURED_REASON_TEXT).filter(r => r !== V.STRAND_NOT_MEASURED_NOTHING_BOUND)) {
      expect(notMeasuredText(reason, 'codes')).not.toMatch(/no code bound/)
    }
  })

  it('an absent or unknown reason claims no cause', () => {
    expect(notMeasuredText(null, 'codes')).toBe('Not measured')
    expect(notMeasuredText(undefined, 'codes')).toBe('Not measured')
    expect(notMeasuredText('a_reason_from_a_newer_server', 'codes')).toBe('Not measured')
    expect(notMeasuredClause(null, 'codes')).toBeNull()
  })

  it('POPULATION: every server reason (STRAND_NOT_MEASURED_*) has words, and no words lack a reason', () => {
    const server = Object.entries(V).filter(([k]) => k.startsWith('STRAND_NOT_MEASURED_')).map(([, v]) => v).sort()
    expect(server.length).toBeGreaterThanOrEqual(6)
    expect(Object.keys(NOT_MEASURED_REASON_TEXT).sort()).toEqual(server)
  })

  it('the shared note no longer says a not-measured strand binds nothing', () => {
    expect(STRAND_NOT_MEASURED_TEXT).not.toMatch(/is bound/)
    expect(STRAND_NOT_MEASURED_TEXT).toMatch(/says why/)
  })
})

describe('#1659 — the resolved strand carries the reason only while not measured', () => {
  it('a covered strand’s stray reason is ignored; a not-measured one is kept', () => {
    const display = readDisplay(DISPLAY)
    const rs = rowStrands(display, data({
      's-int': strandOf('codes', 'covers', V.STRAND_NOT_MEASURED_BOUND_GONE, [LIVE]),
      's-txt': strandOf('text_codes', 'not_measured', V.STRAND_NOT_MEASURED_NO_QUESTIONS),
    }).rows[0])
    expect(rs.find(s => s.strand.key === 's-int')!.notMeasuredReason).toBeNull()
    expect(rs.find(s => s.strand.key === 's-txt')!.notMeasuredReason).toBe(V.STRAND_NOT_MEASURED_NO_QUESTIONS)
  })
})

describe('#1659 — the report table says why in each cell (the Report view and every export)', () => {
  it('a merged-away code: "not measured (what it binds is inactive …)", never "no code bound"', () => {
    const { row } = report({
      's-int': strandOf('codes', 'not_measured', V.STRAND_NOT_MEASURED_BOUND_INACTIVE),
      's-txt': strandOf('text_codes', 'not_measured', V.STRAND_NOT_MEASURED_NO_QUESTIONS),
      's-svy': strandOf('variables', 'not_measured', V.STRAND_NOT_MEASURED_NOTHING_BOUND),
      's-obs': strandOf('observation_codes', 'not_measured', V.STRAND_NOT_MEASURED_BOUND_GONE),
    })
    const high = row.cells[0]
    expect(high).toContain('Interviews: not measured (what it binds is inactive in the codebook).')
    expect(high).toContain('Survey comments: not measured (none of its survey questions is in this project).')
    expect(high).toContain('Baseline survey: not measured (no variable bound).')
    expect(high).not.toContain('Interviews: not measured.')
  })

  it('the observation strand beside the groups says why too', () => {
    const display = readDisplay(DISPLAY)
    const rs = rowStrands(display, data({ 's-obs': strandOf('observation_codes', 'not_measured', V.STRAND_NOT_MEASURED_BOUND_GONE) }).rows[0])
      .find(s => s.strand.key === 's-obs')!
    expect(observationBesideText('Morale', rs.tag, rs)).toBe('Beside “Morale”: Site visits: not measured (what it binds is no longer in this project).')
  })

  it('a response with no reason keeps the bare words (the control: no cause is invented)', () => {
    const { row } = report({ 's-int': strandOf('codes', 'not_measured', undefined) })
    expect(row.cells[0]).toContain('Interviews: not measured.')
  })

  it('the note’s sentence is the reworded one', () => {
    const { r } = report({ 's-int': strandOf('codes', 'not_measured', V.STRAND_NOT_MEASURED_BOUND_GONE) })
    // The notice rule (2026-11-18, rewrite D): with the fit definitions, in the Definitions.
    const defs = r.definitions.join(' ')
    expect(defs).toContain(STRAND_NOT_MEASURED_TEXT)
    expect(defs).not.toContain('nothing from this strand is bound to the construct')
  })
})
