/**
 * The confirm for applying a rule in place.
 *
 * Every assertion here is a sentence the researcher must be able to read BEFORE
 * an irreversible change to their data. That is the entire reason the dialog
 * exists — the action it guards used to be a bare button.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ApplyRuleDialog from './ApplyRuleDialog'
import type { RecodeDefinition } from '@/lib/api'

afterEach(cleanup)

function defn(over: Partial<RecodeDefinition> = {}): RecodeDefinition {
  return {
    id: 1, column_id: 1, name: 'Anxiety reversed',
    recode_type: 'scale_map', output_type: 'numeric',
    mapping: { Never: 5, Always: 1 }, exclude_values: null,
    is_primary: false, is_auto_detected: false, source_definition_id: null,
    sequence_order: 0, created_at: '', updated_at: '',
    unmapped_values: [], reverse_offset: null,
    ...over,
  } as RecodeDefinition
}

function renderDialog(
  definition: RecodeDefinition | null = defn(),
  columnType = 'ordinal',
  onConfirm = vi.fn(),
) {
  render(
    <ApplyRuleDialog
      open
      definition={definition}
      variableLabel="Math anxiety"
      columnType={columnType}
      isPending={false}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm }
}

describe('ApplyRuleDialog', () => {
  it('names the rule and the variable it will change', () => {
    renderDialog()
    expect(
      screen.getByRole('alertdialog', { name: /Apply “Anxiety reversed” to Math anxiety\?/ }),
    ).toBeInTheDocument()
  })

  it('says plainly that it cannot be undone', () => {
    // The single most important sentence on the screen. MM genuinely cannot
    // restore the replaced values — that is Decision D's whole problem — so this
    // is stated flatly rather than hedged.
    renderDialog()
    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByText(/not kept anywhere/i)).toBeInTheDocument()
  })

  it('points at the non-destructive alternative', () => {
    // "Create as new variable" sits on the same card; a researcher reaching for
    // this button may simply not have noticed it.
    renderDialog()
    expect(screen.getByText(/Create as new variable/)).toBeInTheDocument()
  })

  it('names the responses that will be emptied, before the change', () => {
    // #794 established that a partial match is DISCLOSED rather than prevented —
    // but it disclosed afterwards, in a toast. The data is already on the card,
    // so there is no reason not to say it first.
    renderDialog(defn({ unmapped_values: ['Sometimes', 'No opinion'] }))
    expect(screen.getByText(/2 responses are/i)).toBeInTheDocument()
    expect(screen.getByText(/Sometimes, No opinion/)).toBeInTheDocument()
    expect(screen.getByText(/left empty/i)).toBeInTheDocument()
  })

  it('stays quiet about unmapped values when there are none', () => {
    // A warning that always shows is a warning nobody reads on the run that
    // matters.
    renderDialog()
    expect(screen.queryByText(/not covered by this rule/i)).not.toBeInTheDocument()
  })

  describe('the category-group warning', () => {
    /**
     * ⚠️ This warning MOVED here from the create form (2026-08-24). It was gated
     * on "this will become the primary", a condition creating a rule can no
     * longer make true — so left where it was it would have become copy that
     * never renders. It belongs where the clearing actually happens.
     */
    const GROUP = defn({ recode_type: 'category_group', output_type: 'categorical' })

    it('fires on a numeric-encoded variable', () => {
      renderDialog(GROUP, 'ordinal')
      expect(screen.getByText(/produces names, not numbers/i)).toBeInTheDocument()
      expect(screen.getByText(/means, correlations and\s+scale scores/i)).toBeInTheDocument()
    })

    it('does NOT fire on a variable that has no numeric coding to lose', () => {
      // A nominal column's `value_numeric` is not a meaningful encoding, so
      // there is nothing for the category group to remove — and a warning that
      // fires on the harmless case is how the useful case gets ignored.
      renderDialog(GROUP, 'nominal')
      expect(screen.queryByText(/produces names, not numbers/i)).not.toBeInTheDocument()
    })

    it('does NOT fire for a scale map, which keeps the numbers', () => {
      renderDialog(defn(), 'ordinal')
      expect(screen.queryByText(/produces names, not numbers/i)).not.toBeInTheDocument()
    })
  })

  it('confirms only on the explicit action', () => {
    const { onConfirm } = renderDialog()
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply to this variable' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
