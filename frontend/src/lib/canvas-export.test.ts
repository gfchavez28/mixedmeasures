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
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
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

import { codeAnalysisApi, metricsApi, codesApi, observationsApi, comparisonsApi } from '@/lib/api'
import { toPng } from 'html-to-image'
import { fetchChartTables, captureCanvasChartPngs } from './canvas-export'

/** #1077 (b) — the export lens is REQUIRED; these cases run with no machine coder. */
const NO_MACHINES: ReadonlySet<number> = new Set()
const LENS = { blind: false, self: null, machineCoderIds: NO_MACHINES }

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
    const tables = await fetchChartTables(themeWithChart(qualConfig()), 3, LENS)

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
    const tables = await fetchChartTables(themeWithChart(qualConfig({ orientation: 'cr' })), 3, LENS)

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| Code | apollo11_interview |')
    expect(md).toContain('| Trust in mission control | 4 |')
  })

  it('emits nothing for a chart type this build cannot draw, rather than a wrong table', async () => {
    // Nothing REACHABLE is left on this arm since slab 4 — `qual_content` is
    // the only kind without a case and the save gate cannot produce it. Kept
    // so a tenth kind emits nothing rather than a wrong table.
    const tables = await fetchChartTables(themeWithChart(qualConfig({ tab: 'content' })), 3, LENS)

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('exports a timeline as one row per observation x code, using the SHARED compute', async () => {
    // ⚠️ This is the one kind whose export could grow a second implementation:
    // it mounts no component, so the arithmetic has to be the renderer's. The
    // fixture makes the two answers differ — two coders mark the SAME clip, so
    // pooling gives 1:00.0 / 10% where summing would give 2:00.0 / 20%.
    const tables = await fetchChartTables(themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70] })), 3, LENS)

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
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70] })), 3, { blind: true, self: 1, machineCoderIds: NO_MACHINES },
    )

    const md = tables.get(1)!.md
    // Rapport: both coders marked it ⇒ 1 visible mark for self alone.
    expect(md).toContain('| Playground morning | Rapport | 1 |')
    // Silence: colleague-only ⇒ nothing visible.
    expect(md).toContain('| Playground morning | Silence | 0 |')
  })

  it('#1077 (b): a MACHINE coder\'s marks leave the Coders layer and are all the Machine layer has', async () => {
    // Coder 2 is a model here. Rapport: person 1 and model 2 marked the same clip;
    // Silence: only the model did. The export resolves through the shared lens,
    // so it must agree with the rendered embed on both layers.
    const machine = { blind: false, self: null, machineCoderIds: new Set([2]) }
    const human = (await fetchChartTables(
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70] })), 3, machine,
    )).get(1)!.md
    expect(human).toContain('| Playground morning | Rapport | 1 |')
    expect(human).toContain('| Playground morning | Silence | 0 |')

    const model = (await fetchChartTables(
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70], layer_scope: 'machine' })), 3, machine,
    )).get(1)!.md
    expect(model).toContain('| Playground morning | Rapport | 1 |')
    expect(model).toContain('| Playground morning | Silence | 1 |')
  })

  it('refuses to export a timeline saved on the consensus layer', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ chart_type: 'timeline', code_ids: [71, 70], layer_scope: 'consensus' })), 3, LENS,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(observationsApi.list).not.toHaveBeenCalled()
  })

  it('exports a saturation curve as a per-source table', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig({ chart_type: 'saturation' })), 3, LENS)

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| # | Source | New codes | Cumulative unique codes |')
    expect(md).toContain('| 1 | apollo11_interview | 2 | 2 |')
  })

  it('exports a co-occurrence matrix, fetched directly rather than via the component', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence' })), 3, LENS,
    )

    const md = tables.get(1)!.md
    expect(md.split('\n')[0]).toBe('| Code | Trust | Isolation |')
    expect(md).toContain('| Trust | 4 | 1 |')
    // The level must ride along — it is merged by the component in the UI, so
    // the export has to supply it itself or the server defaults it.
    const sent = vi.mocked(codeAnalysisApi.cooccurrence).mock.calls[0][1] as Record<string, unknown>
    expect(sent.level).toBe('segment')
  })

  it('#1335 (D47): the co-occurrence table says the rule its pairs were counted by, under the table', async () => {
    // A Markdown or HTML reader sees no caption, so the figure's sentence rides as
    // the table's note. Written out here, not imported: the words are the claim.
    const RULE = 'Two codes count as co-occurring only where one coder applied both.'
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence' })), 3, LENS,
    )
    const entry = tables.get(1)!
    expect(entry.table?.note).toBe(RULE)
    expect(entry.md.endsWith(`\n\n${RULE}`)).toBe(true)
    expect(entry.html).toContain(`<p>${RULE}</p>`)
  })

  it('exports a comparison with counts AND proportions per group', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role' })), 3, LENS,
    )

    const md = tables.get(1)!.md
    // #1323 D3: two groups carry Δ. A payload from before the basis carries no
    // interval, so no interval column and no note — nothing is relabelled.
    expect(md.split('\n')[0]).toBe('| Code | Staff n | Volunteer n | Staff % | Volunteer % | Δ (percentage points) |')
    expect(md).toContain('| Trust | 4 | 1 | 40.0% | 20.0% | +20.0 |')
    expect(md).not.toContain('CI')
    expect(md.trimEnd().endsWith('|')).toBe(true)
  })

  it('exports — and the reason for a group with no segments, and keeps a real 0.0% (#1421)', async () => {
    vi.mocked(codeAnalysisApi.demographicComparison).mockResolvedValueOnce({
      groups: ['Staff', 'Volunteer', 'Board'],
      group_totals: {
        Staff: { total_segments: 10, total_word_count: 0 },
        Volunteer: { total_segments: 5, total_word_count: 0 },
        Board: { total_segments: 0, total_word_count: 0 },
      },
      codes: [{
        code_id: 65, code_name: 'Trust', category_name: null,
        by_group: {
          Staff: { count: 4, proportion: 0.4, undefined_reason: null },
          Volunteer: { count: 0, proportion: 0, undefined_reason: null },
          Board: { count: 0, proportion: null, undefined_reason: 'no_segments' },
        },
        delta_proportion: null, test: null,
      }],
    } as never)
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role' })), 3, LENS,
    )

    const row = tables.get(1)!.md.split('\n').find(l => l.startsWith('| Trust '))!
    const cells = row.split('|').slice(1, -1).map(c => c.trim())
    // Code, Staff n, Volunteer n, Board n, Staff %, Volunteer %, Board %
    expect(cells.slice(0, 6)).toEqual(['Trust', '4', '0', '0', '40.0%', '0.0%'])
    expect(cells[6]).toMatch(/^— Nobody in this group has material/)  // HEAD: ''
  })

  it('exports the unit, both p-values and why a code was not tested (#1323)', async () => {
    vi.mocked(codeAnalysisApi.demographicComparison).mockResolvedValueOnce({
      groups: ['Staff', 'Board'],
      group_totals: {
        Staff: { n: 8, participants: 8, total_segments: 40, total_word_count: 0 },
        Board: { n: 8, participants: 8, total_segments: 30, total_word_count: 0 },
      },
      codes: [
        { code_id: 65, code_name: 'Trust', category_name: null,
          by_group: { Staff: { count: 6, proportion: 0.75, undefined_reason: null, passages: 9 },
                      Board: { count: 1, proportion: 0.125, undefined_reason: null, passages: 1 } },
          delta_proportion: 0.625,
          delta_ci: { lower: 0.1704, upper: 0.8231, level: 0.95, method: 'newcombe_hybrid_score' },
          test: { method: 'fisher_exact', statistic: null, p_value: 0.040559, p_adjusted: 0.081119,
                  significant: false, effect_size: null, effect_size_label: null } },
        { code_id: 66, code_name: 'Unclear', category_name: null,
          by_group: { Staff: { count: 2, proportion: 0.25, undefined_reason: null, passages: 2 },
                      Board: { count: 0, proportion: 0, undefined_reason: null, passages: 0 } },
          delta_proportion: 0.25,
          delta_ci: { lower: -0.0934, upper: 0.5918, level: 0.95, method: 'newcombe_hybrid_score' },
          test: null, test_omitted_reason: 'universal_code' },
      ],
      basis: { unit: 'participant', correction: 'discrete_holm', family_size: 1, family_reachable: 1,
               tarone_family_size: 1, alpha: 0.05, tested_groups: ['Staff', 'Board'], test_omitted_reason: null },
      scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
               unassigned_passages: 0, participants_without_group: 0 },
    } as never)
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role' })), 3, LENS,
    )
    const md = tables.get(1)!.md
    // The correction is NAMED (never the wire key `discrete_holm`), and Δ's interval
    // is labelled by `ci-label.ts` as UNADJUSTED (D3) — the p beside it is adjusted.
    expect(md).toContain('| Code | Staff (of 8 participants) | Board (of 8 participants) | Staff % | Board % | Δ (percentage points) | Δ 95% CI (unadjusted) | p | p adjusted (discrete Holm) |')
    expect(md).toContain('| Trust | 6 | 1 | 75.0% | 12.5% | +62.5 | [17.0, 82.3] | .041 | .081 |')   // HEAD: no p at all
    // A negative bound takes the minus the Δ column uses.
    expect(md).toMatch(/\| Unclear \|.*\| \+25\.0 \| \[-9\.3, 59\.2\] \| — \| Not tested: a universal code/)
    // The method note the figure prints beneath itself rides under the table (session B):
    // the Markdown export has no image to carry it.
    const after = md.split('\n').slice(-1)[0]
    expect(after).toMatch(/^Each participant counts once/)
    expect(after).toContain('not adjusted for the number of codes')
    expect(tables.get(1)!.html).toMatch(/<\/table>\n<p>Each participant counts once/)
  })

  it('emits nothing for a comparison with no grouping variable', async () => {
    const tables = await fetchChartTables(
      themeWithChart(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: null })), 3, LENS,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.demographicComparison).not.toHaveBeenCalled()
  })

  it('emits nothing for an empty saved selection', async () => {
    const tables = await fetchChartTables(themeWithChart(qualConfig({ code_ids: [] })), 3, LENS)

    expect(tables.get(1)).toBeUndefined()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })

  it('still routes a quantitative material to quickCompute', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [] } as never)
    await fetchChartTables(themeWithChart({ column_ids: [7], metric_type: 'frequency_distribution' }), 3, LENS)

    expect(metricsApi.quickCompute).toHaveBeenCalled()
    expect(codeAnalysisApi.sourceFrequencies).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 #832 — the EXPORT must draw the same cross-tab the canvas draws.
 *
 * `cross_tab` is the one #823(g) type whose data does not come from
 * `quickCompute`, and #823(g) taught only `InlineChartRenderer` about it. The
 * export kept falling through to `metricsToMarkdownTable`, which has cases for
 * `frequency_distribution`, `dumbbell` and `line` and a scalar-bar default —
 * **no `cross_tab` case at all** — so it emitted the ROW variable's marginal
 * distribution with the second axis silently absent.
 *
 * ⚠️ **Round 3 did not create that; it created the DIVERGENCE.** Beforehand the
 * renderer printed the literal token `"cross_tab chart"` and the export emitted
 * the wrong table: both useless, consistently. Afterwards the canvas was right
 * and `.md` was wrong, which is worse — nothing gave the researcher a reason to
 * doubt the file. Markdown has no images at all, and HTML/PDF/docx fall back to
 * these same tables whenever the PNG capture does not run.
 */
