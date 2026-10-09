/**
 * #1146 — Quantitative's Group By auto-clear survives the invalid-params effect.
 *
 * Both run in one commit and both write the URL. On React Router's own setter the
 * invalid-params effect ran after EVERY URL change (the setter's identity changes
 * with the URL) and navigated to the LAST RENDER's URL even with nothing invalid —
 * dropping the auto-clear made earlier in that commit, so the grouping stayed in the
 * URL, kept being sent with every compute and was saved with the chart, under a
 * select that was disabled. All three clears failed on the shipped code (the
 * 2026-10-08 audit's probe, re-run by the auditor); confirmed live on a scratch
 * install the same day.
 *
 * The real `AnalysisView`; its APIs and heavy children are stubbed, and the grouping
 * verdict is taken from the URL the way the real derivation reaches it for a mixed
 * column + group selection once metrics are in hand.
 */
import { useEffect } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  const stub = new Proxy({}, { get: () => never })
  return {
    ...actual,
    metricsApi: stub, domainsApi: stub, datasetsApi: stub, materialsApi: stub,
    statisticalTestsApi: stub, correlationsApi: stub, comparisonsApi: stub, dataQualityApi: stub,
  }
})
vi.mock('@/components/analysis/AnalysisSidebar', () => ({ default: () => null }))
vi.mock('@/components/analysis/AnalysisChartRenderer', () => ({ default: () => null }))
vi.mock('@/components/analysis/CorrelationsComparisonsContent', () => ({ default: () => null }))
vi.mock('@/components/analysis/DataQualityTab', () => ({ DataQualityContent: () => null }))
vi.mock('@/components/charts/ChartTypeToolbar', () => ({ default: () => null }))
vi.mock('@/hooks/useQuickCompute', () => ({
  useQuickCompute: () => ({ metrics: [], isComputing: false, error: null, compute: () => {}, clear: () => {} }),
}))
vi.mock('@/hooks/useAnalysisDerived', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAnalysisDerived')>('@/hooks/useAnalysisDerived')
  return {
    useAnalysisDerived: (args: Parameters<typeof actual.useAnalysisDerived>[0]) => {
      const real = actual.useAnalysisDerived(args)
      // A variable AND a group selected together → Group By unavailable; group 4 is
      // a multi-dataset domain (dataset grouping available).
      const mixed = args.selectedDomainIds.size > 0 && args.selectedColumnIds.size > 0
      const multi = args.selectedDomainIds.has(4)
      const groupByAvailability = mixed
        ? { enabled: false, datasetGroupingAvailable: false, reason: 'mixed' }
        : { enabled: true, datasetGroupingAvailable: multi, reason: '' }
      return { ...real, groupByAvailability, canGroupBy: groupByAvailability.enabled, chartType: 'horizontal_bar', activeChartType: 'horizontal_bar' }
    },
  }
})

import AnalysisView from './AnalysisView'

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const seen: {
  search: string
  keys: string[]
  navigate: ((to: string, o?: { replace?: boolean }) => void) | null
} = { search: '', keys: [], navigate: null }

function Spy() {
  const loc = useLocation()
  const nav = useNavigate()
  // Recorded after commit (an effect, not the render), once per location.
  useEffect(() => {
    seen.search = loc.search
    seen.keys.push(loc.key)
    seen.navigate = nav
  }, [loc, nav])
  return null
}

function renderAt(search: string) {
  seen.keys = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/1/analysis/quantitative${search}`]}>
          <Spy />
          <Routes>
            <Route path="/projects/:projectId/analysis/quantitative" element={<AnalysisView />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

const settle = async () => {
  await act(async () => {})
  await act(async () => {})
}

describe('AnalysisView — the Group By auto-clear lands', () => {
  it('a selection that disables Group By clears groupBy from the URL', async () => {
    renderAt('?columns=5&groupBy=7')
    await settle()
    expect(new URLSearchParams(seen.search).get('groupBy')).toBe('7') // valid at first
    await act(async () => { seen.navigate!('?columns=5&domains=3&groupBy=7', { replace: true }) })
    await settle()
    expect(new URLSearchParams(seen.search).get('groupBy')).toBeNull()
  })

  it('leaving a multi-dataset group clears groupMode=dataset', async () => {
    renderAt('?domains=4&groupMode=dataset')
    await settle()
    expect(new URLSearchParams(seen.search).get('groupMode')).toBe('dataset')
    await act(async () => { seen.navigate!('?domains=5&groupMode=dataset', { replace: true }) })
    await settle()
    expect(new URLSearchParams(seen.search).get('groupMode')).toBeNull()
  })

  it('a stale groupBy2 with no groupBy (an old link) is cleared', async () => {
    renderAt('?columns=5&groupBy2=9')
    await settle()
    expect(new URLSearchParams(seen.search).get('groupBy2')).toBeNull()
  })

  it('a URL change with nothing invalid causes no navigation of its own', async () => {
    // The invalid-params effect re-runs on every URL change; it must decide first and
    // write only when something is invalid. It used to navigate every time.
    renderAt('?columns=5&groupBy=7')
    await settle()
    const before = seen.keys.length
    await act(async () => { seen.navigate!('?columns=5&groupBy=8', { replace: true }) })
    await settle()
    expect(new URLSearchParams(seen.search).get('groupBy')).toBe('8')
    expect(seen.keys.length - before).toBe(1) // ours, and nothing after it
  })
})
