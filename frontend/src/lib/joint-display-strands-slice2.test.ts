/**
 * Joint display slice 2 (r2, reconciled onto r1's model and wire — the combine) — three or more
 * strands and observation strands, as every reader draws them: a row's answer per strand
 * (`by_strand`), a strand's display-level facts (`response.strands`), the drift keys (r2-7 = r1-7),
 * the fits per named pair (r2-3, r1-8 — always `row.fits`, R2), the builder's edits (r2-1, r2-4)
 * and the report table the Report view and the three exports print (r2-2, r2-6).
 *
 * 🔴 POSITIVE CONTROLS: a slice-1 display (no `strands` key) reads as its implicit pair, draws and
 * reports exactly as it did — and r1's wire answering it reports the same table as slice 1's.
 * (File renamed from r2's `joint-display-slice2.test.ts`: r1's test holds that name.)
 */
import { describe, it, expect } from 'vitest'
import type { JointDisplayComputeResponse, JointDisplayObservationCode, JointDisplayRowResult, JointDisplayRowStrand, JointDisplayStrandResult } from '@/lib/api'
import { computeRequest, displayCoderScope, pinPassagesRequest, readDisplay, rowCells, rowDrift } from '@/lib/joint-display'
import {
  isImplicitPair, makeStrandsExplicit, nextPair, pairNotApplicable, rowFits, writeFits, moveStrand, removeStrand, rowStrands, strandsProblem, strandTag,
} from '@/lib/joint-display-strands'
import { buildJointDisplayReport, type ReportConstructRow } from '@/lib/joint-display-report'
import { stampBaseline } from '@/components/canvas/joint-display/display-helpers'

const CTX = { coderName: () => 'Me', withholding: false, self: 1, asOf: '15 Nov 2026' }

function codeStrand(codeId: number, name: string, high: number, low: number) {
  return {
    code_id: codeId, name, unit: 'participants', rated: false, formed_groups: null,
    cells: [
      { group: 'High', count: high, n: 11, share: high / 11, share_undefined_reason: null, passages: 9, rating: null },
      { group: 'Low', count: low, n: 10, share: low / 10, share_undefined_reason: null, passages: 2, rating: null },
    ],
    difference: { value: high / 11 - low / 10, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}

const HOURS = {
  column_id: 12, name: 'Training hours', dataset_id: 2, unit: 'participants', formed_groups: null, summary: 'mean',
  unavailable_reason: null, categories: [],
  cells: [
    { group: 'High', n: 11, mean: 30, mean_undefined_reason: null, sd: 4, sd_undefined_reason: null, distribution: [] },
    { group: 'Low', n: 10, mean: 18, mean_undefined_reason: null, sd: 5, sd_undefined_reason: null, distribution: [] },
  ],
  effect: { d: 2.5, ci_lower: 1.3, ci_upper: 3.6, ci_level: 0.95, ci_method: 'hedges_olkin_normal', unavailable_reason: null },
}

/** A slice-1 answer (the wire at HEAD). */
function slice1Row(): JointDisplayRowResult {
  return {
    key: 'r1', codes: [codeStrand(31, 'Planning time', 7, 0)], variables: [HOURS as never],
    missing_code_ids: [], missing_column_ids: [], strands: { codes: 'covers', variables: 'covers' },
  }
}

/** One strand of a row on r1's wire (`by_strand[key]`): only its kind's list filled. */
function strandOf(kind: string, status: string, lists: Partial<Pick<JointDisplayRowStrand, 'codes' | 'variables' | 'observation_codes'>>): JointDisplayRowStrand {
  return { kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], ...lists }
}

/** The same answer on r1's wire: `by_strand` keyed by the implicit pair, slice 1's fields its projection. */
function c2ImplicitRow(): JointDisplayRowResult {
  return {
    ...slice1Row(),
    by_strand: {
      variables: strandOf('variables', 'covers', { variables: [HOURS as never] }),
      codes: strandOf('codes', 'covers', { codes: [codeStrand(31, 'Planning time', 7, 0)] }),
    },
  }
}

function response(rows: JointDisplayRowResult[], strands?: JointDisplayStrandResult[]): JointDisplayComputeResponse {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: null,
    ...(strands ? { strands } : {}),
    rows,
  }
}

const SLICE1 = {
  title: 'Teachers', group_by_column_id: 11, conversation_ids: null, document_ids: null,
  rows: [{ key: 'r1', construct: 'Protected planning time', code_ids: [31], column_ids: [12], fit: 'expansion' }],
}

