/**
 * Track J · J1 — per-coder visibility filter popover. Verifies the trigger
 * states and the never-hide-yourself rule (the active coder's checkbox is
 * disabled, so the row-level predicate only needs the `hidden` set).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import CoderFilterPopover from './CoderFilterPopover'

afterEach(cleanup)

const coders = [
  { id: 1, username: 'Me' },
  { id: 2, username: 'Bob Smith' },
]

describe('CoderFilterPopover', () => {
  it('trigger reflects the no-filter state', () => {
    render(<CoderFilterPopover coders={coders} activeCoderId={1} hidden={new Set()} onChange={() => {}} />)
    expect(screen.getByLabelText('Filter codes by coder')).toBeInTheDocument()
  })

  it('trigger surfaces the hidden count', () => {
    render(<CoderFilterPopover coders={coders} activeCoderId={1} hidden={new Set([2])} onChange={() => {}} />)
    expect(screen.getByLabelText('Filter codes by coder (1 hidden)')).toBeInTheDocument()
  })

  it('lets you hide another coder but never yourself', () => {
    const onChange = vi.fn()
    render(<CoderFilterPopover coders={coders} activeCoderId={1} hidden={new Set()} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Filter codes by coder'))
    expect(screen.getByLabelText(/Me \(you/)).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Show codes by Bob Smith'))
    expect(onChange).toHaveBeenCalledWith(new Set([2]))
  })

  it('"Just me" hides every other coder; "Show all" clears', () => {
    const onChange = vi.fn()
    render(<CoderFilterPopover coders={coders} activeCoderId={1} hidden={new Set([2])} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Filter codes by coder (1 hidden)'))
    fireEvent.click(screen.getByText('Just me'))
    expect(onChange).toHaveBeenCalledWith(new Set([2]))
    fireEvent.click(screen.getByText('Show all'))
    expect(onChange).toHaveBeenCalledWith(new Set())
  })
})

describe('CoderFilterPopover · active-here markers (#457)', () => {
  const roster = [
    { id: 1, username: 'Me' },
    { id: 2, username: 'Bob Smith' },
    { id: 3, username: 'Cara' },
  ]

  it('marks who coded the source, flags the rest as no-codes, and shows a count', () => {
    render(
      <CoderFilterPopover
        coders={roster}
        activeCoderId={1}
        hidden={new Set()}
        onChange={() => {}}
        activeCoderIds={new Set([1, 2])}
      />,
    )
    fireEvent.click(screen.getByLabelText('Filter codes by coder'))
    expect(screen.getByText(/2 of 3 coded here/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Show codes by Bob Smith \(coded here\)/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Show codes by Cara \(no codes in this source\)/)).toBeInTheDocument()
  })

  it('hides archived-who-coded extras behind a "view all" toggle, then lists + filters them (#451)', () => {
    const onChange = vi.fn()
    const onShowArchivedChange = vi.fn()
    const props = {
      coders: roster,
      activeCoderId: 1,
      hidden: new Set<number>(),
      onChange,
      activeCoderIds: new Set([1]),
      extraCoders: [{ id: 9, username: 'Kwame', archived: true }],
      onShowArchivedChange,
    }
    const { rerender } = render(<CoderFilterPopover {...props} showArchived={false} />)
    fireEvent.click(screen.getByLabelText('Filter codes by coder'))
    expect(screen.getByText(/1 of 3 coded here/)).toBeInTheDocument()
    expect(screen.getByText(/\+1 archived/)).toBeInTheDocument()
    // archived row is collapsed by default — only the "view all" toggle shows it
    expect(screen.queryByLabelText(/Show codes by Kwame/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /View all.*1 archived/i }))
    expect(onShowArchivedChange).toHaveBeenCalledWith(true)
    // once revealed (controlled), the archived coder is listed, labeled, and filterable
    rerender(<CoderFilterPopover {...props} showArchived={true} />)
    const kwame = screen.getByLabelText(/Show codes by Kwame \(archived\) \(coded here\)/)
    fireEvent.click(kwame)
    expect(onChange).toHaveBeenCalledWith(new Set([9]))
  })

  it('shows no markers when activeCoderIds is omitted (multi-source surfaces)', () => {
    render(<CoderFilterPopover coders={roster} activeCoderId={1} hidden={new Set()} onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText('Filter codes by coder'))
    expect(screen.queryByText(/coded here/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Show codes by Bob Smith')).toBeInTheDocument()
  })
})
