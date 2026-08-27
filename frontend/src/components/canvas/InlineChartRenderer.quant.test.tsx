/**
 * #817 / #823(g) — a QUANTITATIVE material must draw its own figure.
 *
 * ⚠️ **Sibling of `InlineChartRenderer.test.tsx`, which states that every one of
 * its fixtures is qualitative.** That is the right premise there and the wrong
 * one here: the defects below live entirely in the quantitative branch, and a
 * qualitative fixture passes with or without them.
 *
 * **The defect, measured on the GSS canvas.** A comparison material rendered
 *
 *     Metric                             1       2       3
 *     Trust scale A (Depends = middle)   47.1%   6.3%    46.6%
 *
 * — the pooled frequency distribution of its own variables — under the title
 * *"Comparison · Trust scale A (Depends = middle) by degree"*, with F = 690.88,
 * the per-group n/M/SD, p, ω² and the whole Tukey block absent. The canvas had
 * no quantitative-comparison renderer at all, so the config fell into the metric
 * branch and `detectChartType` picked a plausible chart for the wrong data.
 *
 * ⚠️ **The load-bearing assertion is which ENDPOINT is called**, not what is on
 * screen. A render assertion alone would pass against a renderer that drew a
 * comparison table from metric data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import InlineChartRenderer from './InlineChartRenderer'

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

import { metricsApi, comparisonsApi } from '@/lib/api'

/** The shape `AnalysisView` saves for a group comparison (corpus material 7). */
function comparisonConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    column_ids: [],
    domain_ids: [1],
    metric_type: 'frequency_distribution', // carried from the descriptives tab
    compare_by: 60,
    rc_view: 'comparisons',
    test_type: 'auto',
    nonparametric: false,
    // `rc_chart_type` is absent for the DEFAULT table, exactly as saved.
    ...over,
  }
}

/** A descriptives config — the control that must keep using quickCompute. */
function metricConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { column_ids: [11], domain_ids: [], metric_type: 'mean', ...over }
}

function comparisonResponse() {
  return {
    groups: ['Under 45', '45 and over'],
    group_column_label: 'degree',
    rows: [{
      label: 'Trust scale A',
      full_label: 'Trust scale A (Depends = middle)',
      source_id: 1,
      source_type: 'domain',
      group_stats: [
        { group: 'Under 45', n: 120, mean: 2.31, sd: 0.5, median: 2, ci_lower: 2.2, ci_upper: 2.4 },
        { group: '45 and over', n: 98, mean: 1.88, sd: 0.6, median: 2, ci_lower: 1.8, ci_upper: 2.0 },
      ],
      test: {
        test_type: 'one_way_anova', statistic: 690.88, df: 1, p: 0.0001,
        effect_size: 0.06, effect_size_type: 'eta_squared', omega_squared: 0.06,
      },
      test_omitted_reason: null,
    }],
    bonferroni_warning: false,
    bonferroni_threshold: null,
    unavailable_reason: null,
  }
}

function metricResponse(metricType = 'frequency_distribution') {
  return {
    metrics: [{
      id: 1, name: 'Trust scale A', metric_type: metricType,
      input_source_type: 'dataset_column', input_source_id: 11,
      grouping_column_id: null, input_source_label: 'Trust scale A',
      results: [{
        group_value: null, valid_n: 218, total_n: 218,
        result_data: metricType === 'mean'
          ? { mean: 2.1, std_dev: 0.5, min: 1, max: 3 }
          : { counts: { '1': 47, '2': 6, '3': 47 }, percentages: { '1': 47.1, '2': 6.3, '3': 46.6 } },
      }],
    }],
  }
}

