/**
 * computeDisplayValue — the dataset-grid cell display logic.
 *
 * #561: the .sav adapter's dedupe suffix (#541a) bakes the code into the
 * label ("Agree (1)"), and the grid's own `(value)` annotation then rendered
 * "Agree (1) (1)". The annotation is suppressed ONLY when the label's
 * trailing (N) equals the displayed numeric — when they differ (REVERSE, or
 * a label whose parenthetical is unrelated) it carries information and stays.
 */
import { describe, it, expect } from 'vitest'
import { computeDisplayValue } from './EditableCell'
import type { DatasetColumn, DatasetValueCell, RecodeDefinitionSummary } from '@/lib/api'

const column = { id: 1, column_type: 'ordinal' } as unknown as DatasetColumn

const cell = (text: string): DatasetValueCell =>
  ({ id: 1, value_text: text, value_numeric: null }) as unknown as DatasetValueCell

const def = (
  mapping: Record<string, number | string>,
  recodeType: 'scale_map' | 'reverse' | 'category_group' = 'scale_map',
): RecodeDefinitionSummary =>
  ({
    id: 1,
    recode_type: recodeType,
    mapping,
    exclude_values: [],
  }) as unknown as RecodeDefinitionSummary

describe('computeDisplayValue — #561 double-parenthesis suppression', () => {
  it('suppresses the annotation when the label already ends in (mapped value)', () => {
    // The #541a dedupe shape: "Agree (1)" → 1, "Agree (2)" → 2
    const d = def({ 'Agree (1)': 1, 'Agree (2)': 2 })
    expect(computeDisplayValue(cell('Agree (1)'), column, d).display).toBe('Agree (1)')
    expect(computeDisplayValue(cell('Agree (2)'), column, d).display).toBe('Agree (2)')
  })

  it('keeps the annotation when the trailing (N) differs from the displayed value', () => {
    // The differing case (e.g. a reversed display where the label carries the
    // forward code but the cell shows the reflected one): the annotation
    // disambiguates and must stay — per the locked decision, suppress ONLY
    // on exact equality.
    const differing = def({ 'Agree (1)': 5 })
    expect(computeDisplayValue(cell('Agree (1)'), column, differing).display).toBe('Agree (1) (5)')
  })

  it('keeps the annotation for plain labels (no trailing parenthetical)', () => {
    const d = def({ Agree: 2 })
    const out = computeDisplayValue(cell('Agree'), column, d)
    expect(out.display).toBe('Agree (2)')
    expect(out.isNumeric).toBe(true)
    expect(out.numericValue).toBe(2)
  })

  it('does not suppress on a non-numeric parenthetical', () => {
    const d = def({ 'Agree (a)': 1 })
    expect(computeDisplayValue(cell('Agree (a)'), column, d).display).toBe('Agree (a) (1)')
  })

  it('suppresses for decimal-rendered codes too', () => {
    const d = def({ 'Agree (1.5)': 1.5 })
    expect(computeDisplayValue(cell('Agree (1.5)'), column, d).display).toBe('Agree (1.5)')
  })

  it('tooltip still spells out raw → recoded even when suppressed', () => {
    const d = def({ 'Agree (1)': 1 })
    const out = computeDisplayValue(cell('Agree (1)'), column, d)
    expect(out.titleText).toBe('raw Agree (1) → recoded 1')
  })
})
