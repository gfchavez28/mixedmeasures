/**
 * buildMissingRules / rulesToRows — the missing-values editor's validator and
 * seed (#592 slab 4). Mirrors the backend `services/missing_values._validate_rule`,
 * so what this accepts is exactly what `parse_missing_rules` reads back.
 *
 * Tri-state + a11y (#609/#610): deriveMissingMode / buildMissingPayload /
 * missingRulesEqual, and the MissingValuesSection component (mode switching,
 * the REPLACE disclosure, error announcement, focus retention on row removal).
 */
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  MissingValuesSection,
  buildMissingRules,
  buildMissingPayload,
  deriveMissingMode,
  missingRulesEqual,
  rulesToRows,
  type MissingMode,
  type MissingRow,
} from './MissingValueRows'

const val = (code: string, label = ''): MissingRow => ({ kind: 'value', code, label })
const rng = (lo: string, hi: string, label = ''): MissingRow => ({ kind: 'range', lo, hi, label })

describe('buildMissingRules', () => {
  it('builds discrete rules, with the label optional', () => {
    const res = buildMissingRules([val('99', 'Refused'), val('98')])
    expect(res.ok).toBe(true)
    expect(res.rules).toEqual([{ value: '99', label: 'Refused' }, { value: '98' }])
  })

  it('keeps codes as STRINGS — the cell space is text', () => {
    // A discrete rule may legitimately be a string (.sav string user-missing,
    // #541b), so this must never coerce to number the way the labels editor does.
    const res = buildMissingRules([val('REF', 'Refused')])
    expect(res.rules).toEqual([{ value: 'REF', label: 'Refused' }])
  })

  it('builds a range rule', () => {
    const res = buildMissingRules([rng('-99', '-1')])
    expect(res.rules).toEqual([{ lo: -99, hi: -1 }])
  })

  it('allows an unbounded side (SPSS LO THRU / THRU HI)', () => {
    expect(buildMissingRules([rng('', '0')]).rules).toEqual([{ lo: null, hi: 0 }])
    expect(buildMissingRules([rng('100', '')]).rules).toEqual([{ lo: 100, hi: null }])
  })

  it('distinguishes "nothing declared" (null) from a real empty declaration', () => {
    // null = no declaration -> the recognized-N/A defaults apply.
    // The caller sends `[]` separately to mean "nothing is missing".
    const res = buildMissingRules([])
    expect(res.ok).toBe(true)
    expect(res.rules).toBeNull()
  })

  it('ignores fully-blank rows so an untouched editor is not an error', () => {
    const res = buildMissingRules([val('99', 'Refused'), val(''), rng('', '')])
    expect(res.ok).toBe(true)
    expect(res.rules).toEqual([{ value: '99', label: 'Refused' }])
  })

  it('rejects a range with neither bound', () => {
    // Both blank is a blank ROW (ignored); this is the case where one field was
    // touched then cleared — guarded because the backend requires a bound.
    const res = buildMissingRules([rng(' ', ' ')])
    expect(res.ok).toBe(true)
    expect(res.rules).toBeNull()
  })

  it('rejects a backwards range', () => {
    const res = buildMissingRules([rng('5', '1')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('backwards')
  })

  it('rejects a non-numeric range bound', () => {
    const res = buildMissingRules([rng('abc', '1')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('numbers')
  })

  it('rejects an infinite bound — it would 500 the response', () => {
    // ±Infinity is not JSON-compliant (starlette uses allow_nan=False), and
    // pyreadstat emits exactly these for SPSS's LOWEST/HIGHEST THRU.
    const res = buildMissingRules([rng('-Infinity', '0')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('numbers')
  })

  it('rejects duplicate codes', () => {
    const res = buildMissingRules([val('99', 'Refused'), val('99', 'Declined')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('twice')
  })

  it('rejects a value row with a label but no code', () => {
    const res = buildMissingRules([val('', 'Refused')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('code')
  })

  it('mixes discrete and range rules (SPSS: 3 discrete + 1 range)', () => {
    const res = buildMissingRules([
      val('97', 'Not asked'), val('98', "Don't know"), val('99', 'Refused'),
      rng('-99', '-1'),
    ])
    expect(res.ok).toBe(true)
    expect(res.rules).toHaveLength(4)
  })
})

describe('rulesToRows', () => {
  it('round-trips a declaration back into editor rows', () => {
    const rules = [{ value: '99', label: 'Refused' }, { lo: -99, hi: -1 }]
    expect(buildMissingRules(rulesToRows(rules)).rules).toEqual(rules)
  })

  it('round-trips a RANGE label — API-authored display metadata survives a save (#612)', () => {
    // Pre-fix, rulesToRows dropped the label: the next dialog Apply silently
    // deleted it and declaredChanged flagged a phantom change.
    const rules = [{ lo: -99, hi: -1, label: 'Sentinel band' }]
    expect(buildMissingRules(rulesToRows(rules)).rules).toEqual(rules)
  })

  it('renders an unbounded side as a blank input, not "null"', () => {
    expect(rulesToRows([{ lo: null, hi: 0 }]))
      .toEqual([{ kind: 'range', lo: '', hi: '0', label: '' }])
  })

  it('treats no declaration as no rows', () => {
    expect(rulesToRows(null)).toEqual([])
    expect(rulesToRows(undefined)).toEqual([])
  })

  it('shows an explicit empty declaration as no rows', () => {
    // `[]` means "nothing is missing" — an empty editor. The dialog only sends
    // `[]` vs null based on what the researcher leaves behind.
    expect(rulesToRows([])).toEqual([])
  })
})

describe('badRow (#610a)', () => {
  it('reports the failing row by its ROWS index, skipping blank rows', () => {
    const res = buildMissingRules([val('99'), val(''), val('99', 'Refused')])
    expect(res.ok).toBe(false)
    expect(res.badRow).toBe(2)
  })

  it('reports a backwards range row', () => {
    const res = buildMissingRules([val('99'), rng('5', '1')])
    expect(res.badRow).toBe(1)
  })
})

describe('deriveMissingMode (#609)', () => {
  it('maps the three backend states to the three modes', () => {
    expect(deriveMissingMode(null)).toBe('automatic')
    expect(deriveMissingMode(undefined)).toBe('automatic')
    expect(deriveMissingMode([])).toBe('none')
    expect(deriveMissingMode([{ value: '99' }])).toBe('custom')
  })
})

describe('buildMissingPayload (#609)', () => {
  it('Automatic sends null (the defaults apply)', () => {
    expect(buildMissingPayload('automatic', [val('99')])).toEqual(
      { ok: true, msg: '', rules: null })
  })

  it('Nothing missing sends [] — a REAL declaration', () => {
    expect(buildMissingPayload('none', [])).toEqual({ ok: true, msg: '', rules: [] })
  })

  it('These values sends the validated rows', () => {
    const res = buildMissingPayload('custom', [val('99', 'Refused')])
    expect(res.ok).toBe(true)
    expect(res.rules).toEqual([{ value: '99', label: 'Refused' }])
  })

  it('These values with all rows blank is DISABLED, never a silent un-declare', () => {
    // Pre-#609 the dialog mapped empty rows to `rules: null` and sent the
    // un-declare — deleting every row silently reverted to the defaults.
    const res = buildMissingPayload('custom', [val(''), rng('', '')])
    expect(res.ok).toBe(false)
    expect(res.rules).toBeNull()
    // msg empty: the section shows a hint, not an amber alert.
    expect(res.msg).toBe('')
  })

  it('These values propagates a row error', () => {
    const res = buildMissingPayload('custom', [rng('5', '1')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('backwards')
    expect(res.badRow).toBe(0)
  })
})

describe('missingRulesEqual (#609)', () => {
  it('null (defaults) never equals [] (nothing missing)', () => {
    expect(missingRulesEqual(null, [])).toBe(false)
    expect(missingRulesEqual([], null)).toBe(false)
    expect(missingRulesEqual(null, null)).toBe(true)
    expect(missingRulesEqual(undefined, null)).toBe(true)
    expect(missingRulesEqual([], [])).toBe(true)
  })

  it('compares field-wise, not by JSON serialization', () => {
    // Same content — a raw stringify compare would also pass here, but the
    // point is the inverse: content equality must not depend on key order or
    // absent-vs-empty labels.
    expect(missingRulesEqual(
      [{ value: '99', label: 'Refused' }, { lo: -99, hi: -1 }],
      [{ value: '99', label: 'Refused' }, { lo: -99, hi: -1 }],
    )).toBe(true)
    expect(missingRulesEqual([{ value: '99' }], [{ value: '99', label: '' }])).toBe(true)
  })

  it('detects real differences, including a range label (#612b rides this)', () => {
    expect(missingRulesEqual([{ value: '99' }], [{ value: '98' }])).toBe(false)
    expect(missingRulesEqual([{ lo: 1, hi: 5 }], [{ value: '99' }])).toBe(false)
    expect(missingRulesEqual(
      [{ lo: 1, hi: 5, label: 'Bad' }], [{ lo: 1, hi: 5 }],
    )).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MissingValuesSection component (#609/#610)
// ---------------------------------------------------------------------------

afterEach(cleanup)

function Harness({ initialMode, initialRows }: {
  initialMode: MissingMode
  initialRows: MissingRow[]
}) {
  const [mode, setMode] = useState<MissingMode>(initialMode)
  const [rows, setRows] = useState<MissingRow[]>(initialRows)
  return (
    <MissingValuesSection
      mode={mode}
      onModeChange={setMode}
      rows={rows}
      onRowsChange={setRows}
      validation={buildMissingPayload(mode, rows)}
    />
  )
}

describe('MissingValuesSection', () => {
  it('switching to "These values" seeds one blank row to type into', () => {
    render(<Harness initialMode="automatic" initialRows={[]} />)
    expect(screen.queryByLabelText('Missing value code for row 1')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'These values' }))
    expect(screen.getByLabelText('Missing value code for row 1')).toBeInTheDocument()
    // All-blank custom shows guidance, not the REPLACE sentence.
    expect(screen.getByText(/switch back to/)).toBeInTheDocument()
  })

  it('discloses REPLACE semantics once rules exist (#609b)', () => {
    render(<Harness initialMode="custom" initialRows={[val('99', 'Refused')]} />)
    expect(screen.getByText(/replace the automatic rules/)).toBeInTheDocument()
  })

  it('announces a validation error and marks the failing row (#610a)', () => {
    render(<Harness initialMode="custom" initialRows={[rng('5', '1')]} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('backwards')
    const badInput = screen.getByLabelText('Range low bound for row 1')
    expect(badInput).toHaveAttribute('aria-invalid', 'true')
    expect(badInput).toHaveAttribute('aria-describedby', alert.id)
  })

  it('keeps focus in the editor when a row is removed (#610b)', () => {
    render(<Harness initialMode="custom"
                    initialRows={[val('98', "Don't know"), val('99', 'Refused')]} />)
    fireEvent.click(screen.getByLabelText('Remove missing row 1'))
    // The row that took the removed one's place now holds focus.
    expect(screen.getByLabelText('Remove missing row 1')).toHaveFocus()
    fireEvent.click(screen.getByLabelText('Remove missing row 1'))
    // Last row gone -> focus lands on "Add value", never <body>.
    expect(screen.getByTestId('mv-add-value')).toHaveFocus()
  })
})
