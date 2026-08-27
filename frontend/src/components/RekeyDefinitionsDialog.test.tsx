/**
 * #584's death arm — the re-key confirm.
 *
 * Two things are asserted here that no backend test can see: that a blocked row
 * is not offerable as a CONTROL, and that the description does not contradict
 * the rows underneath it. The drift dialog shipped with exactly that
 * contradiction and it was found by looking at the screen, not by a test — so
 * the sibling case is pinned here rather than re-discovered.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import RekeyDefinitionsDialog from './RekeyDefinitionsDialog'
import { isSelectable } from '@/lib/rekey-status'
import type { RekeyPlanItem } from '@/lib/api'

afterEach(cleanup)

const item = (over: Partial<RekeyPlanItem>): RekeyPlanItem => ({
  definition_id: 1,
  name: 'Reverse score',
  recode_type: 'reverse',
  is_primary: false,
  status: 'ready',
  renames: [{ old: '1', new: 'Strongly disagree' }],
  unresolved_keys: [],
  detail: '1 value would be renamed to the column’s current labels.',
  ...over,
})

function setup(plan: RekeyPlanItem[], onConfirm = vi.fn()) {
  render(
    <RekeyDefinitionsDialog
      open columnLabel="Satisfaction" plan={plan} isPending={false}
      onCancel={vi.fn()} onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('isSelectable', () => {
  /**
   * ⚠️ POPULATION-style assertion over the vocabulary rather than one case: a
   * status the backend adds later must default to NOT selectable.
   */
  it('offers only ready rows', () => {
    expect(isSelectable(item({ status: 'ready' }))).toBe(true)
    expect(isSelectable(item({ status: 'blocked' }))).toBe(false)
    expect(isSelectable(item({ status: 'something_new' }))).toBe(false)
  })
})

describe('the confirm', () => {
  it('pre-selects the ready rows, since that is what the researcher opened it for', () => {
    const onConfirm = setup([item({ definition_id: 7 })])
    fireEvent.click(screen.getByRole('button', { name: /Update 1 recode/ }))
    expect(onConfirm).toHaveBeenCalledWith([7])
  })

  it('gives a blocked row no checkbox at all', () => {
    setup([
      item({ definition_id: 1, name: 'Fine one' }),
      item({
        definition_id: 2, name: 'Old labels', status: 'blocked',
        renames: [], unresolved_keys: ['Never', 'Always'],
        detail: 'Some of its values cannot be matched to a code on this column.',
      }),
    ])
    // A selectable control that always fails is a control that lies about what
    // it does — the server 409s the whole batch if one is included.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'Update Fine one' })).toBeInTheDocument()
  })

  it('shows a blocked row’s unresolved values so it can be fixed by hand', () => {
    setup([item({
      status: 'blocked', renames: [], unresolved_keys: ['Never'],
      detail: 'Some of its values cannot be matched to a code: “Never”.',
    })])
    expect(screen.getByText(/“Never”/)).toBeInTheDocument()
  })

  it('cannot be confirmed when every row is blocked', () => {
    setup([item({ status: 'blocked', renames: [], unresolved_keys: ['Never'] })])
    expect(screen.getByRole('button', { name: /Update 0 recodes/ })).toBeDisabled()
  })

  /**
   * Relabelling mints a fresh auto primary that can carry the SAME generated
   * name as the definition it demoted — two "5-point scale" rows, seen on the
   * dev corpus. The type is what tells them apart.
   */
  it('shows each row’s recode type, since names are not unique', () => {
    setup([
      item({ definition_id: 1, name: '5-point scale', recode_type: 'scale_map' }),
      item({ definition_id: 2, name: '5-point scale', recode_type: 'reverse' }),
    ])
    expect(screen.getByText('Scale Map')).toBeInTheDocument()
    expect(screen.getByText('Reverse')).toBeInTheDocument()
  })

  it('names each rename, so the confirm says what it will do', () => {
    setup([item({
      renames: [
        { old: '1', new: 'Strongly disagree' },
        { old: '5', new: 'Strongly agree' },
      ],
    })])
    expect(screen.getByText('Strongly disagree')).toBeInTheDocument()
    expect(screen.getByText('Strongly agree')).toBeInTheDocument()
  })
})

describe('the description does not contradict the rows', () => {
  /**
   * 🔴 The sibling of the defect found by driving the drift dialog: an
   * unconditional "this changes stored scores" sat directly above a row saying
   * "no stored scores change". Two adjacent true-looking sentences saying
   * opposite things, and a researcher has no way to tell which is real.
   */
  it('promises no score change when no SELECTED row is primary', () => {
    setup([item({ is_primary: false })])
    expect(screen.getByText(/no stored scores change/)).toBeInTheDocument()
    expect(screen.queryByText(/changes stored scores/)).not.toBeInTheDocument()
  })

  /**
   * 🔴 Found by driving it, on the ordinary case: a column that was ALREADY
   * labelled has recodes keyed on the previous labels, none of which resolve.
   * The description promised "renaming makes them work again" over rows that
   * each said the opposite, above a disabled button.
   */
  it('promises no repair when nothing is translatable', () => {
    setup([item({ status: 'blocked', renames: [], unresolved_keys: ['None'] })])
    expect(screen.getByText(/none of them can be repaired automatically/)).toBeInTheDocument()
    expect(screen.queryByText(/makes them work again/)).not.toBeInTheDocument()
  })

  it('warns about stored scores when a selected row IS primary', () => {
    setup([item({ is_primary: true })])
    expect(screen.getByText(/changes stored scores/)).toBeInTheDocument()
  })

  /**
   * ⚠️ Keyed on the SELECTION, not on what is present: the warning has to
   * describe what the button is about to do. Unticking the primary row must
   * take the warning with it.
   */
  it('drops the warning when the primary row is unticked', () => {
    setup([
      item({ definition_id: 1, name: 'Plain', is_primary: false }),
      item({ definition_id: 2, name: 'Primary one', is_primary: true }),
    ])
    expect(screen.getByText(/changes stored scores/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Update Primary one' }))
    expect(screen.getByText(/no stored scores change/)).toBeInTheDocument()
  })
})
