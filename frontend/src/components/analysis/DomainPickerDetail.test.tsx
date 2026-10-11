/**
 * Tests for DomainPickerDetail (Phase 4.7).
 *
 * Covers:
 *   1. Members preview — grouped by dataset with truncation
 *   2. The scale score — the metric the server flags `is_scale_score`, with the
 *      `(auto)` suffix (#1177 retired the multi-metric radio)
 *   3. No scale score — "Create scale score" button, lookalikes or not
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
    real_group_count: 0,
    is_scale_score: true,
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

  it('#1177: a lookalike is not the scale score — the button is offered, and no lookalike is named', () => {
    // The aggregate with some answers excluded: same group, same grouping
    // fields, same label. It used to hide the button and read "Scale score:".
    const lookalike = makeMetric({
      id: 200, origin: 'auto', origin_context: 'quick-compute',
      exclude_values: ["Don't know"], is_scale_score: false,
    })
    const onCreate = vi.fn()
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[lookalike]}
        onCreateScoreMetric={onCreate}
        isCreatingMetric={false}
      />,
    )
    expect(screen.queryByText(/Scale score:/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Create scale score/i }))
    expect(onCreate).toHaveBeenCalledWith(42)
  })

  it('#1177: beside lookalikes, only the scale score is named — and nothing is a choice', () => {
    const lookalike = makeMetric({
      id: 200, origin: 'auto', origin_context: 'quick-compute', input_source_label: 'Wellness',
      exclude_values: ["Don't know"], is_scale_score: false,
    })
    const scale = makeMetric({ id: 100 })
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[lookalike, scale]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    expect(screen.getByText('Wellness (auto)')).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('a grouped variant is never the scale score', () => {
    const grouped = makeMetric({
      id: 200, grouping_column_id: 5, input_source_label: 'Wellness by region', is_scale_score: false,
    })
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[grouped]}
        onCreateScoreMetric={vi.fn()}
        isCreatingMetric={false}
      />,
    )
    expect(screen.queryByText(/by region/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create scale score/i })).toBeInTheDocument()
  })

  it('a busy create keeps its focus and does not fire twice (#959)', () => {
    const onCreate = vi.fn()
    render(
      <DomainPickerDetail
        domain={makeDomain()}
        domainMetrics={[]}
        onCreateScoreMetric={onCreate}
        isCreatingMetric={true}
      />,
    )
    const btn = screen.getByRole('button', { name: /Creating scale score/i })
    expect(btn).not.toBeDisabled()               // `disabled` would blur a focused button
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(btn)
    expect(onCreate).not.toHaveBeenCalled()
  })
})