/** Three per-group strands and an observation strand beside them. */
const NAMED = {
  title: 'Teachers', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5, 6], document_ids: [] },
    { key: 's-fg', kind: 'codes', label: 'Focus groups', conversation_ids: [7], document_ids: [] },
    { key: 's-svy', kind: 'variables', label: 'Baseline survey', dataset_id: 2 },
    { key: 's-obs', kind: 'observation_codes', label: 'Site visits', observation_ids: null },
  ],
  rows: [{
    key: 'r1', construct: 'Protected planning time', fit: 'expansion',
    bindings: {
      's-int': { code_ids: [31] }, 's-fg': { code_ids: [31] }, 's-svy': { column_ids: [12] }, 's-obs': { code_ids: [31] },
    },
    status: { 's-fg': 'silent' },
  }],
}

/** The L2 measure, r1's field names (R6): 2 of 3 observations, 9 of 60 minutes; no clips while cuts are open. */
const OBS_CODE: JointDisplayObservationCode = {
  code_id: 31, name: 'Planning time', unit: 'observations', observations: 2, of_observations: 3, seconds: 540,
  observed_seconds: 3600, time_share: 0.15, time_share_undefined_reason: null, clips: null, of_clips: null,
  clips_undefined_reason: 'clips_open_cuts', rating_unavailable_reason: null,
}
const OBS_OPEN: JointDisplayRowStrand = strandOf('observation_codes', 'covers', { observation_codes: [OBS_CODE] })
/** The observation strand's display-level facts (`response.strands[i].observations`). */
function obsFacts(segmentation: string, agreed = 0): JointDisplayStrandResult {
  return { key: 's-obs', kind: 'observation_codes', unit: 'observations', dataset_id: null, groups: null, scope: null,
    observations: { chosen: 3, with_coding: 2, agreed, observed_seconds: 3600, segmentation } }
}

function namedRow(obs: JointDisplayRowStrand = OBS_OPEN): JointDisplayRowResult {
  return {
    key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'covers' },
    by_strand: {
      's-int': strandOf('codes', 'covers', { codes: [codeStrand(31, 'Planning time', 7, 0)] }),
      's-fg': strandOf('codes', 'covers', { codes: [codeStrand(31, 'Planning time', 2, 2)] }),
      's-svy': strandOf('variables', 'covers', { variables: [HOURS as never] }),
      's-obs': obs,
    },
  }
}

function report(display: unknown, rows: JointDisplayRowResult[], strands: JointDisplayStrandResult[] = [obsFacts('open')]) {
  return buildJointDisplayReport({
    display: readDisplay(display), data: response(rows, strands), unavailable: null, facts: new Map(),
    attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false, misfits: new Map(),
  }, CTX)
}

describe('the model reads strands (r1-1) — and a slice-1 display as its implicit pair', () => {
  it('reads explicit strands, per-strand bindings and status, the fit pair, and a pin’s strand', () => {
    const d = readDisplay({ ...NAMED, rows: [{ ...NAMED.rows[0], fit_strands: ['s-fg', 's-svy'],
      pins: [{ excerptId: 41, displayText: 'x', group: 'High', strand: 's-fg' }] }] })
    expect(d.strands.map(s => [s.key, s.kind, s.label])).toEqual([
      ['s-int', 'codes', 'Interviews'], ['s-fg', 'codes', 'Focus groups'],
      ['s-svy', 'variables', 'Baseline survey'], ['s-obs', 'observation_codes', 'Site visits']])
    expect(d.strands[0].conversation_ids).toEqual([5, 6])
    expect(d.rows[0].bindings['s-svy'].column_ids).toEqual([12])
    expect(d.rows[0].status['s-fg']).toBe('silent')
    // R2: slice 1's one-pair storage (`fit` + `fit_strands`) is READ as one fit over that pair.
    expect(d.rows[0].fits).toEqual([{ strands: ['s-fg', 's-svy'], fit: 'expansion' }])
    expect(d.rows[0].pins[0].strand).toBe('s-fg')
  })

  it('POSITIVE CONTROL: a slice-1 display reads as its implicit pair, asks it as strands, and draws Survey then Coded', () => {
    const d = readDisplay(SLICE1)
    expect(isImplicitPair(d)).toBe(true)
    expect(d.strands.map(s => [s.key, s.kind, s.dataset_id])).toEqual([['codes', 'codes', null], ['variables', 'variables', null]])
    const req = computeRequest(d, displayCoderScope(false, 1))!
    expect(req.strands.map(s => [s.key, s.conversation_ids, s.dataset_id])).toEqual([['codes', null, null], ['variables', null, null]])
    expect(req.rows).toEqual([{ key: 'r1', bindings: {
      codes: { code_ids: [31], column_ids: [], marked_formed: false },
      variables: { code_ids: [], column_ids: [12], marked_formed: false } } }])
    expect(rowStrands(d, slice1Row()).map(rs => [rs.tag, rs.placement])).toEqual([['Survey', 'per_group'], ['Coded', 'per_group']])
  })

  it('a display with named strands sends them and each row’s bindings (C2)', () => {
    const req = computeRequest(readDisplay(NAMED), displayCoderScope(false, 1))!
    expect(req.strands?.map(s => [s.key, s.kind])).toEqual([['s-int', 'codes'], ['s-fg', 'codes'], ['s-svy', 'variables'], ['s-obs', 'observation_codes']])
    expect(req.strands[0].conversation_ids).toEqual([5, 6])
    expect(req.rows[0].bindings['s-svy']).toEqual({ code_ids: [], column_ids: [12], marked_formed: false })
  })
})

