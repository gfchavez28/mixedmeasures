/**
 * #652 slab 1 — a qualitative material must actually DRAW on the canvas.
 *
 * ⚠️ These tests assert against the MOUNTED renderer, not the helpers.
 * `inline-chart-params.test.ts` covers the config→request mapping, and those
 * tests pass whether or not this component ever calls it — the #624 shape,
 * where the piece shipped and one consuming surface never wired it up. Here the
 * consuming surface IS the subject.
 *
 * ⚠️ Every fixture is a qualitative config with no `column_ids`. A quantitative
 * fixture passes before and after, which is what let the bug ship.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import InlineChartRenderer from './InlineChartRenderer'
import type { SourceFrequenciesResponse } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(),
    frequencies: vi.fn(),
    saturation: vi.fn(),
    cooccurrence: vi.fn(),
    demographicComparison: vi.fn(),
  },
  // The Timeline (slab 4) is the one kind with no analysis endpoint — it
  // assembles reference data instead.
  codesApi: { list: vi.fn() },
  categoriesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

// The Timeline embed reads the coder roster and the blind lens. Both are
// exercised properly in `QualTimelineEmbed.test.tsx`; here they only need to
// resolve so the MOUNT can be asserted.
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coders: [], coderMap: new Map(), multiCoder: false }),
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ blind: false, blindHiddenSet: new Set<number>(), toggleReveal: vi.fn() }),
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'researcher' } }),
}))

// The chart components read the theme — `QualHeatmap` for its cell ramp,
// `QualBarChart` / `QualStackedBar` for axis and grid colours via
// `useChartColors`. `ThemeProvider` itself cannot mount here (this jsdom
// environment has no working `localStorage`, which is why no spec in the repo
// wraps it), so the light branch is stubbed with the REAL palette.
//
// ⚠️ Both hooks must be stubbed, not just `useTheme`: `useChartColors` lives in
// the same module and calls its own module-local `useTheme`, so overriding the
// export alone leaves it reaching for a provider that isn't there.
vi.mock('@/lib/theme-context', async () => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    useTheme: () => ({ isDark: false, mode: 'light', toggleTheme: vi.fn(), setTheme: vi.fn() }),
    useChartColors: () => CHART_COLORS,
  }
})

import { metricsApi, codeAnalysisApi, codesApi, categoriesApi, observationsApi } from '@/lib/api'

function qualConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tab: 'descriptives',
    source: 'all',
    code_mode: 'codes',
    code_ids: [65, 66],
    conversation_ids: [],
    text_column_ids: [],
    document_ids: [],
    observation_ids: [1],
    exclude_facilitator: true,
    participant_ids: [],
    coder_ids: [],
    layer_scope: 'human',
    chart_type: 'heatmap',
    value_mode: 'count',
    denominator_mode: 'total',
    sort_order: 'import',
    orientation: 'sr',
    group_by: null,
    ...over,
  }
}

function frequencies(): SourceFrequenciesResponse {
  return {
    codes: [
      { id: 65, name: 'Trust in mission control', color: '#3b82f6', category_id: null, category_name: null, is_universal: false, numeric_id: 1, participant_count: 0, record_count: 0 },
      { id: 66, name: 'Isolation', color: '#ef4444', category_id: null, category_name: null, is_universal: false, numeric_id: 2, participant_count: 0, record_count: 0 },
    ],
    sources: [
      {
        source_type: 'observation', source_id: 1, source_label: 'nasa_collins_apollo11_interview',
        dataset_id: null, dataset_name: null,
        total_segments: 10, total_word_count: 0, coded_segments: 6, import_order: 0,
        code_counts: { '65': { count: 4, word_count: 0 }, '66': { count: 2, word_count: 0 } },
        groups: null,
      },
    ],
    totals: {
      total_segments: 10, total_word_count: 0, coded_segments: 6, total_sources: 1,
      total_conversations: 0, total_documents: 0, total_observations: 1, total_text_columns: 0,
    coded_transcript_segments: 0, coded_texts: 0,
    total_participants: 0, total_records: 0, unlinked_speaker_count: 0,
    },
    group_by: null,
  }
}

// `QualSummaryTable` uses Radix tooltips. In the app `App.tsx` supplies one
// `TooltipProvider` around every route, so the canvas embed already sits inside
// one; this mirrors that, as the other chart-component specs do.
function saturation() {
  return {
    points: [
      { source_index: 0, source_label: 'apollo11_interview', source_type: 'observation', cumulative_unique_codes: 2, new_codes_this_source: 2, new_code_names: ['Isolation'] },
    ],
    total_unique_codes: 2,
    total_sources: 1,
    category_level: false,
  }
}

function cooccurrence() {
  return {
    codes: [
      { id: 65, name: 'Trust in mission control', color: null, category_name: null, is_universal: false },
      { id: 66, name: 'Isolation', color: null, category_name: null, is_universal: false },
    ],
    matrix: [[4, 1], [1, 2]],
    max_cooccurrence: 4,
    total_coded_segments: 6,
    total_coded_texts: 1,
    source: 'all',
  }
}

function comparison() {
  return {
    groups: ['Staff', 'Volunteer'],
    group_totals: {
      Staff: { total_segments: 10, total_word_count: 0 },
      Volunteer: { total_segments: 5, total_word_count: 0 },
    },
    codes: [
      {
        code_id: 65,
        code_name: 'Trust in mission control',
        category_name: null,
        by_group: { Staff: { count: 4, proportion: 0.4 }, Volunteer: { count: 1, proportion: 0.2 } },
        delta_proportion: 0.2,
        test: null,
      },
    ],
  }
}

function renderEmbed(content: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={qc}>
        <InlineChartRenderer projectId={3} materialId={1} content={content} onFigure={() => {}} {...props} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  // Reset BEFORE seeding: several assertions here are `not.toHaveBeenCalled`,
  // which a leaked call from the previous test would satisfy falsely.
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockReset()
  vi.mocked(codeAnalysisApi.frequencies).mockReset()
  vi.mocked(codeAnalysisApi.saturation).mockReset()
  vi.mocked(codeAnalysisApi.cooccurrence).mockReset()
  vi.mocked(codeAnalysisApi.demographicComparison).mockReset()
  vi.mocked(metricsApi.quickCompute).mockReset()
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockResolvedValue(frequencies())
  vi.mocked(codeAnalysisApi.saturation).mockResolvedValue(saturation() as never)
  vi.mocked(codeAnalysisApi.cooccurrence).mockResolvedValue(cooccurrence() as never)
  vi.mocked(codeAnalysisApi.demographicComparison).mockResolvedValue(comparison() as never)

  vi.mocked(codesApi.list).mockReset()
  vi.mocked(categoriesApi.list).mockReset()
  vi.mocked(observationsApi.list).mockReset()
  vi.mocked(observationsApi.listSegments).mockReset()
  vi.mocked(codesApi.list).mockResolvedValue({
    codes: [
      { id: 65, name: 'Trust in mission control', color: '#3b82f6', is_active: true, category_id: null, category_color: null },
      { id: 66, name: 'Isolation', color: '#ef4444', is_active: true, category_id: null, category_color: null },
    ],
    total: 2,
  } as never)
  vi.mocked(categoriesApi.list).mockResolvedValue({ categories: [], total: 0 } as never)
  vi.mocked(observationsApi.list).mockResolvedValue([
    { id: 1, name: 'nasa_collins_apollo11_interview', media_duration_seconds: 600, segmentation_frozen_at: null },
  ] as never)
  vi.mocked(observationsApi.listSegments).mockResolvedValue([
    {
      id: 11, sequence_order: 1, start_time: 0, end_time: 60, text: 'clip',
      applied_codes: [65], attached_notes: [], created_at: '',
      applied_code_details: [{ code_id: 65, user_id: 1, attribution: null, is_universal: false }],
    },
  ] as never)
})

describe('a qualitative material on the canvas', () => {
  it('draws the heatmap instead of an empty state', async () => {
    renderEmbed(qualConfig())

    // The code names come from the fetched payload, so their presence proves
    // the whole chain: config → request → endpoint → chart component.
    expect(await screen.findByText('Trust in mission control')).toBeInTheDocument()
    expect(screen.queryByText(/can.t be drawn on the canvas yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText('No data configured')).not.toBeInTheDocument()
  })

  // One case per type on purpose: `isQualChartRenderable` claiming a type is
  // drawable proves nothing about the router actually having a case for it, and
  // a missing case renders the fallback notice rather than throwing.
  it.each(['heatmap', 'summary'])(
    'mounts a real chart component for chart_type=%s',
    async (chart_type) => {
      renderEmbed(qualConfig({ chart_type }))

      // These two are HTML tables, so their labels are in the DOM.
      expect(await screen.findByText('Trust in mission control')).toBeInTheDocument()
      expect(screen.queryByText(/can.t be drawn on the canvas yet/i)).not.toBeInTheDocument()
    },
  )

  it.each(['bar', 'stacked_bar'])(
    'mounts a real chart component for chart_type=%s',
    async (chart_type) => {
      const { container } = renderEmbed(qualConfig({ chart_type }))

      // Recharts measures its container, which is 0×0 under jsdom, so no axis
      // labels are emitted however correct the wiring is. Assert the mount
      // structurally instead — present container, absent fallback — rather than
      // weakening this to something that would also pass on the notice.
      await waitFor(() => {
        expect(container.querySelector('.recharts-responsive-container')).not.toBeNull()
      })
      expect(screen.queryByText(/can.t be drawn on the canvas yet/i)).not.toBeInTheDocument()
      expect(screen.queryByText('Chart unavailable')).not.toBeInTheDocument()
    },
  )

  it('sends the observation source and the saved coder scope', async () => {
    renderEmbed(qualConfig({ coder_ids: [2] }))
    await screen.findByText('Isolation')

    expect(codeAnalysisApi.sourceFrequencies).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ observation_ids: [1], code_ids: [65, 66], coder_ids: [2] }),
    )
    // The quantitative endpoint must not be consulted for a qual material.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('never fires a request for an empty saved selection', async () => {
    renderEmbed(qualConfig({ code_ids: [] }))

    expect(await screen.findByText(/no codes or sources selected/i)).toBeInTheDocument()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('says what is true of THIS chart type rather than of qualitative charts generally', async () => {
    // Since slab 4 nothing REACHABLE lands on this arm — the only kind without
    // a case is `qual_content`, which the save gate cannot produce. The arm is
    // kept so a tenth chart type fails visibly instead of blank, and this is
    // what keeps it honest.
    renderEmbed(qualConfig({ tab: 'content' }))

    expect(await screen.findByText(/this chart type can.t be drawn on the canvas yet/i)).toBeInTheDocument()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('mounts the timeline for chart_type=timeline, without touching source-frequencies', async () => {
    // ⚠️ THE MOUNT is the subject. `qualChartKind` returning 'timeline' proves
    // nothing about the renderer having wired a branch for it — that is the
    // #624 shape, and un-wiring the branch must fail HERE.
    renderEmbed(qualConfig({ chart_type: 'timeline' }))

    // The observation name comes from the reference query, and the code name is
    // rendered by `TimedAnalytics`'s table — so together they prove the chain
    // config → resolve → component.
    expect(await screen.findByText('nasa_collins_apollo11_interview')).toBeInTheDocument()
    // Twice on purpose: once as a codeline lane label, once as a table row
    // header. They are the two halves that must always render together — the
    // codeline is aria-hidden, so the table IS its accessible equivalent.
    expect(await screen.findAllByText('Trust in mission control')).toHaveLength(2)
    expect(screen.queryByText(/can.t be drawn on the canvas yet/i)).not.toBeInTheDocument()

    // The Timeline has NO analysis endpoint; fetching one would mean the branch
    // fell through to the source-frequency path.
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('never prints an N for the timeline, even when the material asked for one', async () => {
    // `DescriptivesPanel` suppresses N for this type: the descriptives N counts
    // segments/texts, which is not the timeline's unit. Passing `showChartN`
    // through would print a number from a payload this chart never used.
    renderEmbed(qualConfig({ chart_type: 'timeline', show_chart_n: true }))

    expect(await screen.findByText('nasa_collins_apollo11_interview')).toBeInTheDocument()
    expect(screen.queryByText(/^N = /)).not.toBeInTheDocument()
  })

  it('routes a relationships material by rel_view, never by its stale chart_type', async () => {
    // The material carries chart_type 'heatmap' — perfectly drawable, and the
    // wrong chart. If dispatch read it, source-frequencies would be fetched and
    // a descriptives heatmap drawn over co-occurrence's data.
    renderEmbed(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence', chart_type: 'heatmap' }))

    await waitFor(() => expect(codeAnalysisApi.cooccurrence).toHaveBeenCalled())
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('draws the summary table from ONE endpoint (#749)', async () => {
    // The summary type used to fetch `code-frequencies` as well, for the
    // per-kind columns and the totals row. That endpoint reads an unselected
    // kind as ALL of that kind, so the embed could render a selection-scoped
    // body above a project-scoped totals row. Both halves now come from
    // source-frequencies — asserted as the ABSENCE of the second request,
    // because "one payload" is the property that makes the two agree.
    renderEmbed(qualConfig({ chart_type: 'summary' }))
    await screen.findByText('Trust in mission control')
    expect(codeAnalysisApi.sourceFrequencies).toHaveBeenCalled()
    expect(codeAnalysisApi.frequencies).not.toHaveBeenCalled()
  })
})

describe('the slab-2 kinds (saturation · co-occurrence · comparisons)', () => {
  it('draws saturation from its own endpoint', async () => {
    const { container } = renderEmbed(qualConfig({ chart_type: 'saturation' }))

    await waitFor(() => expect(codeAnalysisApi.saturation).toHaveBeenCalled())
    await waitFor(() => {
      expect(container.querySelector('.recharts-responsive-container')).not.toBeNull()
    })
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('scopes saturation by SOURCE only — no code, text-column or participant filters', async () => {
    renderEmbed(qualConfig({ chart_type: 'saturation', text_column_ids: [4], participant_ids: [9] }))

    await waitFor(() => expect(codeAnalysisApi.saturation).toHaveBeenCalled())
    const sent = vi.mocked(codeAnalysisApi.saturation).mock.calls[0][1] as Record<string, unknown>
    expect(sent.observation_ids).toBe('1')
    expect('code_ids' in sent).toBe(false)
    expect('text_column_ids' in sent).toBe(false)
    expect('participant_ids' in sent).toBe(false)
  })

  it('draws co-occurrence, which fetches for itself', async () => {
    renderEmbed(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence' }))

    // The name appears as both a row and a column label, hence findAll.
    expect((await screen.findAllByText('Isolation')).length).toBeGreaterThan(0)
    expect(codeAnalysisApi.cooccurrence).toHaveBeenCalled()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('draws the comparison table and its bar variant off comparison_chart_mode', async () => {
    const relationships = (over: Record<string, unknown>) =>
      qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role', ...over })

    const { unmount, container } = renderEmbed(relationships({ comparison_chart_mode: 'table' }))
    expect(await screen.findByText('Trust in mission control')).toBeInTheDocument()
    expect(container.querySelector('.recharts-responsive-container')).toBeNull()
    unmount()

    const bar = renderEmbed(relationships({ comparison_chart_mode: 'bar' }))
    await waitFor(() => {
      expect(bar.container.querySelector('.recharts-responsive-container')).not.toBeNull()
    })
  })

  it('never fires a comparison request without a grouping variable', async () => {
    renderEmbed(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: null }))

    expect(await screen.findByText(/no grouping variable selected/i)).toBeInTheDocument()
    expect(codeAnalysisApi.demographicComparison).not.toHaveBeenCalled()
  })

  it('still asks for saturation when nothing is selected — empty means ALL sources', async () => {
    // The gate is per-kind: this config would (correctly) block a heatmap.
    renderEmbed(qualConfig({ chart_type: 'saturation', code_ids: [], observation_ids: [] }))

    await waitFor(() => expect(codeAnalysisApi.saturation).toHaveBeenCalled())
    expect(screen.queryByText(/no codes or sources selected/i)).not.toBeInTheDocument()
  })
})

describe('the embed chrome', () => {
  it("carries the researcher's footnote onto the canvas", async () => {
    renderEmbed(qualConfig({ footnote: 'Facilitator turns excluded.' }))

    expect(await screen.findByText('Facilitator turns excluded.')).toBeInTheDocument()
  })

  it('does not print the chart title twice when it repeats the embed heading', async () => {
    renderEmbed(qualConfig({ title: '3 codes' }), { embedTitle: '3 codes' })
    await screen.findByText('Isolation')

    expect(screen.queryByText('3 codes')).not.toBeInTheDocument()
  })

  it('keeps a chart title that differs from the embed heading', async () => {
    renderEmbed(qualConfig({ title: 'Codes by source' }), { embedTitle: '3 codes' })

    expect(await screen.findByText('Codes by source')).toBeInTheDocument()
  })

  it('shows N only when the material asked for it', async () => {
    const { unmount } = renderEmbed(qualConfig({ show_chart_n: true }))
    expect(await screen.findByText(/N = 6/)).toBeInTheDocument()
    unmount()

    renderEmbed(qualConfig())
    await screen.findByText('Isolation')
    expect(screen.queryByText(/N = 6/)).not.toBeInTheDocument()
  })
})
