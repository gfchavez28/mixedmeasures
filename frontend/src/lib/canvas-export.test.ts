/**
 * #652 slab 1 — the canvas export's data tables must not lag the renderer.
 *
 * `fetchChartTables` fed Markdown, HTML, PDF and the docx fallback from
 * `extractComputeParams`, which reads dataset columns and domains only. A
 * qualitative embed therefore exported as an EMPTY table — and because the PNG
 * capture rasterizes whatever the renderer drew, fixing only the renderer would
 * have produced a document whose picture and whose table disagreed.
 *
 * ⚠️ The fixture must be a qualitative config with no `column_ids`; a
 * quantitative one passes either way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme, SourceFrequenciesResponse } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))

vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(),
    frequencies: vi.fn(),
    saturation: vi.fn(),
    cooccurrence: vi.fn(),
    demographicComparison: vi.fn(),
  },
  // The Timeline (slab 4) has no analysis endpoint — the export has to resolve
  // and compute the same way the renderer does.
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { codeAnalysisApi, metricsApi, codesApi, observationsApi } from '@/lib/api'
import { toPng } from 'html-to-image'
import { fetchChartTables, captureCanvasChartPngs } from './canvas-export'

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
    orientation: 'sr',
    ...over,
  }
}

/** A canvas whose single theme embeds one chart. */
function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [
    {
      id: 1,
      content: {
        type: 'doc',
        content: [
          { type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } },
        ],
      },
    } as unknown as CanvasTheme,
  ]
}

