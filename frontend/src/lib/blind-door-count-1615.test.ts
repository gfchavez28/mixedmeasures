/**
 * #1615 D295 — a door's own count of the rating variables it left out while blind is READ,
 * never re-derived. The Quantitative page's selection line counts the variable list's marks;
 * each multi-variable door (comparison, correlation, scatter, cross-tab, Data Quality) also
 * states its own `withheld_rating_variables`, which can be more (a metric's sibling grouping
 * column in another dataset, a variable group holding a score). The page says the door's number
 * when it is more than the selection line said.
 *
 * The page half is a SOURCE scan, stated as such: no unit test mounts the Quantitative page with
 * five live doors. ⚠️ A scan cannot see what a branch renders — the live drive covers it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withheldDoorNotice, withheldSelectionNotice } from '@/lib/blind-rating-columns'
import { stripComments } from '@/lib/strip-comments'

describe('#1615 D295 — the door’s own count', () => {
  it('says the door’s number, in the selection line’s words, only when it is MORE than that line said', () => {
    expect(withheldDoorNotice(2, 0)).toBe(withheldSelectionNotice(2))
    expect(withheldDoorNotice(3, 1)).toBe(
      "3 selected variables are rating scores, left out while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
    expect(withheldDoorNotice(1, 0)).toBe(
      "1 selected variable is a rating score, left out while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
  })

  it('says nothing when the door left out no more than the selection line already said', () => {
    expect(withheldDoorNotice(1, 1)).toBeNull()
    expect(withheldDoorNotice(1, 2)).toBeNull()
    expect(withheldDoorNotice(0, 0)).toBeNull()
    expect(withheldDoorNotice(undefined, 0)).toBeNull()
    expect(withheldDoorNotice(null, 0)).toBeNull()
  })

  it('the page reads every door’s own count and renders the line', () => {
    const page = stripComments(readFileSync(resolve(__dirname, '../pages/AnalysisView.tsx'), 'utf8'))
    for (const payload of ['comparisonData', 'corrMatrixData', 'scatterMatrixData', 'dqSummaryData', 'dqPatternsData', 'crossTabData']) {
      expect(page, payload).toMatch(new RegExp(`${payload}\\?\\.withheld_rating_variables \\?\\? 0`))
    }
    expect(page).toMatch(/const withheldDoorText = withheldDoorNotice\(doorWithheldCount, withheldSelectionCount\)/)
    expect(page).toMatch(/\{withheldDoorText && \(\s*<p [^>]*data-testid="withheld-door">\s*\{withheldDoorText\}/)
  })
})
