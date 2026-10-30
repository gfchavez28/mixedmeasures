/**
 * #1479 — the groups a researcher HID on the saved chart must be hidden on the
 * Canvas embed, in the PNG captured from it (the embed IS what
 * `captureCanvasChartPngs` rasterises) and in the exported table printed under
 * it — on EVERY chart type, the same set the Analysis view draws.
 *
 * #1406 D6 taught the export and four of the embed's arms; the horizontal
 * frequency, heatmap, stacked and line embeds still drew the hidden group, and
 * the export's line table kept its column — one document naming two group sets.
 *
 * 🔴 **The table below is keyed `satisfies Record<ChartType, …>`**: a new chart
 * type does not compile until someone decides how it treats hidden groups. That
 * is the population this issue was about — a decision applied to some arms of a
 * family and not the others.
 *
 * ⚠️ Chart components are MOCKED to record their props (jsdom draws no recharts),
 * and the groups each one draws are read from those props. For the two that
 * filter internally (`FrequencyBarChart`, `DetailedFrequencyTable`) the reader
 * mirrors the component's own one-line filter, named at each.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

const { seen, recorder } = vi.hoisted(() => {
  const seen: { name: string; props: Record<string, unknown> }[] = []
  const recorder = (name: string) => ({
    default: (props: Record<string, unknown>) => { seen.push({ name, props }); return null },
  })
  return { seen, recorder }
})
vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
for (const name of [
  'HorizontalBarChart', 'GroupedScalarBarChart', 'HeatmapTable', 'FrequencyBarChart',
  'StackedHorizontalBarChart', 'VerticalBarChart', 'LineChart', 'DumbbellChart',
  'SummaryStatsTable', 'DetailedFrequencyTable', 'AnalysisCrossTabTable',
]) {
  vi.doMock(`@/components/charts/${name}`, () => recorder(name))
}
vi.mock('@/components/charts/ChartExportWrapper', () => ({
  default: (props: { children?: ReactNode }) => <>{props.children}</>,
}))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(), frequencies: vi.fn(), saturation: vi.fn(),
    cooccurrence: vi.fn(), demographicComparison: vi.fn(),
  },
  codesApi: { list: vi.fn() }, categoriesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import { metricsApi, type MetricDefinitionResponse, type CanvasTheme } from '@/lib/api'
import { DEFAULT_FORMATTING, getGroupValues, type ChartType } from '@/lib/chart-data'
import { fetchChartTables, type ExportTable } from '@/lib/canvas-export'

// Imported dynamically so the `vi.doMock` loop above is in force for them.
const { default: InlineChartRenderer } = await import('./InlineChartRenderer')
const { default: AnalysisChartRenderer } = await import('@/components/analysis/AnalysisChartRenderer')
type AnalysisProps = Parameters<typeof AnalysisChartRenderer>[0]

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }

/** Three real groups plus the missing-group bucket the wire sends FIRST (#1406). */
const freq = (id: number) => ({
  id, name: `Q${id}`, input_source_label: `q${id}`, metric_type: 'frequency_distribution', input_source_id: id,
  input_source_type: 'dataset_column', grouping_column_id: 2,
  results: [
    { group_value: null, valid_n: 1, result_data: { scale_order: ['1', '2'], counts: { 1: 1 }, percentages: { 1: 100, 2: 0 } } },
    { group_value: 'A', valid_n: 2, result_data: { scale_order: ['1', '2'], counts: { 1: 1, 2: 1 }, percentages: { 1: 50, 2: 50 } } },
    { group_value: 'B', valid_n: 2, result_data: { scale_order: ['1', '2'], counts: { 1: 2 }, percentages: { 1: 100, 2: 0 } } },
    { group_value: 'C', valid_n: 4, result_data: { scale_order: ['1', '2'], counts: { 2: 4 }, percentages: { 1: 0, 2: 100 } } },
  ],
}) as unknown as MetricDefinitionResponse
const mean = (id: number) => ({
  id, name: `M${id}`, input_source_label: `m${id}`, metric_type: 'mean', input_source_id: id,
  input_source_type: 'dataset_column', grouping_column_id: 2,
  results: [
    { group_value: null, valid_n: 1, result_data: { mean: 100, ci_method: 't' } },
    { group_value: 'A', valid_n: 2, result_data: { mean: 1, ci_method: 't' } },
    { group_value: 'B', valid_n: 2, result_data: { mean: 9, ci_method: 't' } },
    { group_value: 'C', valid_n: 3, result_data: { mean: 4, ci_method: 't' } },
  ],
}) as unknown as MetricDefinitionResponse

/**
 * How an arm treats a hidden group. `hides`: the embed, the Analysis view and
 * the export table all leave it out. `pools`: no arm draws groups at all (the
 * histogram pools a grouped payload and says so, #1406; the cross-tab has no
 * grouping) — the embed must still MATCH the Analysis view.
 */
