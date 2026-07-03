import { describe, it, expect } from 'vitest'
import type { MergeCodePreview, MergeCodeCandidate } from './api'
import {
  defaultCodeDecisions, combinedLabel, applyBulkCode, buildCodeMapping,
  codeDecisionSummary, buildMergePlan, MERGE_LINK_BAR, MERGE_COLLAPSE_BAR,
  type LocalCodeLite,
} from './merge-code-mapping'

function cand(over: Partial<MergeCodeCandidate> = {}): MergeCodeCandidate {
  return { code_id: 1, name: 'Empathy', description: null, usage: 3, similarity: 0.88, confident: true, ...over }
}
function preview(over: Partial<MergeCodePreview> = {}): MergeCodePreview {
  return {
    uuid: 'u-1', name: 'Empathic', description: 'def', color: '#7c3aed',
    category_name: null, file_app_count: 12, candidates: [cand()], ...over,
  }
}
function local(over: Partial<LocalCodeLite> = {}): LocalCodeLite {
  return { id: 1, name: 'Empathy', color: '#6d28d9', ...over }
}

describe('defaultCodeDecisions (D-2 conservative)', () => {
  it('defaults every divergent code to "new", even a confident match', () => {
    const p = preview({ uuid: 'u-9', candidates: [cand({ similarity: 1, confident: true })] })
    expect(defaultCodeDecisions([p])).toEqual({ 'u-9': { action: 'new' } })
  })
})

describe('combinedLabel', () => {
  it('puts the local name first, then the incoming name', () => {
    expect(combinedLabel('Empathy', 'Empathic')).toBe('Empathy / Empathic')
  })
  it('caps at 255 chars', () => {
    expect(combinedLabel('a'.repeat(200), 'b'.repeat(200)).length).toBe(255)
  })
})

describe('applyBulkCode (stricter bar for the destructive collapse)', () => {
  const exact = preview({ uuid: 'exact', name: 'Active listening', candidates: [cand({ code_id: 2, name: 'Active Listening', similarity: 1.0 })] })
  const close = preview({ uuid: 'close', name: 'Empathic', candidates: [cand({ code_id: 1, name: 'Empathy', similarity: 0.88 })] })
  const weak = preview({ uuid: 'weak', name: 'Power', candidates: [cand({ code_id: 3, name: 'Role', similarity: 0.2, confident: false })] })
  const previews = [exact, close, weak]
  const names = { 1: 'Empathy', 2: 'Active Listening', 3: 'Role' }

  it('"new" resets everything', () => {
    const start = { exact: { action: 'collapse' as const, target_code_id: 2 } }
    expect(applyBulkCode('new', previews, start, names)).toEqual({
      exact: { action: 'new' }, close: { action: 'new' }, weak: { action: 'new' },
    })
  })

  it('"collapse" hits only near-exact (≥0.95) matches; close/weak untouched', () => {
    const out = applyBulkCode('collapse', previews, {}, names)
    expect(out.exact).toEqual({ action: 'collapse', target_code_id: 2 })
    expect(out.close).toBeUndefined() // 0.88 is below the 0.95 collapse bar
    expect(out.weak).toBeUndefined()
  })

  it('"link" hits close (≥0.70) matches and carries a combined label', () => {
    const out = applyBulkCode('link', previews, {}, names)
    expect(out.exact).toEqual({ action: 'link', target_code_id: 2, combined_label: 'Active Listening / Active listening' })
    expect(out.close).toEqual({ action: 'link', target_code_id: 1, combined_label: 'Empathy / Empathic' })
    expect(out.weak).toBeUndefined() // 0.2 below the 0.70 link bar
  })

  it('bars are link 0.70 < collapse 0.95', () => {
    expect(MERGE_LINK_BAR).toBeLessThan(MERGE_COLLAPSE_BAR)
  })
})

describe('buildCodeMapping (wire payload, keyed by uuid)', () => {
  it('emits each action shape; sends combined_label only when set', () => {
    const ps = [preview({ uuid: 'a' }), preview({ uuid: 'b' }), preview({ uuid: 'c' }), preview({ uuid: 'd' })]
    const out = buildCodeMapping(ps, {
      a: { action: 'new' },
      b: { action: 'collapse', target_code_id: 5 },
      c: { action: 'link', target_code_id: 6, combined_label: 'X / Y' },
      d: { action: 'link', target_code_id: 7 },
    })
    expect(out).toEqual({
      a: { action: 'new' },
      b: { action: 'collapse', target_code_id: 5 },
      c: { action: 'link', target_code_id: 6, combined_label: 'X / Y' },
      d: { action: 'link', target_code_id: 7 },
    })
  })

  it('skips codes with no decision', () => {
    expect(buildCodeMapping([preview({ uuid: 'z' })], {})).toEqual({})
  })
})

describe('codeDecisionSummary', () => {
  it('tallies the three actions', () => {
    expect(codeDecisionSummary({
      a: { action: 'new' }, b: { action: 'new' },
      c: { action: 'collapse', target_code_id: 1 },
      d: { action: 'link', target_code_id: 2 },
    })).toEqual({ newCount: 2, collapsed: 1, linked: 1 })
  })
})

describe('buildMergePlan (provenance rows)', () => {
  const locals = [local({ id: 1, name: 'Empathy' }), local({ id: 2, name: 'Active Listening' }), local({ id: 3, name: 'Guilt' })]

  it('unchanged local code → unchanged row, no incoming', () => {
    const rows = buildMergePlan(locals, [], {})
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'unchanged', finalName: 'Empathy', incoming: null })
  })

  it('collapse → the target row absorbs the incoming code (struck/removed)', () => {
    const p = preview({ uuid: 'p', name: 'Active listening' })
    const rows = buildMergePlan(locals, [p], { p: { action: 'collapse', target_code_id: 2 } })
    const row = rows.find(r => r.finalName === 'Active Listening')!
    expect(row.kind).toBe('collapse-target')
    expect(row.incoming).toEqual({ name: 'Active listening', color: '#7c3aed', status: 'removed' })
    // no separate row for the collapsed code
    expect(rows.filter(r => r.kind === 'new')).toHaveLength(0)
  })

  it('link → the target row becomes a group with the incoming code kept', () => {
    const p = preview({ uuid: 'p', name: 'Empathic' })
    const rows = buildMergePlan(locals, [p], { p: { action: 'link', target_code_id: 1, combined_label: 'Empathy / Empathic' } })
    const row = rows.find(r => r.kind === 'link-group')!
    expect(row.finalName).toBe('Empathy / Empathic')
    expect(row.local).toEqual({ name: 'Empathy', color: '#6d28d9' })
    expect(row.incoming).toEqual({ name: 'Empathic', color: '#7c3aed', status: 'new' })
  })

  it('new → its own row, absent on the local side', () => {
    const p = preview({ uuid: 'p', name: 'Power & Control', color: '#d97706' })
    const rows = buildMergePlan(locals, [p], { p: { action: 'new' } })
    const row = rows.find(r => r.kind === 'new')!
    expect(row).toMatchObject({ finalName: 'Power & Control', local: null })
    expect(row.incoming).toEqual({ name: 'Power & Control', color: '#d97706', status: 'new' })
  })
})
