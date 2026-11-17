/**
 * Joint display slice 2 — the document model (C6): explicit strands (r1-1), slice 1's implicit
 * pair read on the way in (r1-2), the fit pair (r1-8), unknown members kept (r1-9) and the drift
 * keys per strand (r1-7). `lib/joint-display.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { JointDisplayRowResult } from '@/lib/api/joint-display'
import {
  computeRequest, defaultFitPair, displayCoderScope, fitsNamingStrand, pairApplicable, primaryFit, readDisplay,
  removeStrand, rowCells, withBinding, withPrimaryFit,
} from '@/lib/joint-display'

const SLICE1 = {
  title: 'T', group_by_column_id: 11, conversation_ids: [21], document_ids: null,
  rows: [{ key: 'a', construct: 'C', code_ids: [3], column_ids: [12], codes_marked_formed: true,
    status: { codes: 'covers', variables: 'silent' }, fit: 'expansion' }],
}

const THREE = {
  group_by_column_id: 11,
  strands: [
    { key: 'int', kind: 'codes', label: 'Interviews', conversation_ids: [21], document_ids: [] },
    { key: 'fg', kind: 'codes', label: 'Focus groups', conversation_ids: [22], document_ids: [] },
    { key: 'svy', kind: 'variables', label: 'Baseline survey', dataset_id: 5 },
    { key: 'obs', kind: 'observation_codes', label: 'Classrooms', observation_ids: [31, null] },
  ],
  rows: [{ key: 'a', construct: 'C', bindings: {
    int: { code_ids: [3] }, fg: { code_ids: [3] }, svy: { column_ids: [12] }, obs: { code_ids: [3] },
    gone: { code_ids: [9] } },
  status: { fg: 'silent', gone: 'covers' },
  fits: [{ strands: ['fg', 'svy'], fit: 'discordance' }, { strands: ['int', 'fg'], fit: 'confirmation' },
    { strands: ['svy', 'fg'], fit: 'expansion' }, { strands: ['int', 'gone'], fit: 'x' }, { strands: ['int', 'int'], fit: 'x' }] }],
}

describe('slice 1 displays read as their implicit pair (r1-2)', () => {
  it('one codes strand over the display sources and one variables strand, the row bound to both', () => {
    const d = readDisplay(SLICE1)
    expect(d.strands.map(s => [s.key, s.kind, s.conversation_ids])).toEqual([['codes', 'codes', [21]], ['variables', 'variables', null]])
    expect(d.rows[0].bindings).toEqual({
      codes: { code_ids: [3], column_ids: [], marked_formed: true },
      variables: { code_ids: [], column_ids: [12], marked_formed: false },
    })
    expect(d.rows[0].status).toEqual({ codes: 'covers', variables: 'silent' })
  })

  it('writes slice 2 only: the legacy members are consumed, never written back beside the strands', () => {
    const d = readDisplay(SLICE1) as unknown as Record<string, unknown>
    expect('conversation_ids' in d).toBe(false)
    expect('code_ids' in (d.rows as Record<string, unknown>[])[0]).toBe(false)
    expect(readDisplay(JSON.parse(JSON.stringify(d)))).toEqual(d) // a second read is the same model
  })

  it('slice 1 s one fit reads as ONE fit over its implicit pair (r1-8)', () => {
    const d = readDisplay(SLICE1)
    expect(d.rows[0].fits).toEqual([{ strands: ['codes', 'variables'], fit: 'expansion' }])
    expect(primaryFit(d.rows[0])).toBe('expansion')
    expect('fit' in (d.rows[0] as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('three or more strands (r1-1)', () => {
  it('reads each strand with its own sources and a binding only for a strand the display has', () => {
    const d = readDisplay(THREE)
    expect(d.strands.map(s => s.key)).toEqual(['int', 'fg', 'svy', 'obs'])
    expect(d.strands[3].observation_ids).toEqual([31, null])
    expect(Object.keys(d.rows[0].bindings)).toEqual(['int', 'fg', 'svy', 'obs'])
    expect(d.rows[0].status).toEqual({ fg: 'silent' })
  })

  it('asks the server per strand, unresolved ids dropped, null = every source kept', () => {
    const req = computeRequest(readDisplay(THREE), displayCoderScope(false, 1))!
    expect(req.strands.find(s => s.key === 'obs')!.observation_ids).toEqual([31])
    expect(req.strands.find(s => s.key === 'svy')!.dataset_id).toBe(5)
    expect(req.rows[0].bindings.fg).toEqual({ code_ids: [3], column_ids: [], marked_formed: false })
    expect('gone' in req.rows[0].bindings).toBe(false)
    expect('conversation_ids' in req).toBe(false)
  })

  it('a kind this build cannot compute is KEPT and never asked of the server (r1-9)', () => {
    const d = readDisplay({ group_by_column_id: 1, strands: [{ key: 'x', kind: 'images', label: 'Photos' }, { key: 'c', kind: 'codes' }],
      rows: [{ key: 'a', bindings: { x: { code_ids: [3] }, c: { code_ids: [3] } } }] })
    expect(d.strands.map(s => [s.key, s.kind])).toEqual([['x', 'images'], ['c', 'codes']])
    expect(d.rows[0].bindings.x.code_ids).toEqual([3])
    const req = computeRequest(d, displayCoderScope(false, 1))!
    expect(req.strands.map(s => s.key)).toEqual(['c'])
    expect(Object.keys(req.rows[0].bindings)).toEqual(['c'])
  })

  it('a text_codes strand sends its columns, and none is [] — never every column (r4-1)', () => {
    const d = readDisplay({ group_by_column_id: 1, strands: [{ key: 't', kind: 'text_codes', text_column_ids: [5, null] },
      { key: 'u', kind: 'text_codes' }] })
    const req = computeRequest(d, displayCoderScope(false, 1))!
    expect(req.strands.map(s => s.text_column_ids)).toEqual([[5], []])
  })
})

describe('fits over NAMED pairs (r1-8, L1)', () => {
  it('reconciled with r2: one pair stored as fit + fit_strands on an explicit display reads as that fit', () => {
    const one = readDisplay({ ...THREE, rows: [{ ...THREE.rows[0], fits: undefined, fit: 'expansion', fit_strands: ['svy', 'obs'] }] })
    expect(one.rows[0].fits).toEqual([{ strands: ['svy', 'obs'], fit: 'expansion' }])
    const dflt = readDisplay({ ...THREE, rows: [{ ...THREE.rows[0], fits: undefined, fit: 'expansion' }] })
    expect(dflt.rows[0].fits).toEqual([{ strands: ['int', 'fg'], fit: 'expansion' }])
  })

  it('a pin keeps the strand it was picked from (r2-5)', () => {
    const d = readDisplay({ ...THREE, rows: [{ ...THREE.rows[0], pins: [{ excerptId: 1, strand: 'fg', speaker: 'X' }] }] })
    expect(d.rows[0].pins[0].strand).toBe('fg')
    expect('speaker' in d.rows[0].pins[0]).toBe(false)
  })

  it('reads each pair once, dropping a pair naming an absent strand or one strand twice', () => {
    const d = readDisplay(THREE)
    expect(d.rows[0].fits).toEqual([{ strands: ['fg', 'svy'], fit: 'discordance' }, { strands: ['int', 'fg'], fit: 'confirmation' }])
  })

  it('the default pair is the first two BOUND per-group strands, else the first two per-group', () => {
    const d = readDisplay(THREE)
    expect(defaultFitPair(d, d.rows[0])).toEqual(['int', 'fg'])
    const onlySurvey = { ...d.rows[0], bindings: { svy: d.rows[0].bindings.svy } }
    expect(defaultFitPair(d, onlySurvey)).toEqual(['int', 'fg'])
    const lone = readDisplay({ strands: [{ key: 'v', kind: 'variables' }, { key: 'o', kind: 'observation_codes' }], rows: [{ key: 'a' }] })
    expect(defaultFitPair(lone, lone.rows[0])).toBeNull()
    expect(withPrimaryFit(lone, lone.rows[0], 'confirmation')).toEqual({})
  })

  it('a pair neither of whose strands binds anything is DERIVED not applicable — never silence', () => {
    const d = readDisplay(THREE)
    expect(pairApplicable(d.rows[0], ['fg', 'svy'])).toBe(true)
    const bare = { ...d.rows[0], bindings: { int: d.rows[0].bindings.int } }
    expect(pairApplicable(bare, ['fg', 'svy'])).toBe(false)
    expect(pairApplicable(bare, ['int', 'fg'])).toBe(true)
  })

  it('setting the first fit writes it over its pair (or the default one)', () => {
    const d = readDisplay(THREE)
    expect(withPrimaryFit(d, d.rows[0], 'expansion').fits![0]).toEqual({ strands: ['fg', 'svy'], fit: 'expansion' })
    const none = { ...d.rows[0], fits: [] }
    expect(withPrimaryFit(d, none, 'expansion').fits).toEqual([{ strands: ['int', 'fg'], fit: 'expansion' }])
  })

  it('removing a strand drops every fit over a pair naming it, counted first; others stay', () => {
    const d = readDisplay(THREE)
    expect(fitsNamingStrand(d, 'fg')).toBe(2)
    const gone = removeStrand(d, 'fg')
    expect(gone.rows[0].fits).toEqual([])
    expect('fg' in gone.rows[0].bindings || 'fg' in gone.rows[0].status).toBe(false)
    expect(removeStrand(d, 'obs').rows[0].fits).toHaveLength(2)
  })
})

describe('forward compatibility: members this build does not know survive an edit (r1-9)', () => {
  it('at every level — display, strand, row, binding — through the edit path', () => {
    const later = {
      ...THREE, layout: { banded: true },
      strands: THREE.strands.map(s => (s.key === 'int' ? { ...s, weight: 2 } : s)),
      rows: [{ ...THREE.rows[0], misfit_later: { mode: 'rule' },
        bindings: { ...THREE.rows[0].bindings, int: { code_ids: [3], codes_later: [7] } } }],
    }
    const d = readDisplay(later)
    // The edit path: `commit({ ...display, rows: rows.map(r => ({ ...r, ...patch })) })`.
    const edited = { ...d, rows: d.rows.map(r => ({ ...r, construct: 'Renamed', ...withBinding(r, 'fg', { code_ids: [4] }) })) }
    const stored = JSON.parse(JSON.stringify(edited))
    expect(stored.layout).toEqual({ banded: true })
    expect(stored.strands[0].weight).toBe(2)
    expect(stored.rows[0].misfit_later).toEqual({ mode: 'rule' })
    expect(stored.rows[0].bindings.int.codes_later).toEqual([7])
    expect(stored.rows[0].bindings.fg.code_ids).toEqual([4])
  })
})

describe('drift keys per strand (r1-7)', () => {
  const cell = { group: 'High', count: 1, n: 2, share: 0.5, share_undefined_reason: null, passages: 1, rating: null }
  const code = (count: number) => ({ code_id: 3, name: 'P', unit: 'participants', rated: false, formed_groups: null,
    cells: [{ ...cell, count }], difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: 'not_two_groups' } })
  const empty = { variables: [], observation_codes: [] }

  it('two codes strands binding ONE code keep two cells', () => {
    const row = { key: 'a', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'covers', variables: 'not_measured' },
      by_strand: { int: { ...empty, codes: [code(1)] }, fg: { ...empty, codes: [code(2)] } } } as JointDisplayRowResult
    const cells = rowCells(row)
    // r2's key format (reconciled): the strand rides the id part, which the import remaps.
    expect(cells['code:3@int:High']).toBe('1 of 2')
    expect(cells['code:3@fg:High']).toBe('2 of 2')
  })

  it('slice 1 s implicit pair keeps slice 1 s keys, so a stamped slice 1 row still matches', () => {
    const row = { key: 'a', codes: [code(1)], variables: [], missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'covers', variables: 'not_measured' },
      by_strand: { codes: { ...empty, codes: [code(1)] }, variables: { ...empty, codes: [] } } } as JointDisplayRowResult
    const legacy = { ...row, by_strand: undefined }
    expect(rowCells(row)).toEqual(rowCells(legacy))
    expect(Object.keys(rowCells(row))).toContain('code:3:High')
  })
})
