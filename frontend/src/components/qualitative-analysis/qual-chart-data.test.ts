import { describe, it, expect } from 'vitest'
import type { CodeInfo, SourceEntry, SourceFrequenciesResponse } from '@/lib/api'
import {
  applyCustomOrder,
  codedSharePercent,
  shapeQualBarData,
  shapeQualCodeSummary,
  shapeQualHeatmapData,
  shapeQualStackedBarData,
  sharePercent,
} from './qual-chart-data'

// #504's resolver (`resolveRenderedBarEntry`) was retired by #1314: the bar label and clicks
// now read the drawn bar's own row (`components/charts/bar-row-label.ts`), and its regression
// is a render test of what the chart draws — `QualBarChart.test.tsx`.

// ── #675 — the code axis is ordered ─────────────────────────────────────────

/**
 * A fixture where the four orders all DISAGREE, because one where they coincide
 * passes with the bug in place — the trap #675 itself sat in for the project's
 * whole life (the sort control looked wired because the bar chart, the one chart
 * that did order codes, was the one people drove).
 *
 *   import order : Wait times, Access, Cost, Staff
 *   alpha        : Access, Cost, Staff, Wait times
 *   count desc   : Staff (14), Access (9), Wait times (5), Cost (2)
 *   custom       : Cost, Staff, Wait times, Access
 */
const code = (id: number, name: string): CodeInfo => ({
  id, name, color: null, category_id: null, category_name: null,
  is_universal: false, numeric_id: id, participant_count: 0, record_count: 0,
})

const CODES = [code(4, 'Wait times'), code(1, 'Access'), code(2, 'Cost'), code(3, 'Staff')]

const source = (id: number, label: string, counts: Record<number, number>): SourceEntry => ({
  source_type: 'conversation', source_id: id, source_label: label,
  dataset_id: null, dataset_name: null,
  total_segments: 20, total_word_count: 400, coded_segments: 15,
  import_order: id,
  code_counts: Object.fromEntries(
    Object.entries(counts).map(([codeId, n]) => [codeId, { count: n, word_count: n * 10 }]),
  ),
  groups: null,
})

const RESPONSE: SourceFrequenciesResponse = {
  codes: CODES,
  sources: [
    source(1, 'Alpha interview', { 4: 3, 1: 5, 2: 1, 3: 8 }),
    source(2, 'Beta interview', { 4: 2, 1: 4, 2: 1, 3: 6 }),
  ],
  totals: {
    total_segments: 40, total_word_count: 800, coded_segments: 30, total_sources: 2,
    total_conversations: 2, total_documents: 0, total_observations: 0, total_text_columns: 0,
    coded_transcript_segments: 30, coded_texts: 0,
    total_participants: 2, total_records: 0, unlinked_speaker_count: 0,
  },
  group_by: null,
}

const CUSTOM = [2, 3, 4, 1] // Cost, Staff, Wait times, Access

describe('applyCustomOrder (#675)', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const idOf = (i: { id: number }) => i.id

  it('orders listed ids first and appends the rest in their original order', () => {
    expect(applyCustomOrder(items, [3], idOf).map(idOf)).toEqual([3, 1, 2])
  })

  it('skips ids that no longer exist rather than leaving a hole', () => {
    expect(applyCustomOrder(items, [99, 2, 42, 1], idOf).map(idOf)).toEqual([2, 1, 3])
  })

  it('is import order when nothing is listed', () => {
    expect(applyCustomOrder(items, [], idOf).map(idOf)).toEqual([1, 2, 3])
  })

  it('never duplicates an item listed twice', () => {
    expect(applyCustomOrder(items, [2, 2, 1], idOf).map(idOf)).toEqual([2, 1, 3])
  })
})

describe('#675 — the bar chart applies every sort, custom included', () => {
  const names = (order: Parameters<typeof shapeQualBarData>[3], custom: number[] = CUSTOM) =>
    shapeQualBarData(RESPONSE, 'count', 'total', order, custom).map(b => b.fullLabel)

  it('import', () => expect(names('import')).toEqual(['Wait times', 'Access', 'Cost', 'Staff']))
  it('alpha', () => expect(names('alpha')).toEqual(['Access', 'Cost', 'Staff', 'Wait times']))
  it('count_desc', () => expect(names('count_desc')).toEqual(['Staff', 'Access', 'Wait times', 'Cost']))
  it('count_asc', () => expect(names('count_asc')).toEqual(['Cost', 'Wait times', 'Access', 'Staff']))
  it('custom', () => expect(names('custom')).toEqual(['Cost', 'Staff', 'Wait times', 'Access']))

  it('custom with no authored order falls back to import, not to empty', () => {
    expect(names('custom', [])).toEqual(['Wait times', 'Access', 'Cost', 'Staff'])
  })
})

