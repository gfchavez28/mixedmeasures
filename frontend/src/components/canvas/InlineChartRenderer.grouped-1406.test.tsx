/**
 * #1406 — a Canvas embed of a GROUPED scalar or frequency figure drew the
 * UNGROUPED figure from `results[0]` — on the wire, the missing-group bucket
 * (NULLs sort first) — under the variable's name. DRIVEN at 3d1d7380: the
 * horizontal and vertical bar embeds of `mean(score) by grp` drew
 * `score = 100.0` (the one record with no group) for groups whose means are
 * 3, 6, — and 0; the table embed printed `n 1, mean 100.00`.
 *
 * ⚠️ The chart components are MOCKED to record their props: the load-bearing
 * assertion is WHICH figure the arm chose and WHAT numbers it handed over,
 * which jsdom's zero-width recharts cannot show.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'

const { seen, recorder } = vi.hoisted(() => {
  const seen: { name: string; props: Record<string, unknown> }[] = []
  const recorder = (name: string) => ({
    default: (props: Record<string, unknown>) => { seen.push({ name, props }); return null },
  })
  return { seen, recorder }
})
// #1615 — the quantitative reads take the blind scope from this hook; every coder here.
vi.mock('@/hooks/useAnalysisScope', () => ({ useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }) }))
vi.mock('@/components/charts/HorizontalBarChart', () => recorder('HorizontalBarChart'))
vi.mock('@/components/charts/GroupedScalarBarChart', () => recorder('GroupedScalarBarChart'))
vi.mock('@/components/charts/VerticalBarChart', () => recorder('VerticalBarChart'))
vi.mock('@/components/charts/SummaryStatsTable', () => recorder('SummaryStatsTable'))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(), frequencies: vi.fn(), saturation: vi.fn(),
    cooccurrence: vi.fn(), demographicComparison: vi.fn(),
  },
  codesApi: { list: vi.fn() },
  categoriesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import { metricsApi } from '@/lib/api'
import InlineChartRenderer from './InlineChartRenderer'

const groupedMean = {
  id: 1, name: 'Q1', input_source_label: 'score', metric_type: 'mean', input_source_id: 3,
  input_source_type: 'dataset_column', grouping_column_id: 2,
  results: [
    { group_value: null, valid_n: 1, result_data: { mean: 100 } },
    { group_value: 'A', valid_n: 3, result_data: { mean: 3 } },
    { group_value: 'B', valid_n: 3, result_data: { mean: 6 } },
    { group_value: 'C', valid_n: 0, result_data: { mean: null } },
    { group_value: 'D', valid_n: 3, result_data: { mean: 0 } },
  ],
}
const groupedFreq = {
  id: 6, name: 'Q6', input_source_label: 'q1', metric_type: 'frequency_distribution', input_source_id: 6,
  input_source_type: 'dataset_column', grouping_column_id: 2,
  results: [
    { group_value: null, valid_n: 1, result_data: { scale_order: ['4'], counts: { 4: 1 }, percentages: { 4: 100 } } },
    { group_value: 'A', valid_n: 3, result_data: { scale_order: ['1'], counts: { 1: 3 }, percentages: { 1: 100 } } },
    { group_value: 'B', valid_n: 3, result_data: { scale_order: ['5'], counts: { 5: 3 }, percentages: { 5: 100 } } },
  ],
}

function renderEmbed(content: Record<string, unknown>, metrics: unknown[]) {
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics, computed_count: 0, reused_count: 1 } as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={qc}>
        <InlineChartRenderer projectId={1} materialId={7} content={content} onFigure={() => {}} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
}
const meanConfig = (chart_type: string, over: Record<string, unknown> = {}) =>
  ({ column_ids: [3], domain_ids: [], metric_type: 'mean', grouping_column_id: 2, chart_type, ...over })

/** The (group, value, n) triples a grouped scalar section was handed. */
function groupsOf(sections: unknown): [string, number | null, number][] {
  const s = (sections as { groups: { groupValue: string; value: number | null; n: number }[] }[])[0]
  return s.groups.map(g => [g.groupValue, g.value, g.n])
}
const EXPECTED: [string, number | null, number][] = [['A', 3, 3], ['B', 6, 3], ['C', null, 0], ['D', 0, 3]]

beforeEach(() => { seen.length = 0; vi.mocked(metricsApi.quickCompute).mockReset() })
afterEach(cleanup)

describe('#1406 — a grouped embed draws its groups', () => {
  it('horizontal_bar: the grouped scalar chart, every group, never the bucket', async () => {
    renderEmbed(meanConfig('horizontal_bar'), [groupedMean])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const last = seen[seen.length - 1]
    expect(last.name).toBe('GroupedScalarBarChart')
    expect(last.props.groupValues).toEqual(['A', 'B', 'C', 'D'])
    expect(groupsOf(last.props.sections)).toEqual(EXPECTED)
  })

  it('vertical_bar: grouped scalar data, not one bar per variable', async () => {
    renderEmbed(meanConfig('vertical_bar'), [groupedMean])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const last = seen[seen.length - 1]
    expect(last.name).toBe('VerticalBarChart')
    expect(last.props.scalarData).toBeUndefined()
    expect(groupsOf(last.props.groupedScalarData)).toEqual(EXPECTED)
  })

  it('the saved hidden groups stay hidden (the dumbbell arm’s precedent)', async () => {
    renderEmbed(meanConfig('horizontal_bar', { hidden_group_values: ['B'] }), [groupedMean])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[seen.length - 1].props.groupValues).toEqual(['A', 'C', 'D'])
  })

  it('table: a row per group with its own n', async () => {
    renderEmbed(meanConfig('table'), [groupedMean])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const rows = seen[seen.length - 1].props.data as { groupValue: string; n: number; mean: number | null }[]
    expect(rows.map(r => [r.groupValue, r.mean, r.n])).toEqual(EXPECTED)
  })

  it('table: the saved hidden groups stay hidden', async () => {
    renderEmbed(meanConfig('table', { hidden_group_values: ['B'] }), [groupedMean])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const rows = seen[seen.length - 1].props.data as { groupValue: string }[]
    expect(rows.map(r => r.groupValue)).toEqual(['A', 'C', 'D'])
  })

  it('vertical_bar of ONE frequency distribution: grouped frequency data', async () => {
    renderEmbed({ column_ids: [6], domain_ids: [], metric_type: 'frequency_distribution', grouping_column_id: 2, chart_type: 'vertical_bar' }, [groupedFreq])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const last = seen[seen.length - 1]
    expect(last.props.frequencyData).toBeUndefined()
    expect(last.props.groupValues).toEqual(['A', 'B'])
    expect((last.props.groupedFrequencyData as { groups: { groupValue: string }[] }).groups.map(g => g.groupValue)).toEqual(['A', 'B'])
  })

  it('an UNGROUPED scalar still draws one bar per variable (positive control)', async () => {
    const ungrouped = { ...groupedMean, grouping_column_id: null, results: [{ group_value: null, valid_n: 40, result_data: { mean: 0 } }] }
    renderEmbed(meanConfig('horizontal_bar', { grouping_column_id: undefined }), [ungrouped])
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const last = seen[seen.length - 1]
    expect(last.name).toBe('HorizontalBarChart')
    expect((last.props.data as { value: number | null }[]).map(b => b.value)).toEqual([0])
  })
})
