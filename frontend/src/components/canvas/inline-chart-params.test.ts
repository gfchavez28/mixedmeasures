/**
 * #652 slab 1 — turning a saved qualitative material config into a
 * source-frequencies request.
 *
 * ⚠️ Every fixture here must be a QUALITATIVE config with **no `column_ids`**.
 * A quantitative fixture passes before AND after the fix — which is exactly why
 * this surface shipped broken: nothing in the suite ever embedded a qual
 * material, so `extractComputeParams` returning an empty selection looked like
 * correct behaviour rather than the bug.
 *
 * The assertions below are deliberately about the CONFIG→REQUEST mapping rather
 * than about rendering, because that mapping is where a saved config and the
 * live analysis view can silently disagree: same endpoint, same components,
 * different arguments.
 */
import { describe, it, expect } from 'vitest'
import {
  extractQualComputeParams,
  buildQualSaturationParams,
  buildQualCooccurrenceParams,
  buildQualComparisonRequest,
  isQualChartRenderable,
  qualChartKind,
  qualChartHasEnoughToFetch,
} from './inline-chart-params'
import type { QualChartType } from '@/lib/qual-analysis-types'

/** A real `qual_heatmap` config, shaped as `buildCurrentConfig` writes it. */
function qualConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tab: 'descriptives',
    source: 'all',
    code_mode: 'codes',
    code_ids: [65, 66, 67],
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

describe('extractQualComputeParams — source selection', () => {
  it('carries an observation-only selection through to the request', () => {
    const params = extractQualComputeParams(qualConfig())
    expect(params.hasSelection).toBe(true)
    expect(params.request.observation_ids).toEqual([1])
    expect(params.request.code_ids).toEqual([65, 66, 67])
  })

  it('refuses to fetch when no codes are selected', () => {
    // An empty `code_ids` list is NOT "all codes" — the service filters on
    // `is not None`, so it would match nothing and return an empty chart that
    // looks like our failure rather than an empty saved selection.
    const params = extractQualComputeParams(qualConfig({ code_ids: [] }))
    expect(params.hasSelection).toBe(false)
  })

  it('refuses to fetch when no sources are selected', () => {
    const params = extractQualComputeParams(qualConfig({ observation_ids: [] }))
    expect(params.hasSelection).toBe(false)
  })

  it('accepts any one of the four source kinds', () => {
    for (const key of ['conversation_ids', 'text_column_ids', 'document_ids', 'observation_ids']) {
      const params = extractQualComputeParams(
        qualConfig({ observation_ids: [], [key]: [9] }),
      )
      expect(params.hasSelection, `${key} should satisfy the source gate`).toBe(true)
    }
  })
})

/**
 * Every descriptives chart type the analysis view can SAVE, the canvas can DRAW.
 *
 * `qualChartKind` decides this from a hand-listed `SOURCE_FREQUENCY_CHART_TYPES`
 * plus two explicit branches. That set is complete today, and it is the shape
 * that goes stale: a seventh `QualChartType` falls through to `null`,
 * `isQualChartRenderable` reports false, and the canvas silently refuses a
 * material the analysis view happily created — which is #652's own defect one
 * variant later.
 *
 * So this pins the ARITY, not the members (#515 → #676). `Record<QualChartType,
 * true>` fails to COMPILE the day a type is added, and the loop then fails until
 * the new type is routed. Nobody has to know this file exists.
 */
const EVERY_DESCRIPTIVES_TYPE: Record<QualChartType, true> = {
  heatmap: true, bar: true, stacked_bar: true, summary: true,
  saturation: true, timeline: true,
}

describe('#652 — the canvas can draw every chart the analysis view can save', () => {
  const types = Object.keys(EVERY_DESCRIPTIVES_TYPE) as QualChartType[]

  it('covers the whole union (a shrunken map would make the loop vacuous)', () => {
    expect(types).toHaveLength(6)
  })

  it.each(types)('%s resolves to a renderable kind', chartType => {
    const params = extractQualComputeParams(qualConfig({ tab: 'descriptives', chart_type: chartType }))
    expect(qualChartKind(params), `${chartType} falls through to null — route it in `
      + 'qualChartKind, or the canvas will refuse a material the analysis view can create')
      .not.toBeNull()
    expect(isQualChartRenderable(params)).toBe(true)
  })
})

