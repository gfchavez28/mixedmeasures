/**
 * #1315 — what "Add to Materials" saves, on every Analysis tab, and what the canvas
 * then makes of it.
 *
 * `buildCurrentChartConfig` wrote every Relationships & Comparisons key on every
 * tab, and a tab switch keeps the R&C URL state (on purpose — it is the
 * researcher's setup). So a Descriptives chart carried `rc_view: 'correlations'`
 * and was REFUSED on the canvas, or, saved after a visit to Comparisons,
 * `rc_view: 'comparisons'` + `compare_by` and was DRAWN as a group comparison
 * under the frequency chart's title. The existing tests fed hand-written configs
 * to the canvas predicates; none ever fed one the SAVER produced.
 *
 * So each case here drives the real `AnalysisView` (its APIs and heavy children
 * stubbed — the `AnalysisView.url-compose.test.tsx` harness), captures the
 * config `materialsApi.createMaterial` receives, JSON round-trips it (the server
 * stores JSON, and `'k' in {k: undefined}` is TRUE, so an un-round-tripped
 * object reads a dropped key as present), and hands it to BOTH canvas consumers'
 * dispatch: `quantChartKind` and `fetchChartTables` — asserting which endpoint
 * the export actually calls.
 */
import { useEffect } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act, fireEvent, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CanvasTheme } from '@/lib/api'

const api = vi.hoisted(() => ({
  createMaterial: vi.fn(),
  quickCompute: vi.fn(),
  crossTabulation: vi.fn(),
  groupComparison: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  const stub = new Proxy({}, { get: () => never })
  const withSpies = (spies: Record<string, unknown>) =>
    new Proxy({}, { get: (_t, key: string) => spies[key] ?? never })
  return {
    ...actual,
    metricsApi: withSpies({ quickCompute: api.quickCompute, crossTabulation: api.crossTabulation }),
    comparisonsApi: withSpies({ groupComparison: api.groupComparison }),
    materialsApi: withSpies({
      // Collection 11 — listed, and also what `createCollection` answers, so a
      // click that lands before the list does still saves into it.
      list: () => Promise.resolve({ collections: [{ id: 11, name: 'Materials' }] }),
      createCollection: () => Promise.resolve({ id: 11, name: 'Materials' }),
      createMaterial: api.createMaterial,
    }),
    domainsApi: stub, datasetsApi: stub, statisticalTestsApi: stub,
    correlationsApi: stub, dataQualityApi: stub,
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

import AnalysisView from './AnalysisView'
import { quantChartKind } from '@/components/canvas/inline-chart-params'
import { fetchChartTables } from '@/lib/canvas-export'

/** The R&C keys, by the sub-view that owns them (mirrors `material_config.py`). */
const SHARED = ['rc_view', 'sig_levels']
const CORRELATION = [
  'corr_type', 'bonferroni', 'cell_format', 'corr_colors', 'show_scatter', 'show_reg_line', 'show_jitter',
]
const COMPARISON = [
  'compare_by', 'compare_by_2', 'test_type', 'nonparametric', 'post_hoc_expanded',
  'rc_chart_type', 'exclude_groups', 'rc_palette',
]
const ALL_RC = [...SHARED, ...CORRELATION, ...COMPARISON]

const never = () => new Promise(() => {})
const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() }

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  for (const spy of Object.values(api)) spy.mockReset()
  // While the page is mounted every endpoint stays pending, as in the
  // url-compose harness; the export phase below gives each an answer.
  api.quickCompute.mockImplementation(never)
  api.crossTabulation.mockImplementation(never)
  api.groupComparison.mockImplementation(never)
  api.createMaterial.mockResolvedValue({ id: 99 })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const seen = { search: '' }
function Spy() {
  const loc = useLocation()
  useEffect(() => { seen.search = loc.search }, [loc])
  return null
}

function renderAt(search: string) {
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

interface Saved {
  material_type: string
  source_tab: string
  /** JSON round-tripped, as the server stores it. */
  config: Record<string, unknown>
}

/** Click "Add to Materials" and return what the saver sent. */
async function save(): Promise<Saved> {
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /Add to Materials/ }))
  await waitFor(() => expect(api.createMaterial).toHaveBeenCalledTimes(1))
  const [, collectionId, data] = api.createMaterial.mock.calls[0]
  expect(collectionId).toBe(11)
  return {
    material_type: data.material_type,
    source_tab: data.source_tab,
    config: JSON.parse(JSON.stringify(data.config)),
  }
}

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{
    id: 1,
    content: {
      type: 'doc',
      content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } }],
    },
  } as unknown as CanvasTheme]
}

/** Which endpoint the canvas EXPORT asks for this config — the second consumer. */
async function exportBranch(config: Record<string, unknown>): Promise<'quickCompute' | 'groupComparison' | 'crossTabulation' | 'none'> {
  for (const spy of [api.quickCompute, api.crossTabulation, api.groupComparison]) spy.mockReset()
  api.quickCompute.mockResolvedValue({ metrics: [] })
  api.crossTabulation.mockResolvedValue(null)
  api.groupComparison.mockResolvedValue({
    groups: [], group_column_label: '', rows: [], bonferroni_warning: false,
    bonferroni_threshold: null, unavailable_reason: 'no_group_values',
  })
  await fetchChartTables(themeWithChart(config), 1, LENS)
  const called = [
    ['quickCompute', api.quickCompute],
    ['crossTabulation', api.crossTabulation],
    ['groupComparison', api.groupComparison],
  ].filter(([, spy]) => (spy as typeof api.quickCompute).mock.calls.length > 0)
  expect(called.length, `the export asked ${called.map(c => c[0]).join(' + ')}`).toBeLessThanOrEqual(1)
  return (called[0]?.[0] as 'quickCompute' | 'groupComparison' | 'crossTabulation') ?? 'none'
}