function frequencies(): SourceFrequenciesResponse {
  return {
    codes: [
      { id: 65, name: 'Trust in mission control', color: null, category_id: null, category_name: null, is_universal: false, numeric_id: 1, participant_count: 0, record_count: 0 },
      { id: 66, name: 'Isolation', color: null, category_id: null, category_name: null, is_universal: false, numeric_id: 2, participant_count: 0, record_count: 0 },
    ],
    sources: [
      {
        source_type: 'observation', source_id: 1, source_label: 'apollo11_interview',
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

// Timeline fixture. Two coders mark the SAME clip with the SAME code, so
// pooling (1:00.0 / 10%) and summing (2:00.0 / 20%) give different answers —
// which is what lets the export's arithmetic be checked at all.
const TIMELINE_CODES = [
  { id: 70, name: 'Rapport', color: '#3b82f6', is_active: true, category_id: null, category_color: null },
  { id: 71, name: 'Silence', color: '#ef4444', is_active: true, category_id: null, category_color: null },
]
const TIMELINE_OBSERVATIONS = [
  { id: 1, name: 'Playground morning', media_duration_seconds: 600, segmentation_frozen_at: null },
]
const TIMELINE_CLIPS = [
  {
    id: 11, sequence_order: 1, start_time: 0, end_time: 60, text: 'a',
    applied_codes: [70], attached_notes: [], created_at: '',
    applied_code_details: [
      { code_id: 70, user_id: 1, attribution: null, is_universal: false },
      { code_id: 70, user_id: 2, attribution: null, is_universal: false },
    ],
  },
  {
    id: 12, sequence_order: 2, start_time: 120, end_time: 180, text: 'b',
    applied_codes: [71], attached_notes: [], created_at: '',
    applied_code_details: [{ code_id: 71, user_id: 2, attribution: null, is_universal: false }],
  },
]

beforeEach(() => {
  vi.mocked(codesApi.list).mockReset()
  vi.mocked(observationsApi.list).mockReset()
  vi.mocked(observationsApi.listSegments).mockReset()
  vi.mocked(codesApi.list).mockResolvedValue({ codes: TIMELINE_CODES, total: 2 } as never)
  vi.mocked(observationsApi.list).mockResolvedValue(TIMELINE_OBSERVATIONS as never)
  vi.mocked(observationsApi.listSegments).mockResolvedValue(TIMELINE_CLIPS as never)
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockReset()
  vi.mocked(codeAnalysisApi.saturation).mockReset()
  vi.mocked(codeAnalysisApi.cooccurrence).mockReset()
  vi.mocked(codeAnalysisApi.demographicComparison).mockReset()
  vi.mocked(metricsApi.quickCompute).mockReset()
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockResolvedValue(frequencies())
  vi.mocked(codeAnalysisApi.saturation).mockResolvedValue({
    points: [
      { source_index: 0, source_label: 'apollo11_interview', source_type: 'observation', cumulative_unique_codes: 2, new_codes_this_source: 2, new_code_names: [] },
    ],
    total_unique_codes: 2, total_sources: 1, category_level: false,
  } as never)
  vi.mocked(codeAnalysisApi.cooccurrence).mockResolvedValue({
    codes: [
      { id: 65, name: 'Trust', color: null, category_name: null, is_universal: false },
      { id: 66, name: 'Isolation', color: null, category_name: null, is_universal: false },
    ],
    matrix: [[4, 1], [1, 2]],
    max_cooccurrence: 4, total_coded_segments: 6, total_coded_texts: 0, source: 'all',
  } as never)
  vi.mocked(codeAnalysisApi.demographicComparison).mockResolvedValue({
    groups: ['Staff', 'Volunteer'],
    group_totals: { Staff: { total_segments: 10, total_word_count: 0 }, Volunteer: { total_segments: 5, total_word_count: 0 } },
    codes: [{
      code_id: 65, code_name: 'Trust', category_name: null,
      by_group: { Staff: { count: 4, proportion: 0.4 }, Volunteer: { count: 1, proportion: 0.2 } },
      delta_proportion: 0.2, test: null,
    }],
  } as never)
})

describe('fetchChartTables — qualitative embeds', () => {
  it('exports a real table for a qualitative material', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig()), 3)

    const table = tables.get(1)
    expect(table).toBeDefined()
    expect(table!.md).toContain('Trust in mission control')
    expect(table!.md).toContain('apollo11_interview')
    // The counts, not just the labels — an empty table with headers would
    // otherwise satisfy a looser assertion.
    expect(table!.md).toContain('| apollo11_interview | 4 | 2 |')
    expect(table!.html).toContain('<td>4</td>')
  })

  it('transposes to match the saved orientation', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig({ orientation: 'cr' })), 3)

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| Code | apollo11_interview |')
    expect(md).toContain('| Trust in mission control | 4 |')
  })

  it('emits nothing for a chart type this build cannot draw, rather than a wrong table', async () => {
    // Nothing REACHABLE is left on this arm since slab 4 — `qual_content` is
    // the only kind without a case and the save gate cannot produce it. Kept
    // so a tenth kind emits nothing rather than a wrong table.
    const tables = await fetchChartTables(themeWithChart(qualConfig({ tab: 'content' })), 3)

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('exports a timeline as one row per observation x code, using the SHARED compute', async () => {
    // ⚠️ This is the one kind whose export could grow a second implementation:
    // it mounts no component, so the arithmetic has to be the renderer's. The
    // fixture makes the two answers differ — two coders mark the SAME clip, so
    // pooling gives 1:00.0 / 10% where summing would give 2:00.0 / 20%.
    const tables = await fetchChartTables(themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70] })), 3)

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe(
      '| Observation | Code | Marks | Airtime | Share of session | Rate | Mean bout | Median bout | Longest bout |',
    )
    expect(md).toContain('| Playground morning | Rapport | 2 | 1:00.0 | 10% |')
    // Codebook order, not the config's — the export resolves through the same
    // shared helper as the renderer, so a config-order mapper fails here too.
    expect(md.indexOf('| Playground morning | Rapport')).toBeLessThan(md.indexOf('| Playground morning | Silence'))
    // The don't-sum anchor rides along, so a reader cannot add the column up
    // and get a different, wrong answer.
    expect(md).toContain('| Playground morning | Covered by selected coding |')
    // No source-frequencies call: that would mean the branch fell through.
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('honours the viewer\u2019s blind lens in the EXPORTED table', async () => {
    // A blind-scoped figure that exports all-coder numbers puts colleagues'
    // work into a shareable file — the on-screen lens's whole point, undone.
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70] })), 3, { blind: true, self: 1 },
    )

    const md = tables.get(1)!.md
    // Rapport: both coders marked it ⇒ 1 visible mark for self alone.
    expect(md).toContain('| Playground morning | Rapport | 1 |')
    // Silence: colleague-only ⇒ nothing visible.
    expect(md).toContain('| Playground morning | Silence | 0 |')
  })

  it('refuses to export a timeline saved on the consensus layer', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70], layer_scope: 'consensus' })), 3,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(observationsApi.list).not.toHaveBeenCalled()
  })

  it('exports a saturation curve as a per-source table', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig({ chart_type: 'saturation' })), 3)

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| # | Source | New codes | Cumulative unique codes |')
    expect(md).toContain('| 1 | apollo11_interview | 2 | 2 |')
  })

  it('exports a co-occurrence matrix, fetched directly rather than via the component', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence' })), 3,
    )

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| Code | Trust | Isolation |')
    expect(md).toContain('| Trust | 4 | 1 |')
    // The level must ride along — it is merged by the component in the UI, so
    // the export has to supply it itself or the server defaults it.
    const sent = vi.mocked(codeAnalysisApi.cooccurrence).mock.calls[0][1] as Record<string, unknown>
    expect(sent.level).toBe('segment')
  })

  it('exports a comparison with counts AND proportions per group', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role' })), 3,
    )

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| Code | Staff n | Volunteer n | Staff % | Volunteer % |')
    expect(md).toContain('| Trust | 4 | 1 | 40.0% | 20.0% |')
  })

  it('emits nothing for a comparison with no grouping variable', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: null })), 3,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.demographicComparison).not.toHaveBeenCalled()
  })

  it('emits nothing for an empty saved selection', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig({ code_ids: [] })), 3)

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('still routes a quantitative material to quickCompute', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [] } as never)
    await fetchChartTables(themeWithChart({ column_ids: [7], metric_type: 'frequency_distribution' }), 3)

    expect(metricsApi.quickCompute).toHaveBeenCalled()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })
})

