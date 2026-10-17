/**
 * #1168 R7 — WHICH payload's `stale_domain_ids` reaches the out-of-date notice
 * on the Relationships & Comparisons tab. `StaleScaleScoresNotice.test.tsx`
 * covers the notice itself; this pins the wiring, which a notice-only test
 * cannot see (a parent passing `[]` would leave it green).
 *
 * The chart components are stubbed: what is under test is the decision beside
 * them, and their own suites cover them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { CorrelationMatrixResponse, GroupComparisonResponse, ScatterMatrixResponse } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  correlationsApi: {}, comparisonsApi: {}, domainsApi: { createScoreMetric: vi.fn() },
  downloadBlob: vi.fn(), extractApiError: (_e: unknown, f: string) => f,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/components/charts/ChartExportWrapper', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/charts/CorrelationMatrixTable', () => ({ default: () => <div>MATRIX</div> }))
vi.mock('@/components/charts/ScatterMatrix', () => ({ default: () => <div>SCATTER</div> }))
vi.mock('@/components/charts/GroupComparisonTable', () => ({ default: () => <div>COMPARISON</div> }))

import CorrelationsComparisonsContent, { type CorrelationsComparisonsContentProps } from './CorrelationsComparisonsContent'

afterEach(cleanup)

const DOMAINS = [{ id: 4, name: 'Wellbeing' }, { id: 6, name: 'Local' }]

const corr = (stale: number[]): CorrelationMatrixResponse => ({
  labels: ['Wellbeing', 'Local'], full_labels: ['Wellbeing', 'Local'],
  matrix: [], adjusted_alpha: null, num_comparisons: 1, stale_domain_ids: stale,
})
const scatter = (stale: number[]): ScatterMatrixResponse => ({
  labels: [], full_labels: [], pairs: [], truncated: false, stale_domain_ids: stale,
})
const comparison = (stale: number[], rows = 1): GroupComparisonResponse => ({
  groups: ['a', 'b'], group_column_label: 'Site',
  rows: Array.from({ length: rows }, (_, i) => ({
    label: `r${i}`, full_label: `r${i}`, source_id: 4, source_type: 'domain',
    group_stats: [], test: null, test_omitted_reason: null,
  })),
  bonferroni_warning: false, bonferroni_threshold: null,
  unavailable_reason: rows === 0 ? 'domain_scores_not_computed' : null,
  stale_domain_ids: stale,
})

function mount(over: Partial<CorrelationsComparisonsContentProps>) {
  const props: CorrelationsComparisonsContentProps = {
    pid: 3, rcView: 'correlations',
    hasRcSelection: true, rcColumnIds: [], rcDomainIds: [4, 6],
    corrType: 'pearson', corrMatrixData: undefined, isCorrFetching: false,
    showScatter: false, scatterMatrixData: undefined, isScatterFetching: false,
    showRegLine: false, showJitter: false, corrCellFormat: 'r_stars', corrColors: 'default',
    sigLevels: { show_05: true, show_01: true, show_001: true }, bonferroniOn: false,
    hasComparisonSelection: false, compareBy: null, compareBy2: null, testType: 'auto',
    nonparametric: false, rcChartType: 'comparison_table', comparisonData: undefined,
    isComparisonFetching: false, excludeGroups: [], rcFormatting: {},
    postHocExpanded: false, onPostHocToggle: () => {},
    domains: DOMAINS, setUrlParam: () => {},
    ...over,
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CorrelationsComparisonsContent {...props} />
    </QueryClientProvider>,
  )
}

const notice = () => screen.queryByText(/^Out of date:/)

describe('correlations view', () => {
  it('names the groups the MATRIX payload says are out of date', () => {
    mount({ corrMatrixData: corr([4]) })
    expect(screen.getByText('MATRIX')).toBeInTheDocument()
    expect(notice()).toHaveTextContent('the scale score for “Wellbeing” was computed before its data changed')
  })

  it('absent when the payload names none (POSITIVE CONTROL above)', () => {
    mount({ corrMatrixData: corr([]) })
    expect(screen.getByText('MATRIX')).toBeInTheDocument()
    expect(notice()).toBeNull()
  })

  it('joins the scatter matrix ids when it is shown, once each', () => {
    mount({ corrMatrixData: corr([4]), showScatter: true, scatterMatrixData: scatter([4, 6]) })
    expect(notice()).toHaveTextContent('the scale scores for “Wellbeing” and “Local”')
  })

  it('says nothing while the result is being recomputed — "Computing…" is on screen instead', () => {
    mount({ corrMatrixData: corr([4]), isCorrFetching: true })
    expect(notice()).toBeNull()
  })
})

describe('comparisons view', () => {
  const base = { rcView: 'comparisons' as const, hasComparisonSelection: true, compareBy: 2 }

  it('names the groups the COMPARISON payload says are out of date', () => {
    mount({ ...base, comparisonData: comparison([4, 6]) })
    expect(screen.getByText('COMPARISON')).toBeInTheDocument()
    expect(notice()).toHaveTextContent('the scale scores for “Wellbeing” and “Local” were computed')
  })

  it('reads the comparison payload, not the correlation one', () => {
    mount({ ...base, comparisonData: comparison([]), corrMatrixData: corr([4]) })
    expect(notice()).toBeNull()
  })

  it('an empty comparison keeps its own compute button and gets no second one', () => {
    mount({ ...base, comparisonData: comparison([4], 0) })
    expect(notice()).toBeNull()
  })
})
