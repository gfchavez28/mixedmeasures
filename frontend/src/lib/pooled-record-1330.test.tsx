/**
 * #1330 (1.5.9, D53/D54) — a variable group's POOLED answers come several to a
 * record, and their intervals now count each record once. The client displays what
 * the server states: the three new `ci_method`s, the record count beside the pooled
 * n, and the standard error over records instead of the naive `sd / √n` it used to
 * derive (which would have contradicted the interval beside it).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { MetricDefinitionResponse } from '@/lib/api'
import { ciCaveat, ciLabel, ciQualifier } from './ci-label'
import { pooledNCaveat, pooledNLabel } from './aggregate-basis'
import { shapeSummaryStats } from './chart-data'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import FrequencyBarChart from '@/components/charts/FrequencyBarChart'
import SummaryStatsTable from '@/components/charts/SummaryStatsTable'
import { stubChartGlobals } from '@/test-support/recharts-render'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function metric(
  mtype: string, source: 'dataset_domain' | 'dataset_column', resultData: Record<string, unknown>,
  validN = 300,
): MetricDefinitionResponse {
  return {
    id: 7, name: 'Wellbeing', input_source_label: 'Wellbeing', origin_context: null,
    metric_type: mtype, input_source_type: source, input_source_id: 3,
    results: [{ id: 1, group_value: null, valid_n: validN, total_n: validN,
      computed_at: '2026-11-02T00:00:00Z', result_data: resultData }],
  } as unknown as MetricDefinitionResponse
}

describe('the three intervals say they are over records', () => {
  it('the pooled mean', () => {
    expect(ciLabel('record_cluster_t')).toBe('95% CI over records')
    expect(ciCaveat('record_cluster_t')).toMatch(/counts each record once/)
  })

  it('the pooled proportion', () => {
    expect(ciLabel('wilson_effective_n')).toBe('95% CI over records')
    expect(ciCaveat('wilson_effective_n')).toMatch(/effective sample size/)
  })

  it('each category of a pooled frequency — per category AND over records', () => {
    expect(ciLabel('wilson_per_category_effective_n')).toBe('95% CI per category, over records')
    expect(ciCaveat('wilson_per_category_effective_n')).toMatch(/not a simultaneous set/)
    expect(ciQualifier('wilson_per_category_effective_n')).toBe(' per category, over records')
  })

  it('the old kinds read as before', () => {
    expect(ciLabel('t_interval')).toBe('95% CI')
    expect(ciLabel('wilson_per_category')).toBe('95% CI per category')
  })
})

describe('the pooled n names its records', () => {
  it('"N values from M records", read from the payload', () => {
    expect(pooledNLabel(300, 75)).toBe('300 values from 75 records')
    expect(pooledNLabel(2, 1)).toBe('2 values from 1 record')
    expect(pooledNLabel(300, 0)).toBe('300 values from 0 records')
  })

  it('a result from before 1.5.9 states no record count and keeps the bare unit', () => {
    expect(pooledNLabel(300)).toBe('300 values')
    expect(pooledNLabel(300, null)).toBe('300 values')
    expect(pooledNCaveat(300, 4)).not.toMatch(/records/)
  })

  it('the tooltip says the interval counts each record once', () => {
    expect(pooledNCaveat(300, 4, 75)).toMatch(/from 75 records, and the interval counts each record once/)
  })
})

describe('the summary table reads what the server stated', () => {
  it('the pooled mean: its record count and its SE over records, never sd / √n', () => {
    const [row] = shapeSummaryStats([metric('mean', 'dataset_domain', {
      mean: 3.0, std_dev: 1.0, ci_lower: 2.6, ci_upper: 3.4, ci_method: 'record_cluster_t',
      record_count: 75, std_error: 0.18,
    })], undefined, 'mean')
    expect(row.se).toBe(0.18)
    expect(row.se).not.toBeCloseTo(1.0 / Math.sqrt(300), 3)
    expect(row.pooledAcrossDomain).toBe(true)
    expect(row.recordCount).toBe(75)
  })

  it('the pooled proportion is pooled too, with its SE in percentage points', () => {
    const [row] = shapeSummaryStats([metric('proportion', 'dataset_domain', {
      percentage: 40, ci_method: 'wilson_effective_n', record_count: 75, std_error: 4.2,
    })], undefined, 'proportion')
    expect(row.pooledAcrossDomain).toBe(true)
    expect(row.se).toBe(4.2)
  })

  it('a real zero SE is a value, not an absence', () => {
    // Reachable: every record has the same mean while its answers vary, so the
    // spread over records is 0 and the pooled SD is not — the derived sd/√n
    // would print 0.06 where the stated SE is 0.
    const [row] = shapeSummaryStats([metric('mean', 'dataset_domain', {
      mean: 3, std_dev: 1, record_count: 75, std_error: 0,
    })], undefined, 'mean')
    expect(row.se).toBe(0)
  })

  it('the table renders what the row carries — the records beside the values, the stated SE', () => {
    const rows = shapeSummaryStats([metric('mean', 'dataset_domain', {
      mean: 3.0, std_dev: 1.0, ci_lower: 2.6, ci_upper: 3.4, ci_method: 'record_cluster_t',
      record_count: 75, std_error: 0.18,
    })], undefined, 'mean')
    const { container } = render(<SummaryStatsTable data={rows} metricType="mean" showCI />)
    const text = container.textContent ?? ''
    expect(text).toContain('300 values from 75 records')
    expect(text).toContain('0.18')
    expect(text).toContain('95% CI over records')
  })

  it('a column metric and an older result still derive it, as before', () => {
    const [col] = shapeSummaryStats([metric('mean', 'dataset_column', { mean: 3, std_dev: 1 })],
      undefined, 'mean')
    expect(col.se).toBeCloseTo(1 / Math.sqrt(300), 6)
    expect(col.pooledAcrossDomain).toBe(false)
    expect(col.recordCount).toBeNull()
  })
})

describe('the frequency chart’s n', () => {
  const freq = (source: 'dataset_domain' | 'dataset_column', extra: Record<string, unknown>) =>
    metric('frequency_distribution', source, {
      scale_order: ['Yes', 'No'], counts: { Yes: 200, No: 100 },
      percentages: { Yes: 66.7, No: 33.3 }, ...extra,
    })

  it('a pooled frequency says how many records its values came from', () => {
    const { container } = render(
      <FrequencyBarChart metrics={[freq('dataset_domain', { record_count: 75 })]} display="percentage"
        showVariableN="all" />,
    )
    expect(container.textContent).toContain('(n=300 values from 75 records)')
  })

  it('a column frequency keeps its bare n', () => {
    const { container } = render(
      <FrequencyBarChart metrics={[freq('dataset_column', {})]} display="percentage" showVariableN="all" />,
    )
    expect(container.textContent).toContain('(n=300)')
  })
})
