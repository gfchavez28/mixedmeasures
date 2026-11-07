/**
 * #1529 D92 (1.5.9) — what the three charts DRAW under *Proportion · Coded only* when a universal
 * code is selected: its row left off the code axis, and ONE note inside the chart naming it, so
 * the analysis view, its PNG and the Canvas embed all say why (the note's words and the shaping are
 * pinned in `qual-chart-data.universal-1529.test.ts`; this file pins the RENDER, the grouped bar's
 * own arm, and the empty state).
 *
 * Every case has its control: the same payload under *All segments* draws "Unclear" and says
 * nothing.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
// `QualHeatmap` reads `useTheme`, the bars `useChartColors`; `ThemeProvider` cannot mount here
// (no working `localStorage`), so both are stubbed with the real light palette.
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import QualHeatmap from './QualHeatmap'
import QualBarChart from './QualBarChart'
import QualStackedBar from './QualStackedBar'
import { stubChartGlobals, yAxisCategories } from '@/test-support/recharts-render'
import type { CodeInfo, SourceFrequenciesResponse } from '@/lib/api'
import type { QualDenominatorMode } from '@/lib/qual-analysis-types'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NOTE = /^Unsubstantive\/Artifact and Unclear are not drawn: /

const code = (id: number, name: string, isUniversal: boolean): CodeInfo => ({
  id, name, color: null, category_id: null, category_name: null,
  is_universal: isUniversal, numeric_id: id, participant_count: 0, record_count: 0,
})

const counts = (c: Record<number, number>) =>
  Object.fromEntries(Object.entries(c).map(([k, n]) => [k, { count: n, word_count: n * 2 }]))

/** The review probe's shape, one document: 4 "Unclear"-only passages beside 1 coded one. */
function payload(codes: CodeInfo[], grouped = false): SourceFrequenciesResponse {
  const c = { 1: 1, 2: 4, 3: 1, 4: 0 }
  return {
    codes,
    sources: [{
      source_type: 'document', source_id: 7, source_label: 'D2', dataset_id: null, dataset_name: null,
      total_segments: 6, total_word_count: 12, coded_segments: 2, import_order: 0,
      code_counts: counts(c),
      groups: grouped
        ? { Staff: { total_segments: 6, total_word_count: 12, coded_segments: 2, code_counts: counts(c) } }
        : null,
    }],
    totals: {
      total_segments: 6, total_word_count: 12, coded_segments: 2, total_sources: 1,
      total_conversations: 0, total_documents: 1, total_observations: 0, total_text_columns: 0,
      coded_transcript_segments: 2, coded_texts: 0, total_participants: 0, total_records: 0,
      unlinked_speaker_count: 0,
    },
    group_by: grouped ? 'role' : null,
  }
}

const MIXED = [
  code(1, 'Unsubstantive/Artifact', true), code(2, 'Unclear', true),
  code(3, 'A theme', false), code(4, 'B theme', false),
]
const ONLY_UNIVERSAL = MIXED.slice(0, 2)

function heatmap(denominatorMode: QualDenominatorMode, codes = MIXED) {
  return render(
    <QualHeatmap data={payload(codes)} valueMode="segment_proportion" denominatorMode={denominatorMode}
      orientation="codes-rows" sortOrder="import" customOrder={[]} showSummaryRow={false} />,
  )
}

function bar(denominatorMode: QualDenominatorMode, opts: { grouped?: boolean; codes?: CodeInfo[] } = {}) {
  return render(
    <QualBarChart data={payload(opts.codes ?? MIXED, opts.grouped)} valueMode="segment_proportion"
      denominatorMode={denominatorMode} sortOrder="import" customOrder={[]}
      groupBy={opts.grouped ? 'role' : null} dataLabels="none" />,
  )
}

function stacked(denominatorMode: QualDenominatorMode, codes = MIXED) {
  return render(
    <QualStackedBar data={payload(codes)} orientation="codes-rows" sortOrder="import" customOrder={[]}
      valueMode="segment_proportion" denominatorMode={denominatorMode} />,
  )
}

describe('the heatmap (#1529 D92)', () => {
  it('Coded only: no universal row, and the note inside the chart', () => {
    const { container } = heatmap('coded')
    const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map(th => th.textContent)
    expect(rows).toEqual(['A theme', 'B theme'])
    expect(container.firstElementChild).toContainElement(screen.getByText(NOTE))
  })

  it('control — All segments: "Unclear" is drawn and nothing is said', () => {
    const { container } = heatmap('total')
    const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map(th => th.textContent)
    expect(rows).toContain('Unclear')
    expect(screen.queryByText(/are not drawn/)).toBeNull()
  })

  it('only universal codes selected: the empty state still says why', () => {
    heatmap('coded', ONLY_UNIVERSAL)
    expect(screen.getByText(/No data available/)).toBeInTheDocument()
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })
})

describe('the bar chart (#1529 D92)', () => {
  it('Coded only: no universal bar, and the note inside the figure', () => {
    const { container } = bar('coded')
    expect(yAxisCategories(container).map(b => b.category)).toEqual(['A theme', 'B theme'])
    expect(container.querySelector('figure')).toContainElement(screen.getByText(NOTE))
  })

  it('control — All segments: "Unclear" is drawn and nothing is said', () => {
    const { container } = bar('total')
    expect(yAxisCategories(container).map(b => b.category)).toContain('Unclear')
    expect(screen.queryByText(/are not drawn/)).toBeNull()
  })

  it('grouped (Compare by): its own arm leaves the universal rows off too', () => {
    const { container } = bar('coded', { grouped: true })
    expect(yAxisCategories(container).map(b => b.category)).toEqual(['A theme', 'B theme'])
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('control — grouped under All segments draws "Unclear"', () => {
    const { container } = bar('total', { grouped: true })
    expect(yAxisCategories(container).map(b => b.category)).toContain('Unclear')
  })

  it('only universal codes selected: the empty state still says why', () => {
    bar('coded', { codes: ONLY_UNIVERSAL })
    expect(screen.getByText(/No data available/)).toBeInTheDocument()
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })
})

describe('the stacked bar (#1529 D92)', () => {
  it('Coded only: no universal bar, and the note inside the figure', () => {
    const { container } = stacked('coded')
    expect(yAxisCategories(container).map(b => b.category)).toEqual(['A theme', 'B theme'])
    expect(container.querySelector('figure')).toContainElement(screen.getByText(NOTE))
  })

  it('control — All segments: "Unclear" is drawn and nothing is said', () => {
    const { container } = stacked('total')
    expect(yAxisCategories(container).map(b => b.category)).toContain('Unclear')
    expect(screen.queryByText(/are not drawn/)).toBeNull()
  })

  it('only universal codes selected: the empty state still says why', () => {
    stacked('coded', ONLY_UNIVERSAL)
    expect(screen.getByText(/No data available/)).toBeInTheDocument()
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })
})
