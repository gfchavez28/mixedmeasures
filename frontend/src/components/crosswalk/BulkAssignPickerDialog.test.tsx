/**
 * BulkAssignPickerDialog — locks in the placement-radio removal from
 * commit 4 of the drag-first redesign. The dialog now always uses
 * `row_per_column` (the only mode left under Path A's unified row model)
 * and exposes onConfirm(bracketId) — no second placement argument.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BulkAssignPickerDialog } from './BulkAssignPickerDialog'
import type { BracketData } from './crosswalk-types'

afterEach(() => cleanup())

function bracket(overrides: Partial<BracketData> = {}): BracketData {
  return {
    domain_id: 50,
    name: 'Leadership',
    description: null,
    color: null,
    sequence_order: 0,
    is_cross_dataset: false,
    dataset_count: 1,
    scale_score_metric_id: null,
    scale_score_metric_state: 'missing',
    rows: [],
    ...overrides,
  }
}

describe('BulkAssignPickerDialog', () => {
  it('renders the bracket list and Add button', () => {
    render(
      <BulkAssignPickerDialog
        open
        onOpenChange={vi.fn()}
        brackets={[bracket()]}
        columnIds={[1, 2]}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByRole('radio', { name: /Leadership/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add 2/ })).toBeInTheDocument()
  })

  it('placement radios are gone (row_per_column / as_additional)', () => {
    render(
      <BulkAssignPickerDialog
        open
        onOpenChange={vi.fn()}
        brackets={[bracket()]}
        columnIds={[1]}
        onConfirm={vi.fn()}
      />,
    )
    // Only one radio group should exist — the bracket list. The placement
    // group ('row_per_column' / 'as_additional') was removed in commit 4.
    expect(screen.queryByRole('radio', { name: /Create equivalence row for each/i })).toBeNull()
    expect(screen.queryByRole('radio', { name: /Add as additional members/i })).toBeNull()
  })

  it('onConfirm receives only the bracketId (no placement)', () => {
    const onConfirm = vi.fn()
    render(
      <BulkAssignPickerDialog
        open
        onOpenChange={vi.fn()}
        brackets={[bracket({ domain_id: 50, name: 'Leadership' })]}
        columnIds={[1, 2, 3]}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add 3/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(50)
  })

  it('preselectedBracketId selects that bracket on open', () => {
    render(
      <BulkAssignPickerDialog
        open
        onOpenChange={vi.fn()}
        brackets={[
          bracket({ domain_id: 50, name: 'Leadership', sequence_order: 0 }),
          bracket({ domain_id: 60, name: 'Communication', sequence_order: 1 }),
        ]}
        columnIds={[1]}
        onConfirm={vi.fn()}
        preselectedBracketId={60}
      />,
    )
    const comm = screen.getByRole('radio', { name: /Communication/ })
    expect(comm).toBeChecked()
  })

  it('cross-dataset chip still renders for cross-dataset brackets', () => {
    render(
      <BulkAssignPickerDialog
        open
        onOpenChange={vi.fn()}
        brackets={[
          bracket({ is_cross_dataset: true, dataset_count: 2 }),
        ]}
        columnIds={[1]}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByText('cross-dataset')).toBeInTheDocument()
  })
})
