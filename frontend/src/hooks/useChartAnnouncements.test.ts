/**
 * #786 — the chart's screen-reader announcements.
 *
 * 🔴 **The filed diagnosis was wrong, and the wrong fix would have passed review.**
 * The entry said the chart-type effect lacked the `metricCount > 0` gate its sibling
 * one block above has. It does lack it — and adding it would have fixed nothing.
 * `activeChartType` is already `null` at zero metrics, so the announcement heard with
 * an empty selection comes from somewhere else: a RACE. `continuousSelection`
 * recomputes from `selectedColumnIds` the instant a checkbox clears, while
 * `selectedMetrics` still holds the previous quick-compute result — so for one commit
 * the derived default flips to `horizontal_bar` and the hook faithfully reports a
 * state that was never rendered. **`metricCount` is the stale half of that race**, so
 * gating on it is gating on the wrong clock.
 *
 * The gate is `hasChart` — the SYNCHRONOUS selection.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import {
  useChartAnnouncements,
  describeChartTypeChange,
  composeAnnouncement,
} from './useChartAnnouncements'
import type { ChartType } from '@/lib/chart-data'

afterEach(cleanup)

type Deps = Parameters<typeof useChartAnnouncements>[0]

const BASE: Deps = {
  isComputing: false,
  metricCount: 0,
  hasChart: false,
  chartType: null,
  groupingColumnId: null,
  groupingColumnId2: null,
  demographics: [],
}

/** Render, then let the mount-skip rAF fire so later changes actually announce. */
async function setup(initial: Partial<Deps> = {}) {
  const view = renderHook((p: Deps) => useChartAnnouncements(p), {
    initialProps: { ...BASE, ...initial },
  })
  await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))) })
  return view
}

describe('describeChartTypeChange', () => {
  it('says nothing when there is no chart type', () => {
    expect(describeChartTypeChange('histogram', null, {})).toBeNull()
  })

  it('is a plain change with no previous type', () => {
    expect(describeChartTypeChange(null, 'histogram', {})).toBe('Chart type changed to Histogram')
  })

  it('is a plain change when the previous type is still available', () => {
    expect(describeChartTypeChange('histogram', 'horizontal_bar', {}))
      .toBe('Chart type changed to Horizontal Bar')
  })

  /**
   * The reported case: a second continuous variable makes the histogram
   * inapplicable, the chart swaps itself, and nothing on screen says why. The
   * reason is not invented here — it is the one already authored beside the
   * availability rule, so the sentence cannot drift from the picker's.
   */
  it('explains an AUTOMATIC change with the reason the type became unavailable', () => {
    expect(describeChartTypeChange('histogram', 'horizontal_bar', {
      histogram: 'Select a single variable to see its distribution',
    })).toBe(
      'Histogram is no longer available — Select a single variable to see its distribution. '
      + 'Showing Horizontal Bar instead.'
    )
  })
})

describe('#786 — nothing is announced when there is no chart', () => {
  it('does NOT announce a chart type with an empty selection', async () => {
    const view = await setup({ hasChart: false, chartType: null })
    // The race: the metric list still reports 1 while the selection is already empty.
    await act(async () => {
      view.rerender({ ...BASE, hasChart: false, metricCount: 1, chartType: 'horizontal_bar' })
    })
    expect(view.result.current).toBe('')
  })

  it('DOES announce once a chart exists', async () => {
    const view = await setup({ hasChart: true, chartType: null })
    await act(async () => {
      view.rerender({ ...BASE, hasChart: true, metricCount: 1, chartType: 'histogram' })
    })
    // Two facts, one commit: the metric count and the chart type both changed
    // here, and before #791 the chart-type effect (declared last) elected itself
    // the only survivor. The composed form also terminates each fact — the
    // banner's copy, straight from `describeChartTypeChange`, is unchanged.
    expect(view.result.current)
      .toBe('Chart updated with 1 variable. Chart type changed to Histogram.')
  })

  /**
   * ⚠️ POPULATION assertion. The hook has FIVE effects that speak and only ONE of
   * them carried a selection gate — the one whose author clearly knew. Asserting the
   * whole set is what stops the sixth from arriving ungated, which is exactly how
   * #771's rule shipped partial four times on the row controls.
   */
  const SILENT_WITH_NO_CHART: Array<[string, Partial<Deps>]> = [
    ['chart type', { chartType: 'histogram' as ChartType }],
    ['compute complete', { isComputing: false, metricCount: 3 }],
    ['group by applied', { groupingColumnId: 42 }],
    ['grouping removed', { groupingColumnId: null }],
    ['diverging layout', { divergingMode: true }],
    ['axis transform', { axisTransform: 'log' }],
  ]

  it.each(SILENT_WITH_NO_CHART)('says nothing about %s with no chart', async (_name, change) => {
    // Start with grouping set so the "removed" case has something to transition FROM.
    const view = await setup({ hasChart: false, groupingColumnId: 7 })
    await act(async () => {
      view.rerender({ ...BASE, hasChart: false, groupingColumnId: 7, ...change })
    })
    expect(view.result.current).toBe('')
  })

  /**
   * The gate must SUPPRESS, never break the bookkeeping underneath it. The grouping
   * effect tracks its own previous value; if the gate short-circuited before that
   * assignment, the first announcement after a chart appeared would be wrong.
   */
  it('resumes correctly after a chart appears — the gate suppresses, it does not corrupt', async () => {
    const view = await setup({ hasChart: false, groupingColumnId: null })
    await act(async () => {
      view.rerender({ ...BASE, hasChart: false, groupingColumnId: 42 })
    })
    expect(view.result.current).toBe('')

    await act(async () => {
      view.rerender({ ...BASE, hasChart: true, groupingColumnId: null })
    })
    expect(view.result.current).toBe('Grouping removed.')
  })
})

