/**
 * #504 / #1314 — a code's bar label and its click both belong to the code the bar is drawn FOR.
 *
 * recharts drops a zero-width bar before it draws, and numbers the label and click callbacks'
 * `index` by what it drew. #504 found this chart labelling and opening the code ABOVE every bar
 * after an unused code, and fixed it with a resolver; #1314 moved the label onto the shared
 * row-reading label (`components/charts/bar-row-label.ts`) and both clicks onto the clicked
 * rectangle's own row. Each assertion reads the label drawn on, or clicks the bar drawn in, a
 * code's BAND (see `test-support/recharts-render.ts`).
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

import QualBarChart from './QualBarChart'
import { dataLabelsByCategory, seriesBarRects, stubChartGlobals } from '@/test-support/recharts-render'
import type { SourceFrequenciesResponse } from '@/lib/api'
import type { QualValueMode } from '@/lib/qual-analysis-types'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const CODES: [number, string][] = [[101, 'Barriers'], [102, 'Cost'], [103, 'Distance'], [104, 'Trust'], [105, 'Access']]
const CODE_ID = Object.fromEntries(CODES.map(([id, name]) => [name, id]))

const counts = (vals: number[]) =>
  Object.fromEntries(CODES.map(([id], i) => [String(id), { count: vals[i], word_count: vals[i] * 10 }]))

/** One source. `byCode` in `CODES` order; `byGroup` makes it a grouped (Compare-By) payload. */
function frequencies(byCode: number[], byGroup?: Record<string, number[]>): SourceFrequenciesResponse {
  return {
    group_by: byGroup ? 'gender' : null,
    codes: CODES.map(([id, name], i) => ({
      id, name, color: null, category_id: null, category_name: null, is_universal: false,
      numeric_id: i + 1, participant_count: 0, record_count: 0,
    })),
    sources: [{
      source_type: 'conversation', source_id: 900, source_label: 'Interview 1',
      dataset_id: null, dataset_name: null,
      total_segments: 20, total_word_count: 400, coded_segments: 20, import_order: 0,
      code_counts: counts(byCode),
      groups: byGroup
        ? Object.fromEntries(Object.entries(byGroup).map(([g, v]) => [g, {
            total_segments: 10, total_word_count: 200, coded_segments: 10, code_counts: counts(v),
          }]))
        : null,
    }],
    totals: {
      total_segments: 20, total_word_count: 400, coded_segments: 20, total_sources: 1,
      total_conversations: 1, total_documents: 0, total_observations: 0, total_text_columns: 0,
      coded_transcript_segments: 20, coded_texts: 0, total_participants: 0, total_records: 0, unlinked_speaker_count: 0,
    },
  }
}

// A LEADING unused code (Barriers) and an INTERIOR one (Distance).
const simple = frequencies([0, 4, 0, 6, 2])

const renderSimple = (valueMode: QualValueMode, onCodeClick?: (id: number) => void) =>
  render(
    <QualBarChart data={simple} valueMode={valueMode} denominatorMode="total" sortOrder="import"
      customOrder={[]} onCodeClick={onCodeClick} />,
  )

describe('QualBarChart (#504 / #1314)', () => {
  it('count labels sit on their own code after an unused one', () => {
    expect(Object.fromEntries(dataLabelsByCategory(renderSimple('count').container))).toEqual({
      Barriers: [],
      Cost: ['4'],
      Distance: [],
      Trust: ['6'],
      Access: ['2'],
    })
  })

  it('proportion labels sit on their own code after an unused one', () => {
    expect(Object.fromEntries(dataLabelsByCategory(renderSimple('segment_proportion').container))).toEqual({
      Barriers: [],
      Cost: ['20.0%'],
      Distance: [],
      Trust: ['30.0%'],
      Access: ['10.0%'],
    })
  })

  it('every bar opens the code it is drawn for', () => {
    const onCodeClick = vi.fn()
    const rects = seriesBarRects(renderSimple('count', onCodeClick).container, 0)
    expect(rects.map(r => r.category)).toEqual(['Cost', 'Trust', 'Access'])
    for (const rect of rects) {
      fireEvent.click(rect.el)
      expect(onCodeClick).toHaveBeenLastCalledWith(CODE_ID[rect.category])
    }
  })

  describe('grouped by a demographic', () => {
    const grouped = frequencies([2, 3, 6, 1, 1], {
      Men: [0, 3, 2, 0, 1],    // a LEADING zero and an interior one
      Women: [2, 0, 4, 1, 0],  // an interior zero and a TRAILING one
    })
    const renderGrouped = (onCodeClick?: (id: number) => void) =>
      render(
        <QualBarChart data={grouped} valueMode="count" denominatorMode="total" sortOrder="import"
          customOrder={[]} groupBy="gender" onCodeClick={onCodeClick} />,
      )

    it.each([
      ['Men', 0, ['Cost', 'Distance', 'Access']],
      ['Women', 1, ['Barriers', 'Distance', 'Trust']],
    ])('every %s bar opens the code it is drawn for', (_group, series, drawnFor) => {
      const onCodeClick = vi.fn()
      const rects = seriesBarRects(renderGrouped(onCodeClick).container, series)
      expect(rects.map(r => r.category)).toEqual(drawnFor)
      for (const rect of rects) {
        fireEvent.click(rect.el)
        expect(onCodeClick).toHaveBeenLastCalledWith(CODE_ID[rect.category])
      }
    })

    it("the group labels read their own bar (a LabelList with a dataKey — not #1314's shape)", () => {
      expect(Object.fromEntries(dataLabelsByCategory(renderGrouped().container))).toEqual({
        Barriers: ['2'],
        Cost: ['3'],
        Distance: ['2', '4'],
        Trust: ['1'],
        Access: ['1'],
      })
    })
  })
})
