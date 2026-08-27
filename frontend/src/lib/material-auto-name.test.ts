import { describe, it, expect } from 'vitest'
import { generateMaterialAutoName } from './material-auto-name'

describe('generateMaterialAutoName (#419)', () => {
  it('descriptives: keeps the metric-type label and joins up to 3 variables', () => {
    expect(
      generateMaterialAutoName({
        activeTab: 'descriptives',
        metricType: 'frequency_distribution',
        metricLabels: ['Training_Hours', 'Fidelity_Score'],
      }),
    ).toBe('Freq Dist · Training_Hours, Fidelity_Score')
  })

  it('descriptives: stores full labels without per-label truncation', () => {
    const long = 'How satisfied are you with the overall program implementation this year'
    const name = generateMaterialAutoName({
      activeTab: 'descriptives',
      metricType: 'mean',
      metricLabels: [long],
    })
    expect(name).toBe(`Mean · ${long}`)
    expect(name).not.toContain('...')
  })

  it('descriptives: collapses >3 variables into a +N suffix', () => {
    expect(
      generateMaterialAutoName({
        activeTab: 'descriptives',
        metricType: 'mean',
        metricLabels: ['A', 'B', 'C', 'D', 'E'],
      }),
    ).toBe('Mean · A, B, C, +2')
  })

  it('comparisons: names from the comparison surface, ignoring the stale descriptives metricType', () => {
    const name = generateMaterialAutoName({
      activeTab: 'rc',
      metricType: 'frequency_distribution', // stale descriptives state — must not leak
      metricLabels: ['Post_Score'],
      rcView: 'comparisons',
      rcChartType: 'comparison_table',
      compareByLabel: 'School',
    })
    expect(name).toBe('Comparison · Post_Score by School')
    expect(name).not.toContain('Freq Dist')
  })

  it('comparisons: includes the second grouping and falls back for unknown chart types', () => {
    expect(
      generateMaterialAutoName({
        activeTab: 'rc',
        metricType: 'mean',
        metricLabels: ['Post_Score'],
        rcView: 'comparisons',
        rcChartType: 'some_future_type',
        compareByLabel: 'School',
        compareBy2Label: 'Grade',
      }),
    ).toBe('Comparison · Post_Score by School × Grade')
  })

  it('comparisons: omits the "by" clause when no grouping label resolves', () => {
    expect(
      generateMaterialAutoName({
        activeTab: 'rc',
        metricType: 'mean',
        metricLabels: ['Post_Score'],
        rcView: 'comparisons',
        rcChartType: 'comparison_table',
        compareByLabel: null,
      }),
    ).toBe('Comparison · Post_Score')
  })

  it('correlations: distinguishes the scatter-matrix view', () => {
    const base = {
      activeTab: 'rc',
      metricType: 'mean',
      metricLabels: ['Pre', 'Post'],
      rcView: 'correlations' as const,
    }
    expect(generateMaterialAutoName({ ...base, showScatter: false })).toBe('Correlations · Pre, Post')
    expect(generateMaterialAutoName({ ...base, showScatter: true })).toBe('Scatter Matrix · Pre, Post')
  })

  it('caps at the 500-char server limit only in pathological cases', () => {
    const name = generateMaterialAutoName({
      activeTab: 'descriptives',
      metricType: 'mean',
      metricLabels: ['x'.repeat(600)],
    })
    expect(name.length).toBe(500)
    expect(name.endsWith('…')).toBe(true)
  })
})

describe('#823(m) — a cross-tab is named for what it draws', () => {
  const base = {
    activeTab: 'descriptives',
    metricType: 'frequency_distribution',
    metricLabels: ['GSS: trust'],
  }

  it('names both axes', () => {
    // Filed case: the material was saved as "Freq Dist · GSS: trust", which
    // describes half the figure — the second axis IS the cross-tab.
    expect(generateMaterialAutoName({
      ...base, descriptiveChartType: 'cross_tab', crossTabColumnLabel: 'degree',
    })).toBe('Cross-tab · GSS: trust × degree')
  })

  it('does not promise an axis that has not been chosen', () => {
    // The chart type can be `cross_tab` before a column is picked.
    expect(generateMaterialAutoName({
      ...base, descriptiveChartType: 'cross_tab', crossTabColumnLabel: null,
    })).toBe('Cross-tab · GSS: trust')
  })

  it('leaves every other descriptives chart alone', () => {
    for (const t of ['horizontal_bar', 'table', 'heatmap', 'line', null, undefined]) {
      expect(generateMaterialAutoName({ ...base, descriptiveChartType: t }))
        .toBe('Freq Dist · GSS: trust')
    }
  })

  it('does not hijack an R&C save that happens to carry a chart type', () => {
    // The rc branch runs first and must keep doing so — a stale descriptives
    // chart type in state is exactly what #419 was about.
    expect(generateMaterialAutoName({
      ...base,
      activeTab: 'rc',
      rcView: 'comparisons',
      rcChartType: 'comparison_table',
      descriptiveChartType: 'cross_tab',
      crossTabColumnLabel: 'degree',
      compareByLabel: 'degree',
    })).toBe('Comparison · GSS: trust by degree')
  })
})
