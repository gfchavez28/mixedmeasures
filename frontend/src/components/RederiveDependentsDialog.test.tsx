/**
 * #584 step 2 — the re-derive confirm.
 *
 * The assertions here are about REFUSAL, because that is where the damage is.
 * A blocked dependent is the label-remapped crosswalk copy: re-deriving onto it
 * writes keys no cell carries and silently NULLs the column on the next apply.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import RederiveDependentsDialog from './RederiveDependentsDialog'
import { isSelectable } from '@/lib/rederive-status'
import type { RederivePlanItem } from '@/lib/api'

afterEach(cleanup)

const item = (over: Partial<RederivePlanItem>): RederivePlanItem => ({
  definition_id: 1, name: 'Reverse copy', column_id: 1, is_primary: false,
  status: 'ready', changed_keys: ['always'], detail: '1 value(s) would be updated.',
  ...over,
})

function setup(plan: RederivePlanItem[], onConfirm = vi.fn()) {
  render(
    <RederiveDependentsDialog
      open sourceName="Satisfaction" plan={plan} isPending={false}
      onCancel={vi.fn()} onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('isSelectable', () => {
  /**
   * ⚠️ POPULATION-style assertion over the status vocabulary: only `ready` is
   * actionable. A fourth status added later defaults to NOT selectable, which is
   * the safe direction — the alternative is a new status silently becoming
   * eligible for a write that changes stored numbers.
   */
  it('offers only ready rows', () => {
    expect(isSelectable(item({ status: 'ready' }))).toBe(true)
    expect(isSelectable(item({ status: 'no_change' }))).toBe(false)
    expect(isSelectable(item({ status: 'blocked' }))).toBe(false)
    expect(isSelectable(item({ status: 'something_new' }))).toBe(false)
  })
})

describe('the confirm', () => {
  it('pre-selects the ready rows, since that is what the researcher opened it for', () => {
    const onConfirm = setup([item({ definition_id: 7 })])
    fireEvent.click(screen.getByRole('button', { name: /Re-derive 1 definition/ }))
    expect(onConfirm).toHaveBeenCalledWith([7])
  })

  /**
   * 🔴 The load-bearing case. A blocked row must not be offerable at all — the
   * server 409s the whole batch if one is included, so a selectable row that
   * always fails would be a control that lies about what it does.
   */
  it('gives a blocked dependent no checkbox, and never sends it', () => {
    const onConfirm = setup([
      item({ definition_id: 7, name: 'Same column copy' }),
      item({ definition_id: 8, name: 'French copy', status: 'blocked', changed_keys: [],
             detail: 'Its mapping shares no values with the source.' }),
    ])
    expect(screen.queryByRole('checkbox', { name: 'Re-derive French copy' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Re-derive Same column copy' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Re-derive 1 definition/ }))
    expect(onConfirm).toHaveBeenCalledWith([7])
  })

  it('says why a blocked dependent is being left alone', () => {
    setup([item({ status: 'blocked', changed_keys: [], detail: 'Its mapping shares no values with the source.' })])
    // The reason has to reach the screen: "can't" without "why" reads as a bug.
    expect(screen.getByText(/shares no values with the source/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/cannot.*be re-derived/i)
  })

  it('names which values move, not just how many definitions', () => {
    setup([item({ changed_keys: ['always', 'often'] })])
    expect(screen.getByText(/Values changing: always, often/)).toBeInTheDocument()
  })

  it('disables the action when nothing is actionable', () => {
    setup([item({ status: 'no_change', changed_keys: [] })])
    expect(screen.getByRole('button', { name: /Re-derive 0 definitions/ })).toBeDisabled()
  })

  it('says so plainly when nothing derives from the source', () => {
    setup([])
    expect(screen.getByText(/Nothing derives from this definition/)).toBeInTheDocument()
  })

  /**
   * 🔴 Found by DRIVING it, not by any test. The description said
   * "This changes stored scores" unconditionally, directly above a row reading
   * "This definition is not primary, so no stored scores change" — the dialog
   * contradicted itself on screen and gave the researcher no way to tell which
   * claim was real. Only a PRIMARY dependent writes value_numeric.
   */
  it('does not claim stored scores change when no selected dependent is primary', () => {
    setup([item({ is_primary: false })])
    expect(screen.getByText(/no stored scores change/)).toBeInTheDocument()
    expect(screen.queryByText(/This changes stored scores/)).toBeNull()
  })

  it('does warn about stored scores when a selected dependent IS primary', () => {
    setup([item({ is_primary: true })])
    expect(screen.getByText(/This changes stored scores/)).toBeInTheDocument()
  })
})
