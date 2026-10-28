/**
 * #1314 — clicking a stacked segment opens the code the segment is drawn FOR.
 *
 * Each source is its own `<Bar>` series, and recharts drops a series' zero-width segment
 * before it draws, numbering the click callback's `index` by what it drew. The handler read
 * `chartData[index]`, so after any code a source never used, a click on that source's
 * segment opened the code ABOVE it. The handler reads the clicked rectangle's own row now.
 * Each assertion clicks the segment drawn in a code's BAND (see
 * `test-support/recharts-render.ts`) and expects that code.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import QualStackedBar from './QualStackedBar'
import { dataLabelsByCategory, seriesBarRects, stubChartGlobals } from '@/test-support/recharts-render'
import type { SourceFrequenciesResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const CODES: [number, string][] = [[101, 'Barriers'], [102, 'Cost'], [103, 'Distance'], [104, 'Trust']]
const CODE_ID = Object.fromEntries(CODES.map(([id, name]) => [name, id]))

/** Per source, its count for each code in `CODES` order. */
function frequencies(sources: [string, number[]][]): SourceFrequenciesResponse {
  return {
    group_by: null,
    codes: CODES.map(([id, name], i) => ({
      id, name, color: null, category_id: null, category_name: null, is_universal: false,
      numeric_id: i + 1, participant_count: 0, record_count: 0,
    })),
    sources: sources.map(([label, counts], i) => ({
      source_type: 'conversation', source_id: 900 + i, source_label: label,
      dataset_id: null, dataset_name: null,
      total_segments: 30, total_word_count: 600, coded_segments: 20, import_order: i,
      code_counts: Object.fromEntries(CODES.map(([id], j) => [String(id), { count: counts[j], word_count: counts[j] * 10 }])),
      groups: null,
    })),
    totals: {
      total_segments: 60, total_word_count: 1200, coded_segments: 40, total_sources: 2,
      total_conversations: 2, total_documents: 0, total_observations: 0, total_text_columns: 0,
      coded_transcript_segments: 40, coded_texts: 0, total_participants: 0, total_records: 0, unlinked_speaker_count: 0,
    },
  }
}

const data = frequencies([
  ['Interview 1', [0, 3, 2, 1]],  // a LEADING zero
  ['Interview 2', [4, 1, 0, 2]],  // an INTERIOR zero
])

const renderChart = (onBarClick?: (id: number) => void) =>
  render(
    <QualStackedBar data={data} orientation="codes-rows" sortOrder="import" customOrder={[]}
      dataLabels="inside" onBarClick={onBarClick} />,
  )

describe('QualStackedBar click drill-down (#1314)', () => {
  it.each([
    ['Interview 1', 0, ['Cost', 'Distance', 'Trust']],
    ['Interview 2', 1, ['Barriers', 'Cost', 'Trust']],
  ])("every %s segment opens the code it is drawn for", (_source, series, drawnFor) => {
    const onBarClick = vi.fn()
    const { container } = renderChart(onBarClick)
    const rects = seriesBarRects(container, series)
    expect(rects.map(r => r.category)).toEqual(drawnFor)
    for (const rect of rects) {
      fireEvent.click(rect.el)
      expect(onBarClick).toHaveBeenLastCalledWith(CODE_ID[rect.category])
    }
    expect(onBarClick).toHaveBeenCalledTimes(drawnFor.length)
  })

  it("the segment labels read their own segment (a LabelList with a dataKey — not #1314's shape)", () => {
    expect(Object.fromEntries(dataLabelsByCategory(renderChart().container))).toEqual({
      Barriers: ['4'],
      Cost: ['3', '1'],
      Distance: ['2'],
      Trust: ['1', '2'],
    })
  })
})
