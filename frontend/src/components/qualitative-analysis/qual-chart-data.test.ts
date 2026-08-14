import { describe, it, expect } from 'vitest'
import type { CodeInfo, SourceEntry, SourceFrequenciesResponse } from '@/lib/api'
import {
  applyCustomOrder,
  resolveRenderedBarEntry,
  shapeQualBarData,
  shapeQualHeatmapData,
  shapeQualStackedBarData,
} from './qual-chart-data'

// #504 regression: recharts compacts zero-dimension rects out of its rendered
// list, so label/click callbacks receive RENDERED indexes. The corpus repro:
// 6 codes with counts [0, 3, 5, 6, 1, 2] — the zero-count first entry shifted
// every painted label one row (Access showed Unclear's 3, etc.).
const entries = [
  { label: 'Unsubstantive', value: 0, count: 0, _codeId: 6 },
  { label: 'Unclear', value: 3, count: 3, _codeId: 1 },
  { label: 'Access barriers', value: 5, count: 5, _codeId: 2 },
  { label: 'Staff support', value: 6, count: 6, _codeId: 3 },
  { label: 'Cost concerns', value: 1, count: 1, _codeId: 4 },
  { label: 'Wait times', value: 2, count: 2, _codeId: 5 },
]

describe('resolveRenderedBarEntry (#504)', () => {
  it('maps rendered indexes past a leading zero-count entry to their own data rows', () => {
    // recharts renders 5 rects (values 3,5,6,1,2) with indexes 0..4
    const renderedValues = [3, 5, 6, 1, 2]
    const resolved = renderedValues.map((v, i) => resolveRenderedBarEntry(entries, i, v))
    expect(resolved.map(e => e?.count)).toEqual([3, 5, 6, 1, 2])
    expect(resolved.map(e => e?.label)).toEqual([
      'Unclear', 'Access barriers', 'Staff support', 'Cost concerns', 'Wait times',
    ])
  })

  it('handles an interior zero-count entry', () => {
    const withInteriorZero = [
      { label: 'A', value: 4, count: 4 },
      { label: 'B', value: 0, count: 0 },
      { label: 'C', value: 7, count: 7 },
    ]
    expect(resolveRenderedBarEntry(withInteriorZero, 0, 4)?.label).toBe('A')
    expect(resolveRenderedBarEntry(withInteriorZero, 1, 7)?.label).toBe('C')
  })

  it('falls back to data-order indexing if recharts stops compacting zero rects', () => {
    // A future recharts passing data indexes: index 2 with value 7 should
    // still resolve to C (rendered[2] is undefined; entries[2] matches).
    const withLeadingZero = [
      { label: 'Z', value: 0, count: 0 },
      { label: 'A', value: 4, count: 4 },
      { label: 'C', value: 7, count: 7 },
    ]
    expect(resolveRenderedBarEntry(withLeadingZero, 2, 7)?.label).toBe('C')
    // ...and a data-index pointing at the zero entry draws no label
    expect(resolveRenderedBarEntry(withLeadingZero, 0, 0)).toBeNull()
  })

  it('returns null when neither mapping agrees with the callback value', () => {
    expect(resolveRenderedBarEntry(entries, 0, 999)).toBeNull()
    expect(resolveRenderedBarEntry(entries, 42, 3)).toBeNull()
  })

  it('is identity-stable when no zero-count entries exist', () => {
    const noZeros = entries.slice(1)
    noZeros.forEach((e, i) => {
      expect(resolveRenderedBarEntry(noZeros, i, e.value)).toBe(e)
    })
  })
})

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
