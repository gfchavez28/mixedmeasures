/**
 * Tests for DomainPickerDetail (Phase 4.7).
 *
 * Covers the three core behaviors described in the Phase 4 directive:
 *   1. Members preview — grouped by dataset with truncation
 *   2. Multi-metric radio — `(auto)` suffix + hint pre-selection
 *   3. Empty-metrics state — "Create scale score" button
 *
 * Bootstrap pattern follows `frontend/src/components/MappingDialog.test.tsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type {
  AnalysisDomainResponse,
  MetricDefinitionSummaryResponse,
  DomainMemberInfo,
} from '@/lib/api'
import DomainPickerDetail from './DomainPickerDetail'

afterEach(() => cleanup())

function makeMember(id: number, dataset: string, label: string, datasetId: number): DomainMemberInfo {
  return {
    id,
    member_type: 'column',
    member_id: id,
    label,
    dataset_id: datasetId,
    dataset_name: dataset,
    column_code: label,
    column_type: 'ordinal',
    scale_points: 5,
    scale_labels: null,
    equivalence_group_id: null,
  }
}

function makeDomain(overrides: Partial<AnalysisDomainResponse> = {}): AnalysisDomainResponse {
  return {
    id: 42,
    project_id: 1,
    name: 'Wellness',
    description: null,
    color: '#7c3aed',
    sequence_order: 0,
    origin: 'human',
    member_count: 3,
    members: [
      makeMember(1, 'Board', 'BQ1', 100),
      makeMember(2, 'Staff', 'SQ1', 200),
      makeMember(3, 'Staff', 'SQ2', 200),
    ],
    created_at: '2026-04-28T00:00:00Z',
    updated_at: '2026-04-28T00:00:00Z',
    ...overrides,
  }
}

function makeMetric(overrides: Partial<MetricDefinitionSummaryResponse> = {}): MetricDefinitionSummaryResponse {
  return {
    id: 100,
    project_id: 1,
    name: 'Wellness scale',
    description: null,
    metric_type: 'domain_aggregate',
    config: {},
    input_source_type: 'dataset_domain',
    input_source_id: 42,
    input_source_label: 'Wellness',
    grouping_column_id: null,
    grouping_column_id_2: null,
    grouping_mode: null,
    exclude_values: null,
    sequence_order: 0,
    origin: 'human',
    origin_context: 'crosswalk_auto',
    stale: false,
    result_type: 'metric_summary',
    latest_computed_at: null,
    total_valid_n: null,
    result_count: 0,
    last_accessed_at: null,
    created_at: '2026-04-28T00:00:00Z',
    updated_at: '2026-04-28T00:00:00Z',
    ...overrides,
  }
}

describe('DomainPickerDetail', () => {
  it('renders member preview grouped by dataset', () => {
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    // Two dataset groups — Board (1 member) + Staff (2 members)
    expect(screen.getByText('Board')).toBeInTheDocument()
    expect(screen.getByText(': BQ1')).toBeInTheDocument()
    expect(screen.getByText('Staff')).toBeInTheDocument()
    expect(screen.getByText(': SQ1, SQ2')).toBeInTheDocument()
  })

  it('shows "Create scale score" button when no ungrouped metric exists', () => {
    const onCreate = vi.fn()
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[]}
        onCreateScoreMetric={onCreate}
        isCreatingMetric={false}
      />,
    )
    const btn = screen.getByRole('button', { name: /Create scale score/i })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onCreate).toHaveBeenCalledWith(42)
  })

  it('renders single-metric label with (auto) suffix when crosswalk_auto', () => {
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[makeMetric()]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    // input_source_label "Wellness" + " (auto)"
    expect(screen.getByText('Wellness (auto)')).toBeInTheDocument()
    // Not shown as a button — it's a label preview
    expect(screen.queryByRole('button', { name: /Create scale score/i })).not.toBeInTheDocument()
  })

  it('multi-metric radio pre-selects the auto variant when no hint', () => {
    const auto = makeMetric({ id: 100, origin_context: 'crosswalk_auto', input_source_label: 'Wellness' })
    const manual = makeMetric({ id: 200, origin_context: null, input_source_label: 'Wellness alt' })
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[manual, auto]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const autoRadio = radios.find(r => (r as HTMLInputElement).value === '100') as HTMLInputElement
    const manualRadio = radios.find(r => (r as HTMLInputElement).value === '200') as HTMLInputElement
    expect(autoRadio.checked).toBe(true)
    expect(manualRadio.checked).toBe(false)
  })

  it('multi-metric radio honors selectedMetricIdHint', () => {
    const auto = makeMetric({ id: 100, origin_context: 'crosswalk_auto' })
    const manual = makeMetric({ id: 200, origin_context: null, input_source_label: 'Wellness alt' })
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[auto, manual]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
        selectedMetricIdHint={200}
      />,
    )
    const manualRadio = screen.getAllByRole('radio').find(
      r => (r as HTMLInputElement).value === '200',
    ) as HTMLInputElement
    expect(manualRadio.checked).toBe(true)
  })

  it('foot-gun: filters out grouped variants from the ungrouped list', () => {
    const ungrouped = makeMetric({ id: 100, grouping_column_id: null, grouping_column_id_2: null })
    const grouped = makeMetric({
      id: 200,
      grouping_column_id: 5,
      grouping_column_id_2: null,
      input_source_label: 'Wellness by region',
    })
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[ungrouped, grouped]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    // Only the ungrouped metric survives the filter — single metric → label, no radio
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByText(/by region/)).not.toBeInTheDocument()
  })
})
