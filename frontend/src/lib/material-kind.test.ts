import { describe, it, expect } from 'vitest'
import { isQualitativeMaterialConfig, materialAnalysisPath, describeMissingRefs, describeStaleInputs } from './material-kind'
import type { MaterialRefKind } from './api/materials'

/**
 * #652 slab 0 — the canvas embed's "Open in Analysis" sent every QUALITATIVE
 * material to the QUANTITATIVE view. Observed live on a
 * `qualitative_descriptives` material: `…/analysis/quantitative?material=1`.
 *
 * The configs below are the real shapes, taken from the two builders:
 *   qual → useQualitativeAnalysis::buildCurrentConfig
 *   quant → AnalysisView::buildCurrentChartConfig
 */

// Trimmed to the discriminating keys plus enough context to stay recognisable.
const QUAL_CONFIG = {
  tab: 'descriptives',
  source: 'all',
  code_mode: 'codes',
  code_ids: [65, 66, 67],
  conversation_ids: [],
  text_column_ids: [],
  document_ids: [],
  observation_ids: [1],
  exclude_facilitator: true,
  chart_type: 'heatmap',
}

const QUANT_CONFIG = {
  title: 'Belonging by site',
  selected_columns: [12, 13],
  selected_domains: [],
  metric_type: 'frequency_distribution',
  chart_type: 'horizontal_bar',
}

describe('isQualitativeMaterialConfig', () => {
  it('identifies a qualitative config by its code keys', () => {
    expect(isQualitativeMaterialConfig(QUAL_CONFIG)).toBe(true)
  })

  it('does not claim a quantitative config', () => {
    expect(isQualitativeMaterialConfig(QUANT_CONFIG)).toBe(false)
  })

  it('treats an observation-only qualitative config as qualitative', () => {
    // The case that surfaced #652: no conversations, no columns, clips only.
    expect(isQualitativeMaterialConfig({
      code_mode: 'codes', code_ids: [1], observation_ids: [7],
    })).toBe(true)
  })

  it('is false for empty / missing / non-object configs', () => {
    expect(isQualitativeMaterialConfig({})).toBe(false)
    expect(isQualitativeMaterialConfig(null)).toBe(false)
    expect(isQualitativeMaterialConfig(undefined)).toBe(false)
  })

  it('matches on code_ids alone, so a partial config still routes right', () => {
    expect(isQualitativeMaterialConfig({ code_ids: [1] })).toBe(true)
  })
})

describe('materialAnalysisPath', () => {
  it('sends a qualitative material to the QUALITATIVE view', () => {
    expect(materialAnalysisPath(3, 1, QUAL_CONFIG))
      .toBe('/projects/3/analysis/qualitative?material=1')
  })

  it('sends a quantitative material to the QUANTITATIVE view', () => {
    expect(materialAnalysisPath(3, 9, QUANT_CONFIG))
      .toBe('/projects/3/analysis/quantitative?material=9')
  })

  it('falls back to quantitative when the config tells us nothing', () => {
    // Not a guess dressed as knowledge: an embed with no config is the
    // pre-existing behaviour, and the quantitative view is where it went before.
    expect(materialAnalysisPath(3, 4, {}))
      .toBe('/projects/3/analysis/quantitative?material=4')
  })

  it('accepts string ids (route params arrive as strings)', () => {
    expect(materialAnalysisPath('3', '1', QUAL_CONFIG))
      .toBe('/projects/3/analysis/qualitative?material=1')
  })
})

/**
 * #652 slab 3 — the "sources missing" sentence.
 *
 * The old copy read *"N referenced columns or domains no longer exist"*, which
 * was accurate only while those were the only kinds ever collected. Once slab 3
 * started reporting codes and sources it would have named the wrong nouns — the
 * same shape as the empty-state copy that told a researcher their observation
 * note did not exist (#676).
 */