describe('extractQualComputeParams — the mapping traps', () => {
  it('expands the stored orientation TOKEN into the component type', () => {
    // The config stores 'sr'/'cr' (the URL token) while every sibling option is
    // stored already-typed. Passing the raw token through would be invisible on
    // the default and wrong only for a researcher who chose codes-rows.
    expect(extractQualComputeParams(qualConfig({ orientation: 'cr' })).orientation).toBe('codes-rows')
    expect(extractQualComputeParams(qualConfig({ orientation: 'sr' })).orientation).toBe('sources-rows')
    expect(extractQualComputeParams(qualConfig({ orientation: undefined })).orientation).toBe('sources-rows')
  })

  it('sends group_by_subtype for the bar chart only', () => {
    // The analysis view sends it only when the chart type is 'bar'. A saved
    // config keeps `group_by` regardless, so sending it unconditionally would
    // fetch different data than the researcher saw.
    const bar = extractQualComputeParams(qualConfig({ chart_type: 'bar', group_by: 'role' }))
    expect(bar.request.group_by_subtype).toBe('role')

    const heatmap = extractQualComputeParams(qualConfig({ chart_type: 'heatmap', group_by: 'role' }))
    expect(heatmap.request.group_by_subtype).toBeUndefined()
  })

  it('carries the custom code order onto the canvas (#675)', () => {
    // The #675 entry said the canvas would get this "free once the shaping
    // honours it, since sort_order and custom_order are already in the config".
    // `buildCurrentConfig` does write it; nothing here read it. Shaping alone
    // would have left a custom-ordered chart rendering in IMPORT order on the
    // canvas while the analysis view showed the researcher's order — a fresh
    // disagreement between the embed and the view, which is the one property
    // this seam had before the fix.
    expect(extractQualComputeParams(qualConfig({ sort_order: 'custom', custom_order: [67, 65, 66] })).customOrder)
      .toEqual([67, 65, 66])
  })

  it('reads an absent or malformed custom order as no order at all', () => {
    expect(extractQualComputeParams(qualConfig()).customOrder).toEqual([])
    expect(extractQualComputeParams(qualConfig({ custom_order: null })).customOrder).toEqual([])
    expect(extractQualComputeParams(qualConfig({ custom_order: ['65', 66] })).customOrder).toEqual([66])
  })

  it('derives aggregation from code_mode', () => {
    expect(extractQualComputeParams(qualConfig({ code_mode: 'categories' })).request.aggregation).toBe('category')
    expect(extractQualComputeParams(qualConfig({ code_mode: 'codes' })).request.aggregation).toBeUndefined()
  })

  it('reads the show/hide flags with their asymmetric defaults', () => {
    // These are written to config only in their NON-default state, so a uniform
    // `?? false` would invert two of the three.
    const bare = extractQualComputeParams(qualConfig())
    expect(bare.showSummaryRow).toBe(true)
    expect(bare.showRowN).toBe(true)
    expect(bare.showChartN).toBe(false)

    const set = extractQualComputeParams(
      qualConfig({ show_summary_row: false, show_row_n: false, show_chart_n: true }),
    )
    expect(set.showSummaryRow).toBe(false)
    expect(set.showRowN).toBe(false)
    expect(set.showChartN).toBe(true)
  })

  it('omits an empty participant list rather than sending []', () => {
    expect(extractQualComputeParams(qualConfig()).request.participant_ids).toBeUndefined()
    expect(extractQualComputeParams(qualConfig({ participant_ids: [4] })).request.participant_ids).toEqual([4])
  })

  it('sends the saved coder scope, null when unnarrowed', () => {
    expect(extractQualComputeParams(qualConfig()).request.coder_ids).toBeNull()
    expect(extractQualComputeParams(qualConfig({ coder_ids: [2, 3] })).request.coder_ids).toEqual([2, 3])
  })
})

