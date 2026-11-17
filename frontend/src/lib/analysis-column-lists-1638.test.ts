/**
 * #1638 — the analysis-columns payload lists a DEMOGRAPHIC column only under `demographics`
 * (and a NOMINAL column in both lists), as `routers/metrics.py::get_analysis_columns` builds it.
 * The union is asked in one place; the fixture is that payload's real shape.
 */
import { describe, it, expect } from 'vitest'
import type { AnalysisColumnsResponse } from '@/lib/api'
import { columnsWithDemographics, datasetsWithDemographics } from '@/lib/analysis-column-lists'

const col = (id: number, name: string, type: string, dataset_id: number, dataset_name: string) => ({
  id, dataset_id, dataset_name, column_code: null, column_name: name, column_text: name, column_type: type,
  scale_labels: null, equivalence_group_id: null, domain_ids: [],
})
const demo = (id: number, name: string, dataset_id: number, dataset_name: string, extra: object = {}) => ({
  id, column_name: name, column_text: name, dataset_id, dataset_name, subtype: null, ...extra,
})

// Roster: a nominal (in both lists) and two demographics (in `demographics` only, one marked);
// Contacts: a dataset whose only analysable columns are demographic, so absent from `datasets`.
const PAYLOAD: AnalysisColumnsResponse = {
  datasets: [
    { id: 1, name: 'Roster', columns: [col(11, 'Gain group', 'nominal', 1, 'Roster'), col(12, 'Hours', 'numeric', 1, 'Roster')] },
    { id: 2, name: 'Survey', columns: [col(21, 'Confidence', 'ordinal', 2, 'Survey')] },
  ],
  domains: [],
  demographics: [
    demo(11, 'Gain group', 1, 'Roster'),
    demo(13, 'Site', 1, 'Roster'),
    demo(14, 'Score band', 1, 'Roster', { withheld_while_blind: true }),
    demo(31, 'Region', 3, 'Contacts'),
  ],
}

describe('datasetsWithDemographics (#1638)', () => {
  it('adds each demographic column to its dataset as type "demographic", a nominal one once', () => {
    const out = datasetsWithDemographics(PAYLOAD)
    expect(out.map(ds => [ds.id, ds.name, ds.columns.map(c => [c.id, c.column_type])])).toEqual([
      [1, 'Roster', [[11, 'nominal'], [12, 'numeric'], [13, 'demographic'], [14, 'demographic']]],
      [2, 'Survey', [[21, 'ordinal']]],
      [3, 'Contacts', [[31, 'demographic']]],
    ])
  })

  it('carries the blind mark and the names a picker shows', () => {
    const band = columnsWithDemographics(PAYLOAD).get(14)
    expect(band).toMatchObject({ column_name: 'Score band', dataset_id: 1, dataset_name: 'Roster', withheld_while_blind: true })
    expect(columnsWithDemographics(PAYLOAD).get(13)?.withheld_while_blind).toBeUndefined()
  })

  it('never changes the payload it reads', () => {
    const before = JSON.stringify(PAYLOAD)
    datasetsWithDemographics(PAYLOAD)
    expect(JSON.stringify(PAYLOAD)).toBe(before)
  })

  it('no payload, or one without the member, reads as the datasets alone', () => {
    expect(datasetsWithDemographics(undefined)).toEqual([])
    const noMember = { datasets: PAYLOAD.datasets, domains: [] } as unknown as AnalysisColumnsResponse
    expect(datasetsWithDemographics(noMember).flatMap(ds => ds.columns.map(c => c.id))).toEqual([11, 12, 21])
  })
})