describe('r2-7 = r1-7 (R4) — drift keys: per strand, and slice 1’s keys kept', () => {
  it('the implicit pair keeps slice 1’s keys, on either wire — a slice-1 baseline does not read as moved', () => {
    expect(Object.keys(rowCells(slice1Row())).sort()).toEqual(Object.keys(rowCells(c2ImplicitRow())).sort())
    expect(rowCells(slice1Row())['code:31:High']).toBe('7 of 11')
    expect(rowDrift(stampBaseline(slice1Row()), c2ImplicitRow())).toEqual([])
  })

  it('two strands binding ONE code keep two cells, keyed by strand, and the drift line names the strand', () => {
    const cells = rowCells(namedRow())
    expect(cells['code:31@s-int:Low']).toBe('0 of 10')
    expect(cells['code:31@s-fg:Low']).toBe('2 of 10')
    expect(cells['variable:12@s-svy:effect']).toBeDefined()
    expect(cells['observation:31@s-obs:beside']).toBe('2 of 3 observations · 15% of observed time (9 min)')
    const moved = namedRow()
    moved.by_strand!['s-fg'] = strandOf('codes', 'covers', { codes: [codeStrand(31, 'Planning time', 3, 2)] })
    const changes = rowDrift(stampBaseline(namedRow()), moved, k => ({ 's-fg': 'Focus groups' } as Record<string, string>)[k] ?? k)
    expect(changes.map(c => c.label)).toEqual(['Planning time (Focus groups), High', 'Planning time (Focus groups), difference'])
  })

  it('found beside: a group whose label holds a colon is named whole', () => {
    const row = slice1Row()
    row.codes[0].cells[0].group = 'Band: 6'
    const changes = rowDrift({ hash: 'x', cells: {}, stamped_at: '' }, row)
    expect(changes.map(c => c.label)).toContain('Planning time, Band: 6')
  })
})

describe('r2-3 / r1-8 — a fit names the pair it compares', () => {
  const pairs = (d: ReturnType<typeof readDisplay>) => rowFits(d, d.rows[0]).map(f => f.pair.map(s => s.key))
  it('slice 1’s one `fit` on an explicit display reads over the first two per-group strands it binds', () => {
    expect(pairs(readDisplay(NAMED))).toEqual([['s-int', 's-fg']])
  })
  it('a stored pair wins — and one naming a removed strand is dropped, leaving the default', () => {
    const fits = (f: unknown) => readDisplay({ ...NAMED, rows: [{ ...NAMED.rows[0], fit: undefined, fits: f }] })
    expect(pairs(fits([{ strands: ['s-svy', 's-obs'], fit: null }]))).toEqual([['s-svy', 's-obs']])
    expect(pairs(fits([{ strands: ['s-gone', 's-svy'], fit: 'expansion' }]))).toEqual([['s-int', 's-fg']])
  })
  it('with one per-group strand there is no DEFAULT pair (r1-8) — the researcher names it; a lone strand has none', () => {
    // Reconciled: r2 defaulted to a per-group strand + the one beside; r1's model (pinned by its
    // own test) offers no default below two per-group strands, and the pair is one click away.
    const two = readDisplay({ ...NAMED, strands: [NAMED.strands[3], NAMED.strands[2]] })
    expect(rowFits(two, two.rows[0])).toEqual([])
    expect(nextPair(two, two.rows[0])!.map(s => s.key)).toEqual(['s-obs', 's-svy'])
    const one = readDisplay({ ...NAMED, strands: [NAMED.strands[2]] })
    expect(rowFits(one, one.rows[0])).toEqual([])
    expect(nextPair(one, one.rows[0])).toBeNull()
  })
})

