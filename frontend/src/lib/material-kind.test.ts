import { describe, it, expect } from 'vitest'
import { isQualitativeMaterialConfig, materialAnalysisPath } from './material-kind'

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