describe('captureCanvasChartPngs — what counts as "rendered" (#682)', () => {
  function mountEmbed(inner: string) {
    document.body.innerHTML = `
      <div data-type="chart-embed" data-material-id="7">
        <div data-chart-capture-root>${inner}</div>
      </div>`
  }

  beforeEach(() => {
    vi.mocked(toPng).mockReset()
    vi.mocked(toPng).mockResolvedValue('data:image/png;base64,AAAA')
  })

  it('captures a TABLE-shaped chart, which the svg-only gate silently skipped', async () => {
    // ⚠️ The gate used to require an `<svg>`. Half of what #652 slabs 1-2
    // shipped renders no SVG at all — heatmap, summary, co-occurrence and
    // comparison table are HTML tables — so those exported with no image and
    // fell back to the data table, losing (for the heatmap) its entire colour
    // ramp. The Timeline is the same shape.
    mountEmbed('<table><tbody><tr><td>1</td></tr></tbody></table>')

    const pngs = await captureCanvasChartPngs()

    expect(pngs.get(7)).toBe('data:image/png;base64,AAAA')
  })

  it('still captures an svg-shaped chart', async () => {
    mountEmbed('<svg><rect /></svg>')

    expect((await captureCanvasChartPngs()).get(7)).toBeDefined()
  })

  it('still refuses an embed that has painted NEITHER', async () => {
    // The gate is not pointless: it is what stops a not-yet-rendered chart
    // being rasterized. Widening it to accept a table must not widen it to
    // accept nothing.
    mountEmbed('<div>Chart unavailable</div>')

    expect(await captureCanvasChartPngs()).toEqual(new Map())
    expect(toPng).not.toHaveBeenCalled()
  })
})