const present = (cfg: Record<string, unknown>, keys: string[]) => keys.filter(k => k in cfg)

describe('#1315 — Descriptives and Data Quality saves carry no R&C key', () => {
  it('Descriptives', async () => {
    renderAt('?columns=5,6')
    const saved = await save()
    expect(saved.source_tab).toBe('descriptives')
    // Positive control: the config is a real chart config, not an empty one
    // that passes every "absent" assertion below.
    expect(saved.config.column_ids).toEqual([5, 6])
    expect(saved.config.metric_type).toBe('frequency_distribution')
    expect(present(saved.config, ALL_RC)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('metric')
    expect(await exportBranch(saved.config)).toBe('quickCompute')
  })

  it('Data Quality (saves the hidden Descriptives chart — the adjacent finding)', async () => {
    renderAt('?tab=data_quality&columns=5,6&rcView=comparisons&compareBy=7')
    const saved = await save()
    expect(saved.source_tab).toBe('descriptives')
    expect(saved.config.column_ids).toEqual([5, 6])
    expect(present(saved.config, ALL_RC)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('metric')
    expect(await exportBranch(saved.config)).toBe('quickCompute')
  })

  it('🔴 arm 2: Comparisons visited, then Descriptives saved — the URL keeps the setup, the save does not', async () => {
    renderAt('?tab=rc&rcView=comparisons&compareBy=7&showScatter=1&corrType=spearman&columns=5,6')
    await settle()
    fireEvent.click(screen.getByRole('tab', { name: 'Descriptives' }))
    await settle()
    const params = new URLSearchParams(seen.search)
    // Not cleared on the switch — it is the researcher's R&C setup.
    expect(params.get('tab')).not.toBe('rc')
    expect(params.get('rcView')).toBe('comparisons')
    expect(params.get('compareBy')).toBe('7')
    const saved = await save()
    expect(saved.source_tab).toBe('descriptives')
    expect(saved.config.column_ids).toEqual([5, 6])
    expect(present(saved.config, ALL_RC)).toEqual([])
    // Before the fix: 'comparison' — a group comparison drawn under the
    // frequency chart's title, and exported as one.
    expect(quantChartKind(saved.config)).toBe('metric')
    expect(await exportBranch(saved.config)).toBe('quickCompute')
  })
})

describe('#1315 — each R&C save carries its OWN sub-view’s keys', () => {
  it('R&C correlations', async () => {
    renderAt('?tab=rc&columns=5,6&compareBy=7&testType=anova')
    const saved = await save()
    expect(saved.source_tab).toBe('correlations')
    expect(saved.material_type).toBe('correlation_matrix')
    expect(saved.config.rc_view).toBe('correlations')
    expect(saved.config.sig_levels).toEqual({ show_05: true, show_01: true, show_001: true })
    expect(saved.config.show_reg_line).toBe(true)
    // The comparison setup in the URL stays out of a correlation.
    expect(present(saved.config, COMPARISON)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('correlation')
    expect(await exportBranch(saved.config)).toBe('none')
  })

  it('R&C correlations with the scatter matrix and Spearman', async () => {
    renderAt('?tab=rc&columns=5,6&showScatter=1&corrType=spearman')
    const saved = await save()
    expect(saved.source_tab).toBe('correlations')
    expect(saved.material_type).toBe('scatter_matrix')
    expect(saved.config.show_scatter).toBe(true)
    expect(saved.config.corr_type).toBe('spearman')
    expect(present(saved.config, COMPARISON)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('correlation')
    expect(await exportBranch(saved.config)).toBe('none')
  })

  it('R&C comparisons', async () => {
    renderAt('?tab=rc&rcView=comparisons&compareBy=7&columns=5,6')
    const saved = await save()
    expect(saved.source_tab).toBe('comparisons')
    expect(saved.material_type).toBe('comparison_table')
    expect(saved.config.rc_view).toBe('comparisons')
    expect(saved.config.compare_by).toBe(7)
    expect(saved.config.nonparametric).toBe(false)
    expect(saved.config.post_hoc_expanded).toBe(true)
    expect(saved.config.sig_levels).toEqual({ show_05: true, show_01: true, show_001: true })
    expect(present(saved.config, CORRELATION)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('comparison')
    expect(await exportBranch(saved.config)).toBe('groupComparison')
  })

  it('🔴 arm 3: a comparison saved with scatter and Spearman on carries neither', async () => {
    renderAt('?tab=rc&rcView=comparisons&compareBy=7&showScatter=1&corrType=spearman&columns=5,6')
    const saved = await save()
    expect(saved.source_tab).toBe('comparisons')
    expect(saved.config.compare_by).toBe(7)
    // Before the fix both rode along, and the export (correlation first)
    // refused what the canvas (comparison first) drew.
    expect(present(saved.config, CORRELATION)).toEqual([])
    expect(quantChartKind(saved.config)).toBe('comparison')
    expect(await exportBranch(saved.config)).toBe('groupComparison')
  })
})
