import { describe, it, expect } from 'vitest'
import {
  COLUMN_TYPES,
  CATEGORICAL_GROUPING_TYPES,
  FILTERABLE_TYPES,
  VALUE_NUMERIC_TYPES,
  CROSSWALK_INELIGIBLE_TYPES,
  isCrosswalkEligible,
  VARIABLE_RULES_INELIGIBLE_TYPES,
  variableRulesRefusal,
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

// ── Value labels / missing rules / recodes: TWO gates, not one ───────────────
//
// 🔴 The bug this predicate exists to prevent: `source` is a gate and it is NOT
// a type. Folding the value-labels modal into the Variables view dropped the
// `manual || imported` block it had lived inside, so a COMPUTED variable was
// offered a seeded value-label dictionary, a missing-value tri-state and a rule
// editor — and `routers/recode.py` 403s all three for `source == 'computed'`
// (:889, :958, :431). A type-only predicate cannot see that.
describe('variableRulesRefusal', () => {
  it('mirrors the backend type set exactly (VALUE_LABEL_INELIGIBLE_TYPES)', () => {
    expect([...VARIABLE_RULES_INELIGIBLE_TYPES].sort()).toEqual(['identifier', 'open_text'])
  })

  it('refuses a computed variable WHATEVER its type', () => {
    // The arm that was missing. Every one of these types is otherwise fine.
    for (const column_type of ['numeric', 'ordinal', 'nominal', 'binary', 'percentage']) {
      expect(variableRulesRefusal({ column_type, source: 'computed' }), column_type)
        .toBe('computed')
    }
  })

  it('names the SOURCE refusal ahead of the type when both apply', () => {
    // The two need different words on screen: blaming the type would send the
    // researcher to change a type that is not the reason.
    expect(variableRulesRefusal({ column_type: 'open_text', source: 'computed' }))
      .toBe('computed')
  })

  it('refuses the ineligible types on a collected variable', () => {
    expect(variableRulesRefusal({ column_type: 'open_text', source: 'imported' }))
      .toBe('ineligible_type')
    expect(variableRulesRefusal({ column_type: 'identifier', source: 'manual' }))
      .toBe('ineligible_type')
  })

  it('passes an ordinary collected variable, manual or imported', () => {
    expect(variableRulesRefusal({ column_type: 'ordinal', source: 'imported' })).toBeNull()
    expect(variableRulesRefusal({ column_type: 'nominal', source: 'manual' })).toBeNull()
    // `source` is optional on the shape: a caller that has only a type must not
    // be silently told "computed".
    expect(variableRulesRefusal({ column_type: 'numeric' })).toBeNull()
  })
})
