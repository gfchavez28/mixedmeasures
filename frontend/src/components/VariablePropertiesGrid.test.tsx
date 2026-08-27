import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import VariablePropertiesGrid from './VariablePropertiesGrid'
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

function renderGrid(columns: DatasetColumn[], selected: number | null = null) {
  const onSelectColumn = vi.fn()
  const onEditValues = vi.fn()
  render(
    <VariablePropertiesGrid
      columns={columns}
      selectedColumnId={selected}
      onSelectColumn={onSelectColumn}
      onEditValues={onEditValues}
    />,
  )
  return { onSelectColumn, onEditValues }
}

describe('VariablePropertiesGrid', () => {
  it('is a grid of variables-as-rows with the Variable View property columns', () => {
    renderGrid([col({ id: 1 }), col({ id: 2 })])
    const grid = screen.getByRole('grid', { name: 'Variable properties' })
    expect(grid).toBeInTheDocument()
    expect([...grid.querySelectorAll('th')].map(t => t.textContent))
      .toEqual(['Name', 'Label', 'Type', 'Values', 'Missing', 'Rule in effect'])
  })

  it('declares NO aria-setsize — the DOM holds the whole set (#758/#772)', () => {
    // The inverse error to #751. A dataset is capped at 500 columns and every
    // row renders, so a reader derives the count itself; adding these by
    // analogy with the virtualised listboxes would be wrong. Pinned so the
    // absence reads as a decision.
    renderGrid([col({ id: 1 }), col({ id: 2 })])
    const grid = screen.getByRole('grid')
    expect(grid.querySelector('[aria-setsize]')).toBeNull()
    expect(grid.querySelector('[aria-posinset]')).toBeNull()
  })

  it('keeps exactly ONE tabbable cell — roving tabindex, not a stop per cell', () => {
    // 3 variables x 6 properties = 18 cells. Without roving that is 18 tab
    // stops before the rest of the page.
    renderGrid([col({ id: 1 }), col({ id: 2 }), col({ id: 3 })])
    expect(screen.getByRole('grid').querySelectorAll('td[tabindex="0"]')).toHaveLength(1)
  })

  it('moves the roving stop with the arrow keys, and keeps it at one', async () => {
    renderGrid([col({ id: 1, column_name: 'age' }), col({ id: 2, column_name: 'sex' })])
    const grid = screen.getByRole('grid')
    ;(grid.querySelector('td[tabindex="0"]') as HTMLElement).focus()

    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Question 1'))
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Question 2'))
    expect(grid.querySelectorAll('td[tabindex="0"]')).toHaveLength(1)
  })

  it('does not walk off either edge', async () => {
    renderGrid([col({ id: 1, column_name: 'only' })])
    const grid = screen.getByRole('grid')
    ;(grid.querySelector('td[tabindex="0"]') as HTMLElement).focus()
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    fireEvent.keyDown(grid, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement).toHaveTextContent('only'))
    expect(grid.querySelectorAll('td[tabindex="0"]')).toHaveLength(1)
  })

  it('marks the selected variable with aria-selected, not only a tint', () => {
    renderGrid([col({ id: 1 }), col({ id: 2 })], 2)
    const rows = screen.getAllByRole('row').slice(1) // drop the header row
    expect(rows[0]).toHaveAttribute('aria-selected', 'false')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('selects a variable when its row is clicked', () => {
    const { onSelectColumn } = renderGrid([col({ id: 7, column_name: 'anx' })])
    fireEvent.click(screen.getByText('anx'))
    expect(onSelectColumn).toHaveBeenCalledWith(7)
  })

  describe('the Missing cell distinguishes all THREE declared states', () => {
    // `null` = the recognized-N/A defaults, `[]` = a real declaration that
    // nothing is missing, rules = those rules (#592/#609c). Keying on length
    // would collapse the first two — the falsy trap this codebase keeps meeting.
    it('null reads as Automatic', () => {
      renderGrid([col({ id: 1, missing_values: null })])
      expect(screen.getByRole('button', { name: /Missing values/ })).toHaveTextContent('Automatic')
    })

    it('an EMPTY declaration reads as Nothing, not as Automatic', () => {
      renderGrid([col({ id: 1, missing_values: [] })])
      expect(screen.getByRole('button', { name: /Missing values/ })).toHaveTextContent('Nothing')
    })

    it('rules read as a count', () => {
      renderGrid([col({ id: 1, missing_values: [{ value: '99' }, { value: '98' }] })])
      expect(screen.getByRole('button', { name: /Missing values/ })).toHaveTextContent('2 rules')
    })
  })

  it('summarises value labels and says how many are hidden', () => {
    renderGrid([col({ id: 1, scale_labels: ['None', 'Mild', 'Moderate', 'Severe', 'Extreme'] })])
    expect(screen.getByRole('button', { name: /Value labels/ })).toHaveTextContent('None, Mild, +3')
  })

  it('names the Values button after its own variable', () => {
    // A browse-mode reader meets this button with no row context (#785), so N
    // buttons called "Value labels" would be N identical names.
    renderGrid([col({ id: 1, column_name: 'anxiety' })])
    expect(screen.getByRole('button', { name: 'Value labels for anxiety' })).toBeInTheDocument()
  })

  it('opens the editor for the clicked variable without selecting the row', () => {
    const c = col({ id: 4, column_name: 'anx' })
    const { onEditValues, onSelectColumn } = renderGrid([c])
    fireEvent.click(screen.getByRole('button', { name: /Value labels/ }))
    expect(onEditValues).toHaveBeenCalledWith(c)
    // The cell button stops propagation — clicking it is not a row click.
    expect(onSelectColumn).not.toHaveBeenCalled()
  })

  describe('the Rule in effect column', () => {
    it('says the rule name when one is primary', () => {
      renderGrid([col({
        id: 1,
        primary_recode: { id: 9, name: 'Anxiety (inverted)', recode_type: 'scale_map', remaps_codes: true },
      })])
      expect(screen.getByText('Anxiety (inverted)')).toBeInTheDocument()
    })

    it('flags a rule that re-maps the codes', () => {
      renderGrid([col({
        id: 1,
        primary_recode: { id: 9, name: 'Flip', recode_type: 'scale_map', remaps_codes: true },
      })])
      expect(screen.getByText('re-maps codes')).toBeInTheDocument()
    })

    it('does NOT flag an identity map', () => {
      renderGrid([col({
        id: 1,
        primary_recode: { id: 9, name: 'Scale', recode_type: 'scale_map', remaps_codes: false },
      })])
      expect(screen.queryByText('re-maps codes')).not.toBeInTheDocument()
    })

    it('reads as em-dash when no rule is in effect', () => {
      renderGrid([col({ id: 1, primary_recode: null })])
      const cells = screen.getAllByRole('gridcell')
      expect(cells[cells.length - 1]).toHaveTextContent('—')
    })
  })
})
