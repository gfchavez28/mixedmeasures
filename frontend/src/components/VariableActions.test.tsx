import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  VariableActions,
  ComputedVariablePanel,
  VariableRulesUnavailable,
} from './VariableActions'
import { swapNameLabelValues, swapNameLabelWords } from '@/lib/dataset-column-label'
import type { DatasetColumn } from '@/lib/api/datasets'

afterEach(cleanup)

const col = (o: Partial<DatasetColumn> & { id: number }): DatasetColumn => ({
  column_code: null,
  column_name: null,
  group_code: null,
  group_label: null,
  column_text: `Question ${o.id}`,
  column_type: 'ordinal',
  sequence_order: o.id,
  scale_labels: null,
  scale_values: null,
  missing_values: null,
  scale_points: null,
  numeric_min: null,
  numeric_max: null,
  numeric_format: null,
  source: 'imported',
  ...o,
} as DatasetColumn)

function renderActions(column: DatasetColumn) {
  const onSubtypeChange = vi.fn()
  const onSwapNameLabel = vi.fn()
  const onOpenDetails = vi.fn()
  render(
    <VariableActions
      column={column}
      onSubtypeChange={onSubtypeChange}
      onSwapNameLabel={onSwapNameLabel}
      onOpenDetails={onOpenDetails}
    />,
  )
  return { onSubtypeChange, onSwapNameLabel, onOpenDetails }
}

// ── The swap arithmetic ──────────────────────────────────────────────────────

describe('swapNameLabelValues', () => {
  it('swaps a name and a label that both exist', () => {
    expect(swapNameLabelValues({ column_name: 'Q1', column_text: 'How anxious?' }))
      .toEqual({ newName: 'How anxious?', newText: 'Q1' })
  })

  it('PROMOTES the label when there is no short name — column_text is NOT NULL', () => {
    // A true swap here would blank `column_text`, which the schema forbids and
    // which would leave the variable unidentifiable in every other surface.
    expect(swapNameLabelValues({ column_name: null, column_text: 'How anxious?' }))
      .toEqual({ newName: 'How anxious?', newText: 'How anxious?' })
  })

  it('returns null when the swap would change nothing', () => {
    // The caller records nothing in the undo stack for a press that does
    // nothing — an undo entry that reverses no change is worse than no entry.
    expect(swapNameLabelValues({ column_name: 'Same', column_text: 'Same' })).toBeNull()
  })

  it('returns null when there is no label to promote', () => {
    expect(swapNameLabelValues({ column_name: 'Q1', column_text: '   ' })).toBeNull()
  })

  it('names itself for what the press will actually do', () => {
    // The two states do DIFFERENT things, so one word for both would be a lie
    // in one of them (#559's family: the name must describe the action).
    expect(swapNameLabelWords({ column_name: 'Q1' })).toBe('Swap name ↔ label')
    expect(swapNameLabelWords({ column_name: null })).toBe('Use label as short name')
  })
})

// ── The actions row ──────────────────────────────────────────────────────────

describe('VariableActions', () => {
  it('offers the demographic subtype ONLY on a demographic variable', () => {
    renderActions(col({ id: 1, column_type: 'demographic', demographic_subtype: 'gender' }))
    const select = screen.getByRole('combobox', { name: /subtype/i })
    expect(select).toHaveValue('gender')

    cleanup()
    renderActions(col({ id: 2, column_type: 'ordinal' }))
    expect(screen.queryByRole('combobox', { name: /subtype/i })).toBeNull()
  })

  it('dispatches a subtype change, and clears it with null rather than an empty string', () => {
    // `PATCH …/subtype` distinguishes "no subtype" (null) from a value; sending
    // `''` would store an empty string as though it were a subtype.
    const { onSubtypeChange } = renderActions(
      col({ id: 1, column_type: 'demographic', demographic_subtype: 'gender' }),
    )
    fireEvent.change(screen.getByRole('combobox', { name: /subtype/i }), { target: { value: '' } })
    expect(onSubtypeChange).toHaveBeenCalledWith(1, null)
  })

  it('offers "Variable details..." ONLY on a manual variable', () => {
    // #575: the save goes through the manual-only PATCH, which 403s on an
    // imported column. This is the single entry point now, so this is the only
    // place the gate exists — its two former siblings did not have it.
    renderActions(col({ id: 1, source: 'manual' }))
    expect(screen.getByRole('button', { name: /variable details/i })).toBeInTheDocument()

    cleanup()
    renderActions(col({ id: 2, source: 'imported' }))
    expect(screen.queryByRole('button', { name: /variable details/i })).toBeNull()

    cleanup()
    renderActions(col({ id: 3, source: 'computed' }))
    expect(screen.queryByRole('button', { name: /variable details/i })).toBeNull()
  })

  it('disables the swap when it would change nothing, rather than hiding it', () => {
    // Hiding it would make the control appear and disappear as the researcher
    // types; the reason it is off is a property of THIS variable's state, which
    // is a transient precondition — native `disabled`, no tab stop earned
    // (`lib/mode-disabled.ts`'s split).
    renderActions(col({ id: 1, column_name: 'Same', column_text: 'Same' }))
    expect(screen.getByRole('button', { name: /swap name/i })).toBeDisabled()
  })

  it('dispatches the swap with the whole column', () => {
    const column = col({ id: 7, column_name: 'Q1', column_text: 'How anxious?' })
    const { onSwapNameLabel } = renderActions(column)
    fireEvent.click(screen.getByRole('button', { name: /swap name/i }))
    expect(onSwapNameLabel).toHaveBeenCalledWith(column)
  })
})