describe('fetchChartTables — cross-tab embeds (#832)', () => {
  const CROSS_TAB = {
    row_values: ['Low', 'High'],
    col_values: ['North', 'South'],
    matrix: [
      [{ count: 4, row_pct: 40, col_pct: 25, total_pct: 10 },
        { count: 6, row_pct: 60, col_pct: 30, total_pct: 15 }],
      [{ count: 12, row_pct: 40, col_pct: 75, total_pct: 30 },
        { count: 18, row_pct: 60, col_pct: 70, total_pct: 45 }],
    ],
    row_totals: [10, 30],
    col_totals: [16, 24],
    n_shared: 40,
    row_column_label: 'Fidelity band',
    col_column_label: 'Region',
    chi_square: null,
  }

  function crossTabConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { chart_type: 'cross_tab', column_ids: [7], cross_tab_column_id: 12, ...over }
  }

  beforeEach(() => {
    // Reset CALL HISTORY, not just the return value — three assertions below
    // are `not.toHaveBeenCalled`, and without this they read calls made by the
    // previous test and fail for a reason that is the harness's, not the code's.
    vi.mocked(metricsApi.crossTabulation).mockReset()
    vi.mocked(metricsApi.quickCompute).mockReset()
    vi.mocked(metricsApi.crossTabulation).mockResolvedValue(CROSS_TAB as never)
  })

  it('fetches the cross-tab endpoint instead of computing a metric', async () => {
    const tables = await fetchChartTables(themeWithChart(crossTabConfig()), 3, LENS)

    expect(metricsApi.crossTabulation).toHaveBeenCalledWith(3, {
      row_column_id: 7, col_column_id: 12, include_chi_square: true,
    })
    // The whole point: the wrong-data path must not run.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
    expect(tables.get(1)).toBeDefined()
  })

  it('exports BOTH axes, with totals — the table the canvas draws', async () => {
    const md = (await fetchChartTables(themeWithChart(crossTabConfig()), 3, LENS)).get(1)!.md
    const lines = md.split('\n')

    // Positive assertions, not "does not contain" — a negative here is the
    // #770/#823(g) trap: `queryByText` never matched because the render was two
    // text nodes, and the guard could not fail.
    expect(lines[0]).toBe('| Fidelity band | North | South | Total |')
    expect(lines).toContain('| Low | 4 | 6 | 10 |')
    expect(lines).toContain('| High | 12 | 18 | 30 |')
    expect(lines).toContain('| Total | 16 | 24 | 40 |')
  })

  it('mirrors the saved display mode rather than always emitting counts', async () => {
    const md = (await fetchChartTables(
      themeWithChart(crossTabConfig({ cross_tab_display: 'row_pct' })), 3, LENS,
    )).get(1)!.md

    expect(md.split('\n')).toContain('| Low | 40.0% | 60.0% | 10 |')
    // Totals stay counts even when the cells are percentages, as on screen.
    expect(md.split('\n')).toContain('| Total | 16 | 24 | 40 |')
  })

  it('mirrors a reversed scale order on BOTH axes', async () => {
    const md = (await fetchChartTables(
      themeWithChart(crossTabConfig({ scaleOrder: 'reversed' })), 3, LENS,
    )).get(1)!.md
    const lines = md.split('\n')

    expect(lines[0]).toBe('| Fidelity band | South | North | Total |')
    // High first, and its cells follow the reversed columns.
    expect(lines[2]).toBe('| High | 18 | 12 | 30 |')
    expect(lines[3]).toBe('| Low | 6 | 4 | 10 |')
  })

  it('emits nothing for a half-configured cross-tab, and does not ask', async () => {
    // No `cross_tab_column_id`: the renderer says so on screen; an export has
    // nowhere to say it, so it emits nothing rather than a table of whatever
    // quickCompute would have returned.
    const tables = await fetchChartTables(
      themeWithChart(crossTabConfig({ cross_tab_column_id: undefined })), 3, LENS,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(metricsApi.crossTabulation).not.toHaveBeenCalled()
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('has no row axis when the selection is not exactly one variable', async () => {
    // A cross-tab is defined over ONE row variable; `columnIds[0]` would
    // silently pick one of two.
    const tables = await fetchChartTables(
      themeWithChart(crossTabConfig({ column_ids: [7, 8] })), 3, LENS,
    )

    expect(tables.get(1)).toBeUndefined()
    expect(metricsApi.crossTabulation).not.toHaveBeenCalled()
    // ⚠️ This second assertion is what makes the test DISCRIMINATE. Without it
    // the case passed with the cross-tab branch deleted — the fall-through also
    // produced no table, for the opposite reason (quickCompute returned
    // nothing). Mutation-found: 5 of 6 cases here failed on the mutant and this
    // one did not.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
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

// ── #817: the export must not lag the renderer either ────────────────────────

describe('#817 — a comparison exports the comparison', () => {
  const comparisonConfig = {
    column_ids: [], domain_ids: [1], metric_type: 'frequency_distribution',
    compare_by: 60, rc_view: 'comparisons', test_type: 'auto',
  }

  beforeEach(() => {
    vi.mocked(metricsApi.quickCompute).mockReset()
    vi.mocked(comparisonsApi.groupComparison).mockReset()
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue({
      groups: ['Under 45', '45 and over'],
      group_column_label: 'degree',
      rows: [{
        label: 'Trust A', full_label: 'Trust scale A', source_id: 1, source_type: 'domain',
        group_stats: [
          { group: 'Under 45', n: 120, mean: 2.31 },
          { group: '45 and over', n: 98, mean: 1.88 },
        ],
        test: { test_type: 'one_way_anova', statistic: 690.88, df: 1, df2: 216, p: 0.0001,
                effect_size: 0.06, effect_size_type: 'eta_squared' },
        test_omitted_reason: null,
      }],
      bonferroni_warning: false, bonferroni_threshold: null, unavailable_reason: null,
    } as never)
  })

  it('reads the comparison endpoint, not quickCompute', async () => {
    // 🔴 The Markdown export has NO images — this table is the only thing a
    // `.md` reader sees. Fixing the renderer alone would have left Markdown
    // carrying the wrong figure while HTML/PDF/docx (which capture the rendered
    // PNG) carried the right one: one material, two answers.
    await fetchChartTables(themeWithChart(comparisonConfig), 4, LENS)
    expect(comparisonsApi.groupComparison).toHaveBeenCalled()
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('emits the groups and the test, not a distribution', async () => {
    const tables = await fetchChartTables(themeWithChart(comparisonConfig), 4, LENS)
    const md = tables.get(1)?.md ?? ''
    expect(md).toContain('Under 45 n')
    // #1423: the strip's words for the test, never its wire id.
    expect(md).toContain('F(1, 216) = 690.88')
    expect(md).toContain('Trust scale A')
  })

  it('🔴 #1315 arm 3: a comparison carrying correlation keys still exports the comparison', async () => {
    // A pre-#1315 saver wrote every R&C key on every view, so a comparison saved
    // after a Spearman or scatter toggle carries `corr_type` and `show_scatter`.
    // The renderer asked "comparison?" first and drew it; this file asked
    // "correlation?" first and exported NOTHING — "Chart data not available"
    // under a chart the canvas showed. Both ask `quantChartKind` now.
    const arm3 = { ...comparisonConfig, show_scatter: true, corr_type: 'spearman' }
    const tables = await fetchChartTables(themeWithChart(arm3), 4, LENS)
    expect(comparisonsApi.groupComparison).toHaveBeenCalled()
    expect(tables.get(1)?.md ?? '').toContain('F(1, 216) = 690.88')
  })

  it('prints the REASON when a row has no test, never a blank cell', async () => {
    // #566 — a blank is indistinguishable from a broken export.
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue({
      groups: ['A'], group_column_label: 'g',
      rows: [{
        label: 'x', full_label: 'x', source_id: 1, source_type: 'column',
        group_stats: [{ group: 'A', n: 1, mean: 1 }],
        test: null, test_omitted_reason: 'insufficient_n',
      }],
      bonferroni_warning: false, bonferroni_threshold: null, unavailable_reason: null,
    } as never)
    const tables = await fetchChartTables(themeWithChart(comparisonConfig), 4, LENS)
    expect(tables.get(1)?.md ?? '').toMatch(/Too few values/)
  })

  it('1.5.9 session A: the p names its method and the groups the tests left out are said', async () => {
    // #1326 STAT-12 (D58) and #1329 (D51): the rendered table says both, so the
    // exported one does — the method in the p cell, the groups under the table.
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue({
      groups: ['A', 'B', 'C'], group_column_label: 'g',
      rows: [{
        label: 'x', full_label: 'Score', source_id: 1, source_type: 'column',
        group_stats: [{ group: 'A', n: 6, mean: 1 }, { group: 'B', n: 5, mean: 2 },
                      { group: 'C', n: 1, mean: 3 }],
        test: { test_type: 'kruskal_wallis', statistic: 5.1, df: 2, p: 0.0781,
                effect_size: 0.4, effect_size_type: 'epsilon_squared' },
        test_omitted_reason: null, untested_groups: ['C'],
      }, {
        label: 'y', full_label: 'Other', source_id: 2, source_type: 'column',
        group_stats: [{ group: 'A', n: 6, mean: 1 }, { group: 'B', n: 5, mean: 2 }],
        test: { test_type: 'mann_whitney_u', statistic: 22, df: 18, p: 0.0355,
                effect_size: 0.56, effect_size_type: 'rank_biserial_r', p_method: 'exact' },
        test_omitted_reason: null, untested_groups: [],
      }],
      bonferroni_warning: false, bonferroni_threshold: null, unavailable_reason: null,
    } as never)
    const tables = await fetchChartTables(themeWithChart(comparisonConfig), 4, LENS)
    const md = tables.get(1)?.md ?? ''
    // #1423: the table's p (`formatP`), never `toFixed(4)`.
    expect(md).toContain('.035 (exact p)')
    expect(md).not.toContain('0.0355')
    expect(md).toContain('Score: C has only one value, so it is shown without an SD and left out of the tests.')
    expect(md).not.toContain('Other: ')
  })
})

describe('#831 — a correlation material exports nothing rather than a wrong table', () => {
  /**
   * The #832 rule applied before it could bite again: the renderer REFUSES to
   * draw a correlation matrix, so an export that quietly ran `quickCompute` on
   * the correlation's own columns would emit a frequency table under the
   * correlation's title — canvas honest, `.md` wrong, and nothing to tell the
   * reader which to believe.
   */
  it('does not call quickCompute for a marked correlation material', async () => {
    const tables = await fetchChartTables(
      themeWithChart({ rc_view: 'correlations', column_ids: [1, 2] }), 3, LENS,
    )
    // The load-bearing assertion: an empty-table check alone would pass just as
    // happily if the request HAD been made and returned nothing.
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
    expect(tables.get(1)?.md ?? '').toBe('')
  })

  it('does not call quickCompute for a LEGACY scatter matrix either', async () => {
    await fetchChartTables(themeWithChart({ column_ids: [1, 2], show_scatter: true }), 3, LENS)
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
  })

  it('still routes an ordinary descriptives material to quickCompute', async () => {
    // Positive control — a refusal that swallowed everything would pass both
    // assertions above while breaking the export.
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [] } as never)
    await fetchChartTables(themeWithChart({ column_ids: [1], metric_type: 'mean' }), 3, LENS)
    expect(metricsApi.quickCompute).toHaveBeenCalled()
  })
})