function renderEmbed(content: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={qc}>
        <InlineChartRenderer projectId={4} materialId={7} content={content} onFigure={() => {}} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(metricsApi.quickCompute).mockReset()
  vi.mocked(metricsApi.crossTabulation).mockReset()
  vi.mocked(comparisonsApi.groupComparison).mockReset()
  vi.mocked(metricsApi.quickCompute).mockResolvedValue(metricResponse() as never)
  vi.mocked(comparisonsApi.groupComparison).mockResolvedValue(comparisonResponse() as never)
  vi.mocked(metricsApi.crossTabulation).mockResolvedValue({
    row_values: ['1', '2'], col_values: ['A', 'B'],
    cells: [[{ count: 3, row_pct: 50, col_pct: 50, total_pct: 25 }, { count: 3, row_pct: 50, col_pct: 50, total_pct: 25 }],
            [{ count: 3, row_pct: 50, col_pct: 50, total_pct: 25 }, { count: 3, row_pct: 50, col_pct: 50, total_pct: 25 }]],
    row_totals: [6, 6], col_totals: [6, 6], grand_total: 12,
    row_label: 'trust', col_label: 'degree', chi_square: null,
  } as never)
})

describe('#817 — a comparison embed draws the comparison', () => {
  it('calls the COMPARISON endpoint, not quickCompute', async () => {
    renderEmbed(comparisonConfig())
    await waitFor(() => expect(comparisonsApi.groupComparison).toHaveBeenCalled())
    // The whole defect in one assertion: computing a metric here is what drew
    // the pooled distribution under the comparison's title.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('sends the saved grouping, test and scope', async () => {
    renderEmbed(comparisonConfig({ compare_by_2: 61, test_type: 'anova', exclude_groups: ['Other'] }))
    await waitFor(() => expect(comparisonsApi.groupComparison).toHaveBeenCalled())
    expect(vi.mocked(comparisonsApi.groupComparison).mock.calls[0][1]).toMatchObject({
      grouping_column_id: 60,
      grouping_column_id_2: 61,
      test_type: 'anova',
      exclude_groups: ['Other'],
      domain_ids: [1],
    })
  })

  it('asks for the QQ points only when the QQ panel is what was saved', async () => {
    // #525b — the only O(n) field in the payload, opt-in in the analysis view
    // for that reason. An embed that always asked would pay it on every render.
    renderEmbed(comparisonConfig())
    await waitFor(() => expect(comparisonsApi.groupComparison).toHaveBeenCalled())
    expect(vi.mocked(comparisonsApi.groupComparison).mock.calls[0][1].include_qq).toBeUndefined()
    cleanup()
    vi.mocked(comparisonsApi.groupComparison).mockClear()
    renderEmbed(comparisonConfig({ rc_chart_type: 'comparison_qq' }))
    await waitFor(() => expect(comparisonsApi.groupComparison).toHaveBeenCalled())
    expect(vi.mocked(comparisonsApi.groupComparison).mock.calls[0][1].include_qq).toBe(true)
  })

  it('renders the groups and the test, not a frequency distribution', async () => {
    renderEmbed(comparisonConfig())
    expect(await screen.findByText(/Under 45/)).toBeInTheDocument()
    // The pooled percentages that used to render here. Their absence is the
    // observable half of the fix.
    expect(screen.queryByText('47.1%')).not.toBeInTheDocument()
  })

  it('a descriptives material still computes a metric', async () => {
    // The positive control. A fix that routed everything to the comparison
    // endpoint would pass every assertion above and break every other chart.
    renderEmbed(metricConfig())
    await waitFor(() => expect(metricsApi.quickCompute).toHaveBeenCalled())
    expect(comparisonsApi.groupComparison).not.toHaveBeenCalled()
  })

  it('needs BOTH markers, so a stale compare_by cannot hijack a descriptives chart', async () => {
    renderEmbed(metricConfig({ compare_by: 60 }))
    await waitFor(() => expect(metricsApi.quickCompute).toHaveBeenCalled())
    expect(comparisonsApi.groupComparison).not.toHaveBeenCalled()
  })

  it('an empty comparison speaks the shared reason vocabulary', async () => {
    // #823c/#827's contract reaches the canvas too — it must not invent a
    // sentence here either.
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue({
      ...comparisonResponse(), rows: [], unavailable_reason: 'no_group_values',
    } as never)
    renderEmbed(comparisonConfig())
    expect(await screen.findByText(/None of these records/)).toBeInTheDocument()
  })
})

