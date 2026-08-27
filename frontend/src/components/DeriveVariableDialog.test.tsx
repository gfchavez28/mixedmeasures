/**
 * Decision B's confirm dialog.
 *
 * The assertions are chosen around what the researcher must be able to LEARN
 * from this screen, because every one of those facts was a finding rather than a
 * layout choice: that the source survives, what the new variable will contain,
 * why the label checkbox is off when it is off, and what the rule does not cover.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import DeriveVariableDialog from './DeriveVariableDialog'
import type { DerivePlan } from '@/lib/api'

afterEach(cleanup)

const PLAN: DerivePlan = {
  output_type: 'numeric',
  column_type: 'numeric',
  mapped: [['Never', '5'], ['Rarely', '4'], ['Sometimes', '3'], ['Often', '2'], ['Always', '1']],
  unmapped_values: [],
  missing_values_carried: [],
  labels: {
    available: true,
    reason: null,
    pairs: [[1, 'Always'], [2, 'Often'], [3, 'Sometimes'], [4, 'Rarely'], [5, 'Never']],
  },
  suggested_name: 'Math anxiety (Anxiety reversed)',
}

function renderDialog(plan: DerivePlan | null = PLAN, onConfirm = vi.fn()) {
  render(
    <DeriveVariableDialog
      open
      sourceLabel="Math anxiety"
      ruleName="Anxiety reversed"
      plan={plan}
      isPending={false}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm }
}

describe('DeriveVariableDialog', () => {
  it('says the source variable is left alone — the reassurance IS the feature', () => {
    renderDialog()
    // The developer's original report was that MM derives a variable without
    // creating one. This sentence is the answer to that, so it is pinned.
    expect(screen.getByText(/is left exactly as it is/i)).toBeInTheDocument()
    expect(screen.getByText('Math anxiety')).toBeInTheDocument()
  })

  it('shows what each response becomes, in a table with real headers', () => {
    renderDialog()
    expect(screen.getByRole('columnheader', { name: 'Response' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Becomes' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Never' })).toBeInTheDocument()
    // Reverse-scored: "Never" becomes 5.
    expect(screen.getByRole('cell', { name: '5' })).toBeInTheDocument()
  })

  it('pre-fills a name the researcher can edit and confirms with the trimmed value', () => {
    const { onConfirm } = renderDialog()
    const input = screen.getByLabelText('Name for the new variable')
    expect(input).toHaveValue('Math anxiety (Anxiety reversed)')

    fireEvent.change(input, { target: { value: '  Anxiety_R  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create variable' }))
    expect(onConfirm).toHaveBeenCalledWith('Anxiety_R', true)
  })

  it('refuses to submit a blank name rather than creating an unfindable variable', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Name for the new variable'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Create variable' })).toBeDisabled()
  })

  it('defaults the label carry ON when it is available', () => {
    renderDialog()
    expect(screen.getByRole('checkbox', { name: /carry the value labels/i })).toBeChecked()
  })

  describe('when labels cannot be carried', () => {
    /**
     * ⚠️ The REASON is the assertion, not the disabled state.
     *
     * Four different conditions turn this off and they send the researcher to
     * four different places — "there are no labels to carry" is a completely
     * different next step from "this rule merges responses, so the merged
     * categories need names you choose". A disabled control with no reason
     * reads as a broken tool, which is why the reason rides the payload.
     */
    const COLLAPSING: DerivePlan = {
      ...PLAN,
      labels: {
        available: false,
        reason: 'This rule merges responses onto shared codes, so the merged '
          + 'categories need names you choose. Create the variable, then add '
          + 'value labels to it.',
        pairs: [],
      },
    }

    it('disables the checkbox AND renders the reason', () => {
      renderDialog(COLLAPSING)
      const box = screen.getByRole('checkbox', { name: /carry the value labels/i })
      expect(box).toBeDisabled()
      expect(box).not.toBeChecked()
      expect(screen.getByText(/merges responses onto shared codes/i)).toBeInTheDocument()
    })

    it('associates the reason with the checkbox for a screen reader', () => {
      renderDialog(COLLAPSING)
      // The reason must be reachable from the control, not merely nearby —
      // a sighted user sees the adjacency and a screen-reader user does not.
      expect(screen.getByRole('checkbox', { name: /carry the value labels/i }))
        .toHaveAccessibleDescription(/merges responses onto shared codes/i)
    })

    it('still allows the variable to be created', () => {
      const { onConfirm } = renderDialog(COLLAPSING)
      fireEvent.click(screen.getByRole('button', { name: 'Create variable' }))
      expect(onConfirm).toHaveBeenCalledWith('Math anxiety (Anxiety reversed)', false)
    })
  })

  it('names the responses the rule does not cover, and says they are not lost', () => {
    // #794: a partial match is disclosed, never prevented — and disclosed BEFORE
    // the researcher acts, not in a toast afterwards.
    renderDialog({ ...PLAN, unmapped_values: ['Strongly agree', 'No opinion'] })
    expect(screen.getByText(/does not cover 2 responses/i)).toBeInTheDocument()
    expect(screen.getByText(/Strongly agree, No opinion/)).toBeInTheDocument()
    expect(screen.getByText(/nothing is lost/i)).toBeInTheDocument()
  })

  it('says the missing rules travel with the values', () => {
    renderDialog({ ...PLAN, missing_values_carried: ['.n:', '.i:'] })
    expect(screen.getByText(/missing-value rules/i)).toBeInTheDocument()
  })

  it('cannot be confirmed before the plan arrives', () => {
    renderDialog(null)
    expect(screen.getByRole('button', { name: 'Create variable' })).toBeDisabled()
    expect(screen.getByText(/working out what this would produce/i)).toBeInTheDocument()
  })

  it('summarises rather than rendering an unbounded mapping table', () => {
    // A declared dictionary may legally carry 500 codes (`MAX_VALUE_LABELS`).
    // #809 is the open issue for exactly this shape one surface over; this
    // dialog must not reproduce it.
    const many: [string, string][] = Array.from({ length: 40 }, (_, i) => [`R${i}`, String(i)])
    renderDialog({ ...PLAN, mapped: many })
    expect(screen.getAllByRole('row')).toHaveLength(7) // header + 6
    expect(screen.getByText(/and 34 more responses/i)).toBeInTheDocument()
  })
})
