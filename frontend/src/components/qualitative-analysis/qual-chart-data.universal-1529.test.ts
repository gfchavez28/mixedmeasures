/**
 * #1529 (1.5.9) — a universal code ("Unclear", "Unsubstantive/Artifact") has no share of the coded
 * total anywhere a chart or table draws one.
 *
 * #1526 D79 withheld a universal row's coded share on the summary table — per CODE. Two places
 * still printed one:
 * - D91 (server, `test_per_category_universal_1529.py`): under *Per Category* every row arrived
 *   `is_universal: false`, so the table and its file printed "Unclear" at 120%. The client half is
 *   unchanged; these cases feed it the flag the server now sends and pin that it is honoured.
 * - D92 (here): the heatmap, bar and stacked bar under *Proportion · Coded only* divided a universal
 *   code's count by the coded total in EITHER mode — the bar read 1.2 (120%) and one document's
 *   heatmap cell 4.0 (400%) on the review's probe. They leave the universal rows off now, named in
 *   one note (`codedShareAxis`, `universalChartNote`).
 *
 * The fixture is the 2026-11-04c review's probe payload (in that
 * review's git-ignored kit): two documents and one survey question; "Unclear" holds 6
 * units, the coded total is 5, and D2 holds 4 "Unclear"-only passages beside 1 coded passage.
 */
import { describe, it, expect } from 'vitest'
import type { CodeInfo, SourceEntry, SourceFrequenciesResponse } from '@/lib/api'
import type { QualDenominatorMode, QualValueMode } from '@/lib/qual-analysis-types'
import {
  codedShareAxis,
  computeCellValue,
  drawsCodedShare,
  shapeQualBarData,
  shapeQualCodeSummary,
  shapeQualHeatmapData,
  shapeQualStackedBarData,
} from './qual-chart-data'
import { codeSummaryCsv } from './qual-summary-columns'
import { UNIVERSAL_SHARE_NOTE, universalChartNote } from '@/lib/universal-share'

const code = (id: number, name: string, isUniversal: boolean): CodeInfo => ({
  id, name, color: null, category_id: null, category_name: null,
  is_universal: isUniversal, numeric_id: Math.abs(id), participant_count: 0, record_count: 0,
})

const source = (
  type: SourceEntry['source_type'], id: number, label: string,
  total: number, coded: number, counts: Record<number, number>,
): SourceEntry => ({
  source_type: type, source_id: id, source_label: label, dataset_id: null, dataset_name: null,
  total_segments: total, total_word_count: total * 2, coded_segments: coded, import_order: id,
  code_counts: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { count: n, word_count: n * 2 }])),
  groups: null,
})

/** The probe's payload; `sign` -1 gives the Per Category ids (a pseudo-category is `-code id`). */
function probe(sign: 1 | -1, name = (n: string) => n): SourceFrequenciesResponse {
  const [U0, U1, A, B] = [15291, 15292, 15293, 15294].map(id => sign * id)
  return {
    codes: [
      code(U0, name('Unsubstantive/Artifact'), true), code(U1, name('Unclear'), true),
      code(A, name('A theme'), false), code(B, name('B theme'), false),
    ],
    sources: [
      source('document', 15296, 'D1', 3, 2, { [U1]: 1, [A]: 1, [B]: 1 }),
      source('document', 15297, 'D2', 5, 1, { [U0]: 1, [U1]: 4, [A]: 1 }),
      source('text_column', 15298, 'Survey › Q1', 4, 2, { [U1]: 1, [A]: 1, [B]: 1 }),
    ],
    totals: {
      total_segments: 12, total_word_count: 24, coded_segments: 5, total_sources: 3,
      total_conversations: 0, total_documents: 2, total_observations: 0, total_text_columns: 1,
      coded_transcript_segments: 3, coded_texts: 2,
      total_participants: 0, total_records: 4, unlinked_speaker_count: 0,
    },
    group_by: null,
  }
}

const PER_CODE = probe(1)
const PER_CATEGORY = probe(-1)
const UNIVERSAL_NAMES = ['Unsubstantive/Artifact', 'Unclear']
const MODES: [QualValueMode, QualDenominatorMode][] = [
  ['count', 'total'], ['count', 'coded'],
  ['segment_proportion', 'total'], ['segment_proportion', 'coded'],
  ['text_coverage', 'total'], ['text_coverage', 'coded'],
]

describe('the fixture can tell a share from a withheld one', () => {
  it('"Unclear" over the coded total reads over 100%, and one document cell 400%', () => {
    expect(computeCellValue(6, 0, 12, 24, 5, 'segment_proportion', 'coded')).toBeCloseTo(1.2)
    expect(computeCellValue(4, 0, 5, 10, 1, 'segment_proportion', 'coded')).toBe(4)
  })
})

describe('drawsCodedShare / codedShareAxis (#1529 D92)', () => {
  it('only Proportion over Coded only draws a share of the coded total', () => {
    for (const [v, d] of MODES) {
      expect(drawsCodedShare(v, d)).toBe(v === 'segment_proportion' && d === 'coded')
    }
  })

  it('leaves the universal rows off under Coded only, and names them', () => {
    const axis = codedShareAxis(PER_CODE.codes, 'segment_proportion', 'coded')
    expect(axis.drawn.map(c => c.name)).toEqual(['A theme', 'B theme'])
    expect(axis.leftOut).toEqual(UNIVERSAL_NAMES)
  })

  it('draws every row in every other mode', () => {
    for (const [v, d] of MODES.filter(([v, d]) => !drawsCodedShare(v, d))) {
      const axis = codedShareAxis(PER_CODE.codes, v, d)
      expect(axis.drawn).toHaveLength(4)
      expect(axis.leftOut).toEqual([])
    }
  })
})