describe('describeMissingRefs', () => {
  const refs = (...kinds: MaterialRefKind[]) => kinds.map(type => ({ type }))

  it('names the kind, not a generic "reference"', () => {
    // "1 conversation" tells the researcher where to look; "1 reference" does not.
    expect(describeMissingRefs(refs('conversation')))
      .toBe('1 conversation referenced here no longer exists.')
  })

  it('pluralises within a kind', () => {
    expect(describeMissingRefs(refs('code', 'code', 'code')))
      .toBe('3 codes referenced here no longer exist.')
  })

  it('lists several kinds rather than collapsing them', () => {
    expect(describeMissingRefs(refs('conversation', 'observation', 'observation')))
      .toBe('1 conversation and 2 observations referenced here no longer exist.')
  })

  it('joins three or more kinds with commas and a final "and"', () => {
    expect(describeMissingRefs(refs('code', 'conversation', 'document')))
      .toBe('1 code, 1 conversation and 1 document referenced here no longer exist.')
  })

  it('never says "columns or domains" when neither is missing', () => {
    const msg = describeMissingRefs(refs('observation'))
    expect(msg).not.toContain('column')
    expect(msg).not.toContain('domain')
  })

  it('still handles the original quantitative kinds', () => {
    expect(describeMissingRefs(refs('column', 'domain')))
      .toBe('1 column and 1 domain referenced here no longer exist.')
  })

  it('degrades to the raw token for a kind a newer server invented', () => {
    // Rendering "undefined" would be worse than an unpolished noun.
    expect(describeMissingRefs([{ type: 'interview' as MaterialRefKind }]))
      .toBe('1 interview referenced here no longer exists.')
  })

  it('returns nothing when nothing is missing', () => {
    expect(describeMissingRefs([])).toBe('')
  })
})

describe('describeStaleInputs', () => {
  it('names the one variable rather than counting it', () => {
    // "A variable needs recomputing" sends a researcher hunting through forty
    // of them. The name is the whole of what they need in order to act.
    expect(describeStaleInputs([{ column_name: 'Score Gain' }]))
      .toBe('Score Gain has changed since it was last computed.')
  })

  it('prefers the short name, falls back to the label', () => {
    expect(describeStaleInputs([{ column_name: null, column_text: 'Change in score' }]))
      .toBe('Change in score has changed since it was last computed.')
  })

  it('never renders an empty name', () => {
    // `column_name` is nullable and `column_text` is only NOT NULL server-side;
    // a blank string would print " has changed since…" with nothing in front.
    expect(describeStaleInputs([{ column_name: '  ', column_text: '' }]))
      .toBe('An unnamed variable has changed since it was last computed.')
  })

  it('names two, and caps the list past that', () => {
    // A chart can read a whole variable group; without the cap one embed could
    // print a paragraph of names above a chart.
    expect(describeStaleInputs([{ column_name: 'A' }, { column_name: 'B' }]))
      .toBe('A and B have changed since they were last computed.')
    expect(describeStaleInputs([{ column_name: 'A' }, { column_name: 'B' }, { column_name: 'C' }]))
      .toBe('A, B and 1 other have changed since they were last computed.')
    expect(describeStaleInputs([
      { column_name: 'A' }, { column_name: 'B' }, { column_name: 'C' }, { column_name: 'D' },
    ])).toBe('A, B and 2 others have changed since they were last computed.')
  })

  it('says nothing when nothing is stale', () => {
    expect(describeStaleInputs([])).toBe('')
  })

  it('🔴 never claims the FIGURES are stale', () => {
    // The dead prop's wording was "Data stale", which for this surface is false:
    // a canvas chart re-fetches on every render, so its figures are never old.
    // What is out of date is an upstream computed variable. #808 is the signal
    // that would justify the other wording, and it does not exist yet.
    const said = describeStaleInputs([{ column_name: 'Score Gain' }])
    expect(said).not.toMatch(/data (is )?stale/i)
    expect(said).toMatch(/last computed/)
  })
})