describe('qualChartKind — the single dispatch', () => {
  it('reads chart_type on the descriptives tab', () => {
    for (const chart_type of ['heatmap', 'bar', 'stacked_bar', 'summary', 'saturation', 'timeline']) {
      expect(qualChartKind(extractQualComputeParams(qualConfig({ chart_type })))).toBe(chart_type)
    }
  })

  it('draws timeline (slab 4) rather than deferring it', () => {
    const params = extractQualComputeParams(qualConfig({ chart_type: 'timeline' }))
    expect(qualChartKind(params)).toBe('timeline')
    expect(isQualChartRenderable(params)).toBe(true)
  })

  it('still returns null — and refuses to fetch — for a kind it has no case for', () => {
    // `qual_content` is the only such kind and the save gate cannot produce it,
    // so nothing REACHABLE lands here. The arm is kept so that a tenth chart
    // type added to `qualChartKind` fails visibly at every consumer instead of
    // rendering blank, and this pin is what keeps the arm honest.
    const params = extractQualComputeParams(qualConfig({ tab: 'content' }))
    expect(qualChartKind(params)).toBeNull()
    expect(isQualChartRenderable(params)).toBe(false)
    expect(qualChartHasEnoughToFetch(params)).toBe(false)
  })

  it('IGNORES a stale chart_type on the relationships tab', () => {
    // The bug this guards: `buildCurrentConfig` writes `chart_type`
    // unconditionally, so a co-occurrence material still carries the last
    // descriptives type — typically 'heatmap', which is perfectly drawable.
    // Dispatching on chart_type would render it as a descriptives heatmap over
    // source-frequencies data: confidently wrong, worse than drawing nothing.
    const params = extractQualComputeParams(
      qualConfig({ tab: 'relationships', rel_view: 'cooccurrence', chart_type: 'heatmap' }),
    )
    expect(params.chartType).toBe('heatmap')
    expect(qualChartKind(params)).toBe('cooccurrence')
  })

  it('reads rel_view then comparison_chart_mode on the relationships tab', () => {
    const kindOf = (over: Record<string, unknown>) =>
      qualChartKind(extractQualComputeParams(qualConfig({ tab: 'relationships', ...over })))

    expect(kindOf({ rel_view: 'cooccurrence' })).toBe('cooccurrence')
    expect(kindOf({ rel_view: 'comparisons', comparison_chart_mode: 'table' })).toBe('comparison_table')
    expect(kindOf({ rel_view: 'comparisons', comparison_chart_mode: 'bar' })).toBe('comparison_bar')
  })
})

describe('layerScope is surfaced as a first-class param (#652 slab 4)', () => {
  // For the source-frequency four the layer is an endpoint parameter; for the
  // Timeline it is a DISPATCH input (that chart reads the human layer and
  // refuses under consensus), and a dispatch input must not be reachable only
  // by digging into a request body.
  it('mirrors request.layer_scope, defaulting to human', () => {
    expect(extractQualComputeParams(qualConfig()).layerScope).toBe('human')
    expect(extractQualComputeParams(qualConfig({ layer_scope: 'consensus' })).layerScope).toBe('consensus')
    expect(extractQualComputeParams(qualConfig({ layer_scope: undefined })).layerScope).toBe('human')
  })
})

describe('qualChartHasEnoughToFetch — the gate differs per kind', () => {
  it('requires codes AND a source for the source-frequency four', () => {
    expect(qualChartHasEnoughToFetch(extractQualComputeParams(qualConfig()))).toBe(true)
    expect(qualChartHasEnoughToFetch(extractQualComputeParams(qualConfig({ code_ids: [] })))).toBe(false)
    expect(qualChartHasEnoughToFetch(extractQualComputeParams(qualConfig({ observation_ids: [] })))).toBe(false)
  })

  it('requires codes AND a source for the timeline — the gate, not the name', () => {
    // ⚠️ `code_ids: []` argues BOTH ways on this path: `timedCodes` reads it as
    // "all active codes" (and `generateAutoName()` even names such a material
    // "All codes"), while `hasQualSelection` gates the whole Descriptives body
    // so the view renders its empty state and the chart never mounts. The gate
    // is what the researcher saw, so the embed reproduces the gate.
    const timeline = (over: Record<string, unknown> = {}) =>
      extractQualComputeParams(qualConfig({ chart_type: 'timeline', ...over }))

    expect(qualChartHasEnoughToFetch(timeline())).toBe(true)
    expect(qualChartHasEnoughToFetch(timeline({ code_ids: [] }))).toBe(false)
    // No source of ANY kind — an observation is not required specifically,
    // because the view's own gate accepts a conversation here.
    expect(qualChartHasEnoughToFetch(
      timeline({ observation_ids: [], conversation_ids: [], document_ids: [], text_column_ids: [] }),
    )).toBe(false)
    expect(qualChartHasEnoughToFetch(timeline({ observation_ids: [], conversation_ids: [4] }))).toBe(true)
  })

  it('asks for saturation with nothing selected — empty means ALL sources there', () => {
    // Unlike source-frequencies, saturation has no `code_ids` and its source
    // filters are truthiness-tested, so an empty config is a valid whole-project
    // request — which is exactly what the analysis view sends by default.
    const params = extractQualComputeParams(
      qualConfig({ chart_type: 'saturation', code_ids: [], observation_ids: [] }),
    )
    expect(qualChartHasEnoughToFetch(params)).toBe(true)
  })

  it('requires a grouping variable for comparisons, and nothing for co-occurrence', () => {
    const comparison = (group_by: string | null) =>
      extractQualComputeParams(qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by }))
    expect(qualChartHasEnoughToFetch(comparison('role'))).toBe(true)
    expect(qualChartHasEnoughToFetch(comparison(null))).toBe(false)

    // Co-occurrence is all-codes by design — its filter params carry no
    // `code_ids` at all, so an empty selection is not a blocker.
    const cooc = extractQualComputeParams(
      qualConfig({ tab: 'relationships', rel_view: 'cooccurrence', code_ids: [] }),
    )
    expect(qualChartHasEnoughToFetch(cooc)).toBe(true)
  })
})

