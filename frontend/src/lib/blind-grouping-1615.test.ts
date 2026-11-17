/**
 * #1615 — while blind, a variable worked out from participant scores forms no groups, and the
 * client says so (the server refuses; `backend/tests/test_blind_grouping_1615.py`).
 *
 * Half behaviour (the CSV builder, the words), half a SOURCE scan, stated as such: no unit test
 * mounts the Qualitative page with blind mode on and a rating-derived subtype, so the scan pins
 * that each grouping request carries the blind flag ONLY while withholding and that the flag
 * rides the query key (a blind and an unblind reader with the same coder list ask different
 * questions — `multicoder.md` *Blind-scope cache correctness*).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sourceDataCsvParams } from '@/lib/qual-comparison'
import { RATING_WITHHELD_TEXT, SERVER_VOCABULARY, attributionWithheldText } from '@/lib/joint-display-vocabulary'

const SEL = { conversations: new Set([1]), textColumns: new Set<number>(), documents: new Set<number>(), observations: new Set<number>() }
const src = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('#1615 — the blind flag on the Source Data CSV', () => {
  it('is sent only while withholding', () => {
    const blind = sourceDataCsvParams([5], SEL, { excludeFacilitator: true, participantIds: [], coderIdsCsv: '2', ratingsFollowCoderIds: true })
    expect(blind.ratings_follow_coder_ids).toBe('true')
    expect(blind.coder_ids).toBe('2')
    // A lead's coder filter is not blind: the same list without the flag.
    const filtered = sourceDataCsvParams([5], SEL, { excludeFacilitator: true, participantIds: [], coderIdsCsv: '2' })
    expect(filtered.ratings_follow_coder_ids).toBeUndefined()
  })
})

describe('#1615 — the words', () => {
  it('a withheld survey strand names its reason, the server key mirrored', () => {
    expect(SERVER_VOCABULARY.VARIABLE_RATING_WITHHELD).toBe('rating_withheld_blind')
    expect(RATING_WITHHELD_TEXT).toMatch(/^Left out while blind: it comes from participant scores, which combine every coder's ratings/)
    expect(attributionWithheldText('Score band')).toBe(
      "Score band is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings.")
  })
})

describe('#1615 — the wiring (a source scan)', () => {
  const page = src('pages/QualitativeAnalysisView.tsx')
  const view = src('components/canvas/extensions/JointDisplayView.tsx')
  const report = src('lib/joint-display-report.ts')

  it('the comparison and the source frequencies send the flag only while withholding, and key on it', () => {
    expect(page.match(/\.\.\.\(withholding \? \{ ratings_follow_coder_ids: true \} : \{\}\)/g)).toHaveLength(2)
    expect(page.match(/^\s+withholding,\s+\/\/ #1615/gm)).toHaveLength(2)
    expect(page).toContain("if (withholding) params.ratings_follow_coder_ids = 'true'")
    expect(page).toContain('ratingsFollowCoderIds: withholding')
    // The Relationships panel's own copy of the Comparison CSV export (the lead's R9) is handed
    // the page's `withholding`; its behaviour is pinned in `RelationshipsPanel.comparison-csv-1323`.
    expect(page).toContain('ratingsFollowCoderIds={withholding}')
  })

  it('the filters ask with the viewer only while withholding, wait for blind mode, and key on the scope', () => {
    expect(page).toContain("queryKey: ['demographic-filters', pid, withholding ? (effectiveCoderIncludeCsv ?? '') : 'every-coder']")
    expect(page).toContain('codeAnalysisApi.demographicFilters(pid, withholding ? effectiveCoderIncludeCsv : undefined)')
    expect(page).toMatch(/demographicFilters\(pid, withholding[^\n]*\n\s+enabled: !!pid && blindSettled,/)
  })

  it("a pin's facts carry the display's blind scope in the request and the key, and wait for it", () => {
    expect(view).toContain("display.attribution.column_id, scope.coderIds?.join(',') ?? 'every-coder']")
    expect(view).toContain('coder_ids: scope.coderIds,')
    expect(view).toContain('enabled: pinIds.length > 0 && scopeReady,')
  })

  it('a withheld strand is told apart from a not-summarisable one on screen and in the report', () => {
    expect(view).toContain('strand.unavailable_reason === V.VARIABLE_RATING_WITHHELD ? RATING_WITHHELD_TEXT : NOT_SUMMARISABLE_TEXT')
    expect(report.indexOf('V.VARIABLE_RATING_WITHHELD')).toBeGreaterThan(-1)
    expect(report.indexOf('V.VARIABLE_RATING_WITHHELD')).toBeLessThan(report.indexOf('V.VARIABLE_NOT_SUMMARISABLE) {'))
  })
})
