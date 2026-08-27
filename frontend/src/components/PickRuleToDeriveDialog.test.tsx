/**
 * Step one of `Add ▾ → Recoded variable…`.
 *
 * The assertions cluster on the EMPTY case, because in a real dataset that is
 * the common one — 3 of 88 variables carry a rule in the developer's own corpus.
 * A dialog whose main job is explaining where rules come from has to be tested
 * as though that were its main job.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import PickRuleToDeriveDialog from './PickRuleToDeriveDialog'
import type { DatasetColumn } from '@/lib/api'

afterEach(cleanup)

function col(over: Partial<DatasetColumn> = {}): DatasetColumn {
  return {
    id: 1, column_code: 'C001', column_name: null, group_code: null, group_label: null,
    column_text: 'Math anxiety', column_type: 'ordinal', sequence_order: 0,
    scale_labels: null, scale_points: null, numeric_min: null, numeric_max: null,
    numeric_format: null, source: 'imported', recode_definitions: [],
    ...over,
  } as DatasetColumn
}

const RULE = {
  id: 10, name: 'Anxiety reversed', recode_type: 'scale_map', output_type: 'numeric',
  mapping: {}, exclude_values: null, is_primary: false, is_auto_detected: false,
  source_definition_id: null, reverse_offset: null,
} as DatasetColumn['recode_definitions'] extends (infer R)[] | undefined ? R : never

function renderDialog(columns: DatasetColumn[], onPick = vi.fn()) {
  render(
    <PickRuleToDeriveDialog
      open
      columns={columns}
      variablesHref="/projects/1/datasets/1/variables"
      onOpenChange={vi.fn()}
      onPick={onPick}
    />,
  )
  return { onPick }
}

describe('PickRuleToDeriveDialog', () => {
  it('says the original is left untouched', () => {
    renderDialog([col({ recode_definitions: [RULE] })])
    expect(screen.getByText(/original is left untouched/i)).toBeInTheDocument()
  })

  describe('when no variable has a rule yet — the common case', () => {
    it('explains where rules come from instead of showing an empty picker', () => {
      // 🔴 The point of the empty state. "No rules found" would be true and
      // useless: deriving needs a saved rule, and rules are authored on a
      // different page, so the dialog has to name that page.
      renderDialog([col(), col({ id: 2, column_text: 'Grade' })])
      expect(screen.getByText(/No variable in this dataset has a saved recode rule/i))
        .toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Variables view' }))
        .toHaveAttribute('href', '/projects/1/datasets/1/variables')
      expect(screen.queryByLabelText('Variable')).not.toBeInTheDocument()
    })

    it('cannot be continued', () => {
      renderDialog([col()])
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    })
  })

  it('lists ONLY variables that have a rule', () => {
    // ⚠️ Filtering rather than showing-and-disabling is a deliberate departure
    // from the gated-entry-point rule (which keeps ineligible identifier columns
    // VISIBLE in the crosswalk). It applies there because hiding removes the
    // only place a mis-typed column is discoverable; here the empty state above
    // carries the discoverability, and a list of 88 with 3 selectable is noise.
    renderDialog([
      col({ recode_definitions: [RULE] }),
      col({ id: 2, column_text: 'Grade', recode_definitions: [] }),
    ])
    const options = screen.getByLabelText('Variable').querySelectorAll('option')
    expect([...options].map(o => o.textContent)).toEqual(['Select a variable...', 'Math anxiety'])
  })

  it('will not offer rules until a variable is chosen', () => {
    renderDialog([col({ recode_definitions: [RULE] })])
    const rules = screen.getByLabelText('Rule')
    expect(rules).toBeDisabled()
    expect(rules).toHaveTextContent('Choose a variable first')
  })

  it('marks which rule is already in effect', () => {
    // The researcher is choosing what to materialise; whether a rule is already
    // rewriting the source changes what they expect the result to look like.
    renderDialog([col({
      recode_definitions: [RULE, { ...RULE, id: 11, name: 'Collapse', is_primary: true }],
    })])
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: '1' } })
    const options = screen.getByLabelText('Rule').querySelectorAll('option')
    expect([...options].map(o => o.textContent))
      .toEqual(['Select a rule...', 'Anxiety reversed', 'Collapse — in effect'])
  })

  it('hands back the column and the rule it was chosen from', () => {
    const { onPick } = renderDialog([col({ recode_definitions: [RULE] })])
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onPick).toHaveBeenCalledWith(1, { id: 10, name: 'Anxiety reversed' })
  })

  it('can never hand back a (variable, rule) pair that does not exist', () => {
    /**
     * 🔴 REWRITTEN after mutation-testing. The first version asserted "changing
     * the variable clears the rule" and **passed with the `setDefinitionId(null)`
     * reset deleted** — so it was pinning nothing.
     *
     * The reason is worth keeping: the reset is belt-and-braces, not the
     * safety. `chosenRule` is a LOOKUP inside the chosen column's own rules, and
     * a `RecodeDefinition.id` is a primary key — globally unique — so a stale id
     * from another variable can never resolve. The select also renders `''` for
     * a value with no matching option, which is why the old assertion could not
     * fail either.
     *
     * So this pins the property that IS load-bearing: whatever the internal
     * state does, `onPick` only ever receives a pair that belongs together. The
     * reset stays (one line, and it keeps the visible control honest), but it is
     * not independently observable — which is a finding about the design, not a
     * gap in the test.
     */
    const { onPick } = renderDialog([
      col({ recode_definitions: [RULE] }),
      col({ id: 2, column_text: 'Grade', recode_definitions: [{ ...RULE, id: 20, name: 'Bands' }] }),
    ])
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: '2' } })

    expect(screen.getByRole('button', { name: 'Continue' }))
      .toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onPick).not.toHaveBeenCalled()

    // …and choosing the NEW variable's own rule works, so the guard above is
    // not passing by having broken the control (the positive control).
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onPick).toHaveBeenCalledWith(2, { id: 20, name: 'Bands' })
  })
})