// ── The computed panel ───────────────────────────────────────────────────────

describe('ComputedVariablePanel', () => {
  const computed = (o: Partial<DatasetColumn> = {}) =>
    col({ id: 9, source: 'computed', column_type: 'numeric', expression: '[Post] - [Pre]', ...o })

  it('states the formula — the one fact that defines a computed variable', () => {
    render(
      <ComputedVariablePanel
        column={computed()}
        onEditFormula={vi.fn()}
        onRecompute={vi.fn()}
        isRecomputing={false}
      />,
    )
    expect(screen.getByText('[Post] - [Pre]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit formula/i })).toBeInTheDocument()
  })

  it('offers Recompute ONLY when the variable is stale, and says which state it is in', () => {
    // Both branches render words. A stale column with no explanation is the
    // half-landed-wire shape (#795); a fresh one with a live Recompute button
    // invites a no-op.
    const { rerender } = render(
      <ComputedVariablePanel
        column={computed({ stale: true })}
        onEditFormula={vi.fn()}
        onRecompute={vi.fn()}
        isRecomputing={false}
      />,
    )
    expect(screen.getByText(/out of date/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^recompute$/i })).toBeInTheDocument()

    rerender(
      <ComputedVariablePanel
        column={computed({ stale: false })}
        onEditFormula={vi.fn()}
        onRecompute={vi.fn()}
        isRecomputing={false}
      />,
    )
    expect(screen.getByText(/up to date/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^recompute$/i })).toBeNull()
  })

  it('does not offer a second recompute while one is in flight', () => {
    render(
      <ComputedVariablePanel
        column={computed({ stale: true })}
        onEditFormula={vi.fn()}
        onRecompute={vi.fn()}
        isRecomputing
      />,
    )
    expect(screen.getByRole('button', { name: /recomputing/i })).toBeDisabled()
  })
})

// ── The refusal notice ───────────────────────────────────────────────────────

describe('VariableRulesUnavailable', () => {
  it('says a computed variable is defined by its FORMULA, not merely disallowed', () => {
    // 🔴 This replaced three editors that all 403'd: a seeded value-label
    // dictionary, a missing-value tri-state and a rule editor were offered on
    // every computed variable after slab 3 folded the modal in and dropped the
    // `manual || imported` block it had lived inside. Verified on the page.
    render(<VariableRulesUnavailable refusal="computed" columnType="numeric" />)
    expect(screen.getByText(/derived from its formula/i)).toBeInTheDocument()
    // The word "numeric" must NOT appear — the type is not why it is refused,
    // and blaming it would send the researcher to change the type in vain.
    expect(screen.queryByText(/numeric variables/i)).toBeNull()
  })

  it('names the TYPE when the type is the reason, and points at the fix', () => {
    render(<VariableRulesUnavailable refusal="ineligible_type" columnType="open_text" />)
    expect(screen.getByText(/open_text/)).toBeInTheDocument()
    expect(screen.getByText(/change the variable type/i)).toBeInTheDocument()
  })
})
