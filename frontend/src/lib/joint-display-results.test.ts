/**
 * D165's different-unit strand: a saved result's unit is DERIVED from its own settings, never
 * typed — and slice 1 places quantitative results only.
 */
import { describe, it, expect } from 'vitest'
import type { AnalysisColumnsResponse, MaterialResponse } from '@/lib/api'
import { boundResultIds, describeResult, isDisplayResult, resultUnit } from '@/lib/joint-display-results'

const col = (id: number, name: string, dataset_id: number, dataset_name: string) => ({
  id, dataset_id, dataset_name, column_code: null, column_name: name, column_text: name, column_type: 'numeric',
  scale_labels: null, equivalence_group_id: null, domain_ids: [],
})

const COLUMNS: AnalysisColumnsResponse = {
  datasets: [
    { id: 1, name: 'Student post-test', columns: [col(10, 'Score', 1, 'Student post-test'), col(11, 'School', 1, 'Student post-test'), col(12, 'Term', 1, 'Student post-test')] },
    { id: 2, name: 'Teacher survey', columns: [col(20, 'Confidence', 2, 'Teacher survey')] },
  ],
  domains: [{ id: 5, name: 'Wellbeing', member_count: 3, datasets: ['Wellbeing survey'] }],
  demographics: [],
}

function material(config: Record<string, unknown>, over: Partial<MaterialResponse> = {}): MaterialResponse {
  return {
    id: 90, collection_id: 1, material_type: 'chart', config, auto_name: 'Comparison · Score by School', custom_name: null,
    display_order: 0, source_tab: 'relationships', created_at: '', has_missing_refs: false, missing_refs: [], ...over,
  }
}

describe('a saved result’s unit, from its own settings', () => {
  it('a comparison: its dataset’s rows, by the variable it compares by (both, when two)', () => {
    expect(resultUnit({ rc_view: 'comparisons', column_ids: [10], compare_by: 11 }, COLUMNS)).toBe('rows of Student post-test, by School')
    expect(resultUnit({ rc_view: 'comparisons', column_ids: [10], compare_by: 11, compare_by_2: 12 }, COLUMNS)).toBe('rows of Student post-test, by School and Term')
  })

  it('a summary: by its grouping variable, or its rows alone', () => {
    expect(resultUnit({ column_ids: [10], metric_type: 'mean', grouping_column_id: 11 }, COLUMNS)).toBe('rows of Student post-test, by School')
    expect(resultUnit({ column_ids: [10, 20], metric_type: 'mean' }, COLUMNS)).toBe('rows of Student post-test and Teacher survey')
    expect(resultUnit({ domain_ids: [5], metric_type: 'domain_aggregate' }, COLUMNS)).toBe('rows of Wellbeing survey')
  })

  it('a cross-tabulation: its two axes', () => {
    expect(resultUnit({ chart_type: 'cross_tab', column_ids: [11], cross_tab_column_id: 12 }, COLUMNS)).toBe('rows of Student post-test, School by Term')
  })

  it('#1638: a DEMOGRAPHIC grouping (listed only under `demographics`) is named, never called missing', () => {
    const withSite: AnalysisColumnsResponse = {
      ...COLUMNS,
      demographics: [{ id: 13, column_name: 'Site', column_text: 'Site', dataset_id: 1, dataset_name: 'Student post-test', subtype: null }],
    }
    expect(resultUnit({ rc_view: 'comparisons', column_ids: [10], compare_by: 13 }, withSite)).toBe('rows of Student post-test, by Site')
    expect(resultUnit({ chart_type: 'cross_tab', column_ids: [13], cross_tab_column_id: 12 }, withSite)).toBe('rows of Student post-test, Site by Term')
  })

  it('a variable or dataset no longer in the project is said, never guessed', () => {
    expect(resultUnit({ column_ids: [99], grouping_column_id: 98 }, COLUMNS)).toBe('rows of a dataset no longer in this project, by a variable no longer in this project')
  })
})

describe('what can stand beside a construct (slice 1)', () => {
  it('a comparison, a cross-tab or a summary — not a correlation (refused on the Canvas, #831), not a qualitative result', () => {
    expect(isDisplayResult(material({ rc_view: 'comparisons', column_ids: [10], compare_by: 11 }))).toBe(true)
    expect(isDisplayResult(material({ chart_type: 'cross_tab', column_ids: [11], cross_tab_column_id: 12 }))).toBe(true)
    expect(isDisplayResult(material({ column_ids: [10], metric_type: 'mean' }))).toBe(true)
    expect(isDisplayResult(material({ rc_view: 'correlations', column_ids: [10, 12] }))).toBe(false)
    expect(isDisplayResult(material({ code_mode: 'codes', code_ids: [1] }))).toBe(false)
  })

  it('describes one by the researcher’s name first; an unplaceable one has no unit', () => {
    expect(describeResult(material({ rc_view: 'comparisons', column_ids: [10], compare_by: 11 }, { custom_name: '  Post-test by school ' }), COLUMNS))
      .toEqual({ materialId: 90, name: 'Post-test by school', kind: 'comparison', kindText: 'a saved comparison', unit: 'rows of Student post-test, by School' })
    expect(describeResult(material({ code_mode: 'codes', code_ids: [1] }), COLUMNS).unit).toBeNull()
  })

  it('a row’s bound ids once each, in order, keeping an unresolved import (D202)', () => {
    expect(boundResultIds([3, null, 3, 4, null])).toEqual([3, null, 4, null])
  })
})
