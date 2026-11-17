/**
 * #1645 — a rated code's rating is drawn ONCE per construct, under no strand's name. The server
 * computes a rated cell per code and group only (`services/joint_display.py::_rating`, D204: the
 * mean of the group's participant scores, each over every rated passage of that person in the
 * project), so it is the same number under every strand binding the code; drawn as
 * "Comments · rated" it read as if the survey comments were rated. The report table — the Report
 * view and the Markdown, HTML and Word exports — and `rowRatedCodes` are checked here; the
 * Compact view in `JointDisplayView.rated-once-1645.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import type { JointDisplayComputeResponse, JointDisplayRowResult, JointDisplayRowStrand } from '@/lib/api'
import { readDisplay } from '@/lib/joint-display'
import { buildJointDisplayReport, reportToMarkdown, type ReportConstructRow } from '@/lib/joint-display-report'
import { rowRatedCodes, rowStrands } from '@/lib/joint-display-strands'
import { RATED_LINE_TAG, RATING_BASIS_TEXT } from '@/lib/joint-display-vocabulary'

const CTX = { coderName: () => 'Me', withholding: false, self: 1, asOf: '16 Nov 2026' }

/** One code's answer on a strand; `rated` codes carry the person-level rating, the same everywhere. */
function code(codeId: number, name: string, rated: boolean, high: number) {
  const rating = (mean: number | null, n: number) => (rated ? { mean, n, undefined_reason: mean == null ? 'no_scores' : null } : null)
  return {
    code_id: codeId, name, unit: 'participants', rated, formed_groups: null,
    cells: [
      { group: 'High', count: high, n: 11, share: high / 11, share_undefined_reason: null, passages: 9, rating: rating(-0.25, 4) },
      { group: 'Low', count: 1, n: 10, share: 0.1, share_undefined_reason: null, passages: 2, rating: rating(null, 0) },
    ],
    difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}

function strandOf(kind: string, status: string, codes: ReturnType<typeof code>[] = []): JointDisplayRowStrand {
  return { kind, status, codes, variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [] }
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
    rating: { basis: 'mean_of_participant_scores', score_basis: 'median', scope: 'every_rated_passage_in_the_project', excluded_ratings: {}, unavailable_reason: null },
    rows: [row],
  }
}

/** Interviews and Survey comments, both binding the rated code 31 and the plain code 32. */
const TWO = {
  title: 'Morale', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-txt', kind: 'text_codes', label: 'Survey comments', text_column_ids: [44] },
  ],
  rows: [{ key: 'r1', construct: 'Morale', bindings: { 's-int': { code_ids: [31, 32] }, 's-txt': { code_ids: [31, 32] } } }],
}
const BOTH = {
  's-int': strandOf('codes', 'covers', [code(31, 'Morale', true, 7), code(32, 'Workload', false, 3)]),
  's-txt': strandOf('text_codes', 'covers', [code(31, 'Morale', true, 2), code(32, 'Workload', false, 1)]),
}

function report(display: unknown, byStrand: Record<string, JointDisplayRowStrand>) {
  const r = buildJointDisplayReport({
    display: readDisplay(display), data: data(byStrand), unavailable: null, facts: new Map(),
    attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false, misfits: new Map(),
  }, CTX)
  return { r, row: r.rows[0] as ReportConstructRow }
}

const count = (s: string, sub: string) => s.split(sub).length - 1

describe('#1645 — the report: one "Rated:" sentence per rated code, after the strands, under no strand', () => {
  it('two strands binding one rated code: the rating once, never after a strand’s line', () => {
    const { row } = report(TWO, BOTH)
    const high = row.cells[0]
    expect(count(high, '-0.25 (4 scores)')).toBe(1)
    expect(high).toContain(`${RATED_LINE_TAG}: Morale -0.25 (4 scores).`)
    expect(high).not.toMatch(/; rated/)
    // after BOTH strands' lines, so it reads as the construct's, not the last strand's
    expect(high.indexOf(`${RATED_LINE_TAG}:`)).toBeGreaterThan(high.lastIndexOf('Survey comments:'))
    // a group with no score says why, once
    expect(count(row.cells[1], 'Nobody in this group has a score on this code')).toBe(1)
  })

  it('a rated code bound only to the comments strand is still not called the comments’ rating', () => {
    const only = { ...TWO, rows: [{ ...TWO.rows[0], bindings: { 's-int': { code_ids: [32] }, 's-txt': { code_ids: [31] } } }] }
    const { row } = report(only, {
      's-int': strandOf('codes', 'covers', [code(32, 'Workload', false, 3)]),
      's-txt': strandOf('text_codes', 'covers', [code(31, 'Morale', true, 2)]),
    })
    expect(row.cells[0]).toContain(`${RATED_LINE_TAG}: Morale -0.25 (4 scores).`)
    expect(row.cells[0]).not.toMatch(/Survey comments: Morale[^.]*rated/)
  })

  it('an unrated code draws no rating (the control), and the note says the rating belongs to no strand', () => {
    const { r, row } = report(TWO, BOTH)
    expect(row.cells[0]).not.toContain(`${RATED_LINE_TAG}: Workload`)
    expect(r.note).toContain(RATING_BASIS_TEXT)
    expect(RATING_BASIS_TEXT).toMatch(/belongs to no one strand/)
  })

  it('every file prints the same once-only rating (the Markdown export reads the same table)', () => {
    const { r } = report(TWO, BOTH)
    const md = reportToMarkdown(r)
    expect(count(md, '-0.25 (4 scores)')).toBe(1)
  })

  it('a strand that is not measured lends no rating; the rating stays while another strand draws the code', () => {
    const { row } = report(TWO, { 's-int': BOTH['s-int'], 's-txt': strandOf('text_codes', 'not_measured') })
    expect(count(row.cells[0], '-0.25 (4 scores)')).toBe(1)
    const none = report(TWO, { 's-int': strandOf('codes', 'not_measured'), 's-txt': strandOf('text_codes', 'not_measured') })
    expect(none.row.cells[0]).not.toContain(`${RATED_LINE_TAG}:`)
  })
})

describe('#1645 — rowRatedCodes', () => {
  it('each rated code once, in the order the per-group strands first draw it; unrated codes never', () => {
    const display = readDisplay(TWO)
    const strands = rowStrands(display, data(BOTH).rows[0])
    expect(rowRatedCodes(strands).map(s => s.code_id)).toEqual([31])
    const two = {
      's-int': strandOf('codes', 'covers', [code(33, 'Trust', true, 1), code(31, 'Morale', true, 7)]),
      's-txt': strandOf('text_codes', 'covers', [code(31, 'Morale', true, 2), code(34, 'Voice', true, 2)]),
    }
    expect(rowRatedCodes(rowStrands(display, data(two).rows[0])).map(s => s.code_id)).toEqual([33, 31, 34])
  })
})
