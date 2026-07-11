import { describe, it, expect } from 'vitest'
import {
  COLUMN_TYPES,
  CATEGORICAL_GROUPING_TYPES,
  FILTERABLE_TYPES,
  VALUE_NUMERIC_TYPES,
  CROSSWALK_INELIGIBLE_TYPES,
  isCrosswalkEligible,
  TYPE_BADGE_CLASSES,
} from './dataset-constants'

// Invariant I-D guard (#399, Seam-1): the grouping/filter/numeric eligibility sets
// are single-sourced here and consumed by CrossAnalysisPanel, useAnalysisDerived,
// SubgroupFilterPanel, and AnalysisView. Before #399 each surface hand-rolled its
// own array and they had drifted (one even referenced a non-existent 'likert' type).

describe('column-type eligibility sets', () => {
  it('grouping axes are categorical-only (no continuous numeric/percentage)', () => {
    expect([...CATEGORICAL_GROUPING_TYPES].sort()).toEqual(
      ['binary', 'demographic', 'nominal', 'ordinal'],
    )
    expect(CATEGORICAL_GROUPING_TYPES).not.toContain('numeric')
    expect(CATEGORICAL_GROUPING_TYPES).not.toContain('percentage')
    expect(CATEGORICAL_GROUPING_TYPES).toContain('binary')
  })

  it('filterable set is the grouping set plus numeric (range operators)', () => {
    expect([...FILTERABLE_TYPES].sort()).toEqual(
      ['binary', 'demographic', 'nominal', 'numeric', 'ordinal'],
    )
    // every grouping type is also filterable (strict superset by exactly 'numeric')
    for (const t of CATEGORICAL_GROUPING_TYPES) expect(FILTERABLE_TYPES).toContain(t)
    const extra = FILTERABLE_TYPES.filter(t => !CATEGORICAL_GROUPING_TYPES.includes(t))
    expect(extra).toEqual(['numeric'])
  })

  it('value-numeric (operand) set includes binary, excludes text/categorical', () => {
    expect([...VALUE_NUMERIC_TYPES].sort()).toEqual(
      ['binary', 'numeric', 'ordinal', 'percentage'],
    )
    expect(VALUE_NUMERIC_TYPES).not.toContain('open_text')
    expect(VALUE_NUMERIC_TYPES).not.toContain('nominal')
  })

  it('every eligibility entry is a real ColumnType — no dead `likert` branch', () => {
    const valid = new Set<string>(COLUMN_TYPES)
    for (const set of [CATEGORICAL_GROUPING_TYPES, FILTERABLE_TYPES, VALUE_NUMERIC_TYPES]) {
      for (const t of set) expect(valid.has(t)).toBe(true)
      expect(set).not.toContain('likert')
    }
  })

  it('#414: identifier is a real type with a badge but in NO eligibility set', () => {
    expect(COLUMN_TYPES).toContain('identifier')
    expect(TYPE_BADGE_CLASSES.identifier).toBeTruthy()
    for (const set of [CATEGORICAL_GROUPING_TYPES, FILTERABLE_TYPES, VALUE_NUMERIC_TYPES]) {
      expect(set).not.toContain('identifier')
    }
  })

  // #556b — backend mirror. `models/dataset.py::CROSSWALK_INELIGIBLE_TYPES` is the
  // server half (it gates the suggest pools); this is the client half (it rejects
  // the drag/dialog gestures). test_556_identifier_hardening.py pins the same two
  // members, so changing one side fails that side's own suite.
  it('crosswalk-ineligible = skip + identifier (backend mirror)', () => {
    expect([...CROSSWALK_INELIGIBLE_TYPES].sort()).toEqual(['identifier', 'skip'])
  })

  it('ineligible types are never analysable (no overlap with the numeric sets)', () => {
    for (const t of CROSSWALK_INELIGIBLE_TYPES) {
      expect(VALUE_NUMERIC_TYPES).not.toContain(t)
      expect(CATEGORICAL_GROUPING_TYPES).not.toContain(t)
    }
  })

  it('isCrosswalkEligible rejects identifier/skip and passes real measures', () => {
    expect(isCrosswalkEligible('identifier')).toBe(false)
    expect(isCrosswalkEligible('skip')).toBe(false)
    expect(isCrosswalkEligible('ordinal')).toBe(true)
    expect(isCrosswalkEligible('numeric')).toBe(true)
    expect(isCrosswalkEligible('nominal')).toBe(true)
  })
})