describe('the slab-2 request builders each mirror their own live caller', () => {
  it('saturation drops code, text-column and participant filters', () => {
    // The endpoint has no `code_ids` parameter and the view's saturation query
    // omits text columns and participants. Sending them would imply a scoping
    // the curve does not have.
    const params = extractQualComputeParams(
      qualConfig({ chart_type: 'saturation', text_column_ids: [4], participant_ids: [9], code_mode: 'categories' }),
    )
    const sat = buildQualSaturationParams(params) as Record<string, unknown>

    expect(sat.observation_ids).toBe('1')
    expect(sat.category_level).toBe(true) // boolean here; `aggregation` elsewhere
    expect('code_ids' in sat).toBe(false)
    expect('text_column_ids' in sat).toBe(false)
    expect('participant_ids' in sat).toBe(false)
  })

  it('the comparison request is null without a grouping variable', () => {
    const none = extractQualComputeParams(qualConfig({ tab: 'relationships', rel_view: 'comparisons' }))
    expect(buildQualComparisonRequest(none)).toBeNull()
  })

  it('the comparison request omits documents and observations by design', () => {
    // Grouping runs through participant demographics, and neither documents nor
    // observation clips carry a speaker→participant link. The analysis view
    // sends conversations + text columns only; mirroring that is correct.
    const params = extractQualComputeParams(
      qualConfig({ tab: 'relationships', rel_view: 'comparisons', group_by: 'role', conversation_ids: [7] }),
    )
    const req = buildQualComparisonRequest(params)! as unknown as Record<string, unknown>

    expect(req.group_by_subtype).toBe('role')
    expect(req.conversation_ids).toEqual([7])
    expect('document_ids' in req).toBe(false)
    expect('observation_ids' in req).toBe(false)
  })

  it('co-occurrence params carry no code_ids', () => {
    const params = extractQualComputeParams(qualConfig({ tab: 'relationships', rel_view: 'cooccurrence' }))
    const cooc = buildQualCooccurrenceParams(params) as Record<string, unknown>
    expect(cooc.code_ids).toBeUndefined()
    expect(cooc.observation_ids).toBe('1')
  })

  it('reads show_effect_size as shown when absent', () => {
    // The view defaults it to '1' and always writes it, but a config predating
    // the key must not silently hide the effect-size column.
    expect(extractQualComputeParams(qualConfig()).showEffectSize).toBe(true)
    expect(extractQualComputeParams(qualConfig({ show_effect_size: false })).showEffectSize).toBe(false)
  })
})

/**
 * #749 — the summary table's second endpoint is GONE.
 *
 * `qualChartNeedsFrequencies` / `buildQualFrequencyParams` existed only because
 * the table drew its per-kind columns from `code-frequencies`. That endpoint
 * reads an unselected kind as ALL of that kind, so a canvas summary embed could
 * render a selection-scoped body above a project-scoped totals row. Both halves
 * now come from `source-frequencies`, and the embed makes one request.
 *
 * The CSV-shaping assertions below survive on the co-occurrence builder, which
 * is the same shape and now its own function.
 */
describe('the co-occurrence embed reproduces the view’s filter scope', () => {
  it('builds CSV filter params that match the source-frequencies scope', () => {
    const params = extractQualComputeParams(
      qualConfig({ chart_type: 'cooccurrence', coder_ids: [2, 3], conversation_ids: [7, 8] }),
    )
    const filter = buildQualCooccurrenceParams(params)
    expect(filter.observation_ids).toBe('1')
    expect(filter.conversation_ids).toBe('7,8')
    expect(filter.coder_ids).toBe('2,3')
    expect(filter.layer_scope).toBe('human')
    expect(filter.source).toBe('all')
    // Empty lists must be omitted, not sent as empty strings.
    expect(filter.document_ids).toBeUndefined()
    expect(filter.participant_ids).toBeUndefined()
  })
})