describe('r2-2, r2-6 — the report table (the Report view and the three exports)', () => {
  const r = report(NAMED, [namedRow()])
  const row = r.rows[0] as ReportConstructRow
  it('each group’s cell tags every per-group strand with its name, in display order', () => {
    expect(row.cells[0]).toBe(
      'Interviews: Planning time 7 of 11. Focus groups: Planning time 2 of 11. Baseline survey: Training hours 30.00 (SD 4.00), n 11.')
  })
  it('the differences name each strand; the fit names its pair and the silent strand', () => {
    expect(row.cells[2]).toContain('Training hours (Baseline survey): d = 2.50')
    expect(row.cells[2]).toContain('Planning time (Focus groups): ')
    expect(row.cells[3]).toBe('Interviews · Focus groups: expansion (Focus groups silent)')
  })
  it('an observation strand stands BESIDE the construct on a row of its own, with its unit and why', () => {
    expect(r.rows[1]).toEqual({ kind: 'beside', rowKey: 'r1', text:
      'Beside “Protected planning time”: Site visits (3 observations): Planning time 2 of 3 observations · 15% of observed time (9 min). Observations are not linked to participants, so this strand is drawn once across the groups and never split by group.' })
  })
  it('the note lists each strand by kind and the observation strand’s basis', () => {
    expect(r.note).toContain('Strands: Interviews and Focus groups (codes); Baseline survey (survey variables); Site visits (observation codes).')
    expect(r.note).toContain("An observation cell gives the observations with at least one clip coded with the code, out of the strand's observations, and the coded time as a share of the observed time. It never counts participants.")
    expect(r.note).toContain('Clips are not counted while each coder cuts their own')
  })
  it('a not-measured observation strand says so beside the row and in the fit', () => {
    const r2 = report(NAMED, [namedRow({ ...OBS_OPEN, status: 'not_measured', observation_codes: [] })])
    expect((r2.rows[1] as { text: string }).text).toBe('Beside “Protected planning time”: Site visits: not measured.')
    expect((r2.rows[0] as ReportConstructRow).cells[3]).toBe('Interviews · Focus groups: expansion (Focus groups silent; Site visits not measured)')
    expect((r2.rows[0] as ReportConstructRow).cells[0]).not.toContain('Site visits')   // never in a group's cell
  })
  it('POSITIVE CONTROL: a slice-1 display reports the same table on either wire, in slice 1’s words', () => {
    const a = report(SLICE1, [slice1Row()], [])
    const b = report(SLICE1, [c2ImplicitRow()], [])
    expect(b).toEqual(a)
    expect((a.rows[0] as ReportConstructRow).cells[0]).toBe('Survey: Training hours 30.00 (SD 4.00), n 11. Coded: Planning time 7 of 11.')
    expect((a.rows[0] as ReportConstructRow).cells[3]).toBe('Expansion')
    expect(a.note).not.toContain('Strands:')
  })
})

