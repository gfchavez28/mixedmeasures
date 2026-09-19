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
import type { ListLoad } from '@/lib/list-status'

afterEach(cleanup)

/** #963 — every mount states whether its options are an ANSWER. */
const load = (status: ListLoad['status'] = 'ready'): ListLoad => ({
  status,
  error: status === 'failed' ? { status: 500 } : null,
  retry: vi.fn(),
  retrying: false,
})

const options: ComboOption[] = [
  { value: 1, label: 'Leadership', color: '#f00' },
  { value: 2, label: 'Climate', color: '#0f0' },
]

describe('CreatableComboList', () => {
  it('renders options plus a clear row when allowClear', () => {
    render(<CreatableComboList options={options} optionsLoad={load()} optionsNoun="categories" value={null} onSelect={() => {}} allowClear clearLabel="No category" />)
    expect(screen.getByText('No category')).toBeInTheDocument()
    expect(screen.getByText('Leadership')).toBeInTheDocument()
    expect(screen.getByText('Climate')).toBeInTheDocument()
  })

  it('filters options as the query changes', () => {
    render(<CreatableComboList options={options} optionsLoad={load()} optionsNoun="categories" value={null} onSelect={() => {}} searchPlaceholder="Search…" />)
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'lead' } })
    expect(screen.getByText('Leadership')).toBeInTheDocument()
    expect(screen.queryByText('Climate')).not.toBeInTheDocument()
  })

  it('selecting an option calls onSelect with its value and dismisses', () => {
    const onSelect = vi.fn()
    const onDismiss = vi.fn()
    render(<CreatableComboList options={options} optionsLoad={load()} optionsNoun="categories" value={null} onSelect={onSelect} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText('Climate'))
    expect(onSelect).toHaveBeenCalledWith(2)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('the clear row calls onSelect(null)', () => {
    const onSelect = vi.fn()
    render(<CreatableComboList options={options} optionsLoad={load()} optionsNoun="categories" value={1} onSelect={onSelect} allowClear clearLabel="No category" />)
    fireEvent.click(screen.getByText('No category'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('offers a create row for a non-matching query and calls onCreate', () => {
    const onCreate = vi.fn()
    render(
      <CreatableComboList
        options={options}
        optionsLoad={load()}
        optionsNoun="categories"
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
        optionsLoad={load()}
        optionsNoun="categories"
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
    render(<CreatableComboList options={options} optionsLoad={load()} optionsNoun="categories" value={null} onSelect={onSelect} searchPlaceholder="Search…" />)
    const input = screen.getByPlaceholderText('Search…')
    fireEvent.change(input, { target: { value: 'climate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(2)
  })
})

/**
 * #963 — what this list may CLAIM and OFFER before its options answer.
 *
 * Both call sites are the same act: creating a code CATEGORY from a typed name.
 * Neither `create_category` nor `create_code` refuses a duplicate name — unlike
 * participants, where the server 409s — so this list is the only duplicate
 * guard there is, and both pickers fetch on OPEN, which makes every cold open
 * an unanswered one. Measured on the running app: *"No categories yet"* beside
 * a *New category "X"* row on a project that has categories.
 *
 * `ready` is the POSITIVE CONTROL and the cases above are it: a component that
 * simply never offered a create row would pass every negative assertion here.
 */
describe('#963 — CreatableComboList before its options answer', () => {
  const typeQuery = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value } })

  const mountLoading = (status: ListLoad['status'], onCreate = vi.fn()) => {
    render(
      <CreatableComboList
        options={[]}
        optionsLoad={load(status)}
        optionsNoun="categories"
        value={null}
        onSelect={() => {}}
        onCreate={onCreate}
        createPrefix="New category"
        searchPlaceholder="Search…"
        emptyText="No categories yet"
      />,
    )
    return onCreate
  }

  it('says it is loading instead of claiming there are none', () => {
    mountLoading('loading')
    expect(screen.getByRole('status')).toHaveTextContent('Loading categories…')
    expect(screen.queryByText('No categories yet')).not.toBeInTheDocument()
  })

  it('offers no create row, so a typed name cannot make a duplicate', () => {
    const onCreate = mountLoading('loading')
    typeQuery('Leadership')
    expect(screen.queryByText(/New category/)).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('after a failure says the load failed and still offers no create row', () => {
    const onCreate = mountLoading('failed')
    expect(screen.getByRole('alert')).toHaveTextContent(/categories could not be loaded/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No categories yet')).not.toBeInTheDocument()
    typeQuery('Leadership')
    expect(screen.queryByText(/New category/)).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL — an answered EMPTY list says so and still offers create', () => {
    const onCreate = vi.fn()
    render(
      <CreatableComboList
        options={[]}
        optionsLoad={load('ready')}
        optionsNoun="categories"
        value={null}
        onSelect={() => {}}
        onCreate={onCreate}
        createPrefix="New category"
        searchPlaceholder="Search…"
        emptyText="No categories yet"
      />,
    )
    expect(screen.getByText('No categories yet')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    typeQuery('Leadership')
    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('Leadership')
  })

  it('the load state is not an option — it sits outside the listbox', () => {
    mountLoading('loading')
    const listbox = screen.getByRole('listbox')
    expect(listbox).not.toContainElement(screen.getByRole('status'))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
