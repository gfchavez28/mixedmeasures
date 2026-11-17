/**
 * #1615 — the coder scope a quantitative read sends while blind, and what the variable list's
 * marks hide and say.
 *
 * The rule's three arms (every coder · the viewer alone · NO read, D96), the picker's view of
 * a marked list, and the sentences. Positive controls: an unmarked column, grouping variable
 * and group are untouched; a list with no marks is returned as it came.
 */
import { describe, it, expect } from 'vitest'
import { analysisScope, isWithheld, visibleAnalysisColumns, withheldSelection, WITHHELD_OPTION_NOTE } from '@/lib/analysis-scope'
import { withheldRatingColumnsNotice, withheldSelectionNotice } from '@/lib/blind-rating-columns'
import { describeUnavailable } from '@/lib/comparison-unavailable'
import type { AnalysisColumnsResponse } from '@/lib/api'

const col = (id: number, dataset_id: number, withheld = false) => ({
  id, dataset_id, dataset_name: dataset_id === 1 ? 'Participants' : 'Survey', column_code: null,
  column_name: `c${id}`, column_text: `c${id}`, column_type: 'numeric', scale_labels: null,
  equivalence_group_id: null, domain_ids: [], ...(withheld ? { withheld_while_blind: true } : {}),
})

const LIST: AnalysisColumnsResponse = {
  datasets: [
    { id: 1, name: 'Participants', columns: [col(10, 1, true), col(11, 1, true), col(12, 1)] },
    { id: 2, name: 'Survey', columns: [col(20, 2)] },
  ],
  domains: [
    { id: 5, name: 'With a score', member_count: 2, datasets: ['Participants'], withheld_while_blind: true },
    { id: 6, name: 'Wellbeing', member_count: 3, datasets: ['Survey'] },
  ],
  demographics: [
    { id: 13, column_name: 'Band', column_text: 'Band', dataset_id: 1, dataset_name: 'Participants', subtype: null, withheld_while_blind: true },
    { id: 21, column_name: 'School', column_text: 'School', dataset_id: 2, dataset_name: 'Survey', subtype: null },
  ],
}

describe('the scope a quantitative read sends (#1615)', () => {
  it('every coder when not withholding — absent from the body, keyed apart', () => {
    expect(analysisScope(false, 7)).toEqual({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder' })
    expect(analysisScope(false, null)).toEqual({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder' })
  })
  it('the viewer alone while withholding, in both spellings and in the key', () => {
    expect(analysisScope(true, 7)).toEqual({ coderIds: [7], coderScope: '7', scopeKey: '7' })
  })
  it('NO scope while withholding with no viewer id (D96) — never an empty list, which means every coder', () => {
    expect(analysisScope(true, null)).toBeNull()
  })
})

describe('what a picker shows from a marked list', () => {
  it('drops the marked columns, grouping variables and groups, and counts the columns per dataset', () => {
    const { data, withheldByDataset } = visibleAnalysisColumns(LIST)
    expect(data.datasets.map(ds => ds.columns.map(c => c.id))).toEqual([[12], [20]])
    expect(data.demographics.map(d => d.id)).toEqual([21])
    expect(data.domains.map(d => d.id)).toEqual([6])
    expect([...withheldByDataset]).toEqual([[1, 2]])
  })
  it('positive control: an unmarked list comes back unchanged, with nothing counted', () => {
    const plain: AnalysisColumnsResponse = { ...LIST, datasets: [LIST.datasets[1]], domains: [LIST.domains[1]], demographics: [LIST.demographics[1]] }
    const { data, withheldByDataset } = visibleAnalysisColumns(plain)
    expect(data).toEqual(plain)
    expect(withheldByDataset.size).toBe(0)
  })
  it('a mark is the literal true, nothing looser', () => {
    expect(isWithheld({ withheld_while_blind: true })).toBe(true)
    expect(isWithheld({ withheld_while_blind: false })).toBe(false)
    expect(isWithheld({})).toBe(false)
    expect(isWithheld(undefined)).toBe(false)
  })
})

describe('a selection that names a hidden score', () => {
  it('counts marked variables, grouping variables and groups once each; unknown ids are not counted', () => {
    expect(withheldSelection(LIST, [10, 12, 99], [5, 6], [13, null, 10])).toBe(3)   // 10 (once), 13, group 5
    expect(withheldSelection(LIST, [12, 20], [6], [21])).toBe(0)                     // control
    expect(withheldSelection(undefined, [10], [5], [13])).toBe(0)                    // the list not loaded
  })
})

describe('the words', () => {
  it('the picker reuses the Data view’s sentence (#1608)', () => {
    expect(withheldRatingColumnsNotice(2)).toBe(
      "2 rating columns are hidden while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
  })
  it('the page says it once for a selection, singular and plural, and nothing for none', () => {
    expect(withheldSelectionNotice(0)).toBeNull()
    expect(withheldSelectionNotice(1)).toBe(
      "1 selected variable is a rating score, left out while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
    expect(withheldSelectionNotice(3)).toMatch(/^3 selected variables are rating scores, left out while blind\. /)
  })
  it('a grouping option keeps its name and says why it cannot be chosen', () => {
    expect(WITHHELD_OPTION_NOTE).toBe('a rating score, hidden while blind')
  })
  it('a comparison the server refuses for a hidden score says so (the new reason)', () => {
    expect(describeUnavailable('rating_withheld_blind')).toEqual({
      title: 'This comparison uses a rating score, which is hidden while blind.',
      detail: 'A participant score combines every coder’s ratings, so it would show your colleagues’ judgements.',
    })
  })
})