type Case = { metricType: string; metrics: () => MetricDefinitionResponse[]; expect: 'hides' | 'pools' }
const ARMS = {
  horizontal_bar: [
    { metricType: 'frequency_distribution', metrics: () => [freq(6)], expect: 'hides' },
    { metricType: 'mean', metrics: () => [mean(3), mean(4)], expect: 'hides' },
  ],
  heatmap: [{ metricType: 'frequency_distribution', metrics: () => [freq(6), freq(7)], expect: 'hides' }],
  stacked_bar: [{ metricType: 'frequency_distribution', metrics: () => [freq(6), freq(7)], expect: 'hides' }],
  vertical_bar: [
    { metricType: 'frequency_distribution', metrics: () => [freq(6)], expect: 'hides' },
    { metricType: 'mean', metrics: () => [mean(3), mean(4)], expect: 'hides' },
  ],
  dumbbell: [{ metricType: 'mean', metrics: () => [mean(3), mean(4)], expect: 'hides' }],
  table: [{ metricType: 'mean', metrics: () => [mean(3), mean(4)], expect: 'hides' }],
  line: [{ metricType: 'mean', metrics: () => [mean(3), mean(4)], expect: 'hides' }],
  frequency_table: [{ metricType: 'frequency_distribution', metrics: () => [freq(6)], expect: 'hides' }],
  histogram: [{ metricType: 'frequency_distribution', metrics: () => [freq(6)], expect: 'pools' }],
  cross_tab: [],   // its own endpoint and table; `hidden_group_values` has no reader there in either view
} satisfies Record<ChartType, Case[]>

const without = (all: string[], hidden: unknown) =>
  all.filter(g => !((hidden as string[] | undefined) ?? []).includes(g))
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => x != null))]

/**
 * The groups the LAST recorded chart draws, read from what it was handed. A
 * histogram draws none — it POOLS the groups — so it returns the pooled bars
 * themselves, which the two views must hand over identically.
 */
function drawnGroups(): string[] | string {
  const last = seen[seen.length - 1]
  if (!last) throw new Error('no chart rendered')
  const p = last.props
  switch (last.name) {
    // Both filter internally: `FrequencyBarChart.tsx:588-590`, `DetailedFrequencyTable.tsx:138-140`.
    case 'FrequencyBarChart':
    case 'DetailedFrequencyTable':
      return without(getGroupValues(p.metrics as MetricDefinitionResponse[]), p.hiddenGroupValues)
    case 'HeatmapTable':
    case 'StackedHorizontalBarChart':
      return uniq((p.data as { rows: { groupLabel?: string }[] }).rows.map(r => r.groupLabel))
    case 'LineChart':
      return uniq((p.data as { series: { groupValue: string | null }[] }).series.map(s => s.groupValue))
    case 'DumbbellChart':
      return (p.data as { groupValues: string[] }).groupValues
    case 'SummaryStatsTable':
      return uniq((p.data as { groupValue: string | null }[]).map(r => r.groupValue))
    case 'GroupedScalarBarChart':
      return p.groupValues as string[]
    case 'VerticalBarChart':
      return p.histogram
        ? `pooled ${JSON.stringify(p.frequencyData)}`
        : (p.groupValues as string[] | undefined) ?? 'none'
    default:
      return 'none'
  }
}

const config = (chartType: ChartType, c: Case, hidden: string[]) => ({
  column_ids: c.metrics().map(m => m.input_source_id), domain_ids: [], metric_type: c.metricType,
  grouping_column_id: 2, chart_type: chartType, hidden_group_values: hidden,
})

async function canvasGroups(chartType: ChartType, c: Case, hidden: string[]) {
  seen.length = 0
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: c.metrics(), computed_count: 0, reused_count: 1 } as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <TooltipProvider><QueryClientProvider client={qc}>
      <InlineChartRenderer projectId={1} materialId={7} content={config(chartType, c, hidden)} onFigure={() => {}} />
    </QueryClientProvider></TooltipProvider>,
  )
  await waitFor(() => expect(seen.length).toBeGreaterThan(0))
  const g = drawnGroups()
  cleanup()
  return g
}

function analysisGroups(chartType: ChartType, c: Case, hidden: string[]) {
  seen.length = 0
  const metrics = c.metrics()
  const props: AnalysisProps = {
    hasAnySelection: true, isComputing: false, qcError: null, hasResults: true, chartType,
    onComputeAll: () => {}, isComputeAllPending: false,
    orderedMetrics: metrics, selectedMetrics: metrics, colorMap: new Map(), activeLabelMap: undefined,
    chartTitle: '', chartSubtitle: '', chartFootnote: '',
    display: 'percentage', scaling: 'relative', showChartN: false, showGroupN: false, showVariableN: 'off', showCI: false,
    metricType: c.metricType, sortOrder: 'none', axisTransform: 'linear',
    formatting: DEFAULT_FORMATTING,
    hiddenResponseOptions: [], scaleOrder: 'natural', hiddenGroupValues: hidden, groupOrganization: 'variable-first', responseLabels: [],
    divergingMode: false, divergingCenter: null, divergingCenterAuto: { centerLabel: null, mode: 'boundary' }, hasMixedScales: false,
    hasMixedTypes: false,
    showErrorBand: false, lineStyle: 'connected', lineOverlay: false,
    proportionMode: 'numeric', proportionOperator: '>=', proportionThreshold: 0, proportionValues: [],
    crossTabColumnId: null, crossTabDisplay: 'count', crossTabData: undefined,
  }
  render(<AnalysisChartRenderer {...props} />)
  const g = drawnGroups()
  cleanup()
  return g
}

