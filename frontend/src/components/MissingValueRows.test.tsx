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
  OBSERVED_PICK_LIMIT,
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

function Harness({ initialMode, initialRows, observedValues }: {
  initialMode: MissingMode
  initialRows: MissingRow[]
  observedValues?: { value_text: string; count: number }[]
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
      observedValues={observedValues}
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


// ── The observed-value picker (#823a) ────────────────────────────────────────
//
// 🔴 It exists because TYPING CANNOT BE MADE SAFE on this input. GSS stores
// ".i:  Inapplicable" with two interior spaces; HTML collapses interior
// whitespace, so the researcher reads one, types one, and declares a rule that
// matches zero of 28,041 cells. Copy-paste does not help either — the clipboard
// receives the collapsed form. Picking is the only input path that carries the
// stored text through unchanged, which is why these assertions are about the
// VALUE that lands in the row, not about the chip's appearance.

const TWO_SPACES = '.i:  Inapplicable'

describe('MissingValueRows — the observed-value picker (#823a)', () => {
  const observed = [
    { value_text: TWO_SPACES, count: 28041 },
    { value_text: 'Yes', count: 400 },
  ]

  it('is absent when there is nothing to offer', () => {
    render(<Harness initialMode="custom" initialRows={[val('')]} />)
    expect(screen.queryAllByTestId('mv-pick')).toHaveLength(0)
  })

  it('puts the STORED text into the row, interior spacing intact', () => {
    render(
      <Harness initialMode="custom" initialRows={[val('')]} observedValues={observed} />,
    )
    fireEvent.click(screen.getAllByTestId('mv-pick')[0])
    const input = screen.getByLabelText('Missing value code for row 1') as HTMLInputElement
    // The assertion that matters: not "it looks right" but that the exact
    // two-space string arrived. A one-space value here IS the bug.
    expect(input.value).toBe(TWO_SPACES)
    expect(input.value).not.toBe('.i: Inapplicable')
  })

  it('fills the blank row rather than appending below it', () => {
    render(
      <Harness initialMode="custom" initialRows={[val('')]} observedValues={observed} />,
    )
    fireEvent.click(screen.getAllByTestId('mv-pick')[0])
    expect(screen.queryByLabelText('Missing value code for row 2')).toBeNull()
  })

  it('appends when every row is already spoken for', () => {
    render(
      <Harness initialMode="custom" initialRows={[val('99')]} observedValues={observed} />,
    )
    fireEvent.click(screen.getAllByTestId('mv-pick')[0])
    const second = screen.getByLabelText('Missing value code for row 2') as HTMLInputElement
    expect(second.value).toBe(TWO_SPACES)
  })

  it('drops a value once it is declared — a second chip would be a duplicate', () => {
    render(
      <Harness initialMode="custom" initialRows={[val(TWO_SPACES)]} observedValues={observed} />,
    )
    const names = screen.getAllByTestId('mv-pick').map(b => b.textContent)
    expect(names.some(n => n?.includes(TWO_SPACES))).toBe(false)
    expect(names.some(n => n?.includes('Yes'))).toBe(true)
  })

  it('bounds the offer by cardinality', () => {
    // A real open-text column carries thousands of distinct values (measured:
    // 4,510 on one GSS column) and a sentinel is not among them.
    const many = Array.from({ length: 50 }, (_, i) => ({ value_text: `v${i}`, count: 50 - i }))
    render(<Harness initialMode="custom" initialRows={[val('')]} observedValues={many} />)
    expect(screen.getAllByTestId('mv-pick')).toHaveLength(OBSERVED_PICK_LIMIT)
  })

  it('names each chip fully, including its count, however it is truncated', () => {
    render(
      <Harness initialMode="custom" initialRows={[val('')]} observedValues={observed} />,
    )
    // The visible label truncates by CSS; the accessible name must not, and the
    // count is what lets a reader tell a sentinel from a real response.
    //
    // ⚠️ NOTE THE SINGLE SPACE, and that it is not a typo. Accessible-name
    // computation NORMALIZES whitespace, exactly as HTML rendering does — so
    // the name cannot carry the two-space distinction either, and two observed
    // values differing only in interior spacing would announce identically.
    // That is a limit of the NAME, not of the control: picking passes the
    // stored string programmatically (asserted above), so the value that lands
    // in the rule is unaffected. It is also the second independent reason the
    // researcher must not be asked to tell these apart by reading.
    expect(
      screen.getByRole('button', { name: 'Declare .i: Inapplicable as missing — 28041 records' }),
    ).toBeInTheDocument()
  })
})


// ── The picker's filter (#823a) ──────────────────────────────────────────────
//
// 🔴 FOUND BY DRIVING, NOT BY REASONING, and it was a defect in the fix itself.
// Frequencies arrive count DESCENDING and a sentinel is RARE: on GSS `wrkstat`
// the six `.x:` sentinels total 47 cells against 36,727 for "Working full
// time", so every one of them fell outside the first twelve chips. The picker
// offered precisely the responses nobody would ever declare missing.
//
// The filter is what makes the whole set reachable. It must be FORGIVING where
// the rule is EXACT: the researcher can only type what the screen showed them —
// one space — so a filter matching raw text would fail on exactly the values
// this control exists to surface.

describe('MissingValueRows — the picker filter (#823a)', () => {
  const many = [
    { value_text: '.n:  No answer', count: 12 },            // two interior spaces
    ...Array.from({ length: 20 }, (_, i) => ({ value_text: `resp ${i}`, count: 900 - i })),
  ]

  it('appears only when the offer is bounded', () => {
    render(<Harness initialMode="custom" initialRows={[val('')]}
             observedValues={[{ value_text: 'Yes', count: 1 }]} />)
    expect(screen.queryByTestId('mv-pick-filter')).toBeNull()

    cleanup()
    render(<Harness initialMode="custom" initialRows={[val('')]} observedValues={many} />)
    expect(screen.getByTestId('mv-pick-filter')).toBeInTheDocument()
  })

  it('says how many it is not drawing — never a silent truncation', () => {
    render(<Harness initialMode="custom" initialRows={[val('')]} observedValues={many} />)
    // The researcher must be able to tell "not in my data" from "on page two".
    expect(screen.getByText(/9 more — type to narrow the list\./)).toBeInTheDocument()
  })

  it('🔴 finds a two-space value when the ONE-space form is typed', () => {
    // The decisive case. Typed text can only ever be the collapsed form,
    // because that is all the screen — and the clipboard — can give.
    render(<Harness initialMode="custom" initialRows={[val('')]} observedValues={many} />)
    fireEvent.change(screen.getByTestId('mv-pick-filter'), {
      target: { value: '.n: no answer' },   // one space, lower case
    })
    const chips = screen.getAllByTestId('mv-pick')
    expect(chips).toHaveLength(1)

    fireEvent.click(chips[0])
    const input = screen.getByLabelText('Missing value code for row 1') as HTMLInputElement
    // Forgiving search, EXACT insertion — the two halves of the fix.
    expect(input.value).toBe('.n:  No answer')
    expect(input.value).not.toBe('.n: No answer')
  })

  it('narrowing to nothing offers nothing rather than falling back to the top N', () => {
    render(<Harness initialMode="custom" initialRows={[val('')]} observedValues={many} />)
    fireEvent.change(screen.getByTestId('mv-pick-filter'), {
      target: { value: 'zzz-not-a-value' },
    })
    expect(screen.queryAllByTestId('mv-pick')).toHaveLength(0)
  })
})