describe('#675 — the heatmap orders codes in BOTH orientations', () => {
  // The regression this pins: `sortOrder` reached only `sortSources`, so the
  // code axis stayed in import order under every option, on both orientations.
  it('codes-rows orders the ROWS', () => {
    const rows = (order: Parameters<typeof shapeQualHeatmapData>[4]) =>
      shapeQualHeatmapData(RESPONSE, 'count', 'total', 'codes-rows', order, CUSTOM).rows.map(r => r.label)
    expect(rows('import')).toEqual(['Wait times', 'Access', 'Cost', 'Staff'])
    expect(rows('alpha')).toEqual(['Access', 'Cost', 'Staff', 'Wait times'])
    expect(rows('count_desc')).toEqual(['Staff', 'Access', 'Wait times', 'Cost'])
    expect(rows('custom')).toEqual(['Cost', 'Staff', 'Wait times', 'Access'])
  })

  it('sources-rows orders the COLUMNS', () => {
    const cols = (order: Parameters<typeof shapeQualHeatmapData>[4]) =>
      shapeQualHeatmapData(RESPONSE, 'count', 'total', 'sources-rows', order, CUSTOM).columnLabels
    expect(cols('import')).toEqual(['Wait times', 'Access', 'Cost', 'Staff'])
    expect(cols('custom')).toEqual(['Cost', 'Staff', 'Wait times', 'Access'])
  })

  it('the cells travel with their column — a reordered axis must not shear the data', () => {
    const data = shapeQualHeatmapData(RESPONSE, 'count', 'total', 'sources-rows', 'custom', CUSTOM)
    const row = data.rows[0] // Alpha interview: Wait 3, Access 5, Cost 1, Staff 8
    expect(row.cells.map(c => [c.columnLabel, c.rawCount])).toEqual([
      ['Cost', 1], ['Staff', 8], ['Wait times', 3], ['Access', 5],
    ])
    expect(data.columnIds).toEqual([2, 3, 4, 1])
  })

  it('leaves the SOURCE axis exactly as it was — custom is a code order', () => {
    const rows = shapeQualHeatmapData(RESPONSE, 'count', 'total', 'sources-rows', 'custom', CUSTOM).rows
    expect(rows.map(r => r.label)).toEqual(['Alpha interview', 'Beta interview'])
  })
})

describe('#675 — the stacked bar orders codes in both orientations', () => {
  it('codes-rows orders the bars', () => {
    const rows = shapeQualStackedBarData(RESPONSE, 'codes-rows', 'custom', 'count', 'total', CUSTOM).rows
    expect(rows.map(r => r.label)).toEqual(['Cost', 'Staff', 'Wait times', 'Access'])
  })

  it('sources-rows orders the stack segments and the legend', () => {
    const data = shapeQualStackedBarData(RESPONSE, 'sources-rows', 'custom', 'count', 'total', CUSTOM)
    expect(data.segmentLabels).toEqual(['Cost', 'Staff', 'Wait times', 'Access'])
    expect(data.rows.map(r => r.label)).toEqual(['Alpha interview', 'Beta interview'])
  })
})

describe('#675 — count ordering agrees across the three charts', () => {
  it('ranks a code identically whether it is a bar, a heatmap row or a stack', () => {
    const bars = shapeQualBarData(RESPONSE, 'text_coverage', 'total', 'count_desc', []).map(b => b.fullLabel)
    const rows = shapeQualHeatmapData(RESPONSE, 'text_coverage', 'total', 'codes-rows', 'count_desc', []).rows.map(r => r.label)
    const stack = shapeQualStackedBarData(RESPONSE, 'codes-rows', 'count_desc', 'text_coverage', 'total', []).rows.map(r => r.label)
    expect(rows).toEqual(bars)
    expect(stack).toEqual(bars)
  })
})

describe('#1526 D79 — a share of a CODED total is withheld on a universal row', () => {
  it('is null for a universal code even when the total is not zero', () => {
    expect(codedSharePercent(true, 3, 2)).toBeNull()      // the probe's Unclear: 150%
    expect(codedSharePercent(true, 0, 2)).toBeNull()
  })

  it('is the plain share for any other code — a zero total stays null, a zero count 0', () => {
    expect(codedSharePercent(false, 1, 2)).toBe(sharePercent(1, 2))
    expect(codedSharePercent(false, 1, 2)).toBe(50)
    expect(codedSharePercent(false, 1, 0)).toBeNull()
    expect(codedSharePercent(false, 0, 2)).toBe(0)
  })

  it('reaches the summary row: a universal row carries its flag, its count and no share', () => {
    const data = {
      codes: [
        { id: 1, name: 'Unclear', color: null, category_id: null, category_name: null,
          category_color: null, is_universal: true, numeric_id: 1 },
        { id: 2, name: 'A', color: null, category_id: null, category_name: null,
          category_color: null, is_universal: false, numeric_id: 100 },
      ],
      sources: [{ source_type: 'document', source_id: 1, source_label: 'D1', coded_segments: 1,
        total_segments: 3, total_word_count: 6,
        code_counts: { '1': { count: 2, word_count: 4 }, '2': { count: 1, word_count: 2 } } }],
      totals: { total_segments: 3, total_word_count: 6, coded_segments: 1 },
    } as unknown as SourceFrequenciesResponse
    const [unclear, a] = shapeQualCodeSummary(data)
    expect([unclear.isUniversal, unclear.totalCount, unclear.segmentPercentage]).toEqual([true, 2, null])
    expect([a.isUniversal, a.totalCount, a.segmentPercentage]).toEqual([false, 1, 100])
  })
})