describe('r2-6 / R6 — the observation strand in its own unit (the literature’s L2)', () => {
  const agreed = strandOf('observation_codes', 'covers', { observation_codes: [{ ...OBS_CODE, seconds: 10,
    time_share: 10 / 3600, clips: 5, of_clips: 40, clips_undefined_reason: null }] })
  it('a clip count only where clips are agreed; the note says which', () => {
    expect(rowCells(namedRow(agreed))['observation:31@s-obs:beside']).toBe('2 of 3 observations · <1% of observed time (10 s) · 5 clips')
    const r = report(NAMED, [namedRow(agreed)], [obsFacts('agreed', 3)])
    expect(r.note).toContain("Clips are counted because the observations' clips were agreed (their segmentation is frozen).")
    expect(r.note).not.toContain('Clips are not counted')
  })
  it('mixed segmentation: clips are counted in the AGREED observations only, and the note says how many (R6)', () => {
    const r = report(NAMED, [namedRow(agreed)], [obsFacts('mixed', 2)])
    expect(r.note).toContain("Clips are counted in the 2 of 3 observations whose clips were agreed; the others' clips are not counted, because each coder cut their own.")
    expect(r.note).not.toContain("Clips are counted because the observations' clips were agreed")
    expect(r.note).not.toContain('Clips are not counted while')
  })
  it('D304: a RATED code on clips says why it draws no rating — beside the row, so the Compact view and every file carry it', () => {
    // The prototype defined the sentence and rendered it nowhere (found by the build's drive).
    const rated = strandOf('observation_codes', 'covers', { observation_codes: [{ ...OBS_CODE,
      rating_unavailable_reason: 'clips_name_no_participant' }] })
    const r = report(NAMED, [namedRow(rated)])
    expect((r.rows[1] as { text: string }).text).toContain(
      'Ratings are not shown for clips: a rating score belongs to a participant, and a clip names none.')
    // POSITIVE CONTROL: an unrated code on clips says nothing about ratings.
    const plain = report(NAMED, [namedRow(OBS_OPEN)])
    expect((plain.rows[1] as { text: string }).text).not.toContain('Ratings are not shown')
  })
  it('a time share drawn as "—" says why, once per strand (an undefined number states its reason)', () => {
    const noDuration = { ...OBS_CODE, observed_seconds: null, time_share: null, time_share_undefined_reason: 'duration_unknown' }
    const r = report(NAMED, [namedRow(strandOf('observation_codes', 'covers', {
      observation_codes: [noDuration, { ...noDuration, code_id: 32, name: 'Barrier noted' }] }))])
    const text = (r.rows[1] as { text: string }).text
    expect(text).toContain('Planning time 2 of 3 observations · —')
    expect(text.split('No share of observed time: an observation has no recorded duration.')).toHaveLength(2)
    // POSITIVE CONTROL: a defined share says nothing of the kind.
    expect(((report(NAMED, [namedRow(OBS_OPEN)]).rows[1]) as { text: string }).text).not.toContain('No share of observed time')
  })
})

// r2's M16, reconciled (R2): MAX_FITS_PER_ROW = 1 (shape (i)) fails this block's first three tests,
// the view's "Compare another pair" test and the "no default pair" test above; the last test here
// is a positive control and passes under either shape.
describe('r2-3, r2-8 — shape (ii): a fit per NAMED pair', () => {
  const d = readDisplay({ ...NAMED, rows: [{ ...NAMED.rows[0], fit: null, fits: [
    { strands: ['s-int', 's-svy'], fit: 'expansion' }, { strands: ['s-fg', 's-obs'], fit: 'discordance' },
    { strands: ['s-int', 's-gone'], fit: 'confirmation' }] }] })
  it('reads each pair with its fit, dropping one that names a removed strand; prints each WITH its pair', () => {
    expect(rowFits(d, d.rows[0]).map(f => [f.pair[0].key, f.pair[1].key, f.fit]))
      .toEqual([['s-int', 's-svy', 'expansion'], ['s-fg', 's-obs', 'discordance']])
    const r = buildJointDisplayReport({ display: d, data: response([namedRow()]), unavailable: null, facts: new Map(),
      attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false, misfits: new Map() }, CTX)
    expect((r.rows[0] as ReportConstructRow).cells[3])
      .toBe('Interviews · Baseline survey: expansion; Focus groups · Site visits: discordance (Focus groups silent)')
  })
  it('fits are ALWAYS written as `fits` (R2), one or many; a new pair is the first not yet recorded', () => {
    const row = d.rows[0]
    expect(writeFits(d, row, [{ strands: ['s-int', 's-fg'], fit: 'confirmation' }]))
      .toEqual({ fits: [{ strands: ['s-int', 's-fg'], fit: 'confirmation' }] })
    expect(writeFits(d, row, [{ strands: ['s-svy', 's-obs'], fit: null }]))
      .toEqual({ fits: [{ strands: ['s-svy', 's-obs'], fit: null }] })
    expect(writeFits(d, row, [{ strands: ['s-int', 's-fg'], fit: null }, { strands: ['s-int', 's-svy'], fit: 'expansion' }]).fits)
      .toHaveLength(2)
    expect(nextPair(d, row)!.map(s => s.key)).toEqual(['s-int', 's-fg'])
  })
  it('DERIVED not applicable: neither strand of the pair has evidence (not measured or recorded silent)', () => {
    const row = { ...d.rows[0], status: { 's-fg': 'silent' as const } }
    const notMeasuredObs = namedRow({ ...OBS_OPEN, status: 'not_measured', observation_codes: [] })
    const pair = rowFits(d, row)[1].pair   // Focus groups (silent) · Site visits (not measured)
    expect(pairNotApplicable(d, row, notMeasuredObs, pair)).toBe(true)
    expect(pairNotApplicable(d, row, namedRow(), pair)).toBe(false)   // Site visits has evidence: silence is the researcher's
    const r = buildJointDisplayReport({ display: { ...d, rows: [row] }, data: response([notMeasuredObs]), unavailable: null,
      facts: new Map(), attributionWithheld: null, attributionUnusable: null, results: new Map(), resultsUnread: false, misfits: new Map() }, CTX)
    expect((r.rows[0] as ReportConstructRow).cells[3]).toContain('Focus groups · Site visits: not applicable')
  })
  it('POSITIVE CONTROL: a two-strand display has one pair and nothing to add', () => {
    const two = readDisplay({ ...NAMED, strands: NAMED.strands.slice(0, 2) })
    expect(rowFits(two, two.rows[0])).toHaveLength(1)
    expect(nextPair(two, { ...two.rows[0], fits: [] })).toBeNull()
  })
})

