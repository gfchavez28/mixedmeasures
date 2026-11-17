import { describe, it, expect } from 'vitest'
import {
  computeRequest, displayCoderScope, emptyDisplay, formatCodeDifference, formatEffect, formatRatingCell,
  formatVariableCell, readDisplay, rowCells, rowDrift, unresolvedReferenceCount,
} from './joint-display'
import type { JointDisplayRowResult, JointDisplayVariableStrand } from '@/lib/api/joint-display'
import { fingerprintJointDisplayRow } from '@/components/canvas/figure-baseline'

/** A row result in the server's shape (`schemas/joint_display.py`), two groups. */
function result(overrides: Partial<{ high: number; low: number; mean: number }> = {}): JointDisplayRowResult {
  const { high = 7, low = 0, mean = 23.9 } = overrides
  return {
    key: 'r1',
    codes: [{
      code_id: 31, name: 'Planning time', unit: 'participants', rated: true, formed_groups: null,
      cells: [
        { group: 'High', count: high, n: 11, share: high / 11, share_undefined_reason: null, passages: 12,
          rating: { mean: 2.45, n: 10, undefined_reason: null } },
        { group: 'Low', count: low, n: 11, share: low / 11, share_undefined_reason: null, passages: 3,
          rating: { mean: null, n: 0, undefined_reason: 'no_scores' } },
      ],
      // The server's difference in shares, from the same counts (so a moved count moves it).
      difference: { value: (high - low) / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
    }],
    variables: [{
      column_id: 12, name: 'Training hours', dataset_id: 2, unit: 'participants', formed_groups: null,
      summary: 'mean', unavailable_reason: null, categories: [],
      cells: [
        { group: 'High', n: 11, mean, mean_undefined_reason: null, sd: 4.1, sd_undefined_reason: null, distribution: [] },
        { group: 'Low', n: 11, mean: 7.1, mean_undefined_reason: null, sd: 2.2, sd_undefined_reason: null, distribution: [] },
      ],
      effect: { d: 2.37, ci_lower: 1.26, ci_upper: 3.49, ci_level: 0.95, ci_method: 'hedges_olkin_d', unavailable_reason: null },
    }],
    missing_code_ids: [],
    missing_column_ids: [],
    strands: { codes: 'covers', variables: 'covers' },
  }
}

describe('reading a stored display (tolerant IN)', () => {
  it('defaults every member of an empty or broken attribute and never throws', () => {
    for (const raw of [null, undefined, '', 'not json', 42, [], { rows: 'x' }]) {
      const d = readDisplay(raw)
      expect(d.rows).toEqual([])
      expect(d.attribution.label).toBe('participant')
      expect(d.settings).toEqual({ fit_vocabulary: 'fetters', implication: false, newcombe: false })
    }
  })

  it('reads a display held as a JSON string (the HTML round trip) the same as the object', () => {
    const obj = { title: 'T', group_by_column_id: 11, rows: [{ key: 'a', construct: 'C', code_ids: [3] }] }
    expect(readDisplay(JSON.stringify(obj))).toEqual(readDisplay(obj))
  })

  it('keeps an id an import could not resolve as null IN PLACE (D202) and counts it', () => {
    const d = readDisplay({
      group_by_column_id: 11, conversation_ids: [21, null], document_ids: null,
      rows: [{ key: 'a', code_ids: [3, null], column_ids: [null] }],
    })
    // Joint display slice 2 (r1-2): a slice 1 display reads as its implicit pair.
    expect(d.strands[0].conversation_ids).toEqual([21, null])
    expect(d.rows[0].bindings.codes.code_ids).toEqual([3, null])
    expect(unresolvedReferenceCount(d)).toBe(3)
  })

  it('a pin keeps exactly the embed attributes plus group, role and purpose', () => {
    const d = readDisplay({ rows: [{ key: 'a', pins: [{
      excerptId: 41, displayText: 'We plan on Fridays.', sourceContext: 'Focus group', conversationId: 21,
      observationId: null, group: 'High', role: 'typical', speaker: 'Robert',
    }] }] })
    expect(Object.keys(d.rows[0].pins[0]).sort()).toEqual(
      ['conversationId', 'displayText', 'excerptId', 'group', 'observationId', 'purpose', 'role', 'sourceContext'])
  })
})

describe('what the display asks the server', () => {
  it('has no request until a grouping variable is chosen', () => {
    expect(computeRequest(emptyDisplay(), displayCoderScope(false, 1))).toBeNull()
  })

  it('keeps null = every source and [] = none, and drops unresolved ids (#1297)', () => {
    const d = readDisplay({
      group_by_column_id: 11, conversation_ids: null, document_ids: [],
      rows: [{ key: 'a', code_ids: [3, null, 4], column_ids: [null, 12], codes_marked_formed: true }],
    })
    const req = computeRequest(d, displayCoderScope(false, 1))!
    // Joint display slice 2 (r1-1/r1-2): the same request, asked as the implicit pair's strands.
    expect(req.strands[0].conversation_ids).toBeNull()
    expect(req.strands[0].document_ids).toEqual([])
    expect(req.rows).toEqual([{ key: 'a', bindings: {
      codes: { code_ids: [3, 4], column_ids: [], marked_formed: true },
      variables: { code_ids: [], column_ids: [12], marked_formed: false } } }])
    expect(readDisplay({ group_by_column_id: 1, conversation_ids: [null] }).strands[0].conversation_ids).toEqual([null])
    expect(computeRequest(readDisplay({ group_by_column_id: 1, conversation_ids: [null] }), displayCoderScope(false, 1))!.strands[0].conversation_ids)
      .toEqual([])
  })

  it('blind mode: the viewer alone while withholding — and nobody when the viewer is unknown (fail closed)', () => {
    expect(displayCoderScope(true, 7)).toEqual({ coderIds: [7], layerScope: 'human', chipsFollow: true })
    expect(displayCoderScope(true, null)).toEqual({ coderIds: [], layerScope: 'human', chipsFollow: true })
    expect(displayCoderScope(false, 7)).toEqual({ coderIds: null, layerScope: 'human', chipsFollow: false })
  })
})

describe('what a cell prints', () => {
  it('a coded count is "x of n", a rated cell its mean and scores, a gap a dash', () => {
    const r = result()
    expect(rowCells(r)['code:31:High']).toBe('7 of 11')
    expect(formatRatingCell(r.codes[0].cells[0])).toBe('2.45 (10 scores)')
    expect(formatRatingCell(r.codes[0].cells[1])).toBe('—')
    expect(formatCodeDifference(r.codes[0])).toBe('+64 pp')
  })

  it('a survey mean carries its SD and n; d carries its stated interval', () => {
    const r = result()
    expect(formatVariableCell(r.variables[0], r.variables[0].cells[0])).toBe('23.90 (SD 4.10), n 11')
    expect(formatEffect(r.variables[0])).toMatch(/^d = 2\.37 \[1\.26, 3\.49\] 95% CI/)
  })

  it('a distribution lists its categories; a strand with no summary prints a dash', () => {
    const s: JointDisplayVariableStrand = {
      ...result().variables[0], summary: 'distribution',
      cells: [{ group: 'High', n: 3, mean: null, mean_undefined_reason: null, sd: null, sd_undefined_reason: null,
        distribution: [{ label: 'Teacher', count: 2, share: 0.67 }, { label: 'Coach', count: 1, share: 0.33 }] }],
    }
    expect(formatVariableCell(s, s.cells[0])).toBe('Teacher 2 · Coach 1, n 3')
    expect(formatVariableCell({ ...s, summary: 'not_summarisable' }, s.cells[0])).toBe('—')
  })

  it('a formed strand gives no between-group number and says why (D171)', () => {
    const r = result()
    r.variables[0] = { ...r.variables[0], formed_groups: 'grouping_variable',
      effect: { d: null, ci_lower: null, ci_upper: null, ci_level: 0.95, ci_method: 'hedges_olkin_d', unavailable_reason: 'formed_groups' } }
    expect(formatEffect(r.variables[0])).toBe('—')
  })
})

describe('drift (D168.5): what moved since the meta-inference was written', () => {
  const stamp = (r: JointDisplayRowResult) => {
    const cells = rowCells(r)
    return { hash: fingerprintJointDisplayRow(cells).hash, cells, stamped_at: '2026-11-06' }
  }

  it('says nothing without a baseline, and nothing when no printed cell moved', () => {
    expect(rowDrift(null, result())).toEqual([])
    expect(rowDrift(stamp(result()), result())).toEqual([])
  })

  it('names the cell that moved, was and now', () => {
    const changes = rowDrift(stamp(result()), result({ low: 1 }))
    const low = changes.find(c => c.key === 'code:31:Low')
    expect(low).toEqual({ key: 'code:31:Low', label: 'Planning time, Low', was: '0 of 11', now: '1 of 11' })
    expect(changes.map(c => c.key)).toContain('code:31:difference')
  })

  it('a change the view cannot print is not a change (the projection is what is drawn)', () => {
    expect(rowDrift(stamp(result({ mean: 23.9 })), result({ mean: 23.9001 }))).toEqual([])
    expect(rowDrift(stamp(result({ mean: 23.9 })), result({ mean: 23.95 })).length).toBe(1)
  })

  it('the hash agrees with the cells: equal cells, equal hash — and a moved cell moves it', () => {
    expect(fingerprintJointDisplayRow(rowCells(result())).hash).toBe(fingerprintJointDisplayRow(rowCells(result())).hash)
    expect(fingerprintJointDisplayRow(rowCells(result({ low: 1 }))).hash).not.toBe(fingerprintJointDisplayRow(rowCells(result())).hash)
  })
})
