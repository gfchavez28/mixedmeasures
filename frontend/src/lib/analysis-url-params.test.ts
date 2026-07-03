import { describe, it, expect } from 'vitest'
import { computeInvalidAnalysisParams } from './analysis-url-params'

const base = {
  decompose: false,
  canDecompose: false,
  divergingMode: false,
  chartType: null,
  axisTransform: 'linear',
  metricType: 'frequency_distribution',
  crossTabColumnId: null,
} as const

// #505 regression: during hydration (quick-compute metrics not yet loaded)
// chartType is null — chart-dependent params must SURVIVE, or deep-links,
// reloads, and saved-material restores render a different chart than saved.
describe('computeInvalidAnalysisParams (#505)', () => {
  it('preserves diverging while metrics hydrate (chartType null)', () => {
    expect(computeInvalidAnalysisParams({
      ...base, divergingMode: true, chartType: null,
    })).toEqual([])
  })

  it('preserves crossTabCol while metrics hydrate (chartType null)', () => {
    expect(computeInvalidAnalysisParams({
      ...base, crossTabColumnId: 11, chartType: null,
    })).toEqual([])
  })

  it('preserves axisTransform while metrics hydrate (chartType null)', () => {
    expect(computeInvalidAnalysisParams({
      ...base, axisTransform: 'log', chartType: null,
    })).toEqual([])
  })

  it('keeps diverging on a hydrated stacked_bar, clears it on other chart types', () => {
    expect(computeInvalidAnalysisParams({
      ...base, divergingMode: true, chartType: 'stacked_bar',
    })).toEqual([])
    expect(computeInvalidAnalysisParams({
      ...base, divergingMode: true, chartType: 'horizontal_bar',
    })).toEqual(['diverging', 'divergingCenter'])
  })

  it('keeps crossTabCol on a hydrated cross_tab, clears it on other chart types', () => {
    expect(computeInvalidAnalysisParams({
      ...base, crossTabColumnId: 11, chartType: 'cross_tab',
    })).toEqual([])
    expect(computeInvalidAnalysisParams({
      ...base, crossTabColumnId: 11, chartType: 'stacked_bar',
    })).toEqual(['crossTabCol', 'crossTabDisplay'])
  })

  it('clears log axisTransform only for known-incompatible chart/metric combos', () => {
    expect(computeInvalidAnalysisParams({
      ...base, axisTransform: 'log', chartType: 'horizontal_bar', metricType: 'mean',
    })).toEqual([])
    expect(computeInvalidAnalysisParams({
      ...base, axisTransform: 'log', chartType: 'horizontal_bar', metricType: 'frequency_distribution',
    })).toEqual(['axisTransform'])
    expect(computeInvalidAnalysisParams({
      ...base, axisTransform: 'log', chartType: 'heatmap', metricType: 'mean',
    })).toEqual(['axisTransform'])
  })

  it('clears decompose regardless of hydration (canDecompose is URL-synchronous)', () => {
    expect(computeInvalidAnalysisParams({
      ...base, decompose: true, canDecompose: false, chartType: null,
    })).toEqual(['decompose'])
    expect(computeInvalidAnalysisParams({
      ...base, decompose: true, canDecompose: true, chartType: null,
    })).toEqual([])
  })
})