describe('composeAnnouncement', () => {
  it('says nothing when nothing was recorded', () => {
    expect(composeAnnouncement({})).toBe('')
  })

  it('terminates a single fact so the reader gets a sentence boundary', () => {
    expect(composeAnnouncement({ chartType: 'Chart type changed to Histogram' }))
      .toBe('Chart type changed to Histogram.')
  })

  /**
   * The automatic chart-type explanation already ends in a full stop. Appending a
   * second one is the kind of thing no assertion notices and every reader does.
   */
  it('does not double a stop the part already ends with', () => {
    expect(composeAnnouncement({
      chartType: 'Histogram is no longer available — pick one variable. Showing Horizontal Bar instead.',
    })).toBe('Histogram is no longer available — pick one variable. Showing Horizontal Bar instead.')
  })

  /**
   * ⚠️ The ORDER is the fix. Passing the parts in the opposite order must not
   * change the sentence — if it does, composition has inherited the declaration
   * order that caused #791 in the first place.
   */
  it('reads in editorial order regardless of the order facts were recorded', () => {
    const expected = 'Chart updated with 3 variables. Chart type changed to Heatmap. Group by: Region applied.'
    expect(composeAnnouncement({
      grouping: 'Group by: Region applied',
      chartType: 'Chart type changed to Heatmap',
      update: 'Chart updated with 3 variables',
    })).toBe(expected)
    expect(composeAnnouncement({
      update: 'Chart updated with 3 variables',
      chartType: 'Chart type changed to Heatmap',
      grouping: 'Group by: Region applied',
    })).toBe(expected)
  })
})

/**
 * #791 — five effects wrote one state, React batched them, and the last-DECLARED
 * writer won. `Chart updated with N variables` never reached the DOM at all.
 *
 * ⚠️ These assertions are what a REVERT fails: restore the direct
 * `setAnnouncement(message)` and every case below reports only the chart-type
 * sentence, because that effect is declared after the others.
 */
describe('#791 — facts recorded in one commit are all heard', () => {
  const CHART = { hasChart: true, chartType: 'histogram' as ChartType, metricCount: 1 }

  it('does not let the chart-type change swallow the compute-complete announcement', async () => {
    const view = await setup(CHART)
    await act(async () => {
      view.rerender({ ...BASE, ...CHART, metricCount: 2, chartType: 'horizontal_bar' })
    })
    expect(view.result.current)
      .toBe('Chart updated with 2 variables. Chart type changed to Horizontal Bar.')
  })

  /**
   * ⚠️ POPULATION assertion, and it is the form that matters here. Any ONE of these
   * co-firing with a chart-type change is a channel that could be silently elected
   * away — and the old defect was invisible precisely because each effect looked
   * correct on its own. `prime` exists because the grouping effect deliberately
   * swallows its first transition (it has no previous value to compare against).
   */
  const CO_OCCURRING: Array<[string, Partial<Deps>, Partial<Deps>, string]> = [
    ['compute complete', {}, { metricCount: 4 }, 'Chart updated with 4 variables.'],
    ['group by', { groupingColumnId: 7 }, { groupingColumnId: 42 }, 'Group by: variable applied.'],
    ['grouping removed', { groupingColumnId: 7 }, { groupingColumnId: null }, 'Grouping removed.'],
    ['diverging layout', {}, { divergingMode: true }, 'Diverging layout applied.'],
    ['axis transform', {}, { axisTransform: 'log' }, 'Log scale applied.'],
  ]

  it.each(CO_OCCURRING)(
    'still says %s when the chart type changes in the same commit',
    async (_name, prime, change, expected) => {
      const view = await setup({ ...CHART, ...prime })
      if (Object.keys(prime).length > 0) {
        // Move off the primed value so the effect's own bookkeeping is initialised
        // without consuming the assertion.
        await act(async () => {
          view.rerender({ ...BASE, ...CHART, ...prime, groupingColumnId: 99 })
        })
      }
      await act(async () => {
        view.rerender({ ...BASE, ...CHART, ...prime, ...change, chartType: 'heatmap' })
      })
      expect(view.result.current).toContain(expected)
      expect(view.result.current).toContain('Chart type changed to Heatmap.')
    },
  )

  /**
   * The region kept describing a chart that was gone: `announce` is suppressed with
   * no chart, so the last sentence simply stayed there. It does not re-announce (a
   * removal is not spoken), but a reader navigating to the region by hand read it.
   */
  it('clears when the chart goes away', async () => {
    const view = await setup({ hasChart: true, chartType: null })
    await act(async () => {
      view.rerender({ ...BASE, hasChart: true, metricCount: 1, chartType: 'histogram' })
    })
    expect(view.result.current)
      .toBe('Chart updated with 1 variable. Chart type changed to Histogram.')

    await act(async () => {
      view.rerender({ ...BASE, hasChart: false, metricCount: 0, chartType: null })
    })
    expect(view.result.current).toBe('')
  })

  it('counts one variable as one variable', async () => {
    const view = await setup({ hasChart: true, metricCount: 0 })
    await act(async () => {
      view.rerender({ ...BASE, hasChart: true, metricCount: 1 })
    })
    expect(view.result.current).toBe('Chart updated with 1 variable.')
  })
})
