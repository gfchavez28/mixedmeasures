/**
 * CreatableComboList — the keyboard-accessible, creatable filter list (#462) used
 * by the create-code category field and the codes-panel "Move to category" action.
 * Type to filter, arrows to move, Enter to pick; a non-matching query offers a
 * "create" row; an optional clear row maps to null.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CreatableComboList, type ComboOption } from './creatable-combobox'

afterEach(cleanup)

const options: ComboOption[] = [
  { value: 1, label: 'Leadership', color: '#f00' },
  { value: 2, label: 'Climate', color: '#0f0' },
]

describe('CreatableComboList', () => {
  it('renders options plus a clear row when allowClear', () => {
    render(<CreatableComboList options={options} value={null} onSelect={() => {}} allowClear clearLabel="No category" />)
    expect(screen.getByText('No category')).toBeInTheDocument()
    expect(screen.getByText('Leadership')).toBeInTheDocument()
    expect(screen.getByText('Climate')).toBeInTheDocument()
  })

  it('filters options as the query changes', () => {
    render(<CreatableComboList options={options} value={null} onSelect={() => {}} searchPlaceholder="Search…" />)
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'lead' } })
    expect(screen.getByText('Leadership')).toBeInTheDocument()
    expect(screen.queryByText('Climate')).not.toBeInTheDocument()
  })

  it('selecting an option calls onSelect with its value and dismisses', () => {
    const onSelect = vi.fn()
    const onDismiss = vi.fn()
    render(<CreatableComboList options={options} value={null} onSelect={onSelect} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText('Climate'))
    expect(onSelect).toHaveBeenCalledWith(2)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('the clear row calls onSelect(null)', () => {
    const onSelect = vi.fn()
    render(<CreatableComboList options={options} value={1} onSelect={onSelect} allowClear clearLabel="No category" />)
    fireEvent.click(screen.getByText('No category'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('offers a create row for a non-matching query and calls onCreate', () => {
    const onCreate = vi.fn()
    render(
      <CreatableComboList
        options={options}
        value={null}
        onSelect={() => {}}
        onCreate={onCreate}
        createPrefix="New category"
        searchPlaceholder="Search…"
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Equity' } })
    const createRow = screen.getByText(/New category/)
    expect(createRow).toBeInTheDocument()
    fireEvent.click(createRow)
    expect(onCreate).toHaveBeenCalledWith('Equity')
  })

  it('does not offer a create row when the query exactly matches an option', () => {
    render(
      <CreatableComboList
        options={options}
        value={null}
        onSelect={() => {}}
        onCreate={() => {}}
        createPrefix="New category"
        searchPlaceholder="Search…"
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Climate' } })
    expect(screen.queryByText(/New category/)).not.toBeInTheDocument()
  })

  it('Enter commits the highlighted row (first filtered option)', () => {
    const onSelect = vi.fn()
    render(<CreatableComboList options={options} value={null} onSelect={onSelect} searchPlaceholder="Search…" />)
    const input = screen.getByPlaceholderText('Search…')
    fireEvent.change(input, { target: { value: 'climate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(2)
  })
})