describe('r2-9 — the Report prints the ePIP overview: each construct against each strand', () => {
  it('with three or more strands, an overview table first among the tables after the display', () => {
    const r = report(NAMED, [namedRow({ ...OBS_OPEN, status: 'not_measured', observation_codes: [] })])
    expect(r.appendix[0].title).toBe('Strands by construct: identified or not identified')
    expect(r.appendix[0].table.headers).toEqual(['Construct', 'Interviews', 'Focus groups', 'Baseline survey', 'Site visits'])
    expect(r.appendix[0].table.rows).toEqual([['Protected planning time', 'Identified', 'Not identified (silent)', 'Identified', 'Not identified (not measured)']])
    expect(report(SLICE1, [slice1Row()], []).appendix).toEqual([])   // POSITIVE CONTROL: slice 1 prints none
  })
})

describe('r2-12 — r4’s open-text strand ("Survey comments") in the cells and the note', () => {
  const TEXT = { ...NAMED, strands: [NAMED.strands[0], { key: 's-txt', kind: 'text_codes', label: 'Survey comments', text_column_ids: [44] }],
    rows: [{ key: 'r1', construct: 'Protected planning time', fit: null, bindings: { 's-int': { code_ids: [31] }, 's-txt': { code_ids: [31] } } }] }
  const textCode = { ...codeStrand(31, 'Planning time', 4, 1),
    cells: codeStrand(31, 'Planning time', 4, 1).cells.map((c, i) => ({ ...c, n: i === 0 ? 9 : 7 })) }
  const row: JointDisplayRowResult = { key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' }, by_strand: {
      's-int': strandOf('codes', 'covers', { codes: [codeStrand(31, 'Planning time', 7, 0)] }),
      's-txt': strandOf('text_codes', 'covers', { codes: [textCode] }) } }
  // r1's wire: the surveyed count is the strand's display-level fact, per group.
  const txtFacts: JointDisplayStrandResult = { key: 's-txt', kind: 'text_codes', unit: 'participants', dataset_id: null,
    scope: null, observations: null, groups: [{ key: 'High', with_material: 9, without_coding: 0, surveyed: 30 },
      { key: 'Low', with_material: 7, without_coding: 0, surveyed: 28 }] }
  it('a cell is "4 of 9 answered (30 surveyed)", the note carries r4’s sentence, and the questions ride the request', () => {
    const r = report(TEXT, [row], [txtFacts])
    expect((r.rows[0] as ReportConstructRow).cells[0]).toContain('Survey comments: Planning time 4 of 9 answered (30 surveyed).')
    expect(r.note).toContain('An open-text count is the participants whose answer to these questions carries the code')
    // Drift keeps the row's own numbers; the surveyed count is a display-level fact, not a row cell.
    expect(rowCells(row)['code:31@s-txt:High']).toBe('4 of 9 answered')
    expect(computeRequest(readDisplay(TEXT), displayCoderScope(false, 1))!.strands[1].text_column_ids).toEqual([44])
  })
  it('none ticked is none — and the builder will not insert it', () => {
    const none = readDisplay({ ...TEXT, strands: [TEXT.strands[0], { ...TEXT.strands[1], text_column_ids: undefined }] })
    expect(none.strands[1].text_column_ids ?? []).toEqual([])
    expect(computeRequest(none, displayCoderScope(false, 1))!.strands[1].text_column_ids).toEqual([])
    expect(strandsProblem(none)).toBe('Choose at least one question for every survey comments strand.')
  })
})

