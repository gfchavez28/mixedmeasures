/**
 * Tests for TypePickerPopover (Phase 4.3/4.4).
 *
 * Single entry point for cell type changes:
 *   - Click trigger → 9 column-type swatches in a popover menu
 *   - Click a type → fires onTypeChange and closes
 *   - When recodeDefCount > 0 → "Has recode definitions" pre-flight message
 *     with a Recode Workbench link instead of the swatch list
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { TypePickerPopover } from './TypePickerPopover'
import { COLUMN_TYPES } from '@/lib/dataset-constants'

afterEach(() => cleanup())

function renderPopover(props: Partial<Parameters<typeof TypePickerPopover>[0]> = {}) {
  const defaults = {
    currentType: 'ordinal',
    columnCode: 'Q1',
    columnText: 'How happy are you?',
    recodeDefCount: 0,
    projectId: 7,
    datasetId: 100,
    columnId: 1,
    onTypeChange: vi.fn(),
    children: <button data-testid="trigger-btn">ordinal</button>,
  }
  return render(
    <MemoryRouter>
      <TypePickerPopover {...defaults} {...props} />
    </MemoryRouter>,
  )
}

describe('TypePickerPopover', () => {
  it('opens with 9 column-type options when no recodes', () => {
    renderPopover()
    fireEvent.click(screen.getByTestId('trigger-btn'))
    // All 9 types from COLUMN_TYPES render as menuitems
    for (const t of COLUMN_TYPES) {
      expect(screen.getByTestId(`type-picker-option-${t}`)).toBeInTheDocument()
    }
    expect(COLUMN_TYPES.length).toBe(9)
  })

  it('marks the current type with aria-current', () => {
    renderPopover({ currentType: 'numeric' })
    fireEvent.click(screen.getByTestId('trigger-btn'))
    const numericOption = screen.getByTestId('type-picker-option-numeric')
    expect(numericOption).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('type-picker-option-ordinal')).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('fires onTypeChange when a different type is picked', () => {
    const onTypeChange = vi.fn()
    renderPopover({ onTypeChange })
    fireEvent.click(screen.getByTestId('trigger-btn'))
    fireEvent.click(screen.getByTestId('type-picker-option-binary'))
    expect(onTypeChange).toHaveBeenCalledWith(1, 100, 'binary')
  })

  it('does NOT fire onTypeChange when the current type is picked (no-op)', () => {
    const onTypeChange = vi.fn()
    renderPopover({ currentType: 'ordinal', onTypeChange })
    fireEvent.click(screen.getByTestId('trigger-btn'))
    fireEvent.click(screen.getByTestId('type-picker-option-ordinal'))
    expect(onTypeChange).not.toHaveBeenCalled()
  })

  it('shows "Has recode definitions" pre-flight when recodeDefCount > 0', () => {
    renderPopover({ recodeDefCount: 3 })
    fireEvent.click(screen.getByTestId('trigger-btn'))
    expect(screen.getByTestId('type-picker-recode-block')).toBeInTheDocument()
    expect(screen.getByText('Has recode definitions')).toBeInTheDocument()
    expect(
      screen.getByTestId('type-picker-recode-block').textContent,
    ).toContain('3 recode definitions')
    expect(
      screen.getByRole('button', { name: /Open Recode Workbench/i }),
    ).toBeInTheDocument()
    // No type swatches surface in this state
    expect(screen.queryByTestId('type-picker-option-ordinal')).not.toBeInTheDocument()
  })

  it('singular phrasing for one recode definition', () => {
    renderPopover({ recodeDefCount: 1 })
    fireEvent.click(screen.getByTestId('trigger-btn'))
    // Text is split across multiple text nodes ("This column has 1 recode
    // definition." + " Clear them..."); match across the whole block.
    expect(
      screen.getByTestId('type-picker-recode-block').textContent,
    ).toContain('This column has 1 recode definition.')
  })
})
