/**
 * A bulk declaration's disclosure describes the OPERATION (#823a/#823b).
 *
 * Both defects here are the same shape one field apart: a per-COLUMN fact
 * presented as what the whole operation did. Measured on GSS, a declaration
 * applied to 41 variables announced "32276 cells no longer counted in analysis"
 * against a true 1,099,939 — 34x understated, on the largest silent data
 * mutation in the workflow.
 */
import { describe, it, expect } from 'vitest'
import { bulkMissingOutcome, describeMissingValueChanges, describeUnmatchedRules } from './missing-values-copy'

const col = (id: number, over: Partial<{
  nulled_rows: number; labelled_rows: number; stripped_scale_points: number
  recovered_rows: number; recovered_unmapped: string[]
}> = {}) => ({
  column_id: id,
  nulled_rows: 0,
  labelled_rows: 0,
  stripped_scale_points: 0,
  recovered_rows: 0,
  recovered_unmapped: [] as string[],
  ...over,
})

/** The GSS shape, shrunk: the authoring column is a small part of the whole. */
const BULK = {
  applied: [
    col(1, { nulled_rows: 32276, recovered_unmapped: ['x'] }),
    col(2, { nulled_rows: 500_000, labelled_rows: 12, recovered_unmapped: ['x', 'y'] }),
    col(3, { nulled_rows: 567_663, stripped_scale_points: 3, recovered_rows: 4 }),
  ],
  nulled_rows_total: 1_099_939,
  unmatched_everywhere: ['.n: No answer'],
}

describe('bulkMissingOutcome (#823b)', () => {
  it('reports the OPERATION total, not the authoring column', () => {
    const out = bulkMissingOutcome(BULK, 1, null)
    expect(out.nulled_rows).toBe(1_099_939)
    // The defect, stated as the value it must never be again.
    expect(out.nulled_rows).not.toBe(32276)
  })

  it("the server's total and the client's own sum describe one operation", () => {
    // The two halves come from different places on purpose (the server sends a
    // total only for `nulled_rows`), so this is the assertion that stops them
    // drifting into disagreeing about the same act.
    const clientSum = BULK.applied.reduce((n, r) => n + r.nulled_rows, 0)
    expect(clientSum).toBe(BULK.nulled_rows_total)
  })

  it('sums the counts the server sends no total for', () => {
    const out = bulkMissingOutcome(BULK, 1, null)
    expect(out.labelled_rows).toBe(12)
    expect(out.stripped_scale_points).toBe(3)
    expect(out.recovered_rows).toBe(4)
  })

  it('unions recovered-unmapped values across columns, deduped', () => {
    // These demand ACTION. Reporting only the authoring column's would leave
    // the other columns' silently unactioned — #823(b) one field over.
    expect(bulkMissingOutcome(BULK, 1, null).recovered_unmapped.sort()).toEqual(['x', 'y'])
  })

  it('carries the rules that matched nothing ANYWHERE', () => {
    expect(bulkMissingOutcome(BULK, 1, null).unmatched_rules).toEqual(['.n: No answer'])
  })

  it('produces a disclosure quoting the real figure', () => {
    const out = bulkMissingOutcome(BULK, 1, null)
    const line = describeMissingValueChanges(out)
    expect(line).toContain('1099939')
    expect(line).not.toContain('32276')
  })

  it('is safe on an all-skipped bulk', () => {
    const out = bulkMissingOutcome(
      { applied: [], nulled_rows_total: 0, unmatched_everywhere: [] }, 7, null,
    )
    expect(out.nulled_rows).toBe(0)
    expect(describeMissingValueChanges(out)).toBeNull()
  })
})

describe('describeUnmatchedRules (#823a)', () => {
  it('is silent when every rule matched something', () => {
    expect(describeUnmatchedRules([], 'column')).toBeNull()
  })

  it('names the rule and points at the picker, never at re-reading', () => {
    // 🔴 The message must NOT ask the researcher to compare two strings. The
    // defect is that ".i:  Inapplicable" and ".i: Inapplicable" are
    // indistinguishable once rendered — that is why the rule matched nothing in
    // the first place, and it is equally true of any message about it.
    const msg = describeUnmatchedRules(['.i: Inapplicable'], 'column')!
    expect(msg).toContain('".i: Inapplicable"')
    expect(msg).toContain('matched no values in this variable')
    expect(msg).toContain('spacing you cannot see')
    expect(msg).toMatch(/pick from the observed values/)
  })

  it('says "any of the variables" on a bulk apply', () => {
    const msg = describeUnmatchedRules(['.n: No answer'], 'all-columns')!
    expect(msg).toContain('matched no values in any of the variables')
  })

  it('caps the list the way the sibling helper does', () => {
    const many = Array.from({ length: 8 }, (_, i) => `r${i}`)
    const msg = describeUnmatchedRules(many, 'column')!
    expect(msg).toContain('+3 more')
    expect(msg).not.toContain('"r5"')
  })
})