async function exportTable(chartType: ChartType, c: Case, hidden: string[]): Promise<ExportTable | null> {
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: c.metrics() } as never)
  const themes = [{
    id: 1,
    content: { type: 'doc', content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config(chartType, c, hidden)) } }] },
  }] as unknown as CanvasTheme[]
  return (await fetchChartTables(themes, 3, LENS)).get(1)?.table ?? null
}

/**
 * The groups an exported table names: a header, a row label's `(G)` suffix,
 * or a cell that is exactly a group's name (the grouped scalar table's Group
 * column). Read from the TABLE the three formats render (#1406 D5).
 */
function tableGroups(t: ExportTable, candidates: string[]): string[] {
  const named = new Set<string>()
  for (const g of candidates) {
    if (t.headers.includes(g)) named.add(g)
    for (const r of t.rows) {
      if (r[0]?.endsWith(` (${g})`) || r.slice(1).includes(g)) named.add(g)
    }
  }
  return candidates.filter(g => named.has(g))
}

beforeEach(() => { seen.length = 0; vi.mocked(metricsApi.quickCompute).mockReset() })
afterEach(cleanup)

const rows = (Object.entries(ARMS) as [ChartType, Case[]][])
  .flatMap(([type, cases]) => cases.map(c => ({ type, c, name: `${type} · ${c.metricType}` })))

describe('#1479 — a hidden group is hidden on every Canvas arm, as the Analysis view hides it', () => {
  it.each(rows)('$name: the embed draws the Analysis view’s groups', async ({ type, c }) => {
    const canvas = await canvasGroups(type, c, ['B'])
    const analysis = analysisGroups(type, c, ['B'])
    expect(canvas).toEqual(analysis)
    if (c.expect === 'hides') expect(canvas).toEqual(['A', 'C'])
  })

  it.each(rows.filter(r => r.c.expect === 'hides'))('$name: the exported table names only the visible groups', async ({ type, c }) => {
    const t = await exportTable(type, c, ['B'])
    expect(t).not.toBeNull()
    expect(tableGroups(t!, ['A', 'B', 'C'])).toEqual(['A', 'C'])
  })

  it.each(rows.filter(r => r.c.expect === 'hides'))('control — $name: with nothing hidden, all three groups are drawn and exported', async ({ type, c }) => {
    expect(await canvasGroups(type, c, [])).toEqual(['A', 'B', 'C'])
    expect(analysisGroups(type, c, [])).toEqual(['A', 'B', 'C'])
    expect(tableGroups((await exportTable(type, c, []))!, ['A', 'B', 'C'])).toEqual(['A', 'B', 'C'])
  })
})

describe('#1479 — the line arm with ONE group left visible', () => {
  // Hide B and C. `LineChart` still treats a lone series WITH a group as grouped
  // (`LineChart.tsx:135`) and names it in its legend and data table; the export
  // must not collapse it into the ungrouped `Metric | Value | N` shape, which
  // would print group A's numbers with nothing saying they are A's.
  it('the embed draws the one series, named', async () => {
    expect(await canvasGroups('line', ARMS.line[0], ['B', 'C'])).toEqual(['A'])
  })
  it('the exported table still names the group', async () => {
    const t = await exportTable('line', ARMS.line[0], ['B', 'C'])
    expect(t?.headers).toEqual(['Metric', 'A'])
    expect(t?.rows).toEqual([['m3', '1'], ['m4', '1']])
  })
  it('control — an UNGROUPED line keeps its Value and N columns', async () => {
    const ungrouped = () => [3, 4].map(id => ({
      id, name: `M${id}`, input_source_label: `m${id}`, metric_type: 'mean', input_source_id: id,
      input_source_type: 'dataset_column', grouping_column_id: null,
      results: [{ group_value: null, valid_n: 5, result_data: { mean: id, ci_method: 't' } }],
    }) as unknown as MetricDefinitionResponse)
    const t = await exportTable('line', { metricType: 'mean', metrics: ungrouped, expect: 'hides' }, [])
    expect(t?.headers).toEqual(['Metric', 'Value', 'N'])
    expect(t?.rows).toEqual([['m3', '3', '5'], ['m4', '4', '5']])
  })
})
