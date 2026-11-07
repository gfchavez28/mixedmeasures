/**
 * #1529 D94 (1.5.9) — the MOUNTED embed fingerprints its universal rows exactly when it draws a
 * share of the coded total. The projection and the per-embed predicate are pinned on their own in
 * `figure-baseline.coded-share-1529.test.ts`; those pass whether or not this component passes the
 * flag (the #624 shape), so here the consuming surface is the subject.
 *
 * The payload carries a universal code, so the two possible fingerprints DIFFER — the case cannot
 * pass by the flag making no difference.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import InlineChartRenderer from './InlineChartRenderer'
import { fingerprintSourceFrequencies, type FigureFingerprint } from './figure-baseline'
import type { SourceFrequenciesResponse } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn() },
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
    blind: false, withholding: false, settled: true, blindLens: new Set<number>(), toggleReveal: vi.fn(),
  }),
}))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 1, username: 'researcher' } }) }))
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import { codeAnalysisApi } from '@/lib/api'

const PAYLOAD: SourceFrequenciesResponse = {
  codes: [
    { id: 2, name: 'Unclear', color: null, category_id: null, category_name: null, is_universal: true, numeric_id: 1, participant_count: 0, record_count: 0 },
    { id: 3, name: 'A theme', color: '#3b82f6', category_id: null, category_name: null, is_universal: false, numeric_id: 100, participant_count: 0, record_count: 0 },
  ],
  sources: [{
    source_type: 'document', source_id: 7, source_label: 'D2', dataset_id: null, dataset_name: null,
    total_segments: 6, total_word_count: 12, coded_segments: 2, import_order: 0,
    code_counts: { '2': { count: 4, word_count: 8 }, '3': { count: 2, word_count: 4 } },
    groups: null,
  }],
  totals: {
    total_segments: 6, total_word_count: 12, coded_segments: 2, total_sources: 1,
    total_conversations: 0, total_documents: 1, total_observations: 0, total_text_columns: 0,
    coded_transcript_segments: 2, coded_texts: 0, total_participants: 0, total_records: 0,
    unlinked_speaker_count: 0,
  },
  group_by: null,
}

const WITH = fingerprintSourceFrequencies(PAYLOAD, { codedShare: true }).hash
const WITHOUT = fingerprintSourceFrequencies(PAYLOAD, { codedShare: false }).hash

const config = (over: Record<string, unknown>) => ({
  tab: 'descriptives', source: 'all', code_mode: 'codes', code_ids: [2, 3],
  conversation_ids: [], text_column_ids: [], document_ids: [7], observation_ids: [],
  exclude_facilitator: true, participant_ids: [], coder_ids: [], layer_scope: 'human',
  sort_order: 'import', orientation: 'cr', group_by: null, ...over,
})

async function figureOf(content: Record<string, unknown>): Promise<string> {
  const onFigure = vi.fn<(f: FigureFingerprint | null) => void>()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <TooltipProvider>
      <QueryClientProvider client={qc}>
        <InlineChartRenderer projectId={3} materialId={1} content={content} onFigure={onFigure} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
  await waitFor(() => expect(onFigure).toHaveBeenLastCalledWith(expect.objectContaining({ hash: expect.any(String) })))
  return onFigure.mock.lastCall![0]!.hash
}

beforeEach(() => {
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockReset()
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockResolvedValue(PAYLOAD)
})
afterEach(cleanup)

describe('the embed fingerprints its universal rows when it draws a coded share (#1529 D94)', () => {
  it('the fixture can tell: the two fingerprints differ', () => {
    expect(WITH).not.toBe(WITHOUT)
  })

  it('a summary table (always *% of Coded*)', async () => {
    expect(await figureOf(config({ chart_type: 'summary', value_mode: 'count', denominator_mode: 'total' })))
      .toBe(WITH)
  })

  it('a heatmap on Proportion · Coded only', async () => {
    expect(await figureOf(config({ chart_type: 'heatmap', value_mode: 'segment_proportion', denominator_mode: 'coded' })))
      .toBe(WITH)
  })

  it('control — a heatmap on Count hashes as it always did', async () => {
    expect(await figureOf(config({ chart_type: 'heatmap', value_mode: 'count', denominator_mode: 'coded' })))
      .toBe(WITHOUT)
  })

  it('control — a bar on Proportion · All segments hashes as it always did', async () => {
    expect(await figureOf(config({ chart_type: 'bar', value_mode: 'segment_proportion', denominator_mode: 'total' })))
      .toBe(WITHOUT)
  })
})
