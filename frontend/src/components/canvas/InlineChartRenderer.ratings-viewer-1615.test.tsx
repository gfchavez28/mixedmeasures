/**
 * #1615 (D297's Canvas path) — the MOUNTED qualitative embed: its two grouping reads carry the
 * VIEWER (`ratings_viewer_id`) while blind mode withholds, beside the figure's SAVED coder scope
 * (which they never replace — the recorded rule), and a grouping refused while blind (D284's 409)
 * prints the server's sentence where *Chart unavailable* stood, and reports no figure (so no
 * baseline is seeded or moved). jsdom: what a mounted component renders, not a live drive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, cleanup, waitFor, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import InlineChartRenderer from './InlineChartRenderer'
import type { FigureFingerprint } from './figure-baseline'

const blindState = { withholding: false }
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(), frequencies: vi.fn(), saturation: vi.fn(),
    cooccurrence: vi.fn(), demographicComparison: vi.fn(),
  },
  codesApi: { list: vi.fn() },
  categoriesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))
vi.mock('@/hooks/useCoders', () => ({
  useMachineCoderIds: () => new Set<number>(),
  useCoders: () => ({ coders: [], coderMap: new Map(), multiCoder: false, status: 'ready' }),
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({
    blind: blindState.withholding, withholding: blindState.withholding, settled: true,
    blindLens: new Set<number>(), toggleReveal: vi.fn(),
  }),
}))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 2, username: 'alice' } }) }))
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import { codeAnalysisApi } from '@/lib/api'

const ALICE = 2
const SAVED = {
  code_ids: [5], code_mode: 'codes', conversation_ids: [9], text_column_ids: [], document_ids: [],
  observation_ids: [], exclude_facilitator: true, participant_ids: [], coder_ids: [], layer_scope: 'human',
}
const COMPARISON = { ...SAVED, tab: 'relationships', rel_view: 'comparisons', comparison_chart_mode: 'table', group_by: 'Score group' }
const BAR = { ...SAVED, tab: 'descriptives', chart_type: 'bar', group_by: 'Score group' }
const REFUSAL = '“Score group” cannot form groups while blind: it comes from participant scores, '
  + "which combine every coder's ratings, so its groups would show your colleagues' judgements."

function mount(content: Record<string, unknown>) {
  const onFigure = vi.fn<(f: FigureFingerprint | null) => void>()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}><TooltipProvider>
      <InlineChartRenderer projectId={1} materialId={7} content={content} onFigure={onFigure} />
    </TooltipProvider></QueryClientProvider>,
  )
  return onFigure
}

beforeEach(() => {
  blindState.withholding = false
  vi.mocked(codeAnalysisApi.demographicComparison).mockReset()
    .mockRejectedValue(Object.assign(new Error('409'), { status: 409, response: { data: { detail: REFUSAL } } }))
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockReset()
    .mockRejectedValue(Object.assign(new Error('409'), { status: 409, response: { data: { detail: REFUSAL } } }))
})
afterEach(cleanup)

describe('a qualitative embed grouped by a variable, opened by a blind coder (#1615)', () => {
  it('the comparison names the viewer beside the figure’s saved scope, and says why it is refused', async () => {
    blindState.withholding = true
    const onFigure = mount(COMPARISON)
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
    const sent = vi.mocked(codeAnalysisApi.demographicComparison).mock.calls[0][1]
    expect(sent.ratings_viewer_id).toBe(ALICE)
    expect(sent.coder_ids).toBeNull()   // the lead's every-coder figure — never the viewer
    expect(screen.queryByText('Chart unavailable')).toBeNull()
    expect(onFigure).not.toHaveBeenCalledWith(expect.objectContaining({ hash: expect.any(String) }))
  })

  it('a bar grouped by a variable does the same through source frequencies', async () => {
    blindState.withholding = true
    mount(BAR)
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
    expect(vi.mocked(codeAnalysisApi.sourceFrequencies).mock.calls[0][1].ratings_viewer_id).toBe(ALICE)
  })

  it('positive control: not blind, the request carries no viewer (exactly as before)', async () => {
    mount(COMPARISON)
    await waitFor(() => expect(codeAnalysisApi.demographicComparison).toHaveBeenCalled())
    expect(vi.mocked(codeAnalysisApi.demographicComparison).mock.calls[0][1]).not.toHaveProperty('ratings_viewer_id')
  })

  it('any other failure keeps “Chart unavailable” (no sentence invented)', async () => {
    blindState.withholding = true
    vi.mocked(codeAnalysisApi.demographicComparison).mockReset()
      .mockRejectedValue(Object.assign(new Error('500'), { status: 500, response: { data: { detail: 'boom' } } }))
    mount(COMPARISON)
    expect(await screen.findByText('Chart unavailable')).toBeInTheDocument()
    expect(screen.queryByText('boom')).toBeNull()
  })
})
