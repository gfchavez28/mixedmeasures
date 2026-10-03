/**
 * #1038 (a) — every "% agreement" figure is formatted by ONE function.
 *
 * The code-set agreement table printed `fmt(percent_agreement)` — "0.85" under a
 * "% agreement" heading — while the per-code table beside it and the row's own
 * accessible name printed "85%". Three agreement tables each carried a private
 * formatter; one was wrong, and nothing but a reader could tell.
 *
 * The scan finds every READ of a `percent_agreement` field in a component and
 * requires it to be the argument of `formatPercent(`. A POPULATION floor proves
 * the walk still sees the tables it exists for, and a PREDICATE falsifier proves
 * the matcher can fail.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR, SOURCE_SCAN_TIMEOUT_MS, sourceFiles } from '@/test-support/source-tree'
import { formatPercent } from '@/lib/stat-format'

/** Each `<expr>.percent_agreement` read, with the 16 characters before it. */
function reads(src: string): { before: string; text: string }[] {
  const out: { before: string; text: string }[] = []
  for (const m of src.matchAll(/[\w?.[\]]*\.percent_agreement\b/g)) {
    out.push({ before: src.slice(Math.max(0, m.index! - 16), m.index!), text: m[0] })
  }
  return out
}

const formatted = (r: { before: string }) => /formatPercent\($/.test(r.before)

describe('every % agreement read is formatted as a percentage (#1038 a)', () => {
  const found: { file: string; text: string; ok: boolean }[] = []
  for (const abs of sourceFiles({ root: 'components', ext: 'tsx', floor: 50 })) {
    const src = stripComments(readFileSync(abs, 'utf8'))
    for (const r of reads(src)) found.push({ file: relative(SRC_DIR, abs), text: r.text, ok: formatted(r) })
  }

  it('finds the three agreement tables it exists for', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const files = new Set(found.map((f) => f.file))
    expect(found.length).toBeGreaterThanOrEqual(6)
    for (const table of ['IrrMatrix.tsx', 'MachineAgreementTable.tsx', 'OpenCutReliability.tsx']) {
      expect([...files].some((f) => f.endsWith(table)), table).toBe(true)
    }
  })

  it('each one goes through formatPercent', () => {
    expect(found.filter((f) => !f.ok)).toEqual([])
  })

  it('the predicate can fail — the #1038 (a) line itself is caught', () => {
    const [bad] = reads('<td>{fmt(s.percent_agreement)}</td>')
    expect(formatted(bad)).toBe(false)
    const [good] = reads('<td>{formatPercent(s.percent_agreement)}</td>')
    expect(formatted(good)).toBe(true)
  })
})

describe('formatPercent', () => {
  it('reads a proportion as a whole percentage, and 0 is 0%', () => {
    expect(formatPercent(0.85)).toBe('85%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('has no value for a missing or non-finite one', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(undefined)).toBe('—')
    expect(formatPercent(Number.NaN)).toBe('—')
  })
})
