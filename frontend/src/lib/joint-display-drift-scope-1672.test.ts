/**
 * #1672 D353–D354 (and #1675 D361): a drift stamp records the coder view it was read under, and
 * is compared ONLY within that view — the one reading (`rowDriftState`) the construct detail, the
 * Compact view and the Report view share. And #1674 D357's cleared stamp reads as cleared.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import {
  baselineScopeOf, computeRequest, displayCoderScope, pinPassagesRequest, readDisplay, rowCells, rowDriftState,
  rowMoved, type JointDisplayRowBaseline,
} from './joint-display'
import { caseCountRequest, caseRequest } from './joint-display-cases'
import { stampBaseline } from '@/components/canvas/joint-display/display-helpers'
import { stripComments } from './strip-comments'
import type { JointDisplayRowResult } from '@/lib/api'

function cell(group: string, count: number, n: number, mean: number | null) {
  return { group, count, n, share: count / n, share_undefined_reason: null, passages: count,
    rating: mean == null ? null : { mean, n: count, undefined_reason: null } }
}
function row(high: number, mean: number): JointDisplayRowResult {
  const s = { code_id: 31, name: 'Trust', unit: 'participants', rated: true, formed_groups: null,
    cells: [cell('High', high, 11, mean), cell('Low', 1, 10, 2)],
    difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: 'x' } }
  return { key: 'r1', codes: [s], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' } } as unknown as JointDisplayRowResult
}

const COLLEAGUE = 2
const ME = 1
const stamped = (scope: JointDisplayRowBaseline['scope'], r = row(6, 4.5)): JointDisplayRowBaseline =>
  ({ hash: 'h', cells: rowCells(r), stamped_at: '2026-11-15', scope, cleared: null })

describe('#1672 D354 — drift compared within one coder view', () => {
  it('the same view compares: a real move is a move, no move is silence', () => {
    expect(rowDriftState(stamped('all'), row(2, 3), 'all').kind).toBe('moved')
    expect(rowDriftState(stamped('all'), row(6, 4.5), 'all').kind).toBe('none')
    expect(rowDriftState(stamped(ME), row(2, 3), ME).kind).toBe('moved')
  })

  it('a blind viewer is never shown a colleague-scoped stamp — no figures, no mark', () => {
    const s = rowDriftState(stamped(COLLEAGUE), row(2, 3), ME)
    expect(s).toEqual({ kind: 'other_scope', stampedAt: '2026-11-15' })
    expect(JSON.stringify(s)).not.toMatch(/6 of 11|4\.5/)
    expect(rowMoved(stamped(COLLEAGUE), row(2, 3), ME)).toBe(false)
  })

  it('…nor an every-coder stamp; and an every-coder viewer is never told a blind stamp moved', () => {
    expect(rowDriftState(stamped('all'), row(2, 3), ME).kind).toBe('other_scope')
    expect(rowDriftState(stamped(ME), row(2, 3), 'all').kind).toBe('other_scope')
    expect(rowMoved(stamped(ME), row(2, 3), 'all')).toBe(false)
  })

  it('an unrecorded scope (a stamp from before D353), or no viewer scope, compares nothing', () => {
    expect(rowDriftState(stamped(null), row(2, 3), 'all').kind).toBe('other_scope')
    expect(rowDriftState(stamped('all'), row(2, 3), null).kind).toBe('other_scope')
  })

  it('#1674 D357 — a cleared stamp is cleared, whatever the views', () => {
    const cleared: JointDisplayRowBaseline = { hash: '', cells: {}, stamped_at: '2026-11-15', scope: 'all', cleared: 'withdrawal' }
    expect(rowDriftState(cleared, row(2, 3), 'all')).toEqual({ kind: 'cleared', stampedAt: '2026-11-15' })
    expect(rowMoved(cleared, row(2, 3), 'all')).toBe(false)
  })
})

describe('#1672 D353 — the stamp records the view, and the reader keeps it', () => {
  it('stampBaseline writes the scope it is given', () => {
    expect(stampBaseline(row(6, 4.5), ME).scope).toBe(ME)
    expect(stampBaseline(row(6, 4.5), 'all')).toMatchObject({ scope: 'all', cleared: null })
  })

  it('baselineScopeOf names displayCoderScope’s two cases, and none for no scope', () => {
    expect(baselineScopeOf(displayCoderScope(false, ME))).toBe('all')
    expect(baselineScopeOf(displayCoderScope(true, ME))).toBe(ME)
    expect(baselineScopeOf(displayCoderScope(true, null))).toBeNull()
  })

  it('readDisplay reads scope and cleared, and an unknown scope as null', () => {
    const read = (baseline: unknown) =>
      readDisplay({ group_by_column_id: 11, rows: [{ key: 'r1', construct: 'T', baseline }] }).rows[0].baseline
    expect(read({ hash: 'h', cells: { a: 'b' }, stamped_at: 'd', scope: 7 })).toMatchObject({ scope: 7, cleared: null })
    expect(read({ hash: 'h', cells: {}, stamped_at: 'd', scope: 'all' })!.scope).toBe('all')
    expect(read({ hash: 'h', cells: {}, stamped_at: 'd', scope: 'someone' })!.scope).toBeNull()
    expect(read({ hash: 'h', cells: {}, stamped_at: 'd' })!.scope).toBeNull()
    expect(read({ stamped_at: '2026-11-15', cleared: 'withdrawal', scope: 'all' }))
      .toEqual({ hash: '', cells: {}, stamped_at: '2026-11-15', scope: 'all', cleared: 'withdrawal' })
  })
})

describe('#1675 D361 — no viewer while withholding: no scope, and no request', () => {
  const display = readDisplay({ group_by_column_id: 11, rows: [{ key: 'r1', construct: 'T', code_ids: [31] }] })
  it('is null — never `coder_ids: []`, which the server reads as every coder', () => {
    expect(displayCoderScope(true, null)).toBeNull()
    expect(computeRequest(display, null)).toBeNull()
    expect(pinPassagesRequest(display, undefined, 'High', 31, null)).toBeNull()
    expect(caseRequest(display, 'r1', null, { only: 'all', offset: 0, limit: 10 })).toBeNull()
    expect(caseCountRequest(display, 'r1', null)).toBeNull()
  })
  it('CONTROL: with a viewer the request is built, scoped to them', () => {
    expect(computeRequest(display, displayCoderScope(true, ME))!.coder_ids).toEqual([ME])
    expect(computeRequest(display, displayCoderScope(false, ME))!.coder_ids).toBeNull()
  })
})

describe('#1672 — no screen compares a stamp itself', () => {
  it('only lib/joint-display.ts calls rowDrift( — every screen reads rowDriftState / rowMoved', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    // The one walker (#729): its floor and sentinel prove the scan saw the tree it polices.
    const files = sourceFiles({ ext: 'both', floor: 300, sentinels: ['lib/joint-display.ts'] })
    const callers = files.filter(f => /\browDrift\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(srcRel)
    expect(callers).toEqual(['lib/joint-display.ts'])
    // falsifier: the predicate fires on a call
    expect(/\browDrift\(/.test('const x = rowDrift(b, r)')).toBe(true)
  })
})