describe('r2-5 / R9 — a quote is chosen from its code strand’s own sources', () => {
  it('a pin’s strand names its sources; a pin with none reads the first code strand’s; a slice-1 display its own', () => {
    const d = readDisplay(NAMED)
    const sources = (dd: ReturnType<typeof readDisplay>, key: string | undefined) => {
      const r = pinPassagesRequest(dd, key, 'High', 31, displayCoderScope(false, 1))!
      return { conversation_ids: r.conversation_ids, document_ids: r.document_ids }
    }
    expect(sources(d, 's-fg')).toEqual({ conversation_ids: [7], document_ids: [] })
    expect(sources(d, undefined)).toEqual({ conversation_ids: [5, 6], document_ids: [] })
    expect(sources(readDisplay({ ...SLICE1, conversation_ids: [9] }), undefined)).toEqual({ conversation_ids: [9], document_ids: null })
  })
})

describe('r2-1, r2-4 — the builder’s strand edits', () => {
  it('making a slice-1 display explicit keeps the pair’s keys (so its baselines still match) and splits datasets', () => {
    const before = readDisplay({ ...SLICE1, conversation_ids: [5],
      rows: [...SLICE1.rows, { key: 'r2', construct: 'Confidence', code_ids: [], column_ids: [21] }] })
    const d = makeStrandsExplicit(before, id => (id === 12 ? 2 : id === 21 ? 3 : null))
    expect(d.strands.map(s => [s.key, s.kind, s.dataset_id])).toEqual([
      ['variables', 'variables', 2], [d.strands[1].key, 'variables', 3], ['codes', 'codes', null]])
    expect(d.strands[2].conversation_ids).toEqual([5])
    expect(d.rows[0].bindings.variables.column_ids).toEqual([12])
    expect(d.rows[1].bindings[d.strands[1].key].column_ids).toEqual([21])
    expect(d.rows[0].bindings.codes.code_ids).toEqual([31])   // the codes binding keeps its key
    expect(isImplicitPair(before)).toBe(true)   // R5: reading split nothing — the edit did
    expect(before.strands.find(s => s.kind === 'variables')!.dataset_id).toBeNull()
    expect(rowDrift(stampBaseline(slice1Row()), c2ImplicitRow())).toEqual([])
    expect(strandTag(d, d.strands[2])).toBe('Codes')   // unnamed until the researcher names it
    expect(strandsProblem(d)).toBe('Name every strand.')
  })
  it('removing a strand takes its bindings, status and any fit pair naming it; moving reorders', () => {
    const d = readDisplay({ ...NAMED, rows: [{ ...NAMED.rows[0], fit: undefined,
      fits: [{ strands: ['s-fg', 's-svy'], fit: 'expansion' }, { strands: ['s-int', 's-svy'], fit: 'confirmation' }] }] })
    const x = removeStrand(d, 's-fg')
    expect(x.strands.map(s => s.key)).toEqual(['s-int', 's-svy', 's-obs'])
    expect(x.rows[0].bindings['s-fg']).toBeUndefined()
    expect(x.rows[0].status['s-fg']).toBeUndefined()
    expect(x.rows[0].fits).toEqual([{ strands: ['s-int', 's-svy'], fit: 'confirmation' }])
    expect(moveStrand(d, 's-svy', -1).strands.map(s => s.key)).toEqual(['s-int', 's-svy', 's-fg', 's-obs'])
  })
  it('refuses fewer than two strands and a survey strand with no dataset', () => {
    expect(strandsProblem(readDisplay({ ...NAMED, strands: [NAMED.strands[0]] }))).toBe('A joint display compares at least two strands.')
    expect(strandsProblem(readDisplay({ ...NAMED, strands: [NAMED.strands[0], { ...NAMED.strands[2], dataset_id: null }] })))
      .toBe('Choose a dataset for every survey strand.')
    expect(strandsProblem(readDisplay(NAMED))).toBeNull()
  })
})
