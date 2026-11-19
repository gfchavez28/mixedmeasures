/**
 * #1691 (D377) — the *Variables N* badge counts every variable on both views — and
 * #1701 (D381) — the By Text table's notice, counted when the loaded contexts agree.
 *
 * The backend half of D377's premise (shown + withheld = the columns list) is
 * `backend/tests/test_variables_tab_count_1691.py`; this pins the client's arithmetic and that
 * the Data view's tab asks it (the page cannot be rendered here — `list-load-state-wiring`'s
 * reason — so its tag is read, comment-stripped).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'
import {
  variablesInDataset, withheldRatingColumnsNotice, withheldRatingColumnsNoticeAcross,
} from '@/lib/blind-rating-columns'

describe('variablesInDataset (#1691, D377)', () => {
  it('adds the withheld rating columns back to the shown ones', () => {
    expect(variablesInDataset(3, 4)).toBe(7)
  })
  it('an absent count (an older server) and a real 0 add nothing', () => {
    expect(variablesInDataset(3, undefined)).toBe(3)
    expect(variablesInDataset(3, 0)).toBe(3)
  })
})

describe("the Data view's tab counts every variable (#1691, D377)", () => {
  const src = stripComments(readFileSync(join(SRC_DIR, 'pages/DatasetView.tsx'), 'utf8'), 'DatasetView.tsx')
  const at = src.indexOf('<DatasetTabs')
  const tag = src.slice(at, src.indexOf('/>', at))

  it('finds the tag (self-check: the scan is not blind)', () => {
    expect(at).toBeGreaterThan(-1)
    expect(tag).toContain('variableCount={columnsKnown ?')
  })
  it('passes the shown columns PLUS the withheld count, never the shown columns alone', () => {
    expect(tag).toContain('variablesInDataset(columns.length, data?.withheld_rating_columns)')
  })
  it('the predicate is falsifiable', () => {
    expect('<DatasetTabs variableCount={columnsKnown ? columns.length : undefined} />')
      .not.toContain('variablesInDataset(')
  })
})

describe('withheldRatingColumnsNoticeAcross (#1701, D381)', () => {
  it('nothing loaded, or nothing withheld, says nothing', () => {
    expect(withheldRatingColumnsNoticeAcross([])).toBeNull()
    expect(withheldRatingColumnsNoticeAcross([0, 0])).toBeNull()
  })
  it('contexts that agree are counted, in the Data view\'s words', () => {
    expect(withheldRatingColumnsNoticeAcross([2, 2, 2])).toBe(withheldRatingColumnsNotice(2))
  })
  it('contexts that disagree — texts from two datasets — are said without a number', () => {
    const said = withheldRatingColumnsNoticeAcross([2, 0, 2])
    expect(said).toBe("Rating columns are hidden while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
    expect(withheldRatingColumnsNoticeAcross([2, 3])).toBe(said)
  })
})
