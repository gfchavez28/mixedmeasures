/**
 * #973 (c) — the column chooser a researcher meets when a file is over the cap.
 *
 * The thing worth guarding here is not the list; it is the BUDGET. This screen
 * exists to let someone bring a file under `MAX_DATASET_CELLS`, so it has to
 * predict the refusal at exactly the number the server refuses at — and it must
 * not predict one at all when the row count is unknown, which SPSS is allowed to
 * record (#539).
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DatasetColumnChooser } from './DatasetColumnChooser'
import type { DatasetColumnsResponse } from '@/lib/api'

afterEach(cleanup)

function summary(overrides: Partial<DatasetColumnsResponse> = {}): DatasetColumnsResponse {
  return {
    columns: [
      { column_index: 0, column_name: 'Q001', sample_values: ['1', '2'] },
      { column_index: 1, column_name: 'Q002', sample_values: ['a', 'b'] },
      { column_index: 2, column_name: 'Q003', sample_values: [] },
    ],
    total_rows: 100,
    cells: 300,
    max_cells: 200,
    ...overrides,
  }
}

function setup(props: Partial<React.ComponentProps<typeof DatasetColumnChooser>> = {}) {
  const onContinue = vi.fn()
  const onToggle = vi.fn()
  const view = render(
    <DatasetColumnChooser
      fileName="survey.csv"
      summary={summary()}
      selected={new Set([0, 1])}
      onToggle={onToggle}
      onSelectAll={vi.fn()}
      onSelectNone={vi.fn()}
      onContinue={onContinue}
      onCancel={vi.fn()}
      {...props}
    />,
  )
  return { ...view, onContinue, onToggle }
}

describe('the budget it states', () => {
  it('counts the SELECTION against the limit the server sent', () => {
    setup({ selected: new Set([0]) })
    // 100 records x 1 column = 100 of 200 — the threshold is never a local copy.
    expect(screen.getByRole('status')).toHaveTextContent(
      '100 records × 1 column = 100 of 200 values',
    )
  })

  it('blocks Continue when the selection is still over the limit', async () => {
    setup({ selected: new Set([0, 1, 2]) })   // 100 x 3 = 300 > 200
    expect(screen.getByRole('status')).toHaveTextContent('300 of 200 values')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('allows Continue at exactly the limit', () => {
    setup({ selected: new Set([0, 1]) })      // 100 x 2 = 200, at the cap
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('blocks Continue when nothing is selected', () => {
    setup({ selected: new Set() })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('says how many columns fit, so the researcher has a target', () => {
    setup()
    // Scoped to the emphasised figure — the budget line below also contains
    // "2 columns", and an unscoped query matches both.
    expect(screen.getByText('2 columns', { selector: 'strong' })).toBeInTheDocument()
  })
})

describe('when the row count is unknown', () => {
  // #539: SPSS may legally record its row count as -1. A budget cannot be
  // computed, and a guessed one would predict a refusal that may never come.
  const unknown = summary({ total_rows: -1, cells: null })

  it('states that the size cannot be checked rather than showing a number', () => {
    setup({ summary: unknown, selected: new Set([0]) })
    expect(screen.getByRole('status')).toHaveTextContent(
      /does not declare how many records/,
    )
    expect(screen.getByRole('status')).not.toHaveTextContent('of 200 values')
  })

  it('still allows Continue — the cap is the server’s to enforce', () => {
    setup({ summary: unknown, selected: new Set([0, 1, 2]) })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('does not tell the researcher how many columns fit', () => {
    // The known-rows copy says "you can import up to N columns"; with no row
    // count there is no such N, so the paragraph must not invent one.
    setup({ summary: unknown, selected: new Set([0]) })
    expect(screen.queryByText(/you can import up to/)).not.toBeInTheDocument()
    expect(screen.getByText(/Pick the ones you need/)).toBeInTheDocument()
  })
})

describe('the list', () => {
  it('names every column and shows its first values', () => {
    setup()
    expect(screen.getByRole('checkbox', { name: 'Q001' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Q003' })).not.toBeChecked()
    // A survey export's names are often codes, so the samples are what
    // distinguish them.
    expect(screen.getByText('1 · 2')).toBeInTheDocument()
  })

  it('names a column that has no name, rather than rendering a blank row', () => {
    setup({
      summary: summary({
        columns: [{ column_index: 4, column_name: '', sample_values: [] }],
      }),
    })
    expect(screen.getByRole('checkbox', { name: 'Column 5' })).toBeInTheDocument()
  })

  it('reports a toggle by ORIGINAL index', () => {
    const { onToggle } = setup()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Q003' }))
    expect(onToggle).toHaveBeenCalledWith(2)
  })
})

describe('while it is working', () => {
  it('disables the controls and says so', () => {
    setup({ busy: true })
    expect(
      screen.getByRole('button', { name: 'Reading the selected columns…' }),
    ).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Q001' })).toBeDisabled()
  })
})
