/**
 * #827 — which grouping variables a comparison can actually use.
 *
 * 🔴 **These cases encode a measurement that contradicts the filed entry.** It
 * says cross-dataset row correspondence runs through participant links and
 * concludes the gate is *"are these two datasets linked?"*; executed against the
 * service (`tests/test_comparison_unavailable_reason.py`), a fully-linked pair
 * still produces no groups, because the comparison reads the grouping column on
 * the ANALYSED row ids and never consults `participant_id`.
 *
 * The two boundary cases below are what make the predicate what it is: a
 * cross-dataset variable GROUP is groupable by a column in either of its
 * datasets (so "same dataset as the variable" is too narrow), and a column in a
 * dataset the analysis does not touch is not (so "different dataset is fine if
 * linked" is too wide).
 */
import { describe, it, expect } from 'vitest'
import { analysedDatasetIds, groupingScopeBlock } from './grouping-scope'

// Dataset 1 holds Score + Site; dataset 2 holds Band. A variable group spans
// both (q1a in 1, q1b in 2) — the shape the crosswalk builds.
const COLUMNS = [
  { id: 11, dataset_id: 1, domain_ids: [] },
  { id: 12, dataset_id: 1, domain_ids: [] },
  { id: 21, dataset_id: 2, domain_ids: [] },
  { id: 31, dataset_id: 1, domain_ids: [90] },
  { id: 32, dataset_id: 2, domain_ids: [90] },
]

describe('analysedDatasetIds', () => {
  it('is the dataset of a selected column', () => {
    expect([...analysedDatasetIds({ columnIds: [11], domainIds: [] }, COLUMNS)]).toEqual([1])
  })

  it('spans EVERY dataset a selected variable group reaches', () => {
    // The case a "same dataset as the variable" gate would break: the group's
    // row scores are written in both datasets, so both are groupable.
    expect([...analysedDatasetIds({ columnIds: [], domainIds: [90] }, COLUMNS)].sort())
      .toEqual([1, 2])
  })

  it('unions columns and groups', () => {
    expect([...analysedDatasetIds({ columnIds: [21], domainIds: [] }, COLUMNS)]).toEqual([2])
  })

  it('is empty when nothing is selected', () => {
    expect(analysedDatasetIds({ columnIds: [], domainIds: [] }, COLUMNS).size).toBe(0)
  })
})

describe('groupingScopeBlock', () => {
  it('blocks a grouping column whose dataset the analysis does not touch', () => {
    const analysed = analysedDatasetIds({ columnIds: [11], domainIds: [] }, COLUMNS)
    expect(groupingScopeBlock(2, analysed)).toBe('other_dataset')
  })

  it('allows one in the same dataset', () => {
    const analysed = analysedDatasetIds({ columnIds: [11], domainIds: [] }, COLUMNS)
    expect(groupingScopeBlock(1, analysed)).toBeNull()
  })

  it('allows EITHER dataset of a cross-dataset variable group', () => {
    const analysed = analysedDatasetIds({ columnIds: [], domainIds: [90] }, COLUMNS)
    expect(groupingScopeBlock(1, analysed)).toBeNull()
    expect(groupingScopeBlock(2, analysed)).toBeNull()
  })

  it('blocks nothing before a variable is chosen', () => {
    // Gating an empty selection would disable the whole list on arrival, which
    // teaches the researcher the feature does not work at all.
    const analysed = analysedDatasetIds({ columnIds: [], domainIds: [] }, COLUMNS)
    expect(groupingScopeBlock(2, analysed)).toBeNull()
  })
})