describe('the three charts draw what codedShareAxis allows (#1529 D92)', () => {
  // Both modes: the charts read only the flag, and since D91 the server sends it per category too.
  for (const [mode, payload] of [['Per Code', PER_CODE], ['Per Category', PER_CATEGORY]] as const) {
    it(`${mode}: the bar leaves "Unclear" off under Coded only and draws it under All segments`, () => {
      const coded = shapeQualBarData(payload, 'segment_proportion', 'coded', 'import', [])
      expect(coded.map(b => b.fullLabel)).toEqual(['A theme', 'B theme'])
      expect(coded.find(b => b.fullLabel === 'A theme')!.value).toBeCloseTo(0.6)  // 3 of 5

      const total = shapeQualBarData(payload, 'segment_proportion', 'total', 'import', [])
      expect(total.find(b => b.fullLabel === 'Unclear')!.value).toBeCloseTo(0.5)  // 6 of 12
      expect(shapeQualBarData(payload, 'count', 'coded', 'import', []).map(b => b.fullLabel))
        .toEqual(['Unsubstantive/Artifact', 'Unclear', 'A theme', 'B theme'])
    })

    it(`${mode}: the heatmap leaves the universal rows off in both orientations`, () => {
      const rows = shapeQualHeatmapData(payload, 'segment_proportion', 'coded', 'codes-rows', 'import', [])
      expect(rows.rows.map(r => r.label)).toEqual(['A theme', 'B theme'])
      expect(rows.maxValue).toBe(1)   // was 4: D2's "Unclear" cell
      const cols = shapeQualHeatmapData(payload, 'segment_proportion', 'coded', 'sources-rows', 'import', [])
      expect(cols.columnLabels).toEqual(['A theme', 'B theme'])
      expect(shapeQualHeatmapData(payload, 'segment_proportion', 'total', 'codes-rows', 'import', [])
        .rows.map(r => r.label)).toContain('Unclear')
    })

    it(`${mode}: the stacked bar leaves the universal rows off in both orientations`, () => {
      const bySource = shapeQualStackedBarData(payload, 'sources-rows', 'import', 'segment_proportion', 'coded', [])
      expect(bySource.segmentLabels).toEqual(['A theme', 'B theme'])
      const byCode = shapeQualStackedBarData(payload, 'codes-rows', 'import', 'segment_proportion', 'coded', [])
      expect(byCode.rows.map(r => r.label)).toEqual(['A theme', 'B theme'])
      expect(shapeQualStackedBarData(payload, 'sources-rows', 'import', 'count', 'coded', [])
        .segmentLabels).toContain('Unclear')
    })
  }
})

describe('universalChartNote (#1529 D92)', () => {
  it('names one row, two rows and three rows in plain English, and nothing for none', () => {
    expect(universalChartNote([])).toBeNull()
    expect(universalChartNote(['Unclear'])).toMatch(/^Unclear is not drawn: /)
    expect(universalChartNote(UNIVERSAL_NAMES)).toMatch(/^Unsubstantive\/Artifact and Unclear are not drawn: /)
    expect(universalChartNote(['A', 'B', 'C'])).toMatch(/^A, B and C are not drawn: /)
  })

  it('says why in the table note’s terms, and gives no instruction a Canvas cannot follow', () => {
    const note = universalChartNote(['Unclear'])!
    expect(note).toContain('is not counted as coded, so universal codes have no share of the coded total')
    expect(UNIVERSAL_SHARE_NOTE).toContain('is not counted as coded, so universal codes have no share of the coded total')
    expect(note).not.toMatch(/choose|select|switch/i)
  })
})

describe('Per Category: the table and its file withhold a universal row’s coded share (#1529 D91)', () => {
  it('the summary row is universal, so *% of Coded* is null, not 120%', () => {
    const unclear = shapeQualCodeSummary(PER_CATEGORY).find(r => r.codeName === 'Unclear')!
    expect(unclear.isUniversal).toBe(true)
    expect(unclear.totalCount).toBe(6)
    expect(unclear.segmentPercentage).toBeNull()
  })

  it('the Frequencies CSV writes the note and leaves the cells blank', () => {
    const csv = codeSummaryCsv(PER_CATEGORY, { categoryMode: true, scope: null })
    const lines = csv.slice(csv.charCodeAt(0) === 0xfeff ? 1 : 0).split('\r\n')
    expect(lines[0]).toBe(`"${UNIVERSAL_SHARE_NOTE}"`)
    const header = lines.find(l => l.startsWith('Category,'))!.split(',')
    const unclear = lines.find(l => l.startsWith('Unclear,'))!.split(',')
    expect(unclear[header.indexOf('Count')]).toBe('6')
    expect(unclear[header.indexOf('% of Coded')]).toBe('')
    expect(unclear[header.indexOf('% Texts')]).toBe('')
  })
})