describe('#823(g) — the four types that printed their own name', () => {
  // ⚠️ **Asserted POSITIVELY, and the first draft was not.** It read
  // `expect(queryByText(`${chartType} chart`)).not.toBeInTheDocument()` — and
  // MUTATION-TESTING showed it passing with the raw-token fallback restored,
  // because `{chartType} chart` renders as TWO text nodes and `queryByText`
  // matches neither. A negative assertion querying a channel the value can
  // never appear in is indistinguishable from a pass (#770). Assert the thing
  // that must exist instead.
  it.each([
    ['frequency_table', 'frequency_distribution', 'table'],
    ['table', 'mean', 'table'],
    ['dumbbell', 'mean', 'svg'],
  ])('%s draws a real figure', async (chartType, metricType, selector) => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue(metricResponse(metricType) as never)
    const { container } = renderEmbed(metricConfig({ chart_type: chartType, metric_type: metricType }))
    await waitFor(() => expect(metricsApi.quickCompute).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector(selector)).toBeTruthy())
    // ...and the "cannot draw this" notice is NOT what rendered.
    expect(screen.queryByText(/can’t be drawn on the canvas yet/)).not.toBeInTheDocument()
  })

  it('a cross-tab fetches its own endpoint', async () => {
    renderEmbed(metricConfig({ chart_type: 'cross_tab', cross_tab_column_id: 12 }))
    await waitFor(() => expect(metricsApi.crossTabulation).toHaveBeenCalled())
    expect(vi.mocked(metricsApi.crossTabulation).mock.calls[0][1]).toMatchObject({
      row_column_id: 11, col_column_id: 12,
    })
  })

  it('a cross-tab with no comparison column says which half is missing', async () => {
    renderEmbed(metricConfig({ chart_type: 'cross_tab' }))
    expect(await screen.findByText(/no comparison column saved/)).toBeInTheDocument()
    expect(metricsApi.crossTabulation).not.toHaveBeenCalled()
  })

  it('an unknown type names no token', async () => {
    // A type from a newer build. The old default printed it verbatim, which
    // reads as a rendering bug rather than a limit.
    renderEmbed(metricConfig({ chart_type: 'sunburst' }))
    expect(await screen.findByText(/can’t be drawn on the canvas yet/)).toBeInTheDocument()
    expect(screen.queryByText(/sunburst/)).not.toBeInTheDocument()
  })
})

describe('#831 — a correlation material refuses rather than draws', () => {
  /**
   * The MOUNT half. `inline-chart-params.test.ts` proves the predicate; only
   * this proves the renderer acts on it — mutation-verified: removing
   * `!isCorrelationMaterial` from `hasSelection` left the whole canvas suite
   * green until these existed ("a component test proves the COMPONENT, not the
   * MOUNT").
   */
  it('does NOT compute a metric on the correlation\'s own columns', async () => {
    renderEmbed({ rc_view: 'correlations', column_ids: [60, 61], metric_type: 'mean' })
    await screen.findByText(/can.t be drawn on the canvas yet/i)
    // The defect this closes: a plausible frequency/mean chart of the
    // correlation's variables, under the correlation's title.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('names WHICH kind it is, so the notice does not read as a rendering fault', async () => {
    renderEmbed({ rc_view: 'correlations', column_ids: [60, 61] })
    expect(await screen.findByText(/Correlation matrices/i)).toBeTruthy()

    cleanup()
    renderEmbed({ column_ids: [60, 61], show_scatter: true })
    expect(await screen.findByText(/Scatter matrices/i)).toBeTruthy()
  })

  it('recovers a LEGACY non-Pearson correlation, which left a trace', async () => {
    renderEmbed({ column_ids: [60, 61], corr_type: 'spearman' })
    await screen.findByText(/can.t be drawn on the canvas yet/i)
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('a legacy default-Pearson material still computes — the ACCEPTED residual', async () => {
    // Recorded as a test so the boundary is visible rather than assumed. It
    // carries no marker of any kind, so it is indistinguishable from
    // descriptives and behaves exactly as it did before #831.
    renderEmbed({ column_ids: [60, 61], metric_type: 'frequency_distribution' })
    await waitFor(() => expect(metricsApi.quickCompute).toHaveBeenCalled())
  })
})
